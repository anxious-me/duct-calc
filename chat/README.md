# air.systems website chat

A chat bubble for the bottom right corner of air.systems, on desktop and mobile.
Customers type, John gets the message on his phone in Telegram and replies from
there. If John doesn't answer within 90 seconds, a Claude AI assistant answers
and copies John on what it said. The assistant is always labeled as an AI bot on
the site and never speaks as John. It answers HVAC questions and uses the
knowledge base in `src/knowledge.md` for business facts. John's own replies are
labeled "John (live reply)".

## How it works

```
 website bubble  ──►  Cloudflare Worker  ──►  Telegram on John's phone
 (widget.js)     ◄──  (one Durable Object     ◄──  John swipes to reply
                       per conversation)
                           │
                           └── no reply from John in time? Claude answers
```

Timing rules (all in `wrangler.toml`), checked in this order:

| Situation | Bot waits |
|---|---|
| John sent `/away` | 20 seconds, everywhere |
| John replied in that chat in the last 15 min | 5 minutes, even during quiet hours |
| Quiet hours (9pm to 7am Pacific) | 20 seconds |
| Otherwise | 90 seconds |
| John replied `/me` to that chat | Never, bot is off for that chat |

The bot is labeled "AI assistant (bot)" everywhere. It never pretends to be John,
never says John is busy or asleep, and tells anyone who needs service right away
to call 408-691-5940. Its replies are cleaned before the customer sees them (no
markdown, no dashes, clipped at about 1,200 characters) and anything that trips
the compliance filter in `src/bot.ts` is replaced with a safe line.

## Telegram commands (John's phone)

- Swipe left on a customer message and type: sends your reply to that customer
- Reply `/me` to a chat: bot stays quiet in that chat
- Reply `/bot` to a chat: bot can help again in that chat
- `/away`: bot answers right away everywhere
- `/back`: bot waits for you again
- `/status`: current mode and today's usage against the daily caps
- `/help`: the rundown

Anything else that starts with `/` is treated as a typo and never reaches the
customer.

## One-time setup (about 20 minutes)

You need three free-ish accounts: Cloudflare (free plan works), Telegram (free),
and an Anthropic API key (pay per use, pennies per chat).

1. Telegram bot
   - In Telegram, message `@BotFather`, send `/newbot`, name it something like
     "SVC Website Chat". Copy the bot token it gives you.
   - Open your new bot and tap Start. Leave this chat open, it becomes your inbox.
   - In the bot's chat settings, set a loud custom notification sound so it
     wakes you up.

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
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any long random string
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
   - Optional: `npx wrangler secret delete SETUP_KEY` turns the `/setup` URL off
     now that the webhook is registered.

5. Test it
   - Open `https://svc-chat.YOURNAME.workers.dev/demo`, click the bubble, send
     a message. It should hit your phone within a second or two.

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
                # walks through the chat, the bot handoff, and John's replies
```

## Costs

- Cloudflare Workers and Durable Objects: free plan covers a small business
  site's chat traffic.
- Telegram: free.
- Claude: billed per message. The bot only runs when John doesn't answer in
  time, and the knowledge base is cached between messages to keep it cheap.
  `BOT_MODEL` in `wrangler.toml` picks the model.

## Limits built in

- 1,000 characters per message, 60 customer messages and 25 bot replies per
  chat. When the bot hits its limit it says so once and leaves the chat to John.
- Per connection: 3 new chats and 12 messages per minute (Cloudflare rate
  limiting, best effort per location).
- Per day, in Pacific time: 200 new chats and 300 bot replies
  (`NEW_CHATS_DAILY_BUDGET` and `BOT_DAILY_BUDGET`). Past the bot cap, customers
  still reach John; the bot just stays quiet. `/status` shows today's numbers.
- Chats are deleted 30 days after their last message (`RETENTION_DAYS`, `0` keeps
  them forever). The widget starts a fresh chat after 14 quiet days, and the
  customer can start one any time with the plus button in the chat header.
- `ALLOWED_ORIGINS` controls which websites' browsers may embed the chat. It is
  not a security boundary on its own: the worker's own demo page is always
  allowed and non-browser clients can send any Origin. The rate limits and
  daily caps above are what bound abuse.
