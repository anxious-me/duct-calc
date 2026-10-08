import type { Env } from './types'

export interface TelegramMessage {
  message_id: number
  chat: { id: number }
  text?: string
  /** Text sent with a photo or file. */
  caption?: string
  reply_to_message?: { message_id: number; text?: string }
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
}

const MAX_LEN = 4000

/**
 * Sends a plain text message to a Telegram chat. Never throws: a Telegram hiccup must not
 * break the website chat. Returns whether Telegram accepted it, so a ring that never
 * reached John's phone is never reported to the customer as rung. A short 429 is retried once.
 */
export async function telegramSend(env: Env, chatId: string, text: string, silent = false): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return false
  const base = env.TELEGRAM_API_BASE || 'https://api.telegram.org'
  const body = JSON.stringify({
    chat_id: chatId,
    text: text.slice(0, MAX_LEN),
    disable_notification: silent,
    link_preview_options: { is_disabled: true },
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      if (res.ok) return true
      const detail = (await res.text()).slice(0, 300)
      console.error('Telegram send failed', res.status, detail)
      if (res.status !== 429 || attempt > 0) return false
      // Telegram says how long to back off. Only wait when it is short: a long sleep would hold the chat.
      let wait = 0
      try {
        wait = Number((JSON.parse(detail) as { parameters?: { retry_after?: number } }).parameters?.retry_after) || 0
      } catch {
        wait = 0
      }
      if (wait <= 0 || wait > 5) return false
      await new Promise((resolve) => setTimeout(resolve, wait * 1000))
    } catch (error) {
      console.error('Telegram send failed', error instanceof Error ? error.message : String(error))
      return false
    }
  }
  return false
}

export const sendToJohn = (env: Env, text: string, silent = false) =>
  telegramSend(env, env.TELEGRAM_CHAT_ID ?? '', text, silent)

/** A short label so John can tell chats apart at a glance. */
export const chatTag = (roomId: string) => roomId.slice(0, 4)

// Every chat notification ends with this line so John's replies can be routed back.
export const refLine = (roomId: string) => `ref: ${roomId}`

/** Appends the ref line, trimming the body first so the ref line always survives Telegram's length limit. */
export function withRef(body: string, roomId: string): string {
  const tail = `\n${refLine(roomId)}`
  return body.slice(0, MAX_LEN - tail.length) + tail
}

/** Customer text is quoted inside notifications; hide anything in it that looks like a ref line. */
export const scrubRef = (text: string) => text.replace(/ref:\s*[a-f0-9]{32}/gi, '[ref removed]')

/** Only the final line of the quoted notification counts, so nothing a customer types can redirect a reply. */
export function roomIdFromReply(msg: TelegramMessage): string | null {
  const match = msg.reply_to_message?.text?.match(/(?:^|\n)ref: ([a-f0-9]{32})\s*$/)
  return match ? match[1] : null
}

const URGENT =
  /\b(gas|carbon monoxide|co alarm|co detector|smoke|burning|fire|spark|sparking|flood|flooding|leak|leaking|no heat|not heating|no cooling|not cooling|no ac|no air|not blowing|not working|stopped working|won'?t turn on|won'?t start|emergency)\b/i

export const looksUrgent = (text: string) => URGENT.test(text)
