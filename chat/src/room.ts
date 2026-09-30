import { DurableObject } from 'cloudflare:workers'
import { botReply } from './bot'
import { looksUrgent, scrubRef, sendToJohn, withRef } from './telegram'
import type { ChatMessage, Env, RoomMeta, Sender } from './types'

const MAX_CUSTOMER_MESSAGES = 60
const MAX_BOT_REPLIES = 25
const ENGAGED_WINDOW_MS = 15 * 60 * 1000
const RESUME_BOT_DELAY_MS = 5000
const CAP_NOTE =
  ' I have reached my limit for this chat. John reads the chat and will reply when he can. For anything urgent call 408-691-5940.'

export const CHAT_FULL_MESSAGE = 'This chat is full. Tap New chat to start another, or call or text 408-691-5940.'

/** One Durable Object per website visitor conversation. */
export class Room extends DurableObject<Env> {
  private botRunning = false

  private async load() {
    const [meta, msgs] = await Promise.all([
      this.ctx.storage.get<RoomMeta>('meta'),
      this.ctx.storage.get<ChatMessage[]>('msgs'),
    ])
    return { meta, msgs: msgs ?? [] }
  }

  private control() {
    return this.env.CONTROL.get(this.env.CONTROL.idFromName('control'))
  }

  async init(roomId: string, page: string): Promise<void> {
    if (await this.ctx.storage.get('meta')) return
    const now = Date.now()
    const meta: RoomMeta = { roomId, createdAt: now, page, johnLastAt: 0, botOff: false, botReplies: 0, lastActivityAt: now, handoffAt: null }
    await this.saveMeta(meta)
  }

  async exists(): Promise<boolean> {
    return !!(await this.ctx.storage.get('meta'))
  }

  async messages(after: number): Promise<{ messages: ChatMessage[]; typing: boolean }> {
    const { msgs } = await this.load()
    return { messages: msgs.filter((m) => m.n > after), typing: this.botRunning }
  }

  private async append(from: Sender, text: string): Promise<ChatMessage> {
    const { msgs } = await this.load()
    const msg: ChatMessage = { n: msgs.length + 1, from, text, ts: Date.now() }
    msgs.push(msg)
    await this.ctx.storage.put('msgs', msgs)
    return msg
  }

  /** Every meta write goes through here so the single alarm always matches the stored state. */
  private async saveMeta(meta: RoomMeta): Promise<void> {
    await this.ctx.storage.put('meta', meta)
    await this.rearm(meta)
  }

  async fromCustomer(text: string): Promise<{ ok: boolean; error?: string }> {
    const { meta, msgs } = await this.load()
    if (!meta) return { ok: false, error: 'unknown chat' }
    if (msgs.filter((m) => m.from === 'customer').length >= MAX_CUSTOMER_MESSAGES) {
      return { ok: false, error: CHAT_FULL_MESSAGE }
    }
    await this.append('customer', text)

    const capped = meta.botReplies >= MAX_BOT_REPLIES
    const delay = meta.botOff || capped ? null : await this.handoffDelay(meta)
    // Commit the handoff alarm before talking to Telegram. If Telegram is down the
    // customer still gets the bot, which is the whole point of the bot.
    const now = Date.now()
    const current = (await this.ctx.storage.get<RoomMeta>('meta')) ?? meta
    await this.saveMeta({ ...current, lastActivityAt: now, handoffAt: delay === null ? null : now + delay * 1000 })

    const header = looksUrgent(text) ? 'NEW CHAT MESSAGE (might be urgent)' : 'New chat message'
    const footer = meta.botOff
      ? 'Bot is off for this chat. Reply to answer.'
      : capped
        ? 'The bot has reached its limit for this chat. Reply to answer.'
        : `Bot answers in ${delay}s unless you reply first. Swipe to reply.`
    await sendToJohn(
      this.env,
      withRef(`${header}${meta.page ? `\nPage: ${meta.page}` : ''}\n\nCustomer: ${scrubRef(text)}\n\n${footer}`, meta.roomId),
    )
    return { ok: true }
  }

  async fromJohn(text: string): Promise<boolean> {
    const { meta } = await this.load()
    if (!meta) return false
    await this.append('john', text)
    const now = Date.now()
    await this.saveMeta({ ...meta, johnLastAt: now, lastActivityAt: now, handoffAt: null })
    return true
  }

  async setBotOff(botOff: boolean): Promise<boolean> {
    const { meta, msgs } = await this.load()
    if (!meta) return false
    let handoffAt = botOff ? null : (meta.handoffAt ?? null)
    // Turning the bot back on while a customer is waiting: answer them shortly.
    if (!botOff && handoffAt === null && meta.botReplies < MAX_BOT_REPLIES && msgs[msgs.length - 1]?.from === 'customer') {
      handoffAt = Date.now() + RESUME_BOT_DELAY_MS
    }
    await this.saveMeta({ ...meta, botOff, handoffAt })
    return true
  }

  /**
   * How long the bot waits for John before answering. /away wins because John sent
   * it on purpose. A reply from John in the last 15 minutes proves he is up, so the
   * engaged window beats quiet hours.
   */
  private async handoffDelay(meta: RoomMeta): Promise<number> {
    if (await this.control().isAway()) return num(this.env.AWAY_HANDOFF_SECONDS, 20)
    if (Date.now() - meta.johnLastAt < ENGAGED_WINDOW_MS) return num(this.env.ENGAGED_HANDOFF_SECONDS, 300)
    if (inQuietHours(this.env)) return num(this.env.AWAY_HANDOFF_SECONDS, 20)
    return num(this.env.HANDOFF_SECONDS, 90)
  }

  /** A Durable Object has one alarm, so it is set to the earlier of the bot handoff and the retention expiry. */
  private async rearm(meta: RoomMeta): Promise<void> {
    const times: number[] = []
    if (typeof meta.handoffAt === 'number') times.push(meta.handoffAt)
    const retention = retentionMs(this.env)
    if (retention > 0) times.push((meta.lastActivityAt ?? meta.createdAt) + retention)
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times))
    else await this.ctx.storage.deleteAlarm()
  }

  async alarm(): Promise<void> {
    const { meta, msgs } = await this.load()
    if (!meta) return
    const now = Date.now()

    if (typeof meta.handoffAt === 'number' && meta.handoffAt <= now + 1000) {
      // Clear the handoff first so a crash below cannot retry the bot in a loop.
      const cleared: RoomMeta = { ...meta, handoffAt: null }
      await this.ctx.storage.put('meta', cleared)
      await this.answerAsBot(cleared, msgs)
    }

    const fresh = await this.ctx.storage.get<RoomMeta>('meta')
    if (!fresh) return
    const retention = retentionMs(this.env)
    if (retention > 0 && (fresh.lastActivityAt ?? fresh.createdAt) + retention <= now) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      return
    }
    await this.rearm(fresh)
  }

  private async answerAsBot(meta: RoomMeta, msgs: ChatMessage[]): Promise<void> {
    if (meta.botOff || meta.botReplies >= MAX_BOT_REPLIES) return
    // Only answer if the customer is still waiting.
    if (msgs[msgs.length - 1]?.from !== 'customer') return
    if (!(await this.control().takeBotCall(num(this.env.BOT_DAILY_BUDGET, 300)))) {
      console.error('Daily bot budget reached, leaving the chat for John')
      return
    }

    const answeredUpTo = msgs.length
    this.botRunning = true
    let reply = ''
    try {
      reply = await botReply(this.env, msgs)
    } finally {
      this.botRunning = false
    }
    if (!reply) return

    // Things may have changed while the bot was thinking.
    const latest = await this.load()
    if (!latest.meta || latest.meta.botOff) return
    // John answered. His reply wins.
    if (latest.msgs[latest.msgs.length - 1]?.from !== 'customer') return
    // The customer sent more. The handoff their new message scheduled will answer with the full context.
    if (latest.msgs.length > answeredUpTo) return

    const botReplies = latest.meta.botReplies + 1
    if (botReplies >= MAX_BOT_REPLIES) reply += CAP_NOTE
    await this.append('bot', reply)
    await this.saveMeta({ ...latest.meta, botReplies })
    await sendToJohn(
      this.env,
      withRef(`Bot replied:\n${reply.slice(0, 3000)}\n\nReply to jump in, or reply /me to turn the bot off for this chat.`, latest.meta.roomId),
      true,
    )
  }
}

/** Global switches and daily counters John controls from Telegram. */
export class Control extends DurableObject<Env> {
  async isAway(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>('away')) ?? false
  }

  async setAway(away: boolean): Promise<void> {
    await this.ctx.storage.put('away', away)
  }

  /** Counts one bot reply against today's budget. False means the budget is spent. */
  takeBotCall(budget: number): Promise<boolean> {
    return this.take('bot', budget)
  }

  /** Counts one new chat against today's budget. False means the budget is spent. */
  takeNewRoom(budget: number): Promise<boolean> {
    return this.take('rooms', budget)
  }

  async usage(): Promise<{ day: string; bot: number; rooms: number }> {
    const day = localDay(this.env)
    const [bot, rooms] = await Promise.all([this.count('bot', day), this.count('rooms', day)])
    return { day, bot, rooms }
  }

  private async count(kind: string, day: string): Promise<number> {
    const cur = await this.ctx.storage.get<{ day: string; count: number }>(`count:${kind}`)
    return cur?.day === day ? cur.count : 0
  }

  private async take(kind: string, budget: number): Promise<boolean> {
    if (budget <= 0) return true
    const day = localDay(this.env)
    const count = await this.count(kind, day)
    if (count >= budget) return false
    await this.ctx.storage.put(`count:${kind}`, { day, count: count + 1 })
    return true
  }
}

export function num(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function retentionMs(env: Env): number {
  return num(env.RETENTION_DAYS, 30) * 24 * 60 * 60 * 1000
}

function timeZone(env: Env): string {
  return env.TIMEZONE || 'America/Los_Angeles'
}

/** Today's date in John's time zone, as YYYY-MM-DD. */
export function localDay(env: Env, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone(env), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

/** QUIET_HOURS is "start-end" in 24h local time, e.g. "21-7". */
export function inQuietHours(env: Env, now = new Date()): boolean {
  const match = env.QUIET_HOURS?.match(/^(\d{1,2})-(\d{1,2})$/)
  if (!match) return false
  const start = Number(match[1])
  const end = Number(match[2])
  let hour: number
  try {
    hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: timeZone(env) }).format(now))
  } catch (error) {
    console.error('Bad TIMEZONE, using America/Los_Angeles', error instanceof Error ? error.message : String(error))
    hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Los_Angeles' }).format(now))
  }
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end
}
