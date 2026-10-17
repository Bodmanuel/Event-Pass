# EventPass

Agent-native ticketing for the PayBox marketplace. An AI agent searches events,
compares ticket tiers, buys inside a spending limit with an x402 payment on Base,
collects verifiable QR tickets, and an organizer redeems each code exactly once.

Two pieces:

| Path | What it is |
|---|---|
| `plugin/` | The PayBox plugin. Builds to `plugin/dist/plugin.mjs`, which is what you upload. |
| `.` (repo root) | The EventPass API: inventory, orders, the x402 payment gate, ticket issuance and redemption. |

## Why the plugin is thin

The hosted PayBox runtime is **stateless** — every operation gets a fresh sandbox
with no memory and no disk — and for x402 the sandbox **ends before the payment is
approved**. So the plugin cannot hold inventory, and it cannot return a ticket in
the same call that pays. Everything durable lives in this API, and ticket
collection is a separate tool call afterwards.

That constraint shapes the whole design:

```
agent                 plugin (stateless)            EventPass API              PayBox
  |                          |                            |                       |
  |-- purchase_ticket ------>|                            |                       |
  |                          |-- POST /v1/orders -------->|  reserve inventory    |
  |                          |<-- orderId, total, payUrl -|  (atomic, 15 min)     |
  |                          |                                                    
  |<-- x402 proposal --------|  proposes the exact total, capped by the budget     
  |                                                                                |
  |----------------------- use_plugin -> PayBox fetches 402 challenge ------------->|
  |                                                                  user approves  |
  |                                          <--- retries payUrl with X-PAYMENT ----|
  |                          verify + settle via facilitator, then issue tickets    |
  |-- get_order_status ----->|-- GET /v1/orders/:id ----->|  tickets + QR + receipt
```

## The four tools

| Tool | Purpose |
|---|---|
| `search_events` | Find events by city, genre, date or max ticket price. |
| `get_ticket_options` | Tiers with per-ticket fees, payable total and live inventory. |
| `purchase_ticket` | Reserves at the live price and returns a Base-USDC x402 proposal. Refuses to propose anything above the caller's stated budget. |
| `get_order_status` | Polls after payment and collects tickets, QR payloads and the receipt. |

## Correctness properties

Enforced in code and covered by tests. Every property below is exercised twice:
once against the in-process store and once against a real PostgreSQL 18 server,
through the production `DATABASE_URL` path.

- **Atomic reservation, no overselling.** The memory store's check and decrement
  run with no `await` between them; the Postgres store does it in a single guarded
  `UPDATE tiers SET remaining = remaining - $2 WHERE tier_id = $1 AND remaining >= $2`,
  so concurrent reservations serialise on the row lock and the loser matches no row.
- **Fixed price.** The reservation pins the total, and the 402 challenge states
  exactly that amount. The gate re-validates the *presented* authorization against
  the reserved total, so a tampered or stale quote cannot settle.
- **No charge without verification.** Tickets are issued only after the payment
  passes local validation, then the facilitator both verifies *and* settles. If
  either refuses, the response is 402/502 and no tickets exist. If payment is
  unconfigured, the endpoint returns 501 — it never pretends a payment happened.
- **Idempotent.** A repeated `idempotencyKey` returns the original order and holds
  inventory once, even under concurrent replays. Replaying the paid endpoint
  returns the same tickets instead of settling twice.
- **Single issuance.** Settlement is a guarded `UPDATE ... WHERE status =
  'awaiting_payment'`, so of any number of concurrent payment callbacks exactly one
  issues tickets.
- **Released holds.** Cancelled, expired or refused reservations return their
  inventory; the release is itself guarded so a hold cannot be returned twice.
- **One-time redemption.** Codes are HMAC-signed per ticket and per event; burning a
  code is a guarded `UPDATE ... WHERE status = 'valid'`, so simultaneous scans admit
  exactly one person and every replay gets `already_redeemed`.

## Run it

Needs Node.js 24 (the plugin's pinned `pnpm test` requires exactly 24.x — Node 26
fails its environment check).

```bash
pnpm install
cp .env.example .env      # fill in TICKET_SECRET, ORGANIZER_KEY, X402_PAY_TO, X402_FACILITATOR_URL
pnpm start                # http://127.0.0.1:8787  (dashboard at /dashboard)
```

```bash
pnpm test                 # 130 tests across both storage backends, stub facilitator, no funds
pnpm test:live            # 6 read-only checks against the deployed API (needs network)
pnpm e2e                  # drives the real plugin/dist/plugin.mjs over MCP stdio end to end
DATABASE_URL=... pnpm e2e # the same demo against PostgreSQL
```

The plugin is built separately:

```bash
cd plugin
pnpm install
pnpm build                # writes plugin/dist/plugin.mjs (the artifact uploaded to PayBox)
pnpm test                 # PayBox conformance suite (requires Node 24.x)
```

The stub facilitator in the tests is a test double only — the server always calls
a real facilitator URL from `X402_FACILITATOR_URL`. No test touches mainnet and no
test result is evidence of a real settlement.

## Storage and deployment

`DATABASE_URL` selects the Postgres adapter; without it the API uses the
in-process store. Both satisfy the same interface, so no route changes between them.

| | in-process | PostgreSQL |
|---|---|---|
| Survives a restart | no | yes |
| Safe behind >1 instance | **no** | yes |
| Serverless (Vercel/Lambda) | **no** — inventory and orders vanish between invocations | yes |
| Setup | none | `DATABASE_URL` + `pnpm migrate` |

The in-process store is fine for `pnpm start` on a laptop and for the test suite.
Any real deployment must set `DATABASE_URL`, because a second instance would hold
its own copy of inventory and two instances would happily oversell the same seat.
`pnpm migrate` is idempotent and seeds the launch event with `on conflict do
nothing`, so redeploying never resets sold inventory. Supabase works unchanged —
use its pooled connection string.

## Order access

`orderId` is a 122-bit random capability, not a sequence number: it is the bearer
token for that order, and the endpoints that return tickets require nothing else.
That is deliberate — the agent that bought the ticket is the only party that ever
sees the id — but it means the id must be treated as a secret: it is never logged,
and it never appears in a URL that a third party would see. An unknown or
mistyped id returns a plain 404 with no hint about whether a near-miss exists.

## Payment configuration

`X402_PAY_TO` is a Base address. `X402_FACILITATOR_URL` must be a facilitator that
supports **USDC on Base mainnet (`eip155:8453`)** — x402.org's public facilitator is
testnet-oriented, so mainnet usually means the Coinbase CDP facilitator with API
keys. PayBox only supports Base and Solana mainnet for x402, so a testnet demo is
not an option: the demo purchase is a real, small USDC payment.

### x402 version and wire shape

PayBox speaks x402 **v2**, so `X402_VERSION=2` (the default) is what runs in
production. The challenge then advertises exactly one requirement in the v2
vocabulary:

```json
{"scheme":"exact","network":"eip155:8453","amount":"9500000",
 "asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
 "payTo":"0x…","maxTimeoutSeconds":300,
 "extra":{"name":"USD Coin","version":"2"}}
```

with the resource descriptor (`url`, `description`, `mimeType`) at the top level
and `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers.
`X402_VERSION=1` switches to the legacy shape: the `"base"` network spelling
with `maxAmountRequired` on each accept. The gate accepts either payment header.

Two details matter more than the version number, and both were learned from live
CDP rejections:

- **`extra` must carry the token's EIP-712 domain, not its ticker.** USDC on Base
  reports `name() = "USD Coin"` and `version() = "2"`. A client builds its
  EIP-3009 signature from `extra`, so advertising `"USDC"` signs against the
  wrong domain and the facilitator's on-chain simulation reverts with
  `invalid_payload` (`contract call failed: … execution reverted`).
- **v2 terms live under `accepted`.** The gate reads `scheme`, `network` and
  `asset` from `paymentPayload.accepted` when present (v1 keeps them at the top
  level), requires the echoed `accepted` to be v2-shaped and to match the
  reserved amount, payee and asset, and forwards it **unchanged** as
  `paymentRequirements`. A v1-shaped `accepted` is refused before the
  facilitator is called, because CDP answers it with
  `'paymentPayload' is invalid: must match one of [x402V2PaymentPayload…]`.

## Configuring the plugin in the PayBox portal

Under **Test & configure**:

1. **Network hosts** — add the exact hostname this API is deployed on (no wildcard).
   For the current deployment that is `eventpass-api.vercel.app`.
2. **Variables & Secrets** — add an *Environment variable* `EVENTPASS_API_URL` set to
   `https://<your-api-host>` (no trailing slash).
3. Upload `plugin/dist/plugin.mjs` from this repo, then run the hosted checks.

No secret goes in the bundle. The plugin reads only `EVENTPASS_API_URL`, and
defaults to `https://eventpass-api.vercel.app` when it is unset — the artifact
targets the real deployment out of the box rather than a placeholder host. A
hosted sandbox does not reliably set `NODE_ENV`, which is why the local API
(`http://127.0.0.1:8787`) is opt-in via `EVENTPASS_LOCAL=1` and can never be
reached from a sandbox by accident.

## Demo script

`pnpm e2e` prints this walkthrough. On camera, replace the stub settlement with a
real PayBox approval:

1. *"Find me two tickets to an Afrobeat event this Saturday, budget $20."*
   → `search_events` returns AfroGroove Fest, Brooklyn, 17 Oct 2026.
2. *"What are my options?"* → GA is 8.00 + 1.50 fee = **9.50 USDC** each.
3. *"Buy two."* → `purchase_ticket` reserves 2 GA for **19.00 USDC** and returns an
   x402 proposal for exactly 19 000 000 atomic USDC on `eip155:8453`.
4. PayBox shows the request; the user approves; PayBox settles and retries the resource.
5. `get_order_status` returns two ticket records with distinct QR payloads and a receipt.
6. Open `/dashboard`, admit the first ticket → **ADMITTED**; scan it again →
   **ALREADY REDEEMED**.

Ask for a purchase over budget (e.g. `maxTotalUsdc: "5"`) to show the guard: the
plugin declines, nothing is charged, and the held inventory is released.

## Going to production

This API is deployed on Vercel at **https://eventpass-api.vercel.app**, which is
what `plugin/dist/plugin.mjs` targets by default.

```bash
vercel deploy --prod \
  -e TICKET_SECRET=$(openssl rand -hex 32) \
  -e ORGANIZER_KEY=$(openssl rand -hex 32) \
  -e DATABASE_URL='postgres://...'          # required in production
```

`vercel.json` rewrites every path to `api/index.mjs`, which wraps the same
Express app `pnpm start` runs — no routes are duplicated for the platform. The
app is built once per warm instance and reused; serverless skips the background
expiry sweeper, because every store operation already expires stale holds before
reading availability, so nothing depends on a long-lived process.

Two platform details are handled explicitly rather than left to chance:

- **`TICKET_SECRET` has no fallback.** A shared default would be a value in this
  public repository, so every deployment that forgot the variable would look
  healthy while signing tickets with a published key. On Vercel, Lambda or
  `NODE_ENV=production` the process now refuses to start without it.
- **A pre-parsed body is tolerated.** A host that buffers the request and invokes
  the handler with a drained stream would otherwise fail *every* POST with
  `stream is not readable` while GETs kept working. Vercel does not buffer — this
  was checked by deploying without the guard and confirming POSTs still returned
  201 — so the middleware in `server.mjs` is a no-op there, kept for the hosts
  that do.

### Verify a deployment, in this order

Steps 1–4 are read-only and cost nothing.

```bash
curl https://<host>/healthz          # ok:true, storage, and x402 booleans — never the values
curl https://<host>/v1/events        # the seeded event with live inventory
curl -X POST https://<host>/v1/orders -H 'content-type: application/json' \
  -d '{"eventId":"evt_afrogroove_2026","tierId":"tier_ga","quantity":1}'
curl -i https://<host>/v1/orders/<id>/pay
```

The last one is the important one, and it costs nothing: with payment configured
it returns **402** with a `PAYMENT-REQUIRED` header and a single v2 `accepts`
entry naming `eip155:8453`, the configured `payTo`, USDC on Base, and the exact
reserved `amount` (plus the USDC EIP-712 domain in `extra`). Without payment
configured it returns **501** and issues nothing. Either way, no ticket exists
afterwards — `GET /v1/orders/<id>` will show an empty `tickets` array.

These same checks run as a suite:

```bash
pnpm test:live        # skips unless EVENTPASS_LIVE=1; read-only, never pays
```

It is skipped by default so the normal suite stays hermetic. The live suite is
the only place that proves the *built* artifact reaches the deployment: it runs
`plugin/dist/plugin.mjs` with no `EVENTPASS_API_URL` and no `NODE_ENV` and asserts the
result says `source: "live"`.

### Deployment status

The production deployment is fully configured: Supabase Postgres behind the
API, and the Coinbase CDP facilitator on Base mainnet (`eip155:8453`) with
short-lived EdDSA JWTs — `/healthz` reports `authentication: "cdp-jwt"` and
`storage: "postgres"`. Tickets are issued only after the facilitator both
verifies and settles a payment; a settled purchase is visible as tickets in
`/healthz`'s `tickets` count and in the order record.

If `storage` ever reports `memory`, the deployment has lost its database and is
not durable. The schema is applied and AfroGroove Fest is seeded on cold start.

Tickets are never issued by any path that has not seen a settled payment, so an
unconfigured or wrongly-configured deployment fails closed rather than handing
out admission.

### Resetting the demo to full inventory

The seed is `on conflict do nothing`, so it restores nothing a real order has
consumed — a cancelled or expired run leaves inventory where it was. To start a
demo from the seeded counts:

```sql
update tiers set remaining = 40 where tier_id = 'tier_ga';
update tiers set remaining = 10 where tier_id = 'tier_vip';
```

Expired and cancelled orders stay in the table as history; only `remaining`
governs what can be sold.

### Diagnosis order when the database will not connect

`password authentication failed for user "postgres"` covers four different
mistakes, so the boot error names which one it is. In the order they occur:

1. **The password is still `[YOUR-PASSWORD]`.** Copying the Connect panel's string
   without substituting the password is the common case and the least obvious,
   because the string looks complete. The boot log gives the password's length —
   15 is the placeholder, so a real password of that length is worth double
   checking.
2. **There is no password in the URL at all.** Fails identically. Localhost is
   exempt, since trust auth needs none.
3. **The password contains a raw `#`, `/` or `?`.** The string is not a valid URL
   and is rejected as malformed; percent-encode the character.
4. **The pooler username lost its project ref.** Supabase's pooler routes by
   username, so it must be `postgres.<project-ref>`; a bare `postgres` only works
   for the direct connection.

A cold-start failure also logs the connection target — host, port, user,
database, SSL mode, and the password's *length* — and never the password. The
length is what identifies cases 1 and 2.
