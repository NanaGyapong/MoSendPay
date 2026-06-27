# MosendPay

A merchant payments platform for Ghana — accept Mobile Money (MTN, Telecel,
AirtelTigo) and cards through one API and dashboard. Built as an aggregator on top
of licensed PSP rails, with a correct double-entry ledger at its core.

See **ARCHITECTURE.md** for the full system design.

## What's here

```
mosendpay/
├── ARCHITECTURE.md              # system design, data model, scaling path
├── migrations/001_init.sql      # canonical PostgreSQL schema (production)
├── src/
│   ├── config/                  # env-driven config
│   ├── db/                      # DB adapter (node:sqlite locally; Postgres-shaped)
│   ├── lib/                     # ids, money math, errors, logger
│   ├── middleware/              # auth (API key + JWT), rate limit, errors
│   ├── modules/
│   │   ├── auth/                # signup, login, API-key + JWT
│   │   ├── ledger/              # double-entry ledger (the money core)
│   │   ├── payments/            # payment state machine + PSP interface + mock
│   │   └── webhooks/            # signed webhook delivery with retry/backoff
│   ├── routes/                  # HTTP endpoints + Zod validation
│   ├── server.js                # API entrypoint
│   └── worker.js                # background worker (webhooks/settlement)
├── web/dashboard.html           # merchant dashboard (React, self-contained)
└── test/flow.test.js            # end-to-end money-path + ledger-integrity tests
```

## Run it

Requires Node 20+ (uses the built-in `node:sqlite`, so no native build step).

```bash
npm install
npm run migrate      # create the local SQLite schema
npm start            # API on http://localhost:4000
```

Open `web/dashboard.html` in a browser (or serve it). It points at
`http://localhost:4000` by default; override with `?api=https://your-host`.
If the API isn't running, the dashboard shows demo data so it always renders.

Run the test suite (proves the ledger never loses money):

```bash
node --test-concurrency=1 test/flow.test.js
```

## Quick API tour

All money is integer **pesewas** in storage; the API accepts `amount` in GHS
(decimal) or `amount_pesewas` (integer) and returns both.

```bash
# 1. Create a merchant (returns a JWT + your API secret key, shown once)
curl -X POST localhost:4000/v1/auth/signup -H 'content-type: application/json' \
  -d '{"businessName":"Kofi Electronics","email":"kofi@shop.gh","password":"password123"}'

# 2. Create a payment (use the sk_live_... secret key)
curl -X POST localhost:4000/v1/payments \
  -H 'authorization: Bearer sk_live_...' -H 'content-type: application/json' \
  -d '{"amount":150.00,"channel":"momo","provider":"mtn","msisdn":"0240000002","reference":"inv-1001"}'

# 3. Fetch it
curl localhost:4000/v1/payments/pay_... -H 'authorization: Bearer sk_live_...'

# 4. Refund (full or partial)
curl -X POST localhost:4000/v1/payments/pay_.../refund \
  -H 'authorization: Bearer sk_live_...' -H 'content-type: application/json' -d '{"amount":50}'
```

> **Mock provider testing:** with `PSP_PROVIDER=mock` (default), a payer MoMo
> number ending in an **even** digit succeeds and an **odd** digit fails — so you
> can test both paths deterministically.

## Endpoints

| Method | Path                          | Auth     | Purpose                          |
|--------|-------------------------------|----------|----------------------------------|
| GET    | `/health`                     | none     | liveness                         |
| POST   | `/v1/auth/signup`             | none     | create merchant + first API key  |
| POST   | `/v1/auth/login`              | none     | dashboard login → JWT            |
| GET    | `/v1/me`                      | JWT      | merchant profile + balance       |
| GET    | `/v1/dashboard/stats`         | JWT      | volume, fees, balance            |
| GET    | `/v1/dashboard/payments`      | JWT      | recent payments                  |
| POST   | `/v1/payments`                | API key  | create a charge (idempotent)     |
| GET    | `/v1/payments/:id`            | API key  | fetch a payment                  |
| GET    | `/v1/payments`                | API key  | list payments                    |
| POST   | `/v1/payments/:id/refund`     | API key  | refund (full/partial)            |
| POST   | `/v1/webhooks/psp`            | provider | async settlement callback        |

## Going to production

This MVP is deliberately runnable with zero infrastructure. The path to scale is
in ARCHITECTURE.md, but the key swaps are:

1. **Postgres** — set `DATABASE_URL`; run `migrations/001_init.sql`. The DB
   adapter (`src/db`) is the only file that changes.
2. **Redis + BullMQ** — move idempotency, rate limiting, and the webhook/settlement
   queue off in-memory/SQLite onto Redis; run `src/worker.js` as its own fleet.
3. **A real PSP** — implement `createHubtelProvider`/`createPaystackProvider` in
   `src/modules/payments/psp.js` against your licensed partner, then set
   `PSP_PROVIDER`. Nothing else in the app changes.
4. **Secrets & TLS** — real `JWT_SECRET`, secrets manager, API gateway with TLS
   and per-key rate limits.

## Regulatory reality

Collecting and settling merchant funds in Ghana requires a Bank of Ghana licence
(PSP/PSSP) or operating under a licensed partner. This codebase is structured to
run on a partner's rails via the `PspProvider` interface — it does not itself hold
or move funds. Treat the licensing path as a real, early workstream, not an
afterthought.
