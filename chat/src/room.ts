import { DurableObject } from 'cloudflare:workers'
import { botReply } from './bot'
import { looksUrgent, scrubRef, sendToJohn, withRef } from './telegram'
import type { ChatMessage, Env, RoomMeta, Sender } from './types'

const MAX_CUSTOMER_MESSAGES = 60
const MAX_BOT_REPLIES = 25
const MAX_HANDOFF_TRIES = 3
const ENGAGED_WINDOW_MS = 15 * 60 * 1000
const RESUME_BOT_DELAY_MS = 5000
const CAP_NOTE =
  ' I have reached my limit for this chat. John reads the chat and will reply when he can. For anything urgent call 408-691-5940.'

export const UNKNOWN_CHAT = 'unknown chat'
export const CHAT_FULL_MESSAGE =
  'This chat is full. Tap the plus button at the top to start a new chat, or call or text 408-691-5940.'

/** What /me or /bot did to a chat. */
export type BotSwitch = 'gone' | 'off' | 'on' | 'capped'

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

  /**
   * Every meta write that can change timing goes through here, so the single alarm
   * always matches what is stored. Rooms from before retention existed get their
   * activity clock started on the first write instead of being judged by createdAt.
   */
  private async saveMeta(meta: RoomMeta): Promise<void> {
    const m = meta.lastActivityAt ? meta : { ...meta, lastActivityAt: Date.now() }
    await this.ctx.storage.put('meta', m)
    await this.rearm(m)
  }

  async fromCustomer(text: string): Promise<{ ok: boolean; error?: string }> {
    const { meta, msgs } = await this.load()
    if (!meta) return { ok: false, error: UNKNOWN_CHAT }
    if (msgs.filter((m) => m.from === 'customer').length >= MAX_CUSTOMER_MESSAGES) {
      return { ok: false, error: CHAT_FULL_MESSAGE }
    }
    await this.append('customer', text)

    // Other requests can run while we wait on Control, so read meta again afterwards.
    const status = await this.control().status(num(this.env.BOT_DAILY_BUDGET, 300))
    const current = await this.ctx.storage.get<RoomMeta>('meta')
    // The retention alarm deleted the chat in that window. The widget starts a new one on 404.
    if (!current) return { ok: false, error: UNKNOWN_CHAT }

    const capped = current.botReplies >= MAX_BOT_REPLIES
    const delay = current.botOff || capped || status.botSpent ? null : this.handoffDelay(current, status.away)
    // Commit the handoff before talking to Telegram. If Telegram is down the
    // customer still gets the bot, which is the whole point of the bot.
    const now = Date.now()
    await this.saveMeta({ ...current, lastActivityAt: now, handoffAt: delay === null ? null : now + delay * 1000, handoffTries: 0 })

    const header = looksUrgent(text) ? 'NEW CHAT MESSAGE (might be urgent)' : 'New chat message'
    const footer = current.botOff
      ? 'Bot is off for this chat. Reply to answer.'
      : capped
        ? 'The bot has reached its limit for this chat. Reply to answer.'
        : status.botSpent
          ? 'The bot has used its daily budget, so it will not answer. Reply to answer.'
          : `Bot answers in ${delay}s unless you reply first. Swipe to reply.`
    await sendToJohn(
      this.env,
      withRef(`${header}\nCustomer: ${scrubRef(text)}${current.page ? `\nPage: ${current.page}` : ''}\n\n${footer}`, current.roomId),
    )
    return { ok: true }
  }

  async fromJohn(text: string): Promise<boolean> {
    const { meta } = await this.load()
    if (!meta) return false
    await this.append('john', text)
    const now = Date.now()
    await this.saveMeta({ ...meta, johnLastAt: now, lastActivityAt: now, handoffAt: null, handoffTries: 0 })
    return true
  }

  async setBotOff(botOff: boolean): Promise<BotSwitch> {
    const { meta, msgs } = await this.load()
    if (!meta) return 'gone'
    const capped = meta.botReplies >= MAX_BOT_REPLIES
    let handoffAt = botOff ? null : (meta.handoffAt ?? null)
    // Turning the bot back on while a customer is waiting: answer them shortly.
    if (!botOff && !capped && handoffAt === null && msgs[msgs.length - 1]?.from === 'customer') {
      handoffAt = Date.now() + RESUME_BOT_DELAY_MS
    }
    await this.saveMeta({ ...meta, botOff, handoffAt, handoffTries: 0 })
    return botOff ? 'off' : capped ? 'capped' : 'on'
  }

  /**
   * How long the bot waits for John before answering. /away wins because John sent
   * it on purpose. A reply from John in the last 15 minutes proves he is up, so the
   * engaged window beats quiet hours.
   */
  private handoffDelay(meta: RoomMeta, away: boolean): number {
    if (away) return num(this.env.AWAY_HANDOFF_SECONDS, 20)
    if (Date.now() - meta.johnLastAt < ENGAGED_WINDOW_MS) return num(this.env.ENGAGED_HANDOFF_SECONDS, 300)
    if (inQuietHours(this.env)) return num(this.env.AWAY_HANDOFF_SECONDS, 20)
    return num(this.env.HANDOFF_SECONDS, 90)
  }

  /** A Durable Object has one alarm, so it is set to the earlier of the bot handoff and the retention expiry. */
  private async rearm(meta: RoomMeta): Promise<void> {
    const times: number[] = []
    if (typeof meta.handoffAt === 'number') times.push(meta.handoffAt)
    const retention = retentionMs(this.env)
    if (retention > 0) times.push((meta.lastActivityAt ?? Date.now()) + retention)
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times))
    else await this.ctx.storage.deleteAlarm()
  }

  async alarm(): Promise<void> {
    const { meta, msgs } = await this.load()
    if (!meta) return
    const now = Date.now()

    // Rooms from before handoffAt existed had an alarm that only meant "bot, answer".
    const legacy = meta.handoffAt === undefined && msgs[msgs.length - 1]?.from === 'customer'
    if (legacy || (typeof meta.handoffAt === 'number' && meta.handoffAt <= now + 1000)) {
      const tries = (meta.handoffTries ?? 0) + 1
      if (tries > MAX_HANDOFF_TRIES) {
        console.error('Bot handoff failed repeatedly, leaving the chat for John')
        await this.ctx.storage.put('meta', { ...meta, handoffAt: null, handoffTries: 0 })
      } else {
        // Count the attempt before doing anything that can fail. If this run dies
        // (an error, a deploy, an eviction mid-reply) the alarm is retried and the
        // handoff is still pending, up to MAX_HANDOFF_TRIES times.
        const counted: RoomMeta = { ...meta, handoffTries: tries }
        await this.ctx.storage.put('meta', counted)
        await this.answerAsBot(counted, msgs)
      }
    }

    const fresh = await this.ctx.storage.get<RoomMeta>('meta')
    if (!fresh) return
    if (!fresh.lastActivityAt) {
      // Old room with no activity clock: start it now rather than delete on sight.
      await this.saveMeta(fresh)
      return
    }
    const retention = retentionMs(this.env)
    if (retention > 0 && fresh.lastActivityAt + retention <= now) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      return
    }
    await this.rearm(fresh)
  }

  /**
   * Answers the waiting customer as the bot. The handoff is only marked done when it
   * is consumed here. If someone else changed it meanwhile (John replied, the
   * customer wrote again, /me) that change owns the handoff now and is left alone.
   */
  private async answerAsBot(meta: RoomMeta, msgs: ChatMessage[]): Promise<void> {
    const due = meta.handoffAt
    const consume = async () => {
      const m = await this.ctx.storage.get<RoomMeta>('meta')
      if (m && m.handoffAt === due) await this.saveMeta({ ...m, handoffAt: null, handoffTries: 0 })
    }

    if (meta.botOff || meta.botReplies >= MAX_BOT_REPLIES || msgs[msgs.length - 1]?.from !== 'customer') return consume()
    if (!(await this.control().takeBotCall(num(this.env.BOT_DAILY_BUDGET, 300)))) {
      console.error('Daily bot budget reached, leaving the chat for John')
      return consume()
    }

    const answeredUpTo = msgs.length
    this.botRunning = true
    let result: Awaited<ReturnType<typeof botReply>>
    try {
      result = await botReply(this.env, msgs)
    } finally {
      this.botRunning = false
    }

    const latest = await this.load()
    if (!latest.meta || latest.meta.handoffAt !== due) return
    if (
      !result ||
      latest.meta.botOff ||
      latest.msgs[latest.msgs.length - 1]?.from !== 'customer' ||
      latest.msgs.length > answeredUpTo
    ) {
      return consume()
    }

    // Only real answers count toward the per-chat cap. Canned lines do not.
    const real = result.kind === 'ok'
    const botReplies = latest.meta.botReplies + (real ? 1 : 0)
    const text = real && botReplies >= MAX_BOT_REPLIES ? result.text + CAP_NOTE : result.text
    await this.append('bot', text)
    await this.saveMeta({ ...latest.meta, botReplies, handoffAt: null, handoffTries: 0 })

    if (real) {
      await sendToJohn(
        this.env,
        withRef(`Bot replied:\n${text.slice(0, 3000)}\n\nReply to jump in, or reply /me to turn the bot off for this chat.`, latest.meta.roomId),
        true,
      )
    } else {
      // Loud on purpose: nobody has really answered this customer yet.
      await sendToJohn(
        this.env,
        withRef(`Bot could not answer this one, so the customer saw:\n${text}\n\nReply to answer them.`, latest.meta.roomId),
      )
    }
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

  /** Everything a new customer message needs to know, in one round trip. */
  async status(botBudget: number): Promise<{ away: boolean; botSpent: boolean }> {
    const [away, bot] = await Promise.all([this.isAway(), this.count('bot', localDay(this.env))])
    return { away, botSpent: botBudget > 0 && bot >= botBudget }
  }

  /** Counts one bot call against today's budget. False means the budget is spent. */
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
