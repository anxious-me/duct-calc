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

export async function telegramSend(env: Env, chatId: string, text: string, silent = false): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4000),
      disable_notification: silent,
      link_preview_options: { is_disabled: true },
    }),
  })
  if (!res.ok) console.error('Telegram send failed', res.status, await res.text())
}

export const sendToJohn = (env: Env, text: string, silent = false) =>
  telegramSend(env, env.TELEGRAM_CHAT_ID, text, silent)

// Every chat notification ends with this line so John's replies can be routed back.
export const refLine = (roomId: string) => `ref: ${roomId}`

export function roomIdFromReply(msg: TelegramMessage): string | null {
  const match = msg.reply_to_message?.text?.match(/ref: ([a-f0-9]{32})/)
  return match ? match[1] : null
}

const URGENT = /\b(gas|carbon monoxide|co alarm|co detector|smoke|burning|fire|spark|sparking|flood|flooding|leak|leaking|no heat|emergency)\b/i

export const looksUrgent = (text: string) => URGENT.test(text)
