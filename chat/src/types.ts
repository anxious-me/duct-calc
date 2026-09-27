import type { Control, Room } from './room'

export interface Env {
  ROOM: DurableObjectNamespace<Room>
  CONTROL: DurableObjectNamespace<Control>

  ANTHROPIC_API_KEY: string
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_CHAT_ID: string
  TELEGRAM_WEBHOOK_SECRET: string
  SETUP_KEY: string

  ALLOWED_ORIGINS: string
  BOT_MODEL: string
  HANDOFF_SECONDS: string
  ENGAGED_HANDOFF_SECONDS: string
  AWAY_HANDOFF_SECONDS: string
  QUIET_HOURS: string
  TIMEZONE: string
}

export type Sender = 'customer' | 'john' | 'bot'

export interface ChatMessage {
  n: number
  from: Sender
  text: string
  ts: number
}

export interface RoomMeta {
  roomId: string
  createdAt: number
  page: string
  johnLastAt: number
  botOff: boolean
  botReplies: number
}
