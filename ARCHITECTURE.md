# MosendPay — System Architecture

A merchant payments platform for Ghana. Merchants accept Mobile Money (MTN, Telecel,
AirtelTigo) and card payments through a single API and dashboard. MosendPay sits on top of
licensed Payment Service Provider (PSP) rails as an aggregator — we own the merchant
relationship, onboarding, ledger, settlement records, and developer experience.

> **Regulatory note:** Moving and settling merchant funds in Ghana is regulated by the Bank
> of Ghana. This MVP is built to run on top of a licensed PSP / aggregator (via a pluggable
> `PspProvider` interface) rather than holding funds directly. A mock provider is included so
> the whole flow runs end-to-end locally.

## 1. Design goals

- **Correctness over everything.** Money systems must never lose or double-count a cedi. The
  ledger is double-entry and append-only; balances are derived, never edited in place.
- **Idempotency everywhere.** Networks retry. Every money-moving call is safe to repeat.
- **Stateless services.** All state lives in Postgres + Redis so the API scales horizontally
  behind a load balancer.
- **Async by default.** Webhooks, settlement, and notifications run through a queue so a slow
  downstream never blocks a checkout.
- **Pluggable rails.** The PSP integration is an interface, so swapping/adding providers
  (Hubtel, Paystack, Flutterwave) is a config change, not a rewrite.

## 2. High-level architecture

```
                          ┌──────────────────────────────┐
   Merchant dashboard ───▶│        API Gateway / LB       │
   Customer checkout  ───▶│      (rate limit, TLS)        │
   Merchant servers   ───▶└──────────────┬───────────────┘
   (API + webhooks)                      │
                                         ▼
                    ┌────────────────────────────────────────┐
                    │           MosendPay API (Node)           │
                    │  auth · merchants · payments · txns ·    │
                    │  ledger · webhooks · settlements         │
                    └───────┬───────────────┬─────────────────┘
                            │               │
                  ┌─────────▼──────┐   ┌─────▼───────┐    ┌──────────────┐
                  │   PostgreSQL   │   │    Redis    │    │  Job worker  │
                  │ (source of     │   │ idempotency │◀──▶│ (BullMQ):    │
                  │  truth, ledger)│   │ cache, rate │    │ webhooks,    │
                  └────────────────┘   │ limit, queue│    │ settlement,  │
                                       └─────────────┘    │ notifications│
                                                          └──────┬───────┘
                                                                 │
                                                          ┌──────▼───────┐
                                                          │ PSP Provider │
                                                          │  interface   │
                                                          │ (mock / real)│
                                                          └──────┬───────┘
                                                                 │
                                              MTN MoMo · Telecel · AirtelTigo · Cards
```

### Why these pieces

- **Postgres** is the source of truth. ACID transactions are non-negotiable for a ledger.
- **Redis** handles idempotency keys, rate limiting, and the job queue (BullMQ). Fast,
  ephemeral, horizontally scalable.
- **A separate worker process** consumes the queue. Webhook delivery to merchants, settlement
  batch creation, and notifications happen here so the request path stays fast.
- **PSP provider interface** abstracts the rails. The mock provider simulates async MoMo
  callbacks so you can run the entire lifecycle without a real license.

## 3. The money model (double-entry ledger)

Every payment touches at least two accounts. We never store a mutable "balance" column that
gets `UPDATE`d — that's how money systems drift and corrupt. Instead:

- Each merchant has a **ledger account**. The platform has system accounts (`psp_clearing`,
  `fees_income`, `settlement_payable`).
- A payment creates a **journal entry** with balanced **postings** (debits == credits).
- A merchant's available balance is `SUM(credits) - SUM(debits)` over their postings — derived
  on read, optionally cached in a materialized balance row updated inside the same DB txn.

Example: customer pays GHS 100, fee is 1.95% (GHS 1.95).

```
Journal entry: payment_succeeded (txn_abc)
  DR psp_clearing            100.00   (money arrived at the rail)
  CR merchant:M1 available    98.05   (merchant earns net)
  CR fees_income              1.95    (we earn the fee)
```

Debits == Credits == 100.00. Always balanced. The ledger is append-only; a refund is a *new*
reversing entry, never a deletion.

## 4. Payment lifecycle (state machine)

```
 created ──▶ pending ──▶ processing ──▶ succeeded
    │           │            │
    │           │            └──▶ failed
    │           └──▶ failed (timeout / declined)
    └──▶ cancelled
                                   succeeded ──▶ refunded / partially_refunded
```

State transitions are guarded — only legal transitions are allowed, and each is written inside
a DB transaction together with its ledger postings, so a payment can never be "succeeded"
without balanced postings existing.

## 5. Idempotency

- Clients send an `Idempotency-Key` header on POST /payments.
- We store `key -> (request_hash, response)` in Postgres (durable) with a Redis fast-path.
- Same key + same body → return the stored response. Same key + different body → 409.
- The PSP callback handler is idempotent on `provider_reference`, so duplicate callbacks
  (which always happen) settle the payment exactly once.

## 6. Security

- Merchant API keys: a public key (`pk_...`) and a secret key (`sk_...`). Only a hash of the
  secret is stored (bcrypt). Shown once at creation.
- Dashboard users authenticate with email + password (bcrypt) → short-lived JWT access token +
  rotating refresh token.
- Webhooks to merchants are signed with HMAC-SHA256 over the raw body; merchants verify with
  their webhook secret.
- Rate limiting per API key and per IP via Redis sliding window.
- All amounts are integers in the smallest unit (pesewas) — never floats.

## 7. Scaling path (MVP → millions)

| Concern        | MVP today                        | At scale                                        |
|----------------|----------------------------------|-------------------------------------------------|
| API            | 1 stateless Node process         | N replicas behind LB (k8s HPA)                  |
| DB             | Single Postgres                  | Primary + read replicas; PgBouncer pooling      |
| Ledger growth  | Single table, indexed            | Partition postings by month; archive cold data  |
| Queue          | Redis + BullMQ                   | Redis Cluster; dedicated worker fleet           |
| Idempotency    | Postgres + Redis                 | Same, Redis Cluster                             |
| Hot reads      | Derived balances                 | Materialized balance rows + cache               |
| Multi-region   | Single region (Accra/EU)         | Read replicas per region, async settlement      |
| Observability  | Structured logs + /health        | OpenTelemetry traces, metrics, alerting         |

Nothing in the MVP blocks this path: services are stateless, state is in Postgres/Redis, and
work is already queued.

## 8. Tech choices

- **Node + Express + TypeScript-style JSDoc** (plain JS here for zero-build runnability),
- **Postgres** via `pg`,
- **Redis + BullMQ** for queue/cache (degrades gracefully to in-memory if absent),
- **React + Vite + Tailwind** dashboard,
- **Zod** for request validation,
- **pino** for structured logging.

See `README.md` for run instructions and `migrations/` for the schema.
