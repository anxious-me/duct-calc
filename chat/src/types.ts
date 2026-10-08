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
  BOT_REPLY_SECONDS?: string
  TRANSFER_WAIT_SECONDS?: string
  ENGAGED_HANDOFF_SECONDS?: string
  RING_ON_FIRST_QUESTION?: string
  RINGS_PER_HOUR?: string
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
  /** A line the system posts on its own (John is not available), not an answer to anything. The bot looks past it. */
  sys?: boolean
  /** A bot line written by the worker, not the model (John's phone was rung). The model sees it as a system notice, never as its own words. */
  canned?: boolean
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
  /** Failed attempts at the current handoff, so a crash mid-reply is retried a bounded number of times. */
  handoffTries?: number
  /** While John's phone is ringing for this chat: when the bot gives up on him and says he is not available. */
  transferUntil?: number | null
  /** How many times this chat has actually rung John's phone. Bounded so one chat cannot ring it all night. */
  transfers?: number
  /** Set once the bot has told the customer John is not available. */
  unavailableAt?: number
}
