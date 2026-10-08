import widgetSource from './widget.client.js'
import demoPage from './demo.html'
import { inQuietHours, num, UNKNOWN_CHAT, type BotSwitch } from './room'
import { roomIdFromReply, sendToJohn, telegramSend, type TelegramUpdate } from './telegram'
import type { Env, RateLimiter } from './types'

export { Control, Room } from './room'

const MAX_TEXT = 1000
const ROOM_ID = /^[a-f0-9]{32}$/

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/widget.js' && request.method === 'GET') {
      return new Response(widgetSource.replaceAll('__CHAT_API__', url.origin), {
        headers: {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'public, max-age=300',
          'access-control-allow-origin': '*',
        },
      })
    }

    if (path === '/' || path === '/demo') {
      return new Response(demoPage, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (path === '/favicon.ico') return new Response(null, { status: 204 })

    if (path === '/telegram' && request.method === 'POST') {
      const given = request.headers.get('x-telegram-bot-api-secret-token') ?? ''
      if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(given, env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response('forbidden', { status: 403 })
      }
      // Always answer 200 quickly. Telegram retries anything else, which would replay John's message.
      const update = (await readJson(request)) as unknown as TelegramUpdate
      ctx.waitUntil(
        handleTelegram(env, update).catch(async (e) => {
          console.error('telegram handler', e)
          await sendToJohn(env, 'That did not go through. Please send it again.')
        }),
      )
      return new Response('ok')
    }

    if (path === '/setup' && request.method === 'GET') {
      return setup(env, url)
    }

    if (path.startsWith('/api/')) {
      return handleApi(request, env, url)
    }

    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>

// ---------- Website API ----------

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const origin = request.headers.get('origin') ?? ''
  // Browsers skip the Origin header on same-origin GETs (the demo page), and the chat id is the secret anyway.
  const allowed = allowedOrigin(env, origin, url.origin) || (!origin && request.method === 'GET')
  const cors: Record<string, string> =
    allowed && origin
      ? {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
          vary: 'origin',
        }
      : {}
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } })

  if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors })
  if (!allowed) return json({ error: 'origin not allowed' }, 403)

  try {
    return await routeApi(request, env, url, json)
  } catch (error) {
    console.error('api', error)
    return json({ error: 'Something went wrong. Please try again, or call 408-691-5940.' }, 500)
  }
}

async function routeApi(request: Request, env: Env, url: URL, json: (body: unknown, status?: number) => Response): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean) // ['api', 'chats', id?, 'messages'?]
  if (parts[1] !== 'chats') return json({ error: 'not found' }, 404)
  const ip = request.headers.get('cf-connecting-ip') || 'unknown'

  // POST /api/chats  -> start a conversation
  if (parts.length === 2 && request.method === 'POST') {
    if (await limited(env.CREATE_LIMIT, ip)) {
      return json({ error: 'Too many new chats from your connection. Please wait a minute, or call 408-691-5940.' }, 429)
    }
    if (!(await control(env).takeNewRoom(num(env.NEW_CHATS_DAILY_BUDGET, 200)))) {
      return json({ error: 'The chat is very busy right now. Please call or text 408-691-5940.' }, 429)
    }
    const body = await readJson(request)
    const page = typeof body.page === 'string' ? body.page.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300) : ''
    const id = randomId()
    await roomStub(env, id).init(id, page)
    return json({ id })
  }

  const id = parts[2]
  if (!id || !ROOM_ID.test(id)) return json({ error: 'not found' }, 404)
  const room = roomStub(env, id)
  if (!(await room.exists())) return json({ error: 'not found' }, 404)

  // GET /api/chats/:id?after=n  -> poll for new messages (never rate limited: an open widget polls every 3s)
  if (parts.length === 3 && request.method === 'GET') {
    const after = Number(url.searchParams.get('after')) || 0
    return json(await room.messages(after))
  }

  // POST /api/chats/:id/messages  -> customer sends a message
  if (parts.length === 4 && parts[3] === 'messages' && request.method === 'POST') {
    if (await limited(env.CHAT_LIMIT, ip)) {
      return json({ error: 'You are sending messages too quickly. Please wait a moment, or call 408-691-5940.' }, 429)
    }
    const body = await readJson(request)
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : ''
    if (!text) return json({ error: 'empty message' }, 400)
    const result = await room.fromCustomer(text)
    if (result.ok) return json(result)
    return json(result, result.error === UNKNOWN_CHAT ? 404 : 429)
  }

  return json({ error: 'not found' }, 404)
}

function allowedOrigin(env: Env, origin: string, self: string): boolean {
  if (!origin) return false
  if (origin === self) return true
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .includes(origin)
}

/** True when the caller has used up its allowance. Fails open if the binding is missing or broken. */
async function limited(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return false
  try {
    return !(await limiter.limit({ key })).success
  } catch (error) {
    console.error('rate limit', error)
    return false
  }
}

// ---------- Telegram (John's side) ----------

const HELP = `How this works:
Every website chat message lands here. Swipe left on it (or long press and tap Reply) and type your answer. It shows up on the website as "John (live reply)".

If you don't reply in time, the bot answers, clearly labeled as a bot, and copies you here.

Reply to a chat with:
/me  bot stays quiet in that chat, it's all you
/bot  let the bot help again in that chat

Send anytime:
/away  bot answers right away everywhere (sleeping, on a roof, etc.)
/back  bot waits for you again
/status  current mode and today's usage`

const SWITCH_REPLY: Record<BotSwitch, string> = {
  gone: 'That chat no longer exists.',
  off: 'Bot is off for that chat. All you.',
  on: 'Bot is back on for that chat.',
  capped: 'The bot has reached its limit for that chat, so it stays quiet. Reply to answer.',
}

async function handleTelegram(env: Env, update: TelegramUpdate): Promise<void> {
  const msg = update.message
  if (!msg?.text) return
  const text = msg.text.trim()
  const chatId = String(msg.chat.id)

  if (chatId !== env.TELEGRAM_CHAT_ID) {
    // Lets John grab his chat id during setup. Strangers get nothing useful.
    if (text.startsWith('/start') || text.startsWith('/id')) {
      await telegramSend(env, chatId, `Your Telegram chat id is ${chatId}. Put it in the TELEGRAM_CHAT_ID secret.`)
    }
    return
  }

  const ctl = control(env)
  const reply = (t: string) => telegramSend(env, chatId, t)
  const command = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '')
  const handoff = num(env.HANDOFF_SECONDS, 90)
  const engaged = num(env.ENGAGED_HANDOFF_SECONDS, 300)
  const away = num(env.AWAY_HANDOFF_SECONDS, 20)

  if (command === '/away') {
    await ctl.setAway(true)
    return reply('Away mode on. The bot answers website chats right away. You still get every message here. Send /back when you are up.')
  }
  if (command === '/back') {
    await ctl.setAway(false)
    return reply(`Back. The bot waits ${handoff}s for you before answering.`)
  }
  if (command === '/status') {
    const [isAway, usage] = await Promise.all([ctl.isAway(), ctl.usage()])
    const mode = isAway
      ? 'Away mode is on. The bot answers right away.'
      : inQuietHours(env)
        ? `Quiet hours (${env.QUIET_HOURS}). The bot answers after ${away}s, but waits ${engaged}s in any chat you replied to in the last 15 minutes.`
        : `You are on. The bot waits ${handoff}s, or ${engaged}s in any chat you replied to in the last 15 minutes.`
    return reply(
      `${mode}\nToday: ${usage.rooms} new chats, ${usage.bot} bot replies (daily caps ${num(env.NEW_CHATS_DAILY_BUDGET, 200)} and ${num(env.BOT_DAILY_BUDGET, 300)}).`,
    )
  }
  if (command === '/start' || command === '/help') return reply(HELP)

  const roomId = roomIdFromReply(msg)
  if (!roomId) {
    if (command === '/me' || command === '/bot') return reply(`Reply to a customer message with ${command} so I know which chat you mean.`)
    if (text.startsWith('/')) return reply('Unknown command. Send /help for the list.')
    return reply('Swipe left on a customer message and reply to that, so I know which chat it goes to. Send /help for the rundown.')
  }
  const room = roomStub(env, roomId)

  if (command === '/me' || command === '/bot') {
    const result = await room.setBotOff(command === '/me')
    return reply(SWITCH_REPLY[result])
  }
  // A typo like /mee must never reach the customer as a live reply.
  if (text.startsWith('/')) return reply('Unknown command. Send /help for the list.')

  const ok = await room.fromJohn(text.slice(0, MAX_TEXT))
  if (!ok) await reply('That chat no longer exists.')
}

/** One-time: point Telegram at this worker. Visit /setup?key=YOUR_SETUP_KEY */
async function setup(env: Env, url: URL): Promise<Response> {
  if (!env.SETUP_KEY || !safeEqual(url.searchParams.get('key') ?? '', env.SETUP_KEY)) {
    return new Response('forbidden', { status: 403 })
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Set the TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET secrets first.', { status: 500 })
  }
  const base = env.TELEGRAM_API_BASE || 'https://api.telegram.org'
  const res = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: `${url.origin}/telegram`,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message'],
    }),
  })
  return new Response(await res.text(), { headers: { 'content-type': 'application/json' } })
}

// ---------- helpers ----------

function roomStub(env: Env, id: string) {
  return env.ROOM.get(env.ROOM.idFromName(id))
}

function control(env: Env) {
  return env.CONTROL.get(env.CONTROL.idFromName('control'))
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time string compare for secrets. */
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y)
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
