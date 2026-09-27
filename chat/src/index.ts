import widgetSource from './widget.client.js'
import demoPage from './demo.html'
import { inQuietHours } from './room'
import { roomIdFromReply, telegramSend, type TelegramUpdate } from './telegram'
import type { Env } from './types'

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

    if (path === '/telegram' && request.method === 'POST') {
      if (request.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 })
      }
      const update = (await request.json()) as TelegramUpdate
      ctx.waitUntil(handleTelegram(env, update).catch((e) => console.error('telegram handler', e)))
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
  const cors: Record<string, string> = allowed
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

  const parts = url.pathname.split('/').filter(Boolean) // ['api', 'chats', id?, 'messages'?]
  if (parts[1] !== 'chats') return json({ error: 'not found' }, 404)

  // POST /api/chats  -> start a conversation
  if (parts.length === 2 && request.method === 'POST') {
    const body = await readJson(request)
    const page = typeof body.page === 'string' ? body.page.slice(0, 300) : ''
    const id = randomId()
    await roomStub(env, id).init(id, page)
    return json({ id, status: await statusFor(env) })
  }

  const id = parts[2]
  if (!id || !ROOM_ID.test(id)) return json({ error: 'not found' }, 404)
  const room = roomStub(env, id)
  if (!(await room.exists())) return json({ error: 'not found' }, 404)

  // GET /api/chats/:id?after=n  -> poll for new messages
  if (parts.length === 3 && request.method === 'GET') {
    const after = Number(url.searchParams.get('after')) || 0
    return json(await room.messages(after))
  }

  // POST /api/chats/:id/messages  -> customer sends a message
  if (parts.length === 4 && parts[3] === 'messages' && request.method === 'POST') {
    const body = await readJson(request)
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : ''
    if (!text) return json({ error: 'empty message' }, 400)
    const result = await room.fromCustomer(text)
    return json(result, result.ok ? 200 : 429)
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

async function statusFor(env: Env): Promise<'online' | 'away'> {
  const away = await env.CONTROL.get(env.CONTROL.idFromName('control')).isAway()
  return away || inQuietHours(env) ? 'away' : 'online'
}

// ---------- Telegram (John's side) ----------

const HELP = `How this works:
Every website chat message lands here. Swipe left on it (or long press and tap Reply) and type your answer. It shows up on the website as you.

If you don't reply in time, the bot answers for you and copies you here.

Reply to a chat with:
/me  bot stays quiet in that chat, it's all you
/bot  let the bot help again in that chat

Send anytime:
/away  bot answers right away everywhere (sleeping, on a roof, etc.)
/back  bot waits for you again
/status  see current mode`

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

  const control = env.CONTROL.get(env.CONTROL.idFromName('control'))
  const reply = (t: string) => telegramSend(env, chatId, t)
  const command = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '')

  if (command === '/away') {
    await control.setAway(true)
    return reply('Away mode on. The bot answers website chats right away. You still get every message here. Send /back when you are up.')
  }
  if (command === '/back') {
    await control.setAway(false)
    return reply(`Back. The bot waits ${env.HANDOFF_SECONDS || 90}s for you before answering.`)
  }
  if (command === '/status') {
    const away = await control.isAway()
    const quiet = inQuietHours(env)
    return reply(
      away
        ? 'Away mode is on. Bot answers right away.'
        : quiet
          ? `Quiet hours (${env.QUIET_HOURS}). Bot answers after ${env.AWAY_HANDOFF_SECONDS || 20}s.`
          : `You are on. Bot waits ${env.HANDOFF_SECONDS || 90}s before answering.`,
    )
  }
  if (command === '/start' || command === '/help') return reply(HELP)

  const roomId = roomIdFromReply(msg)
  if (!roomId) {
    return reply('Swipe left on a customer message and reply to that, so I know which chat it goes to. Send /help for the rundown.')
  }
  const room = roomStub(env, roomId)

  if (command === '/me' || command === '/bot') {
    const botOff = command === '/me'
    const ok = await room.setBotOff(botOff)
    return reply(ok ? (botOff ? 'Bot is off for that chat. All you.' : 'Bot is back on for that chat.') : 'That chat no longer exists.')
  }

  const ok = await room.fromJohn(text.slice(0, MAX_TEXT))
  if (!ok) await reply('That chat no longer exists.')
}

/** One-time: point Telegram at this worker. Visit /setup?key=YOUR_SETUP_KEY */
async function setup(env: Env, url: URL): Promise<Response> {
  if (!env.SETUP_KEY || url.searchParams.get('key') !== env.SETUP_KEY) return new Response('forbidden', { status: 403 })
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
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

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
