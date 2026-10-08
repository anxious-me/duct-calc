import { DurableObject } from 'cloudflare:workers'
import { botReply } from './bot'
import { chatTag, looksUrgent, scrubRef, sendToJohn, withRef } from './telegram'
import type { ChatMessage, Env, RoomMeta, Sender } from './types'

const MAX_CUSTOMER_MESSAGES = 60
const MAX_BOT_REPLIES = 25
const MAX_HANDOFF_TRIES = 3
/** How many times one chat can ring John's phone, so a pushy visitor cannot ring it all night. */
const MAX_TRANSFERS = 3
const ENGAGED_WINDOW_MS = 15 * 60 * 1000
const RESUME_BOT_DELAY_MS = 5000
const PHONE = '408-691-5940'
const CAP_NOTE = ` That is all I can answer in this chat, so from here your messages go straight to John. If it can't wait, call or text ${PHONE}.`

export const UNKNOWN_CHAT = 'unknown chat'
export const CHAT_FULL_MESSAGE =
  'This chat is full. Tap the plus button at the top to start a new chat, or call or text 408-691-5940.'

/** What /me or /bot did to a chat. */
export type BotSwitch = 'gone' | 'off' | 'on' | 'capped'

/** Why the bot is getting John: the customer asked, the reply was blocked, or Claude failed. */
type Why = 'asked' | 'safe' | 'error'
/** What happened when it tried. */
type Outcome = 'ringing' | 'pending' | 'unavailable' | 'enough'

/**
 * The customer-facing lines around getting John. Written here, not by the model, so they
 * are always true: the bot only says John's phone rang when it did, and only says he is
 * not available when he was asked and did not pick up (or sent /away).
 */
function johnLine(why: Why | null, outcome: Outcome, night: boolean): string {
  const lead =
    why === 'safe' ? "I can't answer that one here. " : why === 'error' ? 'Sorry, the AI assistant is having trouble right now. ' : ''
  const middle = {
    ringing: "I just sent this chat to John's phone. If he's available he'll answer right here.",
    pending: "John's phone already has this chat. If he's available he'll answer right here.",
    unavailable: `${night ? "It's after hours and John is probably asleep, so he isn't" : "John isn't"} available right now. Leave your name, phone number, and what's going on, and he'll get back to you as soon as he can.`,
    enough: 'John already has this chat and will see everything here.',
  }[outcome]
  return `${lead}${middle} If it can't wait, call or text him at ${PHONE}.`
}

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
   * When msgs is given it is written in the same atomic put, so a bot line and the
   * state change that goes with it can never come apart.
   */
  private async saveMeta(meta: RoomMeta, msgs?: ChatMessage[]): Promise<void> {
    const m = meta.lastActivityAt ? meta : { ...meta, lastActivityAt: Date.now() }
    await this.ctx.storage.put<RoomMeta | ChatMessage[]>(msgs ? { meta: m, msgs } : { meta: m })
    await this.rearm(m)
  }

  /**
   * A customer message. While the bot is handling the chat John's phone stays quiet:
   * the bot answers right away and John gets a silent copy. His phone only rings when
   * he is in the conversation (he replied in the last 15 minutes, or sent /me), when
   * nobody else can answer, or when the customer asks for him (see getJohn).
   */
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

    const now = Date.now()
    const capped = current.botReplies >= MAX_BOT_REPLIES
    const canBot = !current.botOff && !capped && !status.botSpent
    // /away means John is not around, so even a chat he was in goes back to the bot.
    const live = !status.away && (current.botOff || now - current.johnLastAt < ENGAGED_WINDOW_MS)
    const delay = !canBot ? null : live ? num(this.env.ENGAGED_HANDOFF_SECONDS, 300) : num(this.env.BOT_REPLY_SECONDS, 2)
    // Commit the handoff before talking to Telegram. If Telegram is down the
    // customer still gets the bot, which is the whole point of the bot.
    await this.saveMeta({ ...current, lastActivityAt: now, handoffAt: delay === null ? null : now + delay * 1000, handoffTries: 0 })

    if (!live && canBot) return { ok: true }
    const footer = current.botOff
      ? 'Bot is off for this chat. Reply to answer.'
      : capped
        ? 'The bot has reached its limit for this chat. Reply to answer.'
        : status.botSpent
          ? 'The bot has used its daily budget, so it will not answer. Reply to answer.'
          : `Bot answers in ${delay}s unless you reply first. Swipe to reply.`
    await sendToJohn(
      this.env,
      withRef(`${header(current, text)}${live ? ' (you are in this chat)' : ''}\nCustomer: ${scrubRef(text)}${pageLine(current)}\n\n${footer}`, current.roomId),
    )
    return { ok: true }
  }

  async fromJohn(text: string): Promise<boolean> {
    const { meta } = await this.load()
    if (!meta) return false
    await this.append('john', text)
    const now = Date.now()
    // John picked up, so a pending "not available" line must never fire.
    await this.saveMeta({ ...meta, johnLastAt: now, lastActivityAt: now, handoffAt: null, handoffTries: 0, transferUntil: null })
    return true
  }

  async setBotOff(botOff: boolean): Promise<BotSwitch> {
    const { meta, msgs } = await this.load()
    if (!meta) return 'gone'
    const capped = meta.botReplies >= MAX_BOT_REPLIES
    let handoffAt = botOff ? null : (meta.handoffAt ?? null)
    // Turning the bot back on while a customer is waiting: answer them shortly.
    if (!botOff && !capped && handoffAt === null && lastSpeaker(msgs) === 'customer') {
      handoffAt = Date.now() + RESUME_BOT_DELAY_MS
    }
    // /me means John owns the chat, so the bot will not tell anyone he is unavailable.
    const transferUntil = botOff ? null : (meta.transferUntil ?? null)
    await this.saveMeta({ ...meta, botOff, handoffAt, handoffTries: 0, transferUntil })
    return botOff ? 'off' : capped ? 'capped' : 'on'
  }

  /** A Durable Object has one alarm, so it is set to the earliest of the bot handoff, the transfer deadline and the retention expiry. */
  private async rearm(meta: RoomMeta): Promise<void> {
    const times: number[] = []
    if (typeof meta.handoffAt === 'number') times.push(meta.handoffAt)
    if (typeof meta.transferUntil === 'number') times.push(meta.transferUntil)
    const retention = retentionMs(this.env)
    if (retention > 0) times.push((meta.lastActivityAt ?? Date.now()) + retention)
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times))
    else await this.ctx.storage.deleteAlarm()
  }

  async alarm(): Promise<void> {
    let { meta, msgs } = await this.load()
    if (!meta) return
    const now = Date.now()

    if (typeof meta.transferUntil === 'number' && meta.transferUntil <= now + 1000) {
      await this.transferTimedOut(meta)
      ;({ meta, msgs } = await this.load())
      if (!meta) return
    }

    // Rooms from before handoffAt existed had an alarm that only meant "bot, answer".
    const legacy = meta.handoffAt === undefined && lastSpeaker(msgs) === 'customer'
    if (legacy || (typeof meta.handoffAt === 'number' && meta.handoffAt <= now + 1000)) {
      const tries = (meta.handoffTries ?? 0) + 1
      if (tries > MAX_HANDOFF_TRIES) {
        console.error('Bot handoff failed repeatedly, leaving the chat for John')
        await this.ctx.storage.put('meta', { ...meta, handoffAt: null, handoffTries: 0 })
        // Loud: the customer is waiting and nobody has answered.
        if (lastSpeaker(msgs) === 'customer' && !meta.botOff) {
          await sendToJohn(
            this.env,
            withRef(`${header(meta)}: the bot could not answer after several tries, so the customer has no reply yet.\n\n${transcript(msgs)}\n\nReply to answer them.`, meta.roomId),
          )
        }
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

  /** John's phone rang and he did not reply in time: tell the customer, plainly, that he is not available. */
  private async transferTimedOut(due: RoomMeta): Promise<void> {
    const { meta, msgs } = await this.load()
    if (!meta || meta.transferUntil !== due.transferUntil) return
    const line = johnLine(null, 'unavailable', inQuietHours(this.env))
    const now = Date.now()
    // A customer may have just asked something. The line is marked sys so the bot still answers them.
    await this.saveMeta({ ...meta, transferUntil: null, unavailableAt: now }, [...msgs, { n: msgs.length + 1, from: 'bot', text: line, ts: now, sys: true }])
    await sendToJohn(
      this.env,
      withRef(
        `${header(meta)}: you did not reply within ${waitText(this.env)}, so the bot told the customer you are not available. Reply anytime to pick it back up.`,
        meta.roomId,
      ),
      true,
    )
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

    if (meta.botOff || meta.botReplies >= MAX_BOT_REPLIES || lastSpeaker(msgs) !== 'customer') return consume()
    if (!(await this.control().takeBotCall(num(this.env.BOT_DAILY_BUDGET, 300)))) {
      console.error('Daily bot budget reached, leaving the chat for John')
      await sendToJohn(
        this.env,
        withRef(`${header(meta)}: the bot hit its daily budget before it could answer, so the customer has no reply yet.\n\n${transcript(msgs)}\n\nReply to answer them.`, meta.roomId),
      )
      return consume()
    }

    const answeredUpTo = msgs.length
    this.botRunning = true
    let result: Awaited<ReturnType<typeof botReply>>
    try {
      result = await botReply(this.env, msgs, this.statusFor(meta))
    } finally {
      this.botRunning = false
    }

    const latest = await this.load()
    if (!latest.meta || latest.meta.handoffAt !== due) return
    if (
      !result ||
      latest.meta.botOff ||
      lastSpeaker(latest.msgs) !== 'customer' ||
      // Something new from the customer or John means this answer is stale. A system line does not.
      latest.msgs.slice(answeredUpTo).some((m) => !m.sys)
    ) {
      return consume()
    }

    if (result.kind !== 'ok') {
      return this.getJohn(latest.meta, latest.msgs, result.kind === 'transfer' ? 'asked' : result.kind, result.kind === 'transfer' ? result.reason : '')
    }

    // Only real answers count toward the per-chat cap. Canned lines do not.
    const botReplies = latest.meta.botReplies + 1
    const text = botReplies >= MAX_BOT_REPLIES ? result.text + CAP_NOTE : result.text
    const asked = waitingCustomer(latest.msgs)
    const firstQuestion = latest.meta.botReplies === 0 && latest.meta.johnLastAt === 0 && !latest.meta.transfers
    const now = Date.now()
    await this.saveMeta({ ...latest.meta, botReplies, handoffAt: null, handoffTries: 0 }, [
      ...latest.msgs,
      { n: latest.msgs.length + 1, from: 'bot', text, ts: now },
    ])
    // Silent unless John asked to hear about every new customer.
    const ring = firstQuestion && this.env.RING_ON_FIRST_QUESTION === 'true'
    await sendToJohn(
      this.env,
      withRef(
        `${header(latest.meta, asked.join(' '))}${pageLine(latest.meta)}\n${asked.map((t) => `Customer: ${scrubRef(t)}`).join('\n')}\nBot: ${text.slice(0, 2000)}\n\nReply to jump in, or reply /me to turn the bot off for this chat.`,
        latest.meta.roomId,
      ),
      !ring,
    )
  }

  /**
   * Gets John for the customer: rings his phone once and gives him TRANSFER_WAIT_SECONDS
   * to reply in the chat. If he does not, transferTimedOut tells the customer he is not
   * available. /away skips the ring and says so right away. Used when the customer asks
   * for John and when the bot could not answer, so nobody is ever left talking to a wall.
   */
  private async getJohn(meta: RoomMeta, msgs: ChatMessage[], why: Why, reason: string): Promise<void> {
    const now = Date.now()
    const away = await this.control().isAway()
    const transfers = meta.transfers ?? 0
    const outcome: Outcome =
      typeof meta.transferUntil === 'number' ? 'pending' : away ? 'unavailable' : transfers >= MAX_TRANSFERS ? 'enough' : 'ringing'
    const line = johnLine(why, outcome, inQuietHours(this.env))
    const next: RoomMeta = {
      ...meta,
      handoffAt: null,
      handoffTries: 0,
      transfers: outcome === 'ringing' || outcome === 'unavailable' ? transfers + 1 : transfers,
      transferUntil: outcome === 'ringing' ? now + num(this.env.TRANSFER_WAIT_SECONDS, 180) * 1000 : (meta.transferUntil ?? null),
      unavailableAt: outcome === 'unavailable' ? now : meta.unavailableAt,
    }
    await this.saveMeta(next, [...msgs, { n: msgs.length + 1, from: 'bot', text: line, ts: now }])

    const what =
      why === 'asked' ? 'the customer wants to talk to you' : why === 'safe' ? 'the bot could not answer this one' : 'the bot is having trouble (Claude error)'
    const needs = reason ? `\nNeeds: ${scrubRef(reason)}` : ''
    const recent = `${pageLine(meta)}\n\n${transcript(msgs)}`
    if (outcome === 'ringing') {
      await sendToJohn(
        this.env,
        withRef(
          `${what.toUpperCase()} (chat ${chatTag(meta.roomId)})${needs}${recent}\n\nReply to this message to talk to them here. If you do not reply within ${waitText(this.env)}, the bot tells them you are not available.`,
          meta.roomId,
        ),
      )
      return
    }
    const told =
      outcome === 'unavailable'
        ? 'Away mode is on, so the bot told them you are not available.'
        : outcome === 'pending'
          ? 'Your phone already rang for this chat.'
          : 'This chat already rang your phone the most times allowed, so it did not ring again.'
    await sendToJohn(this.env, withRef(`${header(meta)}: ${what}. ${told}${needs}${recent}\n\nReply to answer them.`, meta.roomId), true)
  }

  /** What the model needs to know about this chat right now, so it does not offer what already happened. */
  private statusFor(meta: RoomMeta): string {
    const now = Date.now()
    const lines: string[] = []
    const transfers = meta.transfers ?? 0
    if (typeof meta.transferUntil === 'number') {
      lines.push(
        "John's phone was just rung for this chat and he has not answered yet. Do not call transfer_to_john. If they ask, say John has been notified and will answer here if he is available.",
      )
    } else if (transfers >= MAX_TRANSFERS) {
      lines.push(`John has already been notified about this chat. Do not call transfer_to_john again. Give them ${PHONE} and collect their details for him.`)
    } else if (meta.unavailableAt) {
      lines.push('John was not available earlier in this chat. Collect their details for him. If they still want John, you may try transfer_to_john once more.')
    }
    if (meta.johnLastAt && now - meta.johnLastAt < ENGAGED_WINDOW_MS) {
      lines.push('John replied in this chat in the last 15 minutes but has not answered the latest message.')
    }
    return lines.join(' ')
  }
}

function header(meta: RoomMeta, text = ''): string {
  return `Chat ${chatTag(meta.roomId)}${text && looksUrgent(text) ? ' (might be urgent)' : ''}`
}

const pageLine = (meta: RoomMeta) => (meta.page ? `\nPage: ${meta.page}` : '')

export function waitText(env: Env): string {
  const s = num(env.TRANSFER_WAIT_SECONDS, 180)
  return s % 60 === 0 ? `${s / 60} min` : `${s}s`
}

/** Who spoke last, ignoring lines the system posted on its own. */
function lastSpeaker(msgs: ChatMessage[]): Sender | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) if (!msgs[i].sys) return msgs[i].from
  return undefined
}

/** The customer's messages since anyone last answered them. */
function waitingCustomer(msgs: ChatMessage[]): string[] {
  const real = msgs.filter((m) => !m.sys)
  let i = real.length
  while (i > 0 && real[i - 1].from === 'customer') i--
  return real.slice(i).map((m) => m.text)
}

/** The last few messages, for John to catch up at a glance. */
function transcript(msgs: ChatMessage[], count = 6): string {
  return msgs
    .slice(-count)
    .map((m) => {
      const who = m.from === 'customer' ? 'Customer' : m.from === 'john' ? 'You' : 'Bot'
      const text = scrubRef(m.text)
      return `${who}: ${text.length > 500 ? `${text.slice(0, 500)}...` : text}`
    })
    .join('\n')
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
