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

/** Why the bot is getting John: the customer asked, the reply was blocked, Claude failed, or the bot is out of answers. */
type Why = 'asked' | 'safe' | 'error' | 'limit'
/** What happened when it tried. unreached: Telegram did not take the ring, or the hourly ring cap was hit. */
type Outcome = 'ringing' | 'pending' | 'unavailable' | 'enough' | 'unreached'

/** Gas, carbon monoxide, fire or burning. Narrow on purpose: a plain "gas furnace" question is not an emergency. */
const DANGER =
  /\b(smell\w*(\s+\w+){0,3}\s+(gas|propane|rotten eggs?)|(gas|propane) (is |was )?(smell\w*|leak\w*|odou?r)|leaking (gas|propane)|rotten eggs?|(carbon[- ]?)?monoxide|co[- ]?(alarm|detector)|flames?|(a|on) fire|(caught|catch(es|ing)?) (on )?fire|fire (is )?(coming|inside|out of)|smoke|smoky|smoking|burning|sparks?|sparking)\b/i
const SAFETY_LINE =
  'If you smell gas or a carbon monoxide alarm is going off, get everyone outside now and call 911 or PG&E at 1-800-743-5000. If you see flames or heavy smoke, get everyone out and call 911. For a burning smell or sparks, turn the system off at the thermostat and the breaker. '

/**
 * The customer-facing lines around getting John. Written here, not by the model, so they
 * are always true: the bot only says John's phone rang when Telegram took the ring, and
 * only says he is not available when it rang and he did not pick up (or he sent /away).
 */
function johnLine(why: Why | null, outcome: Outcome, night: boolean): string {
  const lead =
    why === 'safe'
      ? "I can't answer that one here. "
      : why === 'error'
        ? 'Sorry, the AI assistant is having trouble right now. '
        : why === 'limit'
          ? "I can't answer any more in this chat right now. "
          : ''
  const details = "Leave your name, phone number, and what's going on, and he'll get back to you as soon as he can."
  const middle = {
    ringing: "I just sent this chat to John's phone. If he's available he'll answer right here.",
    pending: "John's phone already has this chat. If he's available he'll answer right here.",
    unavailable: `${night ? "It's after hours and John is probably asleep, so he isn't" : "John isn't"} available right now. ${details}`,
    enough: 'John already has this chat and will see everything here.',
    unreached: `I couldn't reach John's phone just now. ${details}`,
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
   * he is in the conversation (he replied in the last 15 minutes, or sent /me), or when
   * the customer needs him and the bot cannot help (see getJohn).
   */
  async fromCustomer(text: string): Promise<{ ok: boolean; error?: string }> {
    // Ask Control first. After this only storage work runs until the message and its
    // handoff are saved together, so a failed call stores nothing and nothing slips in.
    const status = await this.control().status(num(this.env.BOT_DAILY_BUDGET, 300))
    const { meta, msgs } = await this.load()
    if (!meta) return { ok: false, error: UNKNOWN_CHAT }
    if (msgs.filter((m) => m.from === 'customer').length >= MAX_CUSTOMER_MESSAGES) {
      return { ok: false, error: CHAT_FULL_MESSAGE }
    }

    const now = Date.now()
    const all: ChatMessage[] = [...msgs, { n: msgs.length + 1, from: 'customer', text, ts: now }]
    // /away means John is not around, so even a chat he took over with /me goes back to the bot.
    const botOff = meta.botOff && !status.away
    const capped = meta.botReplies >= MAX_BOT_REPLIES
    const canBot = !botOff && !capped && !status.botSpent
    const live = !status.away && (botOff || now - meta.johnLastAt < ENGAGED_WINDOW_MS)
    const delay = !canBot ? null : live ? num(this.env.ENGAGED_HANDOFF_SECONDS, 300) : num(this.env.BOT_REPLY_SECONDS, 2)
    // Commit the message and the handoff before talking to Telegram. If Telegram is
    // down the customer still gets the bot, which is the whole point of the bot.
    const saved: RoomMeta = { ...meta, lastActivityAt: now, handoffAt: delay === null ? null : now + delay * 1000, handoffTries: 0 }
    await this.saveMeta(saved, all)

    if (!live && canBot) return { ok: true }

    if (!live && !botOff) {
      // The bot is out of answers here (chat cap or daily budget) and John is not in the
      // chat. Treat it like a transfer: the customer hears what happened, John's phone rings
      // within the usual limits, never under /away. Once told, follow-ups reach John quietly,
      // except an emergency, which always gets the safety steps and another try for John.
      const told = typeof meta.transferUntil === 'number' || (meta.limitToldAt ?? 0) > meta.johnLastAt
      if (!told || DANGER.test(text)) {
        try {
          await this.getJohn(saved, all, 'limit', '', status.away)
        } catch (error) {
          // The message is already saved; a retry from the widget would store it twice.
          console.error('getJohn failed after the message was saved', error instanceof Error ? error.message : String(error))
        }
        return { ok: true }
      }
      await sendToJohn(
        this.env,
        withRef(`${header(meta, text)}: the bot is at its limit here, so this one is yours.\nCustomer: ${scrubRef(text)}${pageLine(meta)}\n\nReply to answer.`, meta.roomId),
        true,
      )
      return { ok: true }
    }

    const footer = botOff
      ? 'Bot is off for this chat. Reply to answer.'
      : capped
        ? 'The bot has reached its limit for this chat. Reply to answer.'
        : status.botSpent
          ? 'The bot has used its daily budget, so it will not answer. Reply to answer.'
          : `Bot answers in ${delay}s unless you reply first. Swipe to reply.`
    await sendToJohn(
      this.env,
      withRef(`${header(meta, text)} (you are in this chat)\nCustomer: ${scrubRef(text)}${pageLine(meta)}\n\n${footer}`, meta.roomId),
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
        // Loud, because the customer is waiting and nobody has answered. Quiet under /away.
        if (lastSpeaker(msgs) === 'customer') {
          // A /me chat only gets a bot handoff under /away, so that note is quiet too.
          const quiet =
            meta.botOff ||
            (await this.control()
              .isAway()
              .catch(() => false))
          await sendToJohn(
            this.env,
            withRef(`${header(meta)}: the bot could not answer after several tries, so the customer has no reply yet.\n\n${transcript(msgs)}\n\nReply to answer them.`, meta.roomId),
            quiet,
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

    // Away mode hands even /me chats back to the bot.
    const away = await this.control().isAway()
    if ((meta.botOff && !away) || meta.botReplies >= MAX_BOT_REPLIES || lastSpeaker(msgs) !== 'customer') return consume()
    if (!(await this.control().takeBotCall(num(this.env.BOT_DAILY_BUDGET, 300)))) {
      console.error('Daily bot budget reached, handing the chat to John')
      const latest = await this.load()
      if (latest.meta && latest.meta.handoffAt === due && lastSpeaker(latest.msgs) === 'customer') {
        return this.getJohn(latest.meta, latest.msgs, 'limit', '', away)
      }
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

    // John may have sent /away or /back while Claude was thinking. Ask before the final read,
    // because the call lets other requests run, and the read must reflect them.
    const awayNow = await this.control()
      .isAway()
      .catch(() => away)
    const latest = await this.load()
    if (!latest.meta || latest.meta.handoffAt !== due) return
    if (
      !result ||
      (latest.meta.botOff && !awayNow) ||
      lastSpeaker(latest.msgs) !== 'customer' ||
      // Something new from the customer or John means this answer is stale. A system line does not.
      latest.msgs.slice(answeredUpTo).some((m) => !m.sys)
    ) {
      return consume()
    }

    // The bot only claimed it reached John. If his phone really rang earlier in this chat, the
    // claim is a recap and goes out as an answer. Otherwise getJohn makes it true.
    const rangBefore = (latest.meta.transfers ?? 0) > 0 || !!latest.meta.unavailableAt || typeof latest.meta.transferUntil === 'number'
    const answer = result.kind === 'ok' ? result.text : result.kind === 'transfer' && result.claimed && rangBefore ? result.claimed : null
    if (answer === null) {
      const why = result.kind === 'transfer' ? 'asked' : result.kind === 'ok' ? 'asked' : result.kind
      return this.getJohn(latest.meta, latest.msgs, why, result.kind === 'transfer' ? result.reason : '', awayNow)
    }

    // Only real answers count toward the per-chat cap. Canned lines do not.
    const botReplies = latest.meta.botReplies + 1
    const text = botReplies >= MAX_BOT_REPLIES ? answer + CAP_NOTE : answer
    const asked = waitingCustomer(latest.msgs)
    const firstQuestion =
      latest.meta.botReplies === 0 && latest.meta.johnLastAt === 0 && !latest.meta.transfers && !latest.meta.unavailableAt
    const now = Date.now()
    await this.saveMeta({ ...latest.meta, botReplies, handoffAt: null, handoffTries: 0 }, [
      ...latest.msgs,
      { n: latest.msgs.length + 1, from: 'bot', text, ts: now },
    ])
    // Silent unless John asked to hear about every new customer, is not away, and the hour's cap allows.
    const ring =
      firstQuestion &&
      this.env.RING_ON_FIRST_QUESTION === 'true' &&
      !awayNow &&
      (await this.control()
        .takeFirstRing(num(this.env.RINGS_PER_HOUR, 6))
        .catch(() => false))
    const head = `${header(latest.meta, asked.join(' '))}${pageLine(latest.meta)}\n`
    const tail = `\nBot: ${text.slice(0, 2000)}\n\nReply to jump in, or reply /me to turn the bot off for this chat.`
    // Keep the newest customer text. The bot's answer and the footer must always survive Telegram's length limit.
    let quoted = asked.map((t) => `Customer: ${scrubRef(t)}`).join('\n')
    const room = COPY_BUDGET - head.length - tail.length
    if (quoted.length > room) quoted = `...${quoted.slice(-(room - 3))}`
    await sendToJohn(this.env, withRef(head + quoted + tail, latest.meta.roomId), !ring)
  }

  /**
   * Gets John for the customer: rings his phone once and gives him TRANSFER_WAIT_SECONDS
   * to reply in the chat. If he does not, transferTimedOut tells the customer he is not
   * available. /away skips the ring and says so right away. Used when the customer asks
   * for John, when the bot could not answer and when it is out of answers, so nobody is
   * ever left talking to a wall. The ring goes out before anything is saved, so the
   * customer is only told it rang when Telegram took it, and the commit uses a fresh read.
   */
  private async getJohn(meta: RoomMeta, msgs: ChatMessage[], why: Why, reason: string, away: boolean): Promise<void> {
    const transfers = meta.transfers ?? 0
    let outcome: Outcome =
      typeof meta.transferUntil === 'number' ? 'pending' : away ? 'unavailable' : transfers >= MAX_TRANSFERS ? 'enough' : 'ringing'
    const what = {
      asked: 'the customer wants to talk to you',
      safe: 'the bot could not answer this one',
      error: 'the bot is having trouble (Claude error)',
      limit: 'the bot is at its limit (chat cap or daily budget) and cannot answer',
    }[why]
    const needs = reason ? `\nNeeds: ${scrubRef(reason)}` : ''
    const recent = `${pageLine(meta)}\n\n${transcript(msgs)}`
    const danger = DANGER.test(waitingCustomer(msgs).join(' '))
    const ringCap = num(this.env.RINGS_PER_HOUR, 6)

    let capHit = false
    if (outcome === 'ringing') {
      // A Control failure fails closed: no ring, and the customer gets the honest line.
      const slot = await this.control()
        .takeRing(ringCap)
        .catch((error) => {
          console.error('takeRing failed', error instanceof Error ? error.message : String(error))
          return undefined
        })
      if (slot === null) {
        capHit = true
        outcome = 'unreached'
      } else if (slot === undefined) {
        outcome = 'unreached'
      } else {
        const rang = await sendToJohn(
          this.env,
          withRef(
            `${what.toUpperCase()} (chat ${chatTag(meta.roomId)})${needs}${recent}\n\nReply to this message to talk to them here. If you do not reply within ${waitText(this.env)}, the bot tells them you are not available.`,
            meta.roomId,
          ),
        )
        if (!rang) {
          outcome = 'unreached'
          // The phone did not ring, so it does not count against the hour.
          await this.control()
            .refundRing(slot)
            .catch(() => undefined)
        }
      }
    }

    // The ring went out over the network, so the chat may have moved on. Commit against what is stored now.
    const cur = await this.load()
    if (!cur.meta) return
    const now = Date.now()
    const rang = outcome === 'ringing'
    const johnStepped = cur.meta.johnLastAt !== meta.johnLastAt || (cur.meta.botOff && !meta.botOff)
    const ours = cur.meta.handoffAt === meta.handoffAt
    const next: RoomMeta = {
      ...cur.meta,
      handoffAt: ours ? null : cur.meta.handoffAt,
      handoffTries: ours ? 0 : cur.meta.handoffTries,
      transfers: rang ? (cur.meta.transfers ?? 0) + 1 : cur.meta.transfers,
      transferUntil: rang && !johnStepped ? now + num(this.env.TRANSFER_WAIT_SECONDS, 180) * 1000 : (cur.meta.transferUntil ?? null),
      unavailableAt: outcome === 'unavailable' || outcome === 'unreached' ? now : cur.meta.unavailableAt,
    }
    // If John already answered while his phone was ringing, his reply speaks for itself.
    const line = (danger || DANGER.test(waitingCustomer(cur.msgs).join(' ')) ? SAFETY_LINE : '') + johnLine(why, outcome, inQuietHours(this.env))
    const post = !(rang && johnStepped)
    if (post && why === 'limit') next.limitToldAt = now
    // The customer wrote again while the ring went out. Their new message still needs an
    // answer, so this line is a system line the bot looks past, not the bot's turn.
    const late = cur.msgs.slice(msgs.length).some((m) => m.from === 'customer' && !m.sys)
    await this.saveMeta(
      next,
      post ? [...cur.msgs, { n: cur.msgs.length + 1, from: 'bot', text: line, ts: now, canned: true, ...(late ? { sys: true } : {}) }] : undefined,
    )

    if (rang) return
    if (outcome === 'unreached' && !capHit) {
      // Telegram refused the ring, so a note to John would most likely fail too.
      console.error('Ring to John failed, the customer was asked to leave details')
      return
    }
    const told = {
      unavailable: 'Away mode is on, so the bot told them you are not available.',
      pending: 'Your phone already rang for this chat.',
      enough: 'This chat already rang your phone the most times allowed, so it did not ring again.',
      unreached: `Your phone already rang ${ringCap} times this hour, the most allowed, so this did not ring. The customer was asked to leave their details.`,
      ringing: '',
    }[outcome]
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
      lines.push(
        'John was not available earlier in this chat. Collect their details for him. Do not repeat why he is unavailable or guess when he will reply. If they still want John, you may try transfer_to_john once more.',
      )
    }
    if (meta.johnLastAt && now - meta.johnLastAt < ENGAGED_WINDOW_MS) {
      lines.push('John replied in this chat in the last 15 minutes but has not answered the latest message.')
    }
    return lines.join(' ')
  }
}

/** Room left for a silent copy's text before withRef's own cut. */
const COPY_BUDGET = 3900

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text)

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
      return `${who}: ${clip(scrubRef(m.text), 500)}`
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
    return this.take('bot', budget, localDay(this.env))
  }

  /** Counts one new chat against today's budget. False means the budget is spent. */
  takeNewRoom(budget: number): Promise<boolean> {
    return this.take('rooms', budget, localDay(this.env))
  }

  /**
   * Counts one ring of John's phone against this hour's cap, across all chats. Returns the hour
   * it was counted in (for a refund if Telegram refuses the ring), or null when the cap is hit.
   */
  async takeRing(limit: number): Promise<string | null> {
    const period = localHour(this.env)
    return (await this.take('ring', limit, period)) ? period : null
  }

  /** Gives back a ring Telegram did not deliver. Only within the hour it was counted in. */
  async refundRing(period: string): Promise<void> {
    const cur = await this.ctx.storage.get<{ day: string; count: number }>('count:ring')
    if (cur?.day === period && cur.count > 0) await this.ctx.storage.put('count:ring', { day: period, count: cur.count - 1 })
  }

  /** First-question rings have their own hourly count, so they can never use up the rings customers ask for. */
  takeFirstRing(limit: number): Promise<boolean> {
    return this.take('ring-first', limit, localHour(this.env))
  }

  async usage(): Promise<{ day: string; bot: number; rooms: number; rings: number }> {
    const day = localDay(this.env)
    const [bot, rooms, rings] = await Promise.all([this.count('bot', day), this.count('rooms', day), this.count('ring', localHour(this.env))])
    return { day, bot, rooms, rings }
  }

  private async count(kind: string, period: string): Promise<number> {
    const cur = await this.ctx.storage.get<{ day: string; count: number }>(`count:${kind}`)
    return cur?.day === period ? cur.count : 0
  }

  private async take(kind: string, budget: number, period: string): Promise<boolean> {
    if (budget <= 0) return true
    const count = await this.count(kind, period)
    if (count >= budget) return false
    await this.ctx.storage.put(`count:${kind}`, { day: period, count: count + 1 })
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

/** This hour in John's time zone, as YYYY-MM-DDTHH, for hourly caps. */
export function localHour(env: Env, now = new Date()): string {
  return `${localDay(env, now)}T${String(hourIn(env, now)).padStart(2, '0')}`
}

function hourIn(env: Env, now: Date): number {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: timeZone(env) }).format(now))
  } catch (error) {
    console.error('Bad TIMEZONE, using America/Los_Angeles', error instanceof Error ? error.message : String(error))
    return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Los_Angeles' }).format(now))
  }
}

/** QUIET_HOURS is "start-end" in 24h local time, e.g. "21-7". */
export function inQuietHours(env: Env, now = new Date()): boolean {
  const match = env.QUIET_HOURS?.match(/^(\d{1,2})-(\d{1,2})$/)
  if (!match) return false
  const start = Number(match[1])
  const end = Number(match[2])
  const hour = hourIn(env, now)
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end
}
