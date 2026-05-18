# Safe Transparency Telegram Bot — Technical Architecture & Implementation Plan

**Date:** 2026-05-18
**Status:** Ready for Engineering

---

## 1. Tech Stack Recommendation

**Runtime:** Node.js 22 (LTS) + TypeScript 5.x

| Layer | Choice | Justification |
|---|---|---|
| Telegram bot | Grammy | TypeScript-native, better middleware model than Telegraf, active maintenance |
| HTTP client | `undici` (built into Node 22) | Fast, native, no deps |
| HTML scraping | `cheerio` + `playwright` (fallback only) | Cheerio for light HTML, Playwright only when needed |
| Job queues | `BullMQ` + Redis | Battle-tested, repeatable jobs, rate limiting, concurrency control |
| Database | PostgreSQL 16 | Relational state tracking, JSONB for raw tx data, strong query support |
| DB access | `Drizzle ORM` | Lightweight, type-safe, no magic, schema-as-code |
| Blockchain | `viem` | Modern, TypeScript-first, tree-shakeable |
| Decoding | `whatsabi` + 4byte.directory API + custom decoders | Layered decoding strategy |
| Config | `zod` + env vars | Validated at startup, no runtime surprises |
| Hosting | Fly.io (app) + Upstash Redis (managed) + Neon (managed Postgres) | All have generous free tiers; easy to scale |

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TELEGRAM BOT SERVICE                         │
│   Grammy bot framework │ Admin auth │ Commands │ Session state       │
└───────────────────┬─────────────────────────────────────────────────┘
                    │ reads/writes config
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          POSTGRESQL (Neon)                          │
│  communities │ monitored_safes │ transactions │ notifications_sent  │
└──────────────────────┬──────────────────────────────────────────────┘
                       │                          ▲
         schedule jobs │                          │ write results
                       ▼                          │
┌──────────────────────────────┐       ┌──────────┴───────────────────┐
│     POLLER SCHEDULER         │       │     NOTIFICATION CONSUMER    │
│  BullMQ repeatable jobs      │──────▶│  Read queue → decode → send  │
│  One job per (safe, chain)   │       │  Grammy sendMessage          │
│  Adaptive intervals          │       │  Rate-limit Telegram calls   │
└──────────┬───────────────────┘       └──────────────────────────────┘
           │ fetch
           ▼
┌──────────────────────────────┐
│     SAFE DATA FETCHER        │
│  Primary: STS public REST    │
│  Fallback: on-chain eth_logs │
│  Cache: Redis TTL 30s        │
└──────────┬───────────────────┘
           │ raw tx data
           ▼
┌──────────────────────────────┐
│     DECODER SERVICE          │
│  ERC-20/721 patterns         │
│  4byte.directory lookup      │
│  whatsabi ABI resolution     │
│  MultiSend unwrapper         │
│  Fallback: raw summary       │
└──────────────────────────────┘
```

### Data Flow

```
Poller fires (every 60s per Safe)
  → Fetch pending + recent txs from Safe Transaction Service public API
  → Compare against DB (hash + status)
  → Detect: NEW pending, NEW executed, NEW rejected
  → For each delta: push notification job to BullMQ
    → Decode calldata (layered strategy)
    → Format human-readable message
    → Retrieve all Telegram chats monitoring this safe
    → Send message to each chat (respecting Telegram rate limits)
    → Record notification in DB (dedup guard)
```

---

## 3. Database Schema

```sql
CREATE TABLE communities (
  id              SERIAL PRIMARY KEY,
  telegram_chat_id BIGINT UNIQUE NOT NULL,
  chat_type       TEXT NOT NULL,  -- 'group' | 'supergroup' | 'channel'
  chat_title      TEXT,
  admin_user_ids  BIGINT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  is_active       BOOLEAN DEFAULT TRUE
);

CREATE TABLE monitored_safes (
  id              SERIAL PRIMARY KEY,
  community_id    INT REFERENCES communities(id) ON DELETE CASCADE,
  safe_address    TEXT NOT NULL,  -- checksummed EIP-55
  chain_id        INT NOT NULL,   -- 1=mainnet, 8453=base, 10=optimism, etc.
  label           TEXT,
  added_by        BIGINT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(community_id, safe_address, chain_id)
);

CREATE TABLE safe_transactions (
  id              SERIAL PRIMARY KEY,
  safe_address    TEXT NOT NULL,
  chain_id        INT NOT NULL,
  safe_tx_hash    TEXT NOT NULL,
  nonce           INT,
  status          TEXT NOT NULL,  -- 'pending' | 'executed' | 'cancelled'
  tx_type         TEXT,           -- 'transfer' | 'approval' | 'contract_call' | 'multisend' | 'unknown'
  to_address      TEXT,
  value_wei       TEXT,
  calldata        TEXT,
  decoded_summary JSONB,
  on_chain_hash   TEXT,
  confirmation_count INT DEFAULT 0,
  required_confirmations INT,
  raw_payload     JSONB,
  first_seen_at   TIMESTAMPTZ DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(safe_tx_hash, chain_id)
);

CREATE TABLE notifications_sent (
  id              SERIAL PRIMARY KEY,
  safe_tx_id      INT REFERENCES safe_transactions(id),
  community_id    INT REFERENCES communities(id),
  notification_type TEXT NOT NULL,  -- 'pending' | 'executed' | 'cancelled'
  telegram_message_id INT,
  sent_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(safe_tx_id, community_id, notification_type)  -- hard dedup constraint
);

CREATE TABLE polling_state (
  safe_address    TEXT NOT NULL,
  chain_id        INT NOT NULL,
  last_polled_at  TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  consecutive_errors INT DEFAULT 0,
  current_interval_ms INT DEFAULT 60000,
  PRIMARY KEY(safe_address, chain_id)
);
```

---

## 4. Safe Monitoring Strategy (Critical)

### Honest Assessment

Pending Safe transactions do NOT exist on-chain. They are stored off-chain in Safe's Transaction Service backend. There is no public blockchain source for pending multisig proposals.

**Decision:** Use the Safe Transaction Service (STS) public REST API as primary source, with direct RPC as verification layer.

The STS public API requires **no authentication** and is the same API the Safe app itself calls. The PRD's concern about cost points to the paid enterprise tier — the free public tier is consistent with the spirit of the constraint. Safe has also open-sourced their transaction service (self-hosting is a future option).

### Primary: Safe Transaction Service Public REST API

Base URLs by chain:
- Ethereum: `https://safe-transaction-mainnet.safe.global`
- Base: `https://safe-transaction-base.safe.global`
- Optimism: `https://safe-transaction-optimism.safe.global`
- Arbitrum: `https://safe-transaction-arbitrum.safe.global`
- Polygon: `https://safe-transaction-polygon.safe.global`

Key endpoints:
```
GET /api/v1/safes/{address}/multisig-transactions/?ordering=-nonce&limit=20
GET /api/v1/safes/{address}/all-transactions/?ordering=-executionDate&limit=10
```

Cache all responses in Redis with 30s TTL. If a Safe is being polled by 10 communities, it makes 1 request per 30s, not 10.

### Fallback: On-Chain Event Logs (Execution Only)

For executed transactions only (pending not possible via RPC):
```
event ExecutionSuccess(bytes32 txHash, uint256 payment)
event ExecutionFailure(bytes32 txHash, uint256 payment)
```

Use `viem` + free RPC endpoints (Coinbase for Base, Infura for mainnet) to index these.

### Self-Hosting Option (Future)

Safe's transaction service is open source at `github.com/safe-global/safe-transaction-service`. At scale, self-host on a VPS to eliminate rate limit concerns entirely.

---

## 5. Transaction Decoding

### Layered Strategy (in order)

**Layer 1: Native ETH transfer**
- If `calldata == '0x'` and `value > 0` → "Sending X ETH to 0xABCD..."

**Layer 2: ERC-20 hardcoded selectors**
```
transfer(address,uint256)       → 0xa9059cbb
transferFrom(address,address,uint256) → 0x23b872dd
approve(address,uint256)        → 0x095ea7b3
```
For these: fetch token symbol/decimals via `viem.readContract`, format with human units.

**Layer 3: 4byte.directory lookup**
- POST `https://www.4byte.directory/api/v1/signatures/?hex_signature=0xCALLDATA_SELECTOR`
- Returns function name candidates
- Apply heuristics to pick the most likely match

**Layer 4: whatsabi ABI resolution**
- `whatsabi` guesses a contract's ABI from bytecode + event logs
- Use to decode complex contract interactions

**Layer 5: MultiSend unwrapper**
- If `to` == MultiSend contract address, decode the packed batch and apply layers 1-4 to each sub-call

**Layer 6: Graceful fallback**
- "A complex contract interaction was proposed. [View on Safe]"

### Decoder output format

```typescript
interface DecodedTx {
  type: 'transfer' | 'approval' | 'contract_call' | 'multisend' | 'eth_transfer' | 'unknown';
  summary: string;        // Human-readable one-liner
  details?: string[];     // Optional bullet points
  confidence: 'high' | 'medium' | 'low';
  warnings?: string[];    // e.g., "Unlimited approval detected"
}
```

---

## 6. Telegram Bot Design

### Commands

```
/start       — Welcome message + setup instructions
/addwallet <address> [chain] [label] — Add a Safe to monitor
/listwatched — Show all monitored Safes for this chat
/removewallet <address> — Remove a Safe from monitoring
/status      — Show bot health + last poll time
/help        — Command reference
```

### Admin Authentication

Grammy middleware checks `ctx.from.id` against `admin_user_ids` in the communities table.

On bot join event (`my_chat_member`): fetch chat admins via `getChatAdministrators()` and persist to DB. Refresh on each admin command.

### Conversation Flow (Add Wallet)

```
User: /addwallet 0xABCD...
Bot:  "Which chain? [Ethereum] [Base] [Optimism] [Arbitrum] [Polygon] [Other]"
User: [Base]
Bot:  "✅ Now monitoring 0xABCD... on Base. You'll get notifications for new, executed, and cancelled transactions."
```

For `/other` chain: bot prompts for chain ID manually.

### Group vs Channel

- **Groups/Supergroups:** Bot responds to commands in-chat
- **Channels:** Bot can only post (no commands). Admin must DM the bot to configure, specifying the channel chat ID.

---

## 7. Notification Pipeline

### Message Templates

**🟡 New Pending Transaction**
```
🔔 New transaction proposed on [Safe Label]
━━━━━━━━━━━━━━━━━
📤 Action: Sending 25,000 USDC to 0x1234…abcd
💰 Value: 0 ETH
🔢 Nonce: #42
✅ Signatures: 2/4

[View on Safe ↗]
```

**✅ Transaction Executed**
```
✅ Transaction executed on [Safe Label]
━━━━━━━━━━━━━━━━━
📤 Action: Sending 25,000 USDC to 0x1234…abcd
🔢 Nonce: #42
🔗 On-chain: 0xTXHASH…

[View on Etherscan ↗]
```

**❌ Transaction Cancelled**
```
❌ Transaction cancelled on [Safe Label]
━━━━━━━━━━━━━━━━━
📤 Was: Sending 25,000 USDC to 0x1234…abcd
🔢 Nonce: #42
```

### Pipeline Steps

1. BullMQ consumer picks up job
2. Fetch full tx details from DB
3. Run decoder if `decoded_summary` not yet populated
4. Query all `community_id`s watching this safe
5. For each community: check `notifications_sent` (skip if already sent)
6. Format message via template
7. `ctx.api.sendMessage(chat_id, text, { parse_mode: 'HTML' })` — HTML is safer than Markdown for special chars
8. Insert into `notifications_sent` with telegram message ID
9. On Telegram 429 error: respect `retry_after` from response, reschedule job

---

## 8. Polling & Rate Limiting Strategy

### Adaptive Polling

Each Safe gets its own BullMQ repeatable job. Default interval: 60s.

Adaptive logic:
- Activity detected → reduce to 30s for next 5 minutes
- No activity for 1hr → relax to 120s
- No activity for 24hr → relax to 300s
- Error detected → exponential backoff starting at 60s, cap at 600s

### Deduplication of HTTP Requests

Multiple communities may monitor the same Safe. Deduplicate at the Safe level:
- One BullMQ job per `(safe_address, chain_id)` — NOT per community
- On job completion: fan out to all N communities watching that Safe
- Redis cache on raw API response (30s TTL) prevents thundering herd

### Telegram Rate Limits

Telegram allows:
- 30 messages/second overall
- 1 message/second per chat

Use a per-chat token bucket (Redis-backed) to enforce 1 msg/s per chat.
Queue overflow messages with small delays (100ms) rather than dropping.

---

## 9. Scalability Plan

### Phase 1: Single Instance (0–100 Safes)

Single Fly.io machine. BullMQ workers in same process. Neon + Upstash Redis free tiers. ~$0/month.

### Phase 2: Moderate Scale (100–1,000 Safes)

- Separate Fly.io machines for bot service vs. poller workers
- BullMQ concurrency: 10 workers on poller machine
- Redis rate limiting via sliding window
- Neon serverless scaling handles connection pooling automatically

### Phase 3: Large Scale (1,000+ Safes)

- Self-host Safe Transaction Service (eliminates rate limit concerns)
- Horizontal poller workers (each worker claims a partition of Safes)
- Consider migrating from polling to websocket subscriptions against self-hosted STS
- Multi-region Fly.io deployment for Telegram API latency

---

## 10. Implementation Phases

### Phase 1 — MVP (2–3 weeks)

- [ ] Project scaffold: TypeScript, Drizzle, Grammy, BullMQ
- [ ] DB schema + migrations
- [ ] Basic Grammy bot: /start, /addwallet, /listwatched, /removewallet
- [ ] Admin auth middleware
- [ ] Safe polling: STS public API, ETH transfer + ERC-20 decoding only
- [ ] Notification pipeline: 3 message types
- [ ] Dedup via notifications_sent
- [ ] Fly.io deploy with env-based config

### Phase 2 — Robustness (1–2 weeks)

- [ ] Adaptive polling intervals
- [ ] On-chain fallback (viem event logs)
- [ ] 4byte.directory + whatsabi decoder layers
- [ ] MultiSend unwrapper
- [ ] Telegram rate limit token bucket
- [ ] Exponential backoff on errors
- [ ] /status command + health endpoint
- [ ] Page structure change detection (checksum on response structure)

### Phase 3 — Polish & Scale (1–2 weeks)

- [ ] Channel support (admin DM config flow)
- [ ] Custom Safe labels
- [ ] Self-host STS option (Docker Compose)
- [ ] LLM fallback for unknown calldata (optional, per PRD future ideas)
- [ ] Multi-chain support validation across all 5+ chains
- [ ] Observability: structured logging, error alerting

---

## 11. Open Questions — Answered

**Q1: Most reliable way to parse public Safe transaction pages?**
Use the Safe Transaction Service public REST API (no auth required). Do NOT scrape the UI — too brittle. The STS API is stable, versioned, and is what the official app uses.

**Q2: How should polling intervals be optimized?**
Adaptive per-Safe intervals: 30s during active periods, 60s default, 120s/300s when idle. One shared job per (safe, chain_id) across all communities — not per community.

**Q3: How should the system detect page structure changes?**
Store a checksum of the API response schema (top-level key names + types). On each poll, compare. If schema drift detected, log a warning and fall back to raw tx display. Alert the engineering team via a structured error metric.

**Q4: What decoding libraries or services should be used?**
- `viem` for ABI encoding/decoding and RPC calls
- `whatsabi` for ABI recovery from bytecode
- `4byte.directory` API for function selector → name lookup
- Custom hardcoded decoders for ERC-20 transfer/approve (most common case)

**Q5: How should unsupported transactions be represented?**
Always send a notification — never silently skip. Use: "⚠️ A complex contract interaction was proposed that could not be fully decoded. [View on Safe ↗]" Include raw `to` address and ETH value even if calldata can't be decoded.

**Q6: What storage system should track historical transaction states?**
PostgreSQL (`safe_transactions` table) as primary state. Redis for ephemeral cache (30s TTL on API responses). The `notifications_sent` table with a UNIQUE constraint acts as the hard dedup layer.

**Q7: How should Telegram rate limits be handled?**
Per-chat token bucket in Redis, enforcing 1 msg/s per chat. On 429 response, read `retry_after` from Telegram's error body and reschedule the BullMQ job with that delay. Never drop messages — always retry.

**Q8: How should chains/networks be identified?**
By chain ID (integer). Store `chain_id` everywhere. Map chain IDs to STS base URLs via a config file. When user runs `/addwallet`, prompt chain selection via inline keyboard buttons showing chain names. Internally always store and compare by `chain_id`.

**Q9: Should the system support private Telegram groups differently?**
Not differently in terms of notifications — the bot can post to private groups as long as it's a member. The only difference: admin auth is harder since `getChatAdministrators()` still works in private groups. No special handling needed.

**Q10: How should transaction spam or Safe activity bursts be managed?**
- Cap notifications per Safe per hour: if a Safe generates >20 transactions in 1 hour, switch to digest mode for that Safe (batch into one summary message every 15 minutes)
- Use BullMQ's rate limiter on the notification queue: max 5 notifications/minute per community
- This prevents a runaway Safe from flooding a Telegram chat
