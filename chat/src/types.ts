import type { Control, Room } from './room'

/** Cloudflare rate limiting binding (wrangler.toml `[[unsafe.bindings]]` with `type = "ratelimit"`). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface Env {
  ROOM: DurableObjectNamespace<Room>
  CONTROL: DurableObjectNamespace<Control>
  CREATE_LIMIT?: RateLimiter
  CHAT_LIMIT?: RateLimiter

  // Secrets
  ANTHROPIC_API_KEY?: string
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_CHAT_ID?: string
  TELEGRAM_WEBHOOK_SECRET?: string
  SETUP_KEY?: string

  // Vars (see wrangler.toml)
  ALLOWED_ORIGINS?: string
  BOT_MODEL?: string
  HANDOFF_SECONDS?: string
  ENGAGED_HANDOFF_SECONDS?: string
  AWAY_HANDOFF_SECONDS?: string
  QUIET_HOURS?: string
  TIMEZONE?: string
  BOT_DAILY_BUDGET?: string
  NEW_CHATS_DAILY_BUDGET?: string
  RETENTION_DAYS?: string

  // Test hooks: point the bot and Telegram at mock servers during `npm run smoke`.
  ANTHROPIC_BASE_URL?: string
  TELEGRAM_API_BASE?: string
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
  /** Last customer or John activity. Missing on rooms created before retention existed. */
  lastActivityAt?: number
  /** When the bot should answer if John has not by then. Null when nothing is pending. */
  handoffAt?: number | null
}
