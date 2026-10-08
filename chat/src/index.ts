import widgetSource from './widget.client.js'
import demoPage from './demo.html'
import { num, UNKNOWN_CHAT, waitText, type BotSwitch } from './room'
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
    .map((o) => o.trim().replace(/\/+$/, ''))
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

function help(env: Env): string {
  return `How this works:
The AI assistant answers website chats right away. You get a silent copy of every answer here, so your phone stays quiet.

Your phone rings when:
• a customer asks to talk to you (reply within ${waitText(env)}, or the bot tells them you are not available)
• the bot cannot answer something
• a customer writes in a chat you are in (you replied in the last 15 minutes)

To answer, swipe left on any chat message (or long press and tap Reply) and type. It shows on the website as "John (live reply)". Only text goes through, and editing a sent reply does not change the website.

Reply to a chat with:
/me  bot stays quiet in that chat, it's all you
/bot  let the bot help again in that chat

Send anytime:
/away  you are unavailable: customers who ask for you are told so right away, and nothing rings
/back  customers who ask for you ring your phone again
/status  current mode and today's usage`
}

const SWITCH_REPLY: Record<BotSwitch, string> = {
  gone: 'That chat no longer exists.',
  off: 'Bot is off for that chat. All you.',
  on: 'Bot is back on for that chat.',
  capped: 'The bot has reached its limit for that chat, so it stays quiet. Reply to answer.',
}

async function handleTelegram(env: Env, update: TelegramUpdate): Promise<void> {
  if (update.edited_message) {
    if (env.TELEGRAM_CHAT_ID && String(update.edited_message.chat.id) === env.TELEGRAM_CHAT_ID) {
      await sendToJohn(env, 'Edits do not reach the website. Send a new reply instead.')
    }
    return
  }
  const msg = update.message
  if (!msg) return
  const chatId = String(msg.chat.id)
  const raw = msg.text ?? msg.caption
  if (!raw) {
    // A photo, voice note or sticker sent as a reply would otherwise vanish without a word.
    if (chatId === env.TELEGRAM_CHAT_ID && msg.reply_to_message) {
      await telegramSend(env, chatId, 'Only text goes through to the website chat. Photos, voice notes and stickers are not sent. Please type your answer.')
    }
    return
  }
  const text = raw.trim()
  const captionOnly = msg.text === undefined

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

  if (command === '/away') {
    await ctl.setAway(true)
    return reply('Away mode on. Customers who ask for you are told you are not available, and your phone will not ring for them. Send /back when you are around.')
  }
  if (command === '/back') {
    await ctl.setAway(false)
    return reply(`Back. Customers who ask for you ring your phone again, and you have ${waitText(env)} to answer.`)
  }
  if (command === '/status') {
    const [isAway, usage] = await Promise.all([ctl.isAway(), ctl.usage()])
    const mode = isAway
      ? 'Away mode is on. Customers who ask for you are told you are not available.'
      : `You are on. Customers who ask for you ring your phone, and you have ${waitText(env)} to answer before the bot tells them you are not available.`
    return reply(
      `${mode}\nToday: ${usage.rooms} new chats, ${usage.bot} bot replies (daily caps ${num(env.NEW_CHATS_DAILY_BUDGET, 200)} and ${num(env.BOT_DAILY_BUDGET, 300)}).`,
    )
  }
  if (command === '/start' || command === '/help') return reply(help(env))

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
  if (!ok) return reply('That chat no longer exists.')
  if (captionOnly) await reply('Sent your caption as text. The photo or file itself does not go to the website chat.')
}

/** One-time: point Telegram at this worker. Visit /setup?key=YOUR_SETUP_KEY */
async function setup(env: Env, url: URL): Promise<Response> {
  if (!env.SETUP_KEY || !safeEqual(url.searchParams.get('key') ?? '', env.SETUP_KEY)) {
    return new Response('forbidden', { status: 403 })
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Set the TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET secrets first.', { status: 500 })
  }
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response('TELEGRAM_WEBHOOK_SECRET may only use A-Z, a-z, 0-9, _ and -, up to 256 characters.', { status: 500 })
  }
  const base = env.TELEGRAM_API_BASE || 'https://api.telegram.org'
  const res = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: `${url.origin}/telegram`,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'edited_message'],
    }),
  })
  // The command menu is a nicety. It must never fail setup.
  try {
    await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(env.TELEGRAM_CHAT_ID ? { scope: { type: 'chat', chat_id: env.TELEGRAM_CHAT_ID } } : {}),
        commands: [
          { command: 'me', description: 'Reply to a chat: bot stays quiet there' },
          { command: 'bot', description: 'Reply to a chat: let the bot help again' },
          { command: 'away', description: 'You are unavailable, nothing rings' },
          { command: 'back', description: 'Customers who ask for you ring again' },
          { command: 'status', description: "Current mode and today's usage" },
          { command: 'help', description: 'How this works' },
        ],
      }),
    })
  } catch (error) {
    console.error('setMyCommands', error)
  }
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
