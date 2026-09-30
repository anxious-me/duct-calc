import type { Env } from './types'

export interface TelegramMessage {
  message_id: number
  chat: { id: number }
  text?: string
  reply_to_message?: { message_id: number; text?: string }
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

const MAX_LEN = 4000

/** Sends a plain text message to a Telegram chat. Never throws: a Telegram hiccup must not break the website chat. */
export async function telegramSend(env: Env, chatId: string, text: string, silent = false): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return
  const base = env.TELEGRAM_API_BASE || 'https://api.telegram.org'
  try {
    const res = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, MAX_LEN),
        disable_notification: silent,
        link_preview_options: { is_disabled: true },
      }),
    })
    if (!res.ok) console.error('Telegram send failed', res.status, (await res.text()).slice(0, 200))
  } catch (error) {
    console.error('Telegram send failed', error instanceof Error ? error.message : String(error))
  }
}

export const sendToJohn = (env: Env, text: string, silent = false) =>
  telegramSend(env, env.TELEGRAM_CHAT_ID ?? '', text, silent)

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
