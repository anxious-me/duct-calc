# air.systems website chat

A chat bubble for the bottom right corner of air.systems, on desktop and mobile.
Customers type, John gets the message on his phone in Telegram and replies from
there. If John doesn't answer within 90 seconds, a Claude bot answers from the
knowledge base in `src/knowledge.md` and copies John on what it said. John can
jump back in any time and his reply goes straight to the customer.

## How it works

```
 website bubble  ──►  Cloudflare Worker  ──►  Telegram on John's phone
 (widget.js)     ◄──  (one Durable Object     ◄──  John swipes to reply
                       per conversation)
                           │
                           └── no reply from John in time? Claude answers
```

Timing rules (all in `wrangler.toml`):

| Situation | Bot waits |
|---|---|
| Normal hours | 90 seconds |
| John already replied in that chat in the last 15 min | 5 minutes |
| Quiet hours (9pm to 7am Pacific) or John sent `/away` | 20 seconds |
| John replied `/me` to that chat | Never, bot is off for that chat |

The bot always says it is John's assistant. It never pretends to be John.

## Telegram commands (John's phone)

- Swipe left on a customer message and type: sends your reply to that customer
- Reply `/me` to a chat: bot stays quiet in that chat
- Reply `/bot` to a chat: bot can help again in that chat
- `/away`: bot answers right away everywhere
- `/back`: bot waits for you again
- `/status`: shows the current mode
- `/help`: the rundown

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
     `data-hide-on="/contact"` hides the bubble on pages where it would cover
     the form.
   - Optional: point a subdomain like `chat.air.systems` at the worker in the
     Cloudflare dashboard (Workers, your worker, Settings, Domains and Routes).

## Updating what the bot knows

Edit `src/knowledge.md` and run `npm run deploy`. Plain English is fine. The
bot only answers from that file and hands everything else to John, so if you
want it to talk about warranties, financing, rebates, or brands you service,
add that info there.

## Costs

- Cloudflare Workers and Durable Objects: free plan covers a small business
  site's chat traffic.
- Telegram: free.
- Claude: billed per message. The bot only runs when John doesn't answer in
  time, and the knowledge base is cached between messages to keep it cheap.

## Limits built in

- 1,000 characters per message, 60 customer messages and 25 bot replies per
  chat, to keep spam and costs in check.
- Only air.systems and www.air.systems can use the chat API
  (`ALLOWED_ORIGINS` in `wrangler.toml`).
