import { DurableObject } from 'cloudflare:workers'
import { botReply } from './bot'
import { looksUrgent, refLine, sendToJohn } from './telegram'
import type { ChatMessage, Env, RoomMeta, Sender } from './types'

const MAX_CUSTOMER_MESSAGES = 60
const MAX_BOT_REPLIES = 25

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

  async init(roomId: string, page: string): Promise<void> {
    if (await this.ctx.storage.get('meta')) return
    const meta: RoomMeta = { roomId, createdAt: Date.now(), page, johnLastAt: 0, botOff: false, botReplies: 0 }
    await this.ctx.storage.put('meta', meta)
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

  async fromCustomer(text: string): Promise<{ ok: boolean; error?: string }> {
    const { meta, msgs } = await this.load()
    if (!meta) return { ok: false, error: 'unknown chat' }
    if (msgs.filter((m) => m.from === 'customer').length >= MAX_CUSTOMER_MESSAGES) {
      return { ok: false, error: 'This chat is full. Please call or text 408-691-5940.' }
    }
    await this.append('customer', text)

    const delay = meta.botOff ? null : await this.handoffDelay(meta)
    const header = looksUrgent(text) ? 'NEW CHAT MESSAGE (might be urgent)' : 'New chat message'
    const footer =
      delay === null
        ? 'Bot is off for this chat. Reply to answer.'
        : `Bot answers in ${delay}s unless you reply first. Swipe to reply.`
    await sendToJohn(
      this.env,
      `${header}${meta.page ? `\nPage: ${meta.page}` : ''}\n\nCustomer: ${text}\n\n${footer}\n${refLine(meta.roomId)}`,
    )

    if (delay !== null) await this.ctx.storage.setAlarm(Date.now() + delay * 1000)
    return { ok: true }
  }

  async fromJohn(text: string): Promise<boolean> {
    const { meta } = await this.load()
    if (!meta) return false
    await this.append('john', text)
    await this.ctx.storage.put('meta', { ...meta, johnLastAt: Date.now() })
    await this.ctx.storage.deleteAlarm()
    return true
  }

  async setBotOff(botOff: boolean): Promise<boolean> {
    const { meta } = await this.load()
    if (!meta) return false
    await this.ctx.storage.put('meta', { ...meta, botOff })
    if (botOff) await this.ctx.storage.deleteAlarm()
    return true
  }

  /** How long the bot waits for John before answering. */
  private async handoffDelay(meta: RoomMeta): Promise<number> {
    const control = this.env.CONTROL.get(this.env.CONTROL.idFromName('control'))
    const away = await control.isAway()
    if (away || inQuietHours(this.env)) return num(this.env.AWAY_HANDOFF_SECONDS, 20)
    // If John is actively in this conversation, give him more room before the bot jumps in.
    if (Date.now() - meta.johnLastAt < 15 * 60 * 1000) return num(this.env.ENGAGED_HANDOFF_SECONDS, 300)
    return num(this.env.HANDOFF_SECONDS, 90)
  }

  async alarm(): Promise<void> {
    const { meta, msgs } = await this.load()
    if (!meta || meta.botOff || meta.botReplies >= MAX_BOT_REPLIES) return
    // Only answer if the customer is still waiting.
    if (msgs[msgs.length - 1]?.from !== 'customer') return

    this.botRunning = true
    let reply = ''
    try {
      reply = await botReply(this.env, msgs)
    } finally {
      this.botRunning = false
    }
    if (!reply) return

    // John may have answered while the bot was thinking. His reply wins.
    const latest = await this.load()
    if (latest.msgs[latest.msgs.length - 1]?.from !== 'customer' || latest.meta?.botOff) return

    await this.append('bot', reply)
    await this.ctx.storage.put('meta', { ...latest.meta!, botReplies: latest.meta!.botReplies + 1 })
    await sendToJohn(this.env, `Bot replied:\n${reply}\n\nReply to jump in, or reply /me to turn the bot off for this chat.\n${refLine(latest.meta!.roomId)}`, true)
  }
}

/** Global switches John controls from Telegram. */
export class Control extends DurableObject<Env> {
  async isAway(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>('away')) ?? false
  }

  async setAway(away: boolean): Promise<void> {
    await this.ctx.storage.put('away', away)
  }
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** QUIET_HOURS is "start-end" in 24h local time, e.g. "21-7". */
export function inQuietHours(env: Env, now = new Date()): boolean {
  const match = env.QUIET_HOURS?.match(/^(\d{1,2})-(\d{1,2})$/)
  if (!match) return false
  const start = Number(match[1])
  const end = Number(match[2])
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: env.TIMEZONE || 'America/Los_Angeles' }).format(now),
  )
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end
}
