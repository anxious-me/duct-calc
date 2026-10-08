# air.systems website chat

A chat bubble for the bottom right corner of air.systems, on desktop and mobile.
A Claude AI assistant answers customers right away, using the knowledge base in
`src/knowledge.md` for business facts. When a customer wants John, the assistant
asks, and on a yes it rings John's phone in Telegram. John answers from there and
his replies show up labeled "John (live reply)". If he does not reply in time,
the chat tells the customer he is not available and the assistant takes their
details. Visitors who just browse, or open the bubble without asking anything,
never ring anything.

## How it works

```
 website bubble  ──►  Cloudflare Worker  ──►  Claude answers right away
 (widget.js)     ◄──  (one Durable Object       │
                       per conversation)        └── customer wants John?
                           ▲                         ring Telegram on John's phone
                           └──────────────────────── John swipes to reply
```

When John's phone rings (everything else is a silent copy):

| Situation | What happens |
|---|---|
| Customer asks for John and says yes | Phone rings. John has 3 minutes to reply in the chat, then the bot says he is not available |
| The bot cannot answer (blocked reply, Claude down) | Phone rings, same 3 minutes |
| Daily bot budget spent, or the chat hit its bot limit | Phone rings once, same 3 minutes; later messages are silent copies |
| Customer writes in a chat John replied to in the last 15 min | Phone rings, bot answers after 5 minutes if John does not |
| John replied `/me` to that chat | Phone rings for every message, bot stays out (until `/away`) |
| John sent `/away` | Nothing rings. Customers who ask for him are told he is not available, and `/me` chats go back to the bot |
| Anyone else | Bot answers in about 2 seconds, John gets a silent copy |

Set `RING_ON_FIRST_QUESTION = "true"` in `wrangler.toml` to also ring for the
first question in every new chat. One chat can ring John at most 3 times, and all
chats together at most `RINGS_PER_HOUR` (6) times an hour for customers who ask for
him or that the bot cannot help (first-question rings have their own count with the
same cap, and a chat John is in always rings). If a ring is over the
cap or Telegram does not take it, the customer is told John could not be reached
and asked for their details; the chat never claims his phone rang when it did not.
If a customer who asks for John mentions gas, carbon monoxide, fire, smoke or
sparks, the safety steps go in front of the transfer line.

The bot is labeled "AI assistant (bot)" everywhere. It never pretends to be John
and never guesses what he is doing. The "not available" line is written by the
worker, not the model, and only appears after John's phone actually rang and he
did not pick up (after hours it says he is probably asleep). Bot replies are
cleaned before the customer sees them (no markdown, no em or en dashes, clipped at about
1,200 characters) and anything that trips the compliance filter in `src/bot.ts`
rings John instead.

## Telegram commands (John's phone)

- Swipe left on any chat message and type: sends your reply to that customer
  (text only; photo captions go through as text, edits to a sent reply do not)
- Reply `/me` to a chat: bot stays quiet in that chat, it is all you
- Reply `/bot` to a chat: bot can help again in that chat
- `/away`: you are unavailable, nothing rings, customers who ask are told so
- `/back`: customers who ask for you ring your phone again
- `/status`: current mode and today's usage against the daily caps
- `/help`: the rundown

Anything else that starts with `/` is treated as a typo and never reaches the
customer. `/setup` also installs these as the bot's command menu.

## One-time setup (about 20 minutes)

You need three free-ish accounts: Cloudflare (free plan works), Telegram (free),
and an Anthropic API key (pay per use, pennies per chat). You also need Node.js
22 or newer on your computer (the LTS from https://nodejs.org); check with
`node --version`.

1. Telegram bot
   - In Telegram, message `@BotFather`, send `/newbot`, name it something like
     "SVC Website Chat". Copy the bot token it gives you.
   - Open your new bot and tap Start. Leave this chat open, it becomes your inbox.
   - In the bot's chat settings, set a loud custom notification sound. It only
     plays when a customer actually wants you, so it is worth hearing.

2. Anthropic API key
   - Create one at https://platform.claude.com (Settings, API keys).
   - Set a monthly spend limit on that key in the Console (Settings, Limits).
     The worker has its own daily caps, but this is the backstop.

3. Deploy to Cloudflare
   ```bash
   cd chat
   npm install
   npx wrangler login
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # letters, digits, _ and - only, e.g. from: openssl rand -hex 32
   npx wrangler secret put SETUP_KEY                 # any other random string
   npx wrangler secret put TELEGRAM_CHAT_ID          # put 0 for now, fixed in step 4
   npm run deploy
   ```
   Wrangler prints the worker URL, like `https://svc-chat.YOURNAME.workers.dev`.

4. Connect Telegram
   - Visit `https://svc-chat.YOURNAME.workers.dev/setup?key=YOUR_SETUP_KEY`.
     You should see `"ok":true`.
   - Send `/id` to your bot in Telegram. It replies with your chat id.
   - `npx wrangler secret put TELEGRAM_CHAT_ID` and paste that number.
   - Send `/help` to the bot. If it answers with the rundown, you are wired up.
   - Visit the `/setup` URL once more so the command menu is installed for your
     chat (do this before deleting `SETUP_KEY`).
   - Optional: `npx wrangler secret delete SETUP_KEY` turns the `/setup` URL off
     now that the webhook is registered.
   - Upgrading from an earlier version of this chat? Visit the `/setup` URL once
     more after deploying (put `SETUP_KEY` back first if you deleted it) so
     Telegram also reports edited messages and the command menu is installed.

5. Test it
   - Open `https://svc-chat.YOURNAME.workers.dev/demo`, click the bubble, and ask
     an HVAC question. The bot answers in a few seconds and you get a silent copy
     in Telegram.
   - Now type "can I talk to John" and say yes when it offers. Your phone should
     ring. Reply to that message and your answer shows up in the chat.

6. Put it on air.systems
   - Add this one line to the site footer (in WordPress, use a header and
     footer scripts plugin like WPCode, or the theme's footer scripts box):
     ```html
     <script src="https://svc-chat.YOURNAME.workers.dev/widget.js" defer></script>
     ```
   - Optional: `data-color="#0f62fe"` changes the accent color, and
     `data-hide-on="/contact"` hides the bubble on that page and anything under
     it (it is a path prefix match, so `/contact` also covers `/contact/thanks`).
   - Optional: point a subdomain like `chat.air.systems` at the worker in the
     Cloudflare dashboard (Workers, your worker, Settings, Domains and Routes).
   - The `/demo` page stays reachable on the workers.dev URL. Remove that route
     from `src/index.ts` after launch if you would rather it did not.
   - If another chat widget or plugin is still on the site, remove it or turn off
     its visitor notifications. This chat never pings you for a visit, but
     another tool can, and your phone cannot tell the difference.

## Updating what the bot knows

Edit `src/knowledge.md` and run `npm run deploy`. Plain English is fine. The
bot answers general HVAC questions from its own expertise, but business facts
(services, rates, area, booking) come only from that file, and anything not in
it goes to John. If you want it to talk about warranties, financing, rebates,
hours, or brands you service, add that info there. Keep the file free of pound
signs, asterisks and em dashes; the bot copies the style it is shown.

## Checking it locally

```bash
npm run check   # typecheck plus a dry-run bundle
npm run smoke   # starts wrangler dev against mock Claude and Telegram servers and
                # walks through the bot, transfers to John, and his replies
```

## Costs

- Cloudflare Workers and Durable Objects: free plan covers a small business
  site's chat traffic.
- Telegram: free.
- Claude: billed per message. The bot answers every customer message unless
  John is in that chat, and the knowledge base is cached between messages to
  keep it cheap. `BOT_MODEL` in `wrangler.toml` picks the model. Each bot reply
  logs one line with the model and token counts to Workers Logs.

## Limits built in

- 1,000 characters per customer message (John's replies can be up to 4,096),
  60 customer messages and 25 bot replies per chat. When the bot hits its limit
  it says so once and hands the chat to John.
- Per IP address: 3 new chats and 12 messages per minute (Cloudflare rate
  limiting, best effort per location).
- Per day, in Pacific time: 200 new chats and 300 bot replies
  (`NEW_CHATS_DAILY_BUDGET` and `BOT_DAILY_BUDGET`, counting Claude calls). Past
  the bot cap, a customer's next message rings John once like a transfer.
- Per hour: 6 transfer rings of John's phone across all chats (`RINGS_PER_HOUR`,
  `0` turns the cap off). Chats John is in are not capped.
  `/status` shows today's numbers and this hour's rings.
- Chats are deleted 30 days after their last message (`RETENTION_DAYS`, `0` keeps
  them forever). The widget starts a fresh chat after 14 quiet days, and the
  customer can start one any time with the plus button in the chat header.
- `ALLOWED_ORIGINS` controls which websites' browsers may embed the chat. It is
  not a security boundary on its own: the worker's own demo page is always
  allowed and non-browser clients can send any Origin. The rate limits and
  daily caps above are what bound abuse.
