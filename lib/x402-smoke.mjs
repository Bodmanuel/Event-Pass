/**
 * TEMPORARY — $0.10 USDC x402 smoke test. Not part of the EventPass product.
 *
 * This module exists to answer one question that nothing else can: does the
 * payment rail actually work end to end, at a price where a mistake costs ten
 * cents? It is deliberately self-contained. It does NOT import the order store,
 * does NOT reserve inventory, and does NOT issue tickets — it touches exactly
 * one thing, a USDC transfer authorization, and nothing else.
 *
 * Why it is separate from `lib/x402.mjs`: the product's facilitator calls are
 * unauthenticated (`authHeadersFor` sends a bearer token only if one is
 * configured, and none is), while the CDP facilitator this deployment points at
 * requires a short-lived EdDSA JWT. Wiring that into `lib/x402.mjs` would change
 * the purchase flow, which is out of scope here. So the JWT lives here, next to
 * the smoke test that needs it, and the product path is left byte-identical.
 *
 * Delete this file, its routes in `server.mjs`, its test, and `src/plugin.smoke.ts`
 * when the smoke test is done.
 */
import { BASE_CAIP2, USDC_BASE, buildChallenge } from "./x402.mjs";
import { cdpJwt, facilitatorEndpoint, seedFromCdpSecret } from "./cdp-auth.mjs";

/** Exactly $0.10 — 100000 atomic USDC units at 6 decimals. */
export const SMOKE_AMOUNT_ATOMIC = "100000";
export const SMOKE_AMOUNT_USDC = "0.10";
export const SMOKE_RESOURCE_PATH = "/v1/x402/smoke/pay";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/**
 * Loopback is exempt from the HTTPS requirement, exactly as it is for the
 * product's payment origin: a stub facilitator on 127.0.0.1 is how the suite
 * tests this without reaching the network.
 */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

// The CDP JWT lives in ./cdp-auth.mjs and is shared with the production payment
// path. This module does not keep a second copy: two implementations of a
// credential would drift, and the smoke test's job is to exercise the same wire
// behaviour the product uses.

/**
 * Reads the smoke test's configuration and refuses to continue unless every
 * part of it is usable.
 *
 * Fail-closed is the whole point: a smoke test that runs against a half-known
 * configuration would produce a confident result about nothing. Every problem is
 * named by its environment variable, and no value is ever included in a
 * problem — `problems` is served in a public HTTP response.
 */
export function smokeConfig(env = process.env) {
  const problems = [];
  const enabled = ["1", "true", "yes"].includes(String(env.X402_SMOKE_TEST_ENABLED ?? "").trim().toLowerCase());

  const payTo = String(env.X402_PAY_TO ?? "").trim();
  if (!HEX_ADDRESS.test(payTo)) problems.push("X402_PAY_TO is missing or is not a 0x address.");

  const facilitatorUrl = String(env.X402_FACILITATOR_URL ?? "").trim();
  let facilitator;
  if (!facilitatorUrl) {
    problems.push("X402_FACILITATOR_URL is not set.");
  } else {
    try {
      const url = new URL(facilitatorUrl);
      const loopback = url.protocol === "http:" && LOOPBACK_HOST.test(url.host);
      if (url.protocol !== "https:" && !loopback) {
        problems.push("X402_FACILITATOR_URL must be https (plain http is accepted only on loopback).");
      }
      if (url.username || url.password || url.search || url.hash) {
        problems.push("X402_FACILITATOR_URL must carry no credentials, query or fragment.");
      }
      facilitator = { url: url.toString().replace(/\/+$/, ""), host: url.host };
    } catch {
      problems.push("X402_FACILITATOR_URL is not a valid absolute URL.");
    }
  }

  // Authentication. CDP keys are preferred; a static bearer token is accepted as
  // a fallback so a non-CDP facilitator can still be smoke tested.
  const cdpKeyId = String(env.CDP_API_KEY_ID ?? "").trim();
  const cdpKeySecret = String(env.CDP_API_KEY_SECRET ?? "");
  const bearerToken = String(env.X402_VERIFY_TOKEN ?? "").trim();
  let auth;
  if (cdpKeyId && cdpKeySecret) {
    let seed;
    try {
      seed = seedFromCdpSecret(cdpKeySecret);
    } catch (error) {
      problems.push(`CDP_API_KEY_SECRET cannot be used: ${error.message}`);
    }
    if (seed) auth = { mode: "cdp-jwt", keyId: cdpKeyId, keySecret: cdpKeySecret };
  } else if (cdpKeyId || cdpKeySecret) {
    problems.push("CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set together.");
  } else if (bearerToken) {
    auth = { mode: "bearer", token: bearerToken };
  } else {
    problems.push(
      "The facilitator has no authentication configured: set CDP_API_KEY_ID and CDP_API_KEY_SECRET.",
    );
  }

  return {
    enabled,
    ok: problems.length === 0,
    problems,
    payTo,
    facilitator,
    auth,
    network: BASE_CAIP2,
    asset: USDC_BASE,
    amountAtomic: SMOKE_AMOUNT_ATOMIC,
    amountUsdc: SMOKE_AMOUNT_USDC,
    x402Version: Number(env.X402_VERSION ?? 2),
  };
}

/**
 * The 402 challenge for the smoke resource.
 *
 * Built with the product's own `buildChallenge`, so the wire shape is not a
 * second implementation that could drift. The amount is a module constant, never
 * a parameter — the whole point of a smoke test is that the price is fixed and
 * known before anyone approves it.
 */
export function smokeChallenge({ origin, payTo, version }) {
  const resourceUrl = `${origin}${SMOKE_RESOURCE_PATH}`;
  const challenge = buildChallenge({
    orderId: undefined,
    resourceUrl,
    payTo,
    amountAtomic: SMOKE_AMOUNT_ATOMIC,
    description: `EventPass x402 smoke test — ${SMOKE_AMOUNT_USDC} USDC`,
    version,
  });
  // `buildChallenge` stamps `extra.orderId` for the product's per-order flow.
  // There is no order here, and a null one would read as a real id downstream.
  return {
    ...challenge,
    accepts: challenge.accepts.map((entry) => {
      const { orderId: _omitted, ...extra } = entry.extra ?? {};
      return { ...entry, extra };
    }),
  };
}

/** The preflight report. Public by design — never place a credential in it. */
export function smokeReport(config, origin) {
  return {
    smokeTest: true,
    amountAtomic: config.amountAtomic,
    amountUsdc: config.amountUsdc,
    network: config.network,
    asset: config.asset,
    payTo: config.payTo,
    facilitatorHost: config.facilitator?.host ?? null,
    authentication: config.auth?.mode ?? "none",
    // The API key id is not a credential on its own and is needed to confirm
    // which key is in use. The secret and any token are never included.
    authenticationKeyId: config.auth?.mode === "cdp-jwt" ? config.auth.keyId : null,
    resourceUrl: `${origin}${SMOKE_RESOURCE_PATH}`,
    idempotency: "The EIP-3009 authorization nonce is single-use on Base, so a replayed authorization cannot charge twice.",
    fees:
      "No protocol fee is encoded: maxAmountRequired is exactly the 100000 atomic units, and nothing else is charged by this endpoint. " +
      "Network gas is paid by whichever party submits the transfer, per the facilitator's policy — read the total from the PayBox approval preview before approving.",
  };
}

/**
 * Proves the facilitator accepts our authentication, without settling anything.
 *
 * `/verify` validates a payment; it cannot move funds. Calling it with an
 * intentionally empty payload means a reachable, authenticated facilitator
 * answers "that payload is invalid" (a 4xx about the payload) while a rejected
 * credential answers 401/403. The two are distinguishable, which is the entire
 * test. Response bodies are not returned: an upstream error may echo the request.
 */
export async function probeFacilitatorAuth(config, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  if (!config.facilitator || !config.auth) {
    return { authOk: false, status: null, detail: "Facilitator or authentication is not configured." };
  }
  const endpoint = facilitatorEndpoint(config.facilitator.url, "/verify");
  const headers = { "content-type": "application/json" };
  if (config.auth.mode === "cdp-jwt") {
    headers.authorization = `Bearer ${cdpJwt({
      keyId: config.auth.keyId,
      keySecret: config.auth.keySecret,
      method: "POST",
      host: endpoint.host,
      path: endpoint.path,
    })}`;
  } else {
    headers.authorization = `Bearer ${config.auth.token}`;
  }

  let response;
  try {
    response = await fetchImpl(endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ x402Version: 2, paymentPayload: {}, paymentRequirements: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : "could not be reached";
    return { authOk: false, status: null, uri: `POST ${endpoint.host}${endpoint.path}`, detail: `The facilitator ${reason}.` };
  }

  // The target the token claimed. Safe to report — it is a public endpoint path,
  // and when a facilitator answers 401 this is the first thing to compare against
  // the path it was actually mounted at.
  const uri = `POST ${endpoint.host}${endpoint.path}`;

  if (response.status === 401 || response.status === 403) {
    return {
      authOk: false,
      status: response.status,
      uri,
      detail: `The facilitator rejected the credential (HTTP ${response.status}) for ${uri}. Check CDP_API_KEY_ID and CDP_API_KEY_SECRET.`,
    };
  }
  // Any other status means the request got past authentication far enough for the
  // facilitator to have an opinion about the payload, which is what we are testing.
  return {
    authOk: true,
    status: response.status,
    uri,
    detail: `The facilitator accepted the credential and answered HTTP ${response.status} about the (deliberately empty) payload.`,
  };
}

/**
 * Verifies and settles a presented payment for the smoke resource.
 *
 * Structurally validated with the product's own `validatePaymentPayload` before
 * the facilitator is called, so the amount must be exactly 100000 atomic units
 * and the payee must be the configured `payTo`. Passing a stand-in order object
 * is what lets that function be reused unmodified.
 */
export async function settleSmoke({ config, payload, origin, fetchImpl = fetch }) {
  const { validatePaymentPayload, selectRequirement } = await import("./x402.mjs");
  const order = { totalAtomic: SMOKE_AMOUNT_ATOMIC };
  const check = validatePaymentPayload({ payload, order, payTo: config.payTo });
  if (!check.ok) return { ok: false, code: "invalid_payload", reason: check.reason };

  const challenge = smokeChallenge({ origin, payTo: config.payTo, version: config.x402Version });
  const requirement = selectRequirement(challenge, payload);
  if (!requirement) {
    return { ok: false, code: "invalid_payload", reason: "No advertised payment option matches the presented payload." };
  }

  const call = async (suffix) => {
    const endpoint = facilitatorEndpoint(config.facilitator.url, suffix);
    const headers = { "content-type": "application/json" };
    if (config.auth.mode === "cdp-jwt") {
      headers.authorization = `Bearer ${cdpJwt({
        keyId: config.auth.keyId,
        keySecret: config.auth.keySecret,
        method: "POST",
        host: endpoint.host,
        path: endpoint.path,
      })}`;
    } else {
      headers.authorization = `Bearer ${config.auth.token}`;
    }
    return fetchImpl(endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ x402Version: payload.x402Version ?? 2, paymentPayload: payload, paymentRequirements: requirement }),
      signal: AbortSignal.timeout(20_000),
    });
  };

  let verificationResponse;
  try {
    verificationResponse = await call("/verify");
  } catch (error) {
    return { ok: false, code: "facilitator_unreachable", reason: `Could not verify the payment: ${error.message}` };
  }
  const verification = await verificationResponse.json().catch(() => ({}));
  if (!verificationResponse.ok) {
    return { ok: false, code: "verify_failed", status: verificationResponse.status, reason: verification.errorReason ?? verification.invalidReason ?? "Verification failed." };
  }
  if (!verification.isValid) {
    return { ok: false, code: "invalid_payment", reason: verification.invalidReason ?? "Payment verification failed." };
  }

  let settlementResponse;
  try {
    settlementResponse = await call("/settle");
  } catch (error) {
    return { ok: false, code: "facilitator_unreachable", reason: `Verified but could not be settled: ${error.message}` };
  }
  const settlement = await settlementResponse.json().catch(() => ({}));
  if (!settlementResponse.ok) {
    return { ok: false, code: "settle_failed", status: settlementResponse.status, reason: settlement.errorReason ?? "Settlement failed." };
  }
  if (!settlement.success) {
    return { ok: false, code: "invalid_payment", reason: settlement.errorReason ?? "Settlement failed." };
  }

  return {
    ok: true,
    transactionHash: settlement.transaction,
    payer: settlement.payer ?? verification.payer,
    network: settlement.network ?? BASE_CAIP2,
    amountAtomic: SMOKE_AMOUNT_ATOMIC,
    settled: true,
  };
}
