# PayBox Requirements Audit — EventPass

**Subject:** `eventpass` PayBox plugin (`/Users/hi/eventpass-plugin`) and its backend
(`/Users/hi/eventpass-api`, deployed at `https://eventpass-api.vercel.app`).
**Audited:** 2026-10-16, 19:25–20:30 EDT (2026-10-16 23:25 → 2026-10-17 00:30 UTC).
**Backend redeployed:** 2026-10-17 00:37 UTC — deployment `dpl_DhBEMQSqKN9erNbWUNwKcn4teNbu`.
**Artifact under audit:** `dist/plugin.mjs`, 403,922 bytes,
`sha256 f290f6827e6b58aff6f83c148f389065ac68ccb6cb37f49fe93e502b225fed02`.

Every claim below is tagged:

- **[verified]** — I ran it and the result is stated as observed.
- **[assumed]** — inferred or not directly exercised; treated as unproven.
- **[blocked]** — could not be verified, with the specific blocker named.

> **Headline:** the plugin passes local conformance, reaches the live deployment, and the
> backend's root-route failure is fixed in production (`/` now 200, was 500).
> **No x402 payment has ever completed, no ticket has ever been issued, and nothing has
> been uploaded or submitted to the PayBox portal.** The project is **not submitted.**

---

## 1. Requirements passed, with evidence

Requirements are from <https://developer.paybox.sh/requirements.md>, read in this
session. "Local conformance" means the starter's own gate (`pnpm test`), which runs
typecheck, a deterministic build, schema validation and a sample tool call.

### Protocol, artifact and tool discovery

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | Standard TypeScript MCP server, bundled to one `plugin.mjs` | **[verified]** | `src/plugin.ts` → esbuild → single `dist/plugin.mjs`; build reported `dist/plugin.mjs 394.5kb` |
| 2 | Protocol version `2026-07-28` | **[verified]** | Gate report `"protocolVersion":"2026-07-28"`; pinned as `PROTOCOL_VERSION` in `src/plugin.ts:8` and in `manifest.json` |
| 3 | Starter release 1.0.2 toolchain | **[verified]** | Gate report `"starterVersion":"1.0.2"`, `"toolchain":{"node":"24.21.0","platform":"darwin","arch":"arm64"}` |
| 4 | Node.js 24.21.0 (the version CI uses) | **[verified]** | Ran the gate on nvm-installed 24.21.0; `node --version` → `v24.21.0` inside the run |
| 5 | Bundle ≤ 10 MiB, UTF-8 | **[verified]** | 403,922 bytes — 3.9% of the limit |
| 6 | Tool discovery returns the declared tools | **[verified]** | `"discoveredToolCount":4` — `search_events`, `get_ticket_options`, `purchase_ticket`, `get_order_status` |
| 7 | Build is deterministic | **[verified]** | Two consecutive full gate runs produced byte-identical size and hash; the hash also matches `shasum -a 256 dist/plugin.mjs` on disk |
| 8 | `status: "passed"` with no failure `code` | **[verified]** | `"status":"passed"`, no `code` field present |
| 9 | `paybox-plugin.json` names one successful sample tool + arguments | **[verified]** | `{"tool":"search_events","arguments":{"genre":"Afrobeat"}}`, and the gate's `"sampleCall":{"tool":"search_events","status":"passed"}` |
| 10 | Keep discovery free of side effects | **[verified]** | `createServer()` only registers tools; no I/O at module scope. Confirmed live: the hosted discovery test passed with no writes |
| 11 | Log to stderr; stdout reserved for MCP messages | **[verified]** | `grep -rn "console\.(log\|info\|warn\|error\|debug)" src/` → no matches; stdout carries only `serveStdio` output |

### Secrets and credentials

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 12 | Never bundle secrets | **[verified]** | Scanned `dist/plugin.mjs` for every non-empty value in the API's live `.env`: **zero** present. Regex sweep for `postgres://` / `postgresql://`, URLs with userinfo, PEM private keys, `sk-…`, `AKIA…`, ≥64-char hex, and JWTs: **none matched** |
| 13 | Non-sensitive config via environment variable | **[verified]** | The artifact's only `process.env` reads are `EVENTPASS_API_URL` and `EVENTPASS_LOCAL` — a URL and a boolean, both non-sensitive (`src/eventpass.ts:29-34`) |
| 14 | The plugin does not read secrets from `process.env` | **[verified]** | No credential is read at all. The read endpoints are unauthenticated; brokered headers are not used. The API's `TICKET_SECRET`, `ORGANIZER_KEY` and `DATABASE_URL` exist only server-side |
| 15 | Never log or return secrets | **[verified]** | See #12; plus the drift path below (#20) which never echoes a payload |
| 16 | Bounded requests (e.g. a four-second fetch timeout) | **[verified]** | `REQUEST_TIMEOUT_MS = 4_000` with `AbortSignal.timeout` (`src/eventpass.ts:6,46`) |
| 17 | Network calls kept out of startup and discovery | **[verified]** | No fetch outside tool handlers; discovery is side-effect free (#10) |

### x402 payment proposals

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 18 | Return the request under `io.paybox/transactionProposal`, declared in the output schema | **[verified]** | `proposeX402` builds the envelope; `x402OutputSchema` declares the property; local e2e scene 3 produced a proposal the harness read back by that key |
| 19 | `maxAmount` a positive integer string in atomic USDC units | **[verified]** | `atomicAmount(order.totalAtomic)`, never a float. Local e2e: `maxAmount 19000000` for 2 × 9.50 USDC |
| 20 | USDC on Base, `eip155:8453`, asset `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` | **[verified]** | `NETWORK = "eip155:8453"` (`src/plugin.ts:9`); asset asserted in the API suite and returned in the 402 challenge |
| 21 | Expiry within five minutes | **[verified]** *by construction* | The `proposeX402` helper supplies its own four-minute expiry; the plugin never passes `expiresAt`, so it cannot extend it. **[assumed]** that the helper's implementation is correct as documented — I did not re-derive it from the bundle |
| 22 | The proposal amount is the reserved price, not a caller-supplied price | **[verified]** | `purchase_ticket` uses `order.totalAtomic` from the API's own reservation. The suite asserts the 402 challenge's `maxAmountRequired` equals `order.totalAtomic` |
| 23 | Do not put the proposal in an `isError` result | **[verified]** | `purchase_ticket` returns the proposal in `structuredContent`; the over-budget path returns an error *and* cancels the reservation instead of emitting a proposal |
| 24 | Poll the returned request ID; do not re-run the plugin to finish payment | **[verified]** | Tool text: *"Do not call purchase_ticket again to poll."*; `get_order_status` is the documented poll path |
| 25 | HTTPS on port 443 for the payment resource URL | **[verified]** | Four tests in `test/payment-origin.test.mjs` assert an `https://` origin with no port generates a conforming `payUrl`, and that plain-http public and `https://…:8443` origins are refused. In Production, `PUBLIC_BASE_URL` is confirmed set to `https://eventpass-api.vercel.app` — `https:` scheme, no explicit port, therefore 443. Verified **without creating an order**, as instructed. The refusal path itself was not triggered in production (that would require a misconfigured origin) |
| 26 | No secrets in the payment URL or body | **[verified]** | The pay URL is `${origin}/v1/orders/{id}/pay` with no query string and no header; order ids are random 128-bit hex |

### Transaction-proposal hygiene

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 27 | Canonical chain id, no wallet IDs, signing keys, approval modes, signatures, RPC URLs or broadcast instructions | **[verified]** | The plugin emits only `chain`, `url`, `maxAmount` and the helper's envelope. It receives no wallet selection and has no signing path |
| 28 | Never ask for a private key | **[verified]** | No input schema has a key/secret/mnemonic field; `search_events`, `get_ticket_options`, `purchase_ticket`, `get_order_status` accept only event/order identifiers, a quantity, a budget and an optional holder name |
| 29 | A signed payload alone is not execution success | **[verified]** | `get_order_status` reports `tickets_issued` only from the API's order record, which the API sets only from a verified settlement |

### Ticket issuance (project policy, not a PayBox requirement)

The requirements document contains **no** requirement about ticket issuance — I checked,
and it does not describe tickets at all. This is the project's own rule, so it is audited
against the standing constraint *"Never issue a ticket simply because a payment was
proposed, signed, or submitted."*

| # | Rule | Verdict | Evidence |
|---|---|---|---|
| 30 | No ticket on proposal, signature or submission | **[verified]** | `tickets_issued` is written only in the API's settlement path (`lib/store-postgres.mjs:269`), guarded by `where status = 'awaiting_payment'` so a replay cannot double-issue. The live hosted test asserts `tickets: []` and `status: awaiting_payment` after an unpaid 402 probe |
| 31 | No ticket has ever been issued in production | **[verified]** | Live `/healthz` reports `"orders":12,"tickets":0` — twelve orders created, zero tickets ever issued |

---

## 2. Fixes applied in this pass

Working code was not rewritten; each change is surgical and the pre-existing suites
still pass.

### 2.1 Package name

`package.json` `"name": "my-plugin"` → `"name": "eventpass"`.
The MCP server already identified itself as `{ name: "eventpass", version: "1.0.0" }`
(`src/plugin.ts:211`), so the manifest now matches the identity the plugin advertises.

*Observed, not a failure:* `manifest.json` still lists the starter's pristine checksums
for `package.json` and `src/plugin.ts`. Those two files are exactly the ones the starter
instructs you to edit, so this is expected — and the gate passes with it. Worth watching
at upload; if the portal's own preflight rejects it, that is the cause.

### 2.2 Explicit payment origin, and refusing an origin that cannot carry a payment

`server.mjs` resolved the x402 resource origin from the request
(`req.protocol` + `Host`), which on Vercel depends on `trust proxy` and
`X-Forwarded-Proto` being right. If they are not, the plugin generates a `payUrl` the
PayBox sandbox cannot fetch, and the failure is invisible from this side.

- `PUBLIC_BASE_URL` now takes precedence when set, with trailing slashes normalised.
- A new `payOriginOf(req)` validates the resolved origin **before any work happens**:
  it must be `https:` on the default port (or explicit `:443`). A plain-http public host
  or `https://…:8443` is refused with a 500 naming the requirement. Loopback
  (`localhost`, `127.0.0.1`, `[::1]`) stays payable over plain http, because that is where
  local development runs.
- A malformed `PUBLIC_BASE_URL` is refused **without echoing the value** — it could carry
  credentials in its userinfo, and the error body is public.
- The validation is split from URL construction (`payOriginOf` vs `payUrlOf`) and called
  **before `store.reserve`**. Had it been one function, a misconfigured deployment would
  have held a ticket for the full hold window while returning 500. A test asserts zero
  orders are held after a refused sale.
- Other `baseUrlOf` callers (dashboard links, organizer QR) were deliberately left lenient:
  they are not payment resources, and tightening them would break working endpoints.

New file `test/payment-origin.test.mjs`, 4 tests, all passing.

### 2.3 Root route `500 FUNCTION_INVOCATION_FAILED`

**Root cause, from the Vercel build logs** — not a guess:

```
Invalid export found in module "/var/task/server.mjs". The default export must be a function or server.
```

Vercel's zero-config Node/Express preset auto-detected the repository's root `server.mjs`
(which has only named exports: `createEventPass`, `app`) as the project's root function,
registering it as `@vercel/node:.`. Route evaluation runs `{"handle":"filesystem"}`
**before** `rewrites`, so `/` was served by that broken root function instead of falling
through to the working `/(.*) → /api/index` rewrite. `/healthz` and `/dashboard` were
unaffected because neither is a file on disk and neither is `/`.

**Fix:** `"framework": null` added to `vercel.json`, with every other key unchanged.
This disables framework-preset detection so only the explicit `api/index.mjs` entrypoint
is built.

Two other approaches were tried and **rejected** rather than shipped:

1. Legacy `builds` — produced exactly one function, but renamed it `api/index.mjs.func`
   and dropped the `^/api/(.+)(?:\.(?:mjs))$` normalisation route. A routing risk for no gain.
2. Moving `server.mjs` → `lib/app.mjs` — does **not** work. The preset falls back to
   `package.json` `main`, and removing `main` makes the build fail outright
   (*"No entrypoint found. Searched for: app.{js,cjs,mjs,…} - index.{…} - server.{…} - src/…"*).
   **That experiment — the file move plus the `main` edit — was fully reverted**, and
   `README.md` and `test/serverless.test.mjs` prose restored. (The §2.2 change to
   `server.mjs` is separate and does stand.)

   Confirmed by diff against a pre-§2.2 backup: the only difference in `server.mjs` is
   the §2.2 insertion plus two one-line call-site substitutions — a pure addition, with
   no existing logic rewritten:
   ```
   89a90,134    + LOOPBACK_ORIGIN, payOriginOf(), payUrlOf()
   193a239,242  + const payOrigin = payOriginOf(req);   // before store.reserve
   209c258      - payUrl: `${baseUrlOf(req)}/v1/orders/${order.orderId}/pay`
                + payUrl: payUrlOf(payOrigin, order.orderId)
   227c276      - const resourceUrl = `${baseUrlOf(req)}/v1/orders/${order.orderId}/pay`
                + const resourceUrl = payUrlOf(payOriginOf(req), order.orderId)
   ```
   In `vercel.json`, the sole difference from the original is the added `"framework": null`.

**[verified] locally:** `npx vercel build --yes` now emits exactly one function and the
route table resolves `/` correctly:

```
functions/  api          (only entry)
static/     dashboard.html
routes:     [{handle: filesystem}, {src: "^(?:/(.*))$", dest: "/api/index", check: true}, …]
```

**[verified] in Production** (2026-10-17 00:37 UTC): deployed as
`dpl_DhBEMQSqKN9erNbWUNwKcn4teNbu` (`READY`, target `production`). `/` now returns **200**
instead of 500, serving the API index JSON — see §3.5.

### 2.4 Hardened tool outputs

`get_ticket_options` and `get_order_status` (and `search_events`, for consistency) now
`safeParse` live responses against the **exact schema they advertise**, hoisted to module
scope (`searchOutput`, `ticketOptionsOutput`, `orderStatusOutput`) so the validator and
the published schema cannot drift apart.

On a mismatch the tool returns a sanitized `isError` via a `drift()` helper that:

- **never echoes the payload** — it is remote data that could carry anything;
- reduces every reported name to `[A-Za-z0-9_.-]`, capped at 40 chars, max 6 names, so no
  key or issue path can smuggle SQL, a credential or a control character into the agent's
  context;
- names the endpoint and the likely cause (API/plugin drift).

`purchase_ticket` was deliberately left untouched: it is the money path, its response is
already consumed field-by-field, and changing it was not required.

**`"paid"` removed from the order-status enum.** This is not a legitimate API state —
proven by the database itself (`lib/schema.mjs:42`):

```sql
status text not null check (status in ('awaiting_payment','tickets_issued','expired','cancelled','failed'))
```

The string `"paid"` appears nowhere in `lib/`, `server.mjs` or `test/`. `"failed"` was
**kept**, because that same CHECK constraint reserves it — dropping it would turn a future
legitimate order into a hard error, the more expensive of the two mistakes.

**Drift path verified end to end** against a stub API returning malformed payloads. All
five cases returned sanitized `isError` messages and **no leak** (a connection string
injected into `status` did not appear in the output):

| Injected fault | Reported |
|---|---|
| wrong enum literal (`currency: "EUR"`) | `Mismatched or unexpected field(s): currency.` |
| unexpected extra field | `Mismatched or unexpected field(s): surpriseField.` |
| missing required field | `Mismatched or unexpected field(s): purchaseNote.` |
| removed `"paid"` status | `Mismatched or unexpected field(s): status.` |
| `status` carrying `postgres://user:pw@host/db` | `Mismatched or unexpected field(s): status.` — **no leak** |

> **Correction to an earlier note in this session.** A first run of this probe showed the
> `paid` case listing six fields. That was a bug in my throwaway probe
> (`JSON.stringify` of a `Promise` serialises to `{}`, so the stub returned an empty
> object), **not** a plugin fault. After fixing the probe, the case reports exactly
> `status`, as it should. The plugin behaviour was correct throughout.

---

## 3. Verification results

### 3.1 Local — plugin gate

On Node 24.21.0 (nvm), via `pnpm test` (typecheck + deterministic build + conformance):

```json
{"reportVersion":1,"starterVersion":"1.0.2","protocolVersion":"2026-07-28",
 "toolchain":{"node":"24.21.0","platform":"darwin","arch":"arm64"},
 "status":"passed","sampleCall":{"tool":"search_events","status":"passed"},
 "artifact":{"bytes":403922,
   "sha256":"f290f6827e6b58aff6f83c148f389065ac68ccb6cb37f49fe93e502b225fed02"},
 "discoveredToolCount":4}
```

- `discoveredToolCount: 4` — **exactly four tools**, as required. **[verified]**
- Determinism: two consecutive runs, identical `bytes` and `sha256`; the on-disk file
  matches (`403922`, same hash). **[verified]**
- `tsc --noEmit` clean. **[verified]**
- `pnpm install --frozen-lockfile` still resolves after the §2.1 rename
  (`Already up to date`, pnpm v11.11.0). The lockfile keys importers by path (`.`), not by
  package name, so the rename cannot invalidate it. **[verified]**
- `pnpm --version` → `11.11.0`, matching the pinned `packageManager` and `engines`. **[verified]**

### 3.2 Local — API suite

`node --test test/*.test.mjs` on Node 24.21.0:

```
tests 80 | pass 74 | fail 0 | cancelled 0 | skipped 6 | duration_ms 2529
```

The 6 skips are `test/live.test.mjs`, gated behind `EVENTPASS_LIVE=1` by design.
**[verified]**

### 3.3 Local — end-to-end harness (`pnpm e2e`)

Drives the built `dist/plugin.mjs` over MCP stdio against a local API, playing PayBox's
part. All six scenes passed **[verified]**:

1. discovery — found "AfroGroove Fest", 50 tickets left
2. tier comparison — GA 8.00 + 1.50 fee = 9.50 USDC
3. purchase within budget — proposal `maxAmount 19000000` atomic on `eip155:8453`
4. **over-budget refusal — declined, nothing charged, 2 held tickets released**
5. settlement → issuance — 2 tickets, receipt 19.00 USDC
6. redemption — first scan admitted, second rejected as already redeemed

> **Scene 5 is a simulated settlement, not a real payment.** The harness settles the order
> through the API's own organizer endpoint against a local throwaway database with a
> placeholder `payTo`. It is a fixture that proves the plugin's post-settlement collection
> path works. It is **not** evidence that a USDC payment can or did succeed.

### 3.4 Hosted — read-only tests against the deployment

`EVENTPASS_LIVE=1`, run against `https://eventpass-api.vercel.app` — 4 tests, **all pass**
**[verified]**:

- ✔ the deployment is up and reports its configuration honestly
- ✔ discovery answers with live inventory
- ✔ **the built artifact reaches the deployment with no environment configured** — the
  shipped bundle returned `source: "live"`, *not* its bundled catalogue fallback
- ✔ an unknown order is a plain 404 with no hint about near misses

**Two live tests were deliberately not run:** *"the payment gate is read-only-probeable"*
and *"an order created by one request is visible to the next"*. Each creates a production
order, and — see below — those orders are **durable**, so this would have written
permanent rows to the production database. Your instruction was *"Do not create a
production order merely to inspect the URL."* I therefore did not create any. This is a
gap in coverage, not a pass.

> **Discrepancy found.** `test/live.test.mjs:16-17` states the deployed instance "holds its
> inventory in memory" and that its reservations "are ephemeral and disappear with the
> instance." That is **no longer true**: live `/healthz` reports `"storage":"postgres"`.
> The comment is stale and understates the cost of running that suite. Worth correcting
> before anyone runs it against production.

### 3.5 Hosted — route probe

**After** the §2.3 fix was deployed (2026-10-17 00:37 UTC) — all four routes **[verified]**:

| Route | Before fix | After fix |
|---|---|---|
| `/` | **500** `FUNCTION_INVOCATION_FAILED` | **200** — API index JSON |
| `/healthz` | 200 | 200 |
| `/dashboard` | 200 | 200 |
| `/v1/events` | 200 | 200 |

`/healthz` body after the deploy **[verified]**:

```json
{"ok":true,"storage":"postgres","orders":12,"tickets":0,"events":1,
 "x402":{"payToConfigured":true,"facilitatorConfigured":true,"version":2}}
```

The two `x402` booleans flipped from `false` to `true` because the production environment
gained `X402_PAY_TO` and `X402_FACILITATOR_URL` before this deploy and the running
instance now reads them. Note what that proves: `payToConfigured` is
`Boolean(config.payTo)` and `payTo` is a raw `env.X402_PAY_TO` pass-through
(`server.mjs:57,207`) — **no format validation**. So `true` confirms the variables are set
and non-empty, and nothing more. A malformed address would also report `true` and would
fail only at payment time. Validity is unverified — see §7 #10.

`orders` is still 12 and `tickets` is still 0: this audit created no orders and no ticket
has ever been issued in production.

### 3.6 Secret scan of the shipped artifact

Against the live `.env` and pattern sweep (§1 #12): **no secret present.** `dist/plugin.mjs`
is the only file the portal wants uploaded. **[verified]**

---

## 4. Portal configuration

### Done

- **`PUBLIC_BASE_URL=https://eventpass-api.vercel.app` set in Vercel Production
  [verified]** (created before the deploy; read back via `vercel env pull`). The
  deployment was made after it existed, and the value conforms to the HTTPS/443
  requirement.
- **Backend redeployed to Production [verified]** — deployment
  `dpl_DhBEMQSqKN9erNbWUNwKcn4teNbu`, `readyState: READY`, target `production`. It carries
  both the `framework: null` root-route fix and the explicit payment-origin validation.

### Still required

1. **Set the network host in the portal.** The requirements say hosted payment endpoints
   *"must use a configured network host."* Add **`eventpass-api.vercel.app`** as a network
   host (exact hostname, HTTPS). Without this the sandbox cannot fetch the x402 resource
   even though the URL is now correct. **[assumed]** — I cannot see the portal's host list,
   so I cannot confirm whether this is already configured. This is the most likely
   remaining blocker after upload.
2. **Confirm `X402_PAY_TO` and `X402_FACILITATOR_URL` are valid, not merely present.**
   They *are* set in Production — the live runtime reports `payToConfigured: true` and
   `facilitatorConfigured: true` **[verified]**. But the CLI redacts Sensitive values
   (`[SENSITIVE]` on pull), so I could not read them, and the health check performs no
   format validation (§3.5). **Verify in the Vercel dashboard** that `X402_PAY_TO` is a
   well-formed `0x`-prefixed receiving address you control and `X402_FACILITATOR_URL` is a
   reachable Base-mainnet facilitator. Their *correctness* is unverified. **[blocked]** on
   the values being redacted from the CLI.
   **No real payment was initiated or settled to test this.**
3. **Set `EVENTPASS_API_URL`** as a non-sensitive variable in the portal's
   Variables & Secrets, pointing at the same origin. **[assumed]** recommended, not a
   blocker: the bundle already defaults to the deployed host, and §3.4 proves that default
   works with *no* variable set.
4. Upload `dist/plugin.mjs` and run the hosted checks + a sample call.
5. Validate a transaction proposal with an active wallet, then accept the hackathon terms
   and select **Submit Project**.

### Deadline

Portal closes **Saturday 2026-10-17, 20:00 EDT** — currently **~24 hours away** (now is
2026-10-16 19:25 EDT). Uploads and submission must happen before then; afterwards only
viewing, testing, and edits to network access / variables / secrets are permitted.

---

## 5. Deployment and submission status

- **Plugin: not uploaded, not submitted. [verified — by absence: I performed no upload.]**
  Local conformance is a separate check from hosted testing and from submission, and the
  requirements are explicit that *"passing checks does not submit your project."*
- **Backend: deployed to Production and reachable. [verified]** `/`, `/healthz`,
  `/dashboard` and `/v1/events` all return 200 (§3.5).
- **The §2.3 root-route fix is deployed and confirmed** — `/` returns 200. **[verified]**
- **The §2.2 origin fix is deployed**, and `PUBLIC_BASE_URL` is set in Production to an
  HTTPS origin with no explicit port. **[verified]**
- **Hosted PayBox conformance has never been run.** Only local conformance has. These are
  different checks and local success does not imply hosted success — local tests run with
  your OS access and do not exercise the sandbox, brokered credentials, or approval.
  **[blocked]** on the upload in §6.
- **No real USDC transaction has been initiated, and none has ever completed.** No mainnet
  payment was attempted; production still shows **12 orders and 0 tickets** after the
  deploy. **[verified]**

### What must happen next, in order

1. ~~Set `PUBLIC_BASE_URL` and redeploy~~ — **done**, §4.
2. Confirm the x402 variable *values* in the dashboard (**§4.2**).
3. Add the network host in the portal (**§4.1**).
4. Upload `dist/plugin.mjs` → run hosted checks → sample call (**§6**).
5. Validate the transaction proposal with a wallet.
6. Accept the terms and **Submit Project** — before 2026-10-17 20:00 EDT.

---

## 6. Upload and hosted-testing steps for the new artifact

Artifact to upload: **`dist/plugin.mjs`** — 403,922 bytes,
`sha256 f290f6827e6b58aff6f83c148f389065ac68ccb6cb37f49fe93e502b225fed02`.

### Before uploading

1. Rebuild so the file on disk is the one the checks ran against — the gate already does
   this, so just confirm the hash matches the line above:
   ```bash
   cd /Users/hi/eventpass-plugin
   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"   # Node 26 fails the gate
   pnpm test && shasum -a 256 dist/plugin.mjs
   ```
2. In the portal, set the network host **`eventpass-api.vercel.app`** (§4.1) and, if you
   want it explicit, the non-sensitive variable `EVENTPASS_API_URL` =
   `https://eventpass-api.vercel.app` (§4.3).
3. Confirm `paybox-plugin.json` still names a working sample call — it is
   `{"tool":"search_events","arguments":{"genre":"Afrobeat"}}` and the gate recorded
   `"sampleCall":{"tool":"search_events","status":"passed"}`. **[verified]**

### Uploading

4. **Upload `dist/plugin.mjs` only.** Not the source, not a source map, not
   `package.json`, not `.env`, not `node_modules`. The requirements are explicit:
   *"Upload only dist/plugin.mjs."*
5. Let the upload's own checks run. A new upload must pass its own checks — a pass on an
   older version says nothing about this one. Discovery may run in a fresh process, so the
   plugin must not depend on memory persisting; it doesn't (every fact comes from the API).
6. **Reload the tool list after the upload.** Tool lists expire after 10 minutes, and
   discovery only covers the currently displayed upload.

### Hosted testing

7. Run the hosted checks, then trigger the sample call. The plugin logs nothing to stdout
   — only MCP messages — and reads no credential from `process.env`, so there is no secret
   for the console to withhold.
8. Confirm the sample call returns live data: the tool text should report events found
   from `eventpass-api.vercel.app`, not the bundled catalogue. §3.4 already proves the
   bundle resolves to the deployment with **no** environment configured.
9. If you exercise `purchase_ticket`: it proposes a payment, and **nothing is charged until
   you approve it in the transaction window**. The sandbox ends *before* payment — to read
   the paid response you must make a new explicit plugin call (`get_order_status`); do not
   re-run `purchase_ticket` to poll.
10. Validate the transaction proposal with an active wallet if you want pre-flight
    confirmation. Each result validates once, within five minutes and before the proposal
    expires, and any settings or upload change requires a fresh result. **Simulation success
    does not establish economic safety or guarantee later execution.**
11. Rate limits: one start per second and 1,000 per rolling 24 hours; transaction
    validation is one active at a time and 30 per hour. Every run needs an explicit click —
    PayBox never auto-retries.

> **This audit created no production orders and settled no payment.** Steps 9–10 are
> optional and are yours to run; if you do run them, a **real USDC payment is required to
> reach `tickets_issued`**, and that is outside what I was authorized to do.

### Submitting

12. Accept the MoonPay Hackathon Terms & Conditions and select **Submit Project**.
    *"Uploading alone does not enter your project in the hackathon."* and *"Passing checks
    does not submit your project or grant security approval."*
13. Do this **before 2026-10-17 20:00 EDT**. After the deadline only viewing, testing, and
    edits to network access / variables / secrets are permitted — no further uploads or
    submissions.

**[blocked]** Steps 4–13 are portal actions I cannot perform; I have no PayBox portal
session. Nothing above has been executed, so the plugin remains **unsubmitted**.

## 7. Known limitations

1. **Real x402 payments are configured but have never been exercised.** `payTo` and
   `facilitator` are both set in Production (§3.5), so this is no longer the "nothing is
   configured" state — but **no payment has ever been completed**, so the end-to-end money
   path is entirely unproven. It has been exercised only against the API's own simulated
   settlement (§3.3) and a read-only 402 challenge probe. **A real purchase has never been
   shown to work**, and this audit does not claim it does. This remains the single largest
   gap, and it is now a gap in *testing* rather than in *configuration*.
2. **The payment-origin refusal path was never triggered in production.** §2.2's tests
   prove the code path and the configured value conforms, but no production order was
   created to observe a generated `payUrl` (as instructed), and the refusal branch only
   fires on a misconfiguration that no longer exists.
3. **Two live tests were not run** (§3.4), so "an order is visible to a later request" is
   unverified against production. §3.4 shows the store is Postgres, and 12 orders exist,
   which is consistent with it working — but that is inference, not a test result.
4. **`test/live.test.mjs`'s in-memory claim is stale** (§3.4) and understates the cost of
   running that suite against production.
5. **`manifest.json` checksums no longer match the edited starter files** (§2.1). Expected,
   since those are files the starter tells you to edit, and the gate passes — but unproven
   against the portal's own preflight.
6. **The API's inventory is in a database whose persistence I did not independently
   verify** beyond `/healthz` reporting `"storage":"postgres"`. **[assumed]** that this
   means orders survive instance recycling — the 12 surviving orders are consistent with
   it, but I did not force a cold start to prove it.
7. **Four tools, no pagination.** Discovery returns all four at once, well within the
   16-per-page / 256-total limits, so cursor handling is untested (and unused).
8. **`/`'s fix relies on `"framework": null`**, which disables framework-preset detection
   for the whole project. Verified locally by reproducing Vercel's build, **and now
   confirmed in production**: `/` returns 200 and the other three routes are unaffected.
9. **One documented x402 ambiguity remains unhedged in code.** `maxAmount` is documented
   both as *"a positive decimal string in the asset's smallest units"* and as *"a positive
   integer in atomic USDC units."* The plugin emits the integer form, which satisfies both
   readings for whole atomic units, and the API suite asserts the 402 challenge agrees.
10. **The x402 credentials' *values* are unverified.** The runtime reports both as
    configured (§3.5), but that check is a truthiness test with no format validation, and
    the CLI redacts Sensitive values. A wrong-but-present address would look identical to a
    correct one until a real payment is attempted. This is the highest-risk unverified item
    in this audit, because it fails silently and only at payment time.

---

## 8. Reproducing this audit

Older Node will fail the conformance gate — this Mac defaults to Node 26.

```bash
# Plugin gate (must be Node 24.21.0)
cd /Users/hi/eventpass-plugin
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
pnpm install --frozen-lockfile
pnpm test                      # → status: passed, discoveredToolCount: 4
shasum -a 256 dist/plugin.mjs  # → f290f6827e6b58aff6f83c148f389065ac68ccb6cb37f49fe93e502b225fed02

# API suite (includes the 4 payment-origin tests)
cd /Users/hi/eventpass-api
node --test test/*.test.mjs    # → 80 tests, 74 pass, 0 fail, 6 skipped

# Local end-to-end: plugin → API → simulated settlement → tickets
pnpm e2e

# Confirm the Vercel build emits one function and resolves /
rm -rf .vercel/output && npx vercel build --yes
find .vercel/output/functions -maxdepth 1 -mindepth 1   # → api

# Hosted, read-only only (creates no orders)
EVENTPASS_LIVE=1 node --test --test-timeout=90000 \
  --test-name-pattern "up and reports|discovery answers|built artifact reaches|unknown order" \
  test/live.test.mjs
```

`EVENTPASS_LIVE=1 pnpm test:live` runs the **full** live suite and **will create durable
production orders** in Postgres. Run it only with explicit authorization.
