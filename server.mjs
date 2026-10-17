import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import QRCode from "qrcode";

import { centsToAtomic, centsToUsdc } from "./lib/money.mjs";
import { createStore, HttpError, NETWORK, orderView } from "./lib/store.mjs";
import { createPostgresStore } from "./lib/store-postgres.mjs";
import { createPgDriver } from "./lib/drivers/pg.mjs";
import {
  BASE_CAIP2, USDC_BASE, buildChallenge, paymentResponseHeader,
  readPaymentPayload, resolveFacilitator, selectRequirement, settlePayment, validatePaymentPayload, verifyPayment,
} from "./lib/x402.mjs";
// TEMPORARY — the $0.10 x402 smoke test. Remove with the routes below.
import { SMOKE_AMOUNT_USDC, probeFacilitatorAuth, settleSmoke, smokeChallenge, smokeConfig, smokeReport } from "./lib/x402-smoke.mjs";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");

const isServerless = (env) => Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME);

/**
 * Tickets are signed with this, so a *fixed* fallback would be catastrophic in a
 * public deployment: it is in the published source, and every host that forgot
 * to set the variable would look perfectly healthy while signing with a value
 * anyone can read. (Forging a code still needs an existing 80-bit ticket id, so
 * the exposure is narrow rather than open — but "narrow and public" is not a
 * property a signing key should have.)
 *
 * So there is no shared default in production: the process refuses to start.
 * Locally a random secret is minted per process instead, which is safe — tickets
 * issued before a restart stop verifying, rather than becoming forgeable.
 */
function resolveTicketSecret(env) {
  if (env.TICKET_SECRET) return { secret: env.TICKET_SECRET, ephemeral: false };
  if (isServerless(env) || env.NODE_ENV === "production") {
    throw new Error(
      "TICKET_SECRET is required on a deployed instance. Set it to 32 random bytes " +
      "in the host's environment variables; ticket codes are signed with it.",
    );
  }
  return { secret: randomBytes(32).toString("hex"), ephemeral: true };
}

/**
 * Builds the EventPass API. Configuration is read from `env` so tests can inject
 * a stub facilitator without touching the process environment.
 *
 * Storage is chosen here and nowhere else: `DATABASE_URL` selects the Postgres
 * adapter, anything else falls back to the in-process store. Both satisfy the
 * same interface, so no route changes between them.
 */
export async function createEventPass(env = process.env) {
  const { secret: ticketSecret, ephemeral } = resolveTicketSecret(env);
  const config = {
    ticketSecret,
    ticketSecretEphemeral: ephemeral,
    organizerKey: env.ORGANIZER_KEY,
    payTo: env.X402_PAY_TO,
    x402Version: Number(env.X402_VERSION ?? 2),
    holdMinutes: Number(env.ORDER_HOLD_MINUTES ?? 15),
    databaseUrl: env.DATABASE_URL,
    // One authentication mode is chosen here, at boot, and never rebuilt per
    // request — see `resolveFacilitator` for the precedence rules.
    facilitator: resolveFacilitator(env),
  };

  let driver;
  let store;
  if (config.databaseUrl) {
    driver = createPgDriver(config.databaseUrl);
    store = await createPostgresStore({ driver, secret: config.ticketSecret, holdMinutes: config.holdMinutes });
    config.storage = "postgres";
  } else if (isServerless(env)) {
    // The in-process store is a per-instance copy of the world. On a serverless
    // platform that means a cold start begins with full inventory again and two
    // concurrent instances each keep their own — the second sale of the same seat
    // succeeds, and the first buyer's order simply vanishes. There is no request
    // this can serve correctly, so it refuses rather than looking healthy while
    // quietly doing the wrong thing.
    throw new Error(
      "DATABASE_URL is required on a serverless deployment. Without it every instance " +
      "holds its own inventory and loses all orders on a cold start. Set DATABASE_URL " +
      "to a pooled PostgreSQL connection string.",
    );
  } else {
    store = createStore({ secret: config.ticketSecret, holdMinutes: config.holdMinutes });
    config.storage = "memory";
  }

  const baseUrlOf = (req) => (env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

  /**
   * The origin this deployment's x402 resource URLs are built on, validated.
   *
   * PayBox requires HTTPS on port 443, and the plugin's `proposeX402` refuses
   * anything else before a proposal is ever shown. So an origin that cannot carry
   * a payment is rejected here, where the cause is known and nameable, rather than
   * surfacing later as a plugin-side rejection the operator cannot act on.
   *
   * `PUBLIC_BASE_URL` is the explicit answer. Without it the origin is inferred
   * from `req.protocol`, which is `https` only because `trust proxy` is enabled
   * and the platform sends `X-Forwarded-Proto` — a chain that is invisible when it
   * breaks, so the result is checked rather than trusted. Loopback is exempt:
   * plain http on 127.0.0.1 is how this runs locally and never reaches PayBox.
   *
   * This is deliberately separate from `payUrlOf` and callable before any work is
   * done: a misconfigured deployment must fail before it reserves inventory, or it
   * would hold a seat for the full hold window while returning a 500.
   */
  const LOOPBACK_ORIGIN = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

  function payOriginOf(req) {
    const origin = baseUrlOf(req);
    let url;
    try {
      url = new URL(origin);
    } catch {
      // Never echo the value: PUBLIC_BASE_URL could carry credentials in its
      // userinfo, and this response is public.
      throw new HttpError(500, "The payment origin is not a valid absolute URL. Set PUBLIC_BASE_URL to this deployment's https origin.");
    }
    const local = url.protocol === "http:" && LOOPBACK_ORIGIN.test(url.host);
    const payable = url.protocol === "https:" && (url.port === "" || url.port === "443");
    if (!local && !payable) {
      throw new HttpError(
        500,
        `This deployment's public origin (${url.origin}) cannot carry an x402 payment URL: ` +
        "PayBox fetches it over HTTPS on port 443. Set PUBLIC_BASE_URL to this deployment's https origin.",
      );
    }
    return origin;
  }

  const payUrlOf = (origin, orderId) => `${origin}/v1/orders/${orderId}/pay`;

  const ticketsFor = (order) => store.getTickets(order.ticketIds);
  const viewOrder = async (order, baseUrl) => orderView(order, await ticketsFor(order), baseUrl);
  const close = async () => { if (driver) await driver.close(); };

  /**
   * Serialises payment attempts for a single order inside this process. The
   * guarded UPDATE in `store.settle` is what actually makes double issuance
   * impossible; this exists so two concurrent callers do not both spend a
   * facilitator round-trip settling the same authorization.
   */
  const payChains = new Map();
  function withOrderLock(key, fn) {
    const previous = payChains.get(key) ?? Promise.resolve();
    const run = previous.then(fn);
    const guard = run.then(() => {}, () => {});
    payChains.set(key, guard);
    guard.then(() => { if (payChains.get(key) === guard) payChains.delete(key); });
    return run;
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  // Some hosts hand the function an already-parsed body on a drained stream —
  // API-Gateway-style integrations and runtimes that buffer the request before
  // invoking the handler. body-parser decides whether to read the stream from
  // `_body`, not from `req.body`, so it would then wait on a stream that has
  // already ended and fail every POST with "stream is not readable", while GETs
  // kept working. Marking the request as read preserves the parsed body.
  //
  // Vercel is *not* such a host: this was checked against the live deployment by
  // deploying with the middleware removed, and POSTs still returned 201. So on
  // Vercel this is a no-op. It stays because on a host that does buffer, the
  // failure it prevents is total, cheap to misdiagnose, and costs one pass-through.
  app.use((req, _res, next) => {
    if (req._body !== true && (req.body !== undefined || req.readableEnded === true)) {
      if (req.body === undefined) req.body = {};
      req._body = true;
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));

  const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  // -------------------------------------------------------------- discovery

  app.get("/", (_req, res) => {
    res.json({
      service: "EventPass",
      tagline: "Agent-native ticketing with x402 payments",
      network: NETWORK,
      asset: { symbol: "USDC", address: USDC_BASE },
      endpoints: [
        "GET  /v1/events?city=&genre=&onDate=&maxTicketPriceUsdc=&limit=",
        "GET  /v1/events/:eventId/options",
        "POST /v1/orders                      (reserve inventory, returns payUrl)",
        "POST /v1/orders/:orderId/cancel      (release a reservation)",
        "GET  /v1/orders/:orderId             (status, tickets, receipt)",
        "GET  /v1/orders/:orderId/pay         (x402-gated: 402 -> pay -> tickets)",
        "POST /v1/organizer/redeem            (organizer scan, burns a code once)",
        "GET  /dashboard                      (organizer check-in UI)",
      ],
    });
  });

  app.get("/healthz", route(async (_req, res) => {
    res.json({
      ok: true,
      storage: config.storage,
      ...(await store.stats()),
      x402: {
        payToConfigured: Boolean(config.payTo),
        facilitatorConfigured: Boolean(config.facilitator),
        // Which mode won — a name, never a credential. Makes a 401 diagnosable
        // from outside without reading logs that do not exist.
        authentication: config.facilitator?.auth?.mode ?? "none",
        version: config.x402Version,
      },
    });
  }));

  app.get("/v1/events", route(async (req, res) => {
    const limit = req.query.limit === undefined ? 5 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new HttpError(400, "limit must be an integer from 1 to 20");
    const events = await store.listEvents({
      city: req.query.city,
      genre: req.query.genre,
      onDate: req.query.onDate,
      maxTicketPriceUsdc: req.query.maxTicketPriceUsdc,
      limit,
    });
    res.json({ events, count: events.length });
  }));

  app.get("/v1/events/:eventId/options", route(async (req, res) => {
    res.json(await store.getEventOptions(req.params.eventId));
  }));

  // ----------------------------------------------------------------- orders

  app.post("/v1/orders", route(async (req, res) => {
    const { eventId, tierId, quantity, holderName, idempotencyKey } = req.body ?? {};
    for (const [field, value] of Object.entries({ eventId, tierId })) {
      if (typeof value !== "string" || value.length === 0) throw new HttpError(400, `${field} is required`);
    }
    if (!Number.isInteger(quantity)) throw new HttpError(400, "quantity must be an integer");

    // Resolved before the reservation: a deployment whose origin cannot carry a
    // payment must not hold a seat for the hold window while it fails.
    const payOrigin = payOriginOf(req);

    const { order, reused } = await store.reserve({ eventId, tierId, quantity, holderName, idempotencyKey });
    res.status(reused ? 200 : 201).json({
      orderId: order.orderId,
      status: order.status,
      eventId: order.eventId,
      eventName: order.eventName,
      tierId: order.tierId,
      tierName: order.tierName,
      quantity: order.quantity,
      totalUsdc: centsToUsdc(order.totalCents),
      totalAtomic: order.totalAtomic,
      currency: "USDC",
      network: NETWORK,
      expiresAt: order.expiresAt,
      payUrl: payUrlOf(payOrigin, order.orderId),
      reused,
    });
  }));

  app.post("/v1/orders/:orderId/cancel", route(async (req, res) => {
    const order = await store.cancel(req.params.orderId);
    res.json({ orderId: order.orderId, status: order.status });
  }));

  app.get("/v1/orders/:orderId", route(async (req, res) => {
    res.json(await viewOrder(await store.getOrder(req.params.orderId), baseUrlOf(req)));
  }));

  // --------------------------------------------------------- x402 payment

  app.get("/v1/orders/:orderId/pay", route(async (req, res) => withOrderLock(req.params.orderId, async () => {
    const order = await store.getOrder(req.params.orderId);
    const resourceUrl = payUrlOf(payOriginOf(req), order.orderId);
    const description = `${order.quantity} x ${order.tierName} — ${order.eventName}`;

    // Already paid: replay the issued tickets instead of settling twice.
    if (order.status === "tickets_issued") {
      res.json({ status: order.status, settled: true, ...(await viewOrder(order, baseUrlOf(req))) });
      return;
    }
    if (order.status !== "awaiting_payment") {
      res.status(409).json({ error: `Order ${order.orderId} is ${order.status} and cannot be paid.` });
      return;
    }

    // Refuse loudly rather than issuing tickets against an unverified payment.
    if (!config.payTo || !config.facilitator) {
      res.status(501).json({
        error: "Payment is not configured on this deployment, so no tickets were issued.",
        detail: "Set X402_PAY_TO to the receiving USDC address and X402_FACILITATOR_URL to a Base-mainnet facilitator, then retry.",
        missing: [...(config.payTo ? [] : ["X402_PAY_TO"]), ...(config.facilitator ? [] : ["X402_FACILITATOR_URL"])],
      });
      return;
    }

    // A contradictory authentication configuration fails closed here rather than
    // degrading into an unauthenticated facilitator call that would 401 for a
    // valid key. `problem` is written to contain no secret.
    if (config.facilitator.problem) {
      res.status(503).json({
        error: "Payment authentication is misconfigured on this deployment, so no tickets were issued.",
        problems: [config.facilitator.problem],
      });
      return;
    }

    const challenge = buildChallenge({
      orderId: order.orderId,
      resourceUrl,
      payTo: config.payTo,
      amountAtomic: order.totalAtomic,
      description,
      version: config.x402Version,
    });

    const presented = readPaymentPayload(req.headers);
    if (!presented || presented.error) {
      res.status(402)
        .set("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(challenge), "utf8").toString("base64"))
        .json(presented?.error ? { ...challenge, error: presented.error } : challenge);
      return;
    }

    // Structural and economic checks come first: a payload that does not name the
    // right network, payee, asset, amount or validity window is refused here and
    // never reaches the facilitator or the store.
    const check = validatePaymentPayload({ payload: presented.payload, order, payTo: config.payTo });
    if (!check.ok) {
      res.status(402).json({ ...challenge, error: check.reason });
      return;
    }

    const requirement = selectRequirement(challenge, presented.payload);
    if (!requirement) {
      res.status(402).json({ ...challenge, error: "No advertised payment option matches the presented payload." });
      return;
    }

    const settlementRequest = {
      x402Version: presented.payload.x402Version ?? challenge.x402Version,
      paymentPayload: presented.payload,
      paymentRequirements: requirement,
    };

    let verification;
    try {
      verification = await verifyPayment(config.facilitator, settlementRequest);
    } catch (error) {
      res.status(502).json({ error: `Could not verify the payment: ${error.message}` });
      return;
    }
    if (!verification.isValid) {
      res.status(402).json({ ...challenge, error: verification.invalidReason ?? "Payment verification failed." });
      return;
    }

    let settlement;
    try {
      settlement = await settlePayment(config.facilitator, settlementRequest);
    } catch (error) {
      res.status(502).json({ error: `Payment verified but could not be settled: ${error.message}` });
      return;
    }
    if (!settlement.success) {
      res.status(402).json({ ...challenge, error: settlement.errorReason ?? "Settlement failed." });
      return;
    }

    const settled = await store.settle(order.orderId, {
      transactionHash: settlement.transaction,
      payer: settlement.payer ?? verification.payer,
    });

    res.status(200)
      .set("PAYMENT-RESPONSE", paymentResponseHeader(settlement))
      .json({ status: settled.status, settled: true, ...(await viewOrder(settled, baseUrlOf(req))) });
  })));

  // ------------------------------------------- TEMPORARY x402 smoke test
  //
  // Delete this whole section, `lib/x402-smoke.mjs`, `test/x402-smoke.test.mjs`
  // and `src/plugin.smoke.ts` in the plugin when the $0.10 test is done.
  //
  // It shares nothing with the order flow on purpose: no store call, no
  // reservation, no ticket. `config` is read here only for the x402 version and
  // the payee address; `store` is never touched, so these routes cannot create an
  // order or move inventory even if they are called in a loop.
  //
  // Both routes 404 unless X402_SMOKE_TEST_ENABLED is set, so a deployment with
  // the flag unset is indistinguishable from one without this code.

  const smoke = () => smokeConfig(env);

  app.get("/v1/x402/smoke", route(async (req, res) => {
    const config = smoke();
    if (!config.enabled) { res.status(404).json({ error: "Not found." }); return; }

    const report = smokeReport(config, payOriginOf(req));
    const probe = config.ok ? await probeFacilitatorAuth(config) : { authOk: false, status: null, detail: "Configuration is incomplete, so the facilitator was not called." };
    res.status(config.ok ? 200 : 503).json({ ...report, configured: config.ok, problems: config.problems, probe });
  }));

  app.get("/v1/x402/smoke/pay", route(async (req, res) => {
    const config = smoke();
    if (!config.enabled) { res.status(404).json({ error: "Not found." }); return; }

    // Fail closed before anything else: an unverified configuration must not
    // produce a challenge that looks payable.
    if (!config.ok) {
      res.status(503).json({
        error: "The x402 smoke test is not correctly configured, so no payment was requested.",
        problems: config.problems,
      });
      return;
    }

    const origin = payOriginOf(req);
    const challenge = smokeChallenge({ origin, payTo: config.payTo, version: config.x402Version });
    const presented = readPaymentPayload(req.headers);
    if (!presented || presented.error) {
      // The unpaid challenge. Nothing has been verified, settled or charged.
      res.status(402)
        .set("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(challenge), "utf8").toString("base64"))
        .json(presented?.error ? { ...challenge, error: presented.error } : challenge);
      return;
    }

    const result = await settleSmoke({ config, payload: presented.payload, origin });
    if (!result.ok) {
      const status = result.code === "invalid_payment" || result.code === "invalid_payload" ? 402 : 502;
      res.status(status).json({ ...challenge, error: result.reason, code: result.code });
      return;
    }
    res.status(200).json({
      smokeTest: true,
      settled: true,
      transactionHash: result.transactionHash,
      payer: result.payer,
      payTo: config.payTo,
      network: result.network,
      asset: config.asset,
      amountAtomic: result.amountAtomic,
      amountUsdc: SMOKE_AMOUNT_USDC,
      note: "A USDC transfer settled. No order was created and no ticket was issued.",
    });
  }));

  // ---------------------------------------------------- organizer check-in

  function requireOrganizer(req, res, next) {
    if (!config.organizerKey) {
      res.status(503).json({ error: "Organizer check-in is disabled: set ORGANIZER_KEY on this deployment." });
      return;
    }
    if (req.get("x-organizer-key") !== config.organizerKey) {
      res.status(401).json({ error: "Invalid organizer key." });
      return;
    }
    next();
  }

  app.post("/v1/organizer/redeem", requireOrganizer, route(async (req, res) => {
    const code = req.body?.code;
    if (typeof code !== "string" || code.length === 0) throw new HttpError(400, "code is required");
    const { result, ticket } = await store.redeem(code);
    res.status({ invalid: 404, already_redeemed: 409, void: 409, redeemed: 200 }[result]).json({
      result,
      admitted: result === "redeemed",
      ticket: ticket && {
        ticketId: ticket.ticketId,
        eventId: ticket.eventId,
        tierName: ticket.tierName,
        holderName: ticket.holderName,
        status: ticket.status,
        redeemedAt: ticket.redeemedAt,
      },
    });
  }));

  app.get("/v1/organizer/tickets", requireOrganizer, route(async (req, res) => {
    const eventId = String(req.query.eventId ?? "");
    if (!eventId) throw new HttpError(400, "eventId is required");
    // The QR URLs must be absolute and point at this deployment, not at whatever
    // base URL the store happened to be constructed with.
    res.json({ eventId, tickets: await store.listTicketsForEvent(eventId, baseUrlOf(req)) });
  }));

  // ---------------------------------------------------------- QR + landing

  app.get("/q/:code.svg", route(async (req, res) => {
    const svg = await QRCode.toString(`${baseUrlOf(req)}/t/${req.params.code}`, {
      type: "svg", margin: 1, width: 320, errorCorrectionLevel: "M",
    });
    res.type("image/svg+xml").send(svg);
  }));

  app.get("/t/:code", route((req, res) => {
    const code = req.params.code;
    res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EventPass ticket</title>
<style>
 body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0b0b10;color:#f4f4f6;margin:0;padding:24px;display:flex;justify-content:center}
 .card{background:#15151d;border:1px solid #2a2a38;border-radius:16px;padding:24px;max-width:360px;width:100%}
 img{width:100%;background:#fff;border-radius:12px;padding:12px;box-sizing:border-box}
 code{display:block;word-break:break-all;font-size:11px;color:#9a9ab0;margin-top:12px}
 h1{font-size:18px;margin:0 0 4px} p{color:#9a9ab0;font-size:13px;margin:0 0 16px}
</style></head><body><div class="card">
<h1>AfroGroove Fest</h1><p>Show this QR at the entrance. It redeems once.</p>
<img alt="Ticket QR code" src="/q/${code}.svg"><code>${code}</code>
</div></body></html>`);
  }));

  app.get("/dashboard", (_req, res) => res.sendFile(join(publicDir, "dashboard.html")));

  // ------------------------------------------------------------- fallbacks

  app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));

  app.use((error, _req, res, _next) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    // A body we could not parse is the caller's mistake, not ours. Express attaches
    // the raw body to the error, so it must never be echoed back.
    if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") {
      res.status(400).json({ error: error.type === "entity.too.large" ? "Request body is too large." : "Request body is not valid JSON." });
      return;
    }
    // Anything else is a bug, not a user-facing condition. Log the detail for the
    // operator and return a fixed string: an exception message can carry SQL,
    // constraint names, upstream URLs or credentials, and this response is public.
    console.error(`[eventpass] unhandled ${error?.name ?? "Error"}: ${error?.message ?? error}`);
    if (error?.stack) console.error(error.stack.split("\n").slice(1, 4).join("\n"));
    res.status(500).json({ error: "Unexpected server error." });
  });

  return { app, store, config, close };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file; configuration comes from the host environment.
  }
  const port = Number(process.env.PORT ?? 8787);
  const { app, config, store, close } = await createEventPass();

  // Reservations expire on their own; a slow sweep keeps availability honest even
  // when nobody is reading. Guarded UPDATEs make this safe to run alongside traffic.
  //
  // Serverless has no long-lived process to sweep with, so it is skipped there —
  // it is an optimisation, not a correctness requirement: every store operation
  // expires stale holds before it reads availability (see `expireStale` in
  // lib/store-postgres.mjs and `expireStaleOrders` in lib/store.mjs).
  const serverless = isServerless(process.env);
  const sweeper = store.expireStale && !serverless
    ? setInterval(() => { store.expireStale().catch(() => {}); }, 30_000)
    : undefined;
  sweeper?.unref();

  const server = app.listen(port, () => {
    console.log(`[eventpass] listening on http://127.0.0.1:${port} (storage=${config.storage})`);
    console.log(`[eventpass] payTo=${config.payTo ?? "(unset)"} facilitator=${config.facilitator?.url ?? "(unset)"} x402Version=${config.x402Version}`);
    if (!config.organizerKey) console.warn("[eventpass] ORGANIZER_KEY unset — organizer check-in disabled");
    if (config.ticketSecretEphemeral) console.warn("[eventpass] TICKET_SECRET unset — signing with a random per-process secret; tickets issued now stop verifying on restart");
    if (!config.payTo || !config.facilitator) console.warn("[eventpass] payment unconfigured — the pay endpoint returns 501 and issues no tickets");
    if (config.facilitator?.warning) console.warn(`[eventpass] ${config.facilitator.warning}`);
    if (config.facilitator?.problem) console.warn("[eventpass] payment authentication misconfigured — the pay endpoint returns 503 and issues no tickets");
    if (config.storage === "memory") console.warn("[eventpass] in-memory storage: orders and inventory reset on restart and are not shared between instances");
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      clearInterval(sweeper);
      server.close(async () => { await close(); process.exit(0); });
    });
  }
}

export { centsToAtomic, BASE_CAIP2, USDC_BASE };
