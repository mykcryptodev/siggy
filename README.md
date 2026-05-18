# Siggy — Safe Transparency Bot (@siggytheparrotbot)

A Telegram bot that monitors Gnosis Safe multisig wallets and posts human-readable transaction notifications to Telegram groups.

## Features

- 🔔 **Real-time notifications** for new pending transactions
- ✅ **Execution alerts** when transactions go on-chain
- ❌ **Cancellation notices** when transactions are rejected
- 🔍 **Human-readable decoding** — ERC-20 transfers, approvals, and unknown calldata via 4byte.directory
- 🚫 **No history spam** — watermarks existing transactions on add
- 🔐 **Admin-only management** — only group admins can add/remove Safes
- 🌐 **Multi-chain** — Ethereum, Base, Optimism, Arbitrum, Polygon, Gnosis

## Tech Stack

- **Runtime**: Node.js 22 + TypeScript 5
- **Telegram**: Grammy (webhook mode)
- **Database**: PostgreSQL via Drizzle ORM (Neon recommended)
- **Hosting**: Vercel (serverless functions + cron)
- **Blockchain**: viem

## Setup

### 1. Clone and install

```bash
git clone <repo>
cd safe-transparency-bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:
```
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
DATABASE_URL=postgresql://user:pass@host/db
WEBHOOK_SECRET=random_secret_string  # optional but recommended
CRON_SECRET=random_cron_secret       # optional, for /api/poll protection
NODE_ENV=production
```

### 3. Set up database

Using Neon (recommended for Vercel):

1. Create a project at [neon.tech](https://neon.tech)
2. Copy the connection string to `DATABASE_URL` in `.env`
3. Run migrations:

```bash
npm run db:generate
npm run db:migrate
```

### 4. Deploy to Vercel

```bash
npm install -g vercel
vercel
```

Set environment variables in Vercel dashboard or via CLI:
```bash
vercel env add TELEGRAM_BOT_TOKEN
vercel env add DATABASE_URL
vercel env add WEBHOOK_SECRET
vercel env add CRON_SECRET
```

### 5. Register webhook

After deployment, register the webhook with Telegram:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://your-project.vercel.app/api/telegram" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/addsafe <address> [chain] [label]` | Add a Safe to monitor |
| `/listsafes` | Show monitored Safes |
| `/removesafe <address>` | Remove a Safe |
| `/status` | Bot status and stats |
| `/help` | Command reference |

### Adding a Safe

```
/addsafe 0x1234...abcd
```
If no chain is specified, Siggy will ask you to select one via inline buttons.

With chain and optional label:
```
/addsafe 0x1234...abcd base Treasury
```

## Supported Chains

| Chain | Chain ID |
|-------|----------|
| Ethereum | 1 |
| Base | 8453 |
| Optimism | 10 |
| Arbitrum | 42161 |
| Polygon | 137 |
| Gnosis | 100 |

## Architecture

```
Vercel Cron (every 60s)
  → /api/poll
    → Fetch all monitored Safes from DB
    → For each Safe: GET /api/v1/safes/{address}/multisig-transactions/
    → Detect new/changed transactions
    → Decode calldata (ETH transfer → ERC-20 → 4byte.directory → fallback)
    → Send Telegram notifications
    → Record in notifications_sent (dedup)

Telegram Webhook
  → /api/telegram
    → Grammy handles commands
    → /addsafe: watermark existing txs, then monitor
```

## Database Schema

See `src/db/schema.ts` for the full Drizzle schema.

Key tables:
- `communities` — Telegram chats using the bot
- `monitored_safes` — (community, safe_address, chain_id) pairs
- `safe_transactions` — All known transactions with decoded data
- `notifications_sent` — Dedup table (prevents duplicate messages)

## Development

Run locally with polling (not webhook):
```bash
npm run dev
```

Type check:
```bash
npm run typecheck
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | From @BotFather |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `REDIS_URL` | ❌ | For future BullMQ queue support |
| `WEBHOOK_SECRET` | Recommended | Validates Telegram webhook requests |
| `CRON_SECRET` | Recommended | Protects /api/poll endpoint |
| `NODE_ENV` | ✅ | `production` or `development` |
