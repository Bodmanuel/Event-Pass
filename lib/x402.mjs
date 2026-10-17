/**
 * Minimal x402 resource-server gate.
 *
 * PayBox's own proposal vocabulary is CAIP-2 (`eip155:8453`) and its payment
 * headers are the v2 names, so v2 is the default here. The npm `x402` v1 line
 * names the same chain `"base"` and uses `X-PAYMENT`. Rather than bet on one, the
 * challenge advertises BOTH network spellings and this module accepts either
 * payment header; `selectRequirement` honours whichever the client chose. Only
 * the envelope's reported `x402Version` is a configuration knob (`X402_VERSION`,
 * default 2) — set it to 1 if PayBox's hosted payment preview reports a v1
 * envelope. Nothing else in the flow depends on the version number, so a
 * mismatch changes the wire label, never whether tickets are issued.
 */
import { cdpJwt, facilitatorEndpoint, seedFromCdpSecret } from "./cdp-auth.mjs";

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_CAIP2 = "eip155:8453";

const PAYMENT_HEADERS = ["payment-signature", "x-payment"];
/**
 * Maps each accepted spelling of a network to the other. It is deliberately a
 * toggle rather than a canonicaliser: `selectRequirement` compares a payload
 * against our own `accepts` entries by putting both through it, so both sides
 * land on the same spelling either way. Do NOT use it for a validity test — use
 * `isBaseNetwork` for that.
 */
const NETWORK_ALIASES = { [BASE_CAIP2]: "base", base: BASE_CAIP2 };

export function normaliseNetwork(network) {
  return NETWORK_ALIASES[String(network ?? "").toLowerCase()] ?? String(network ?? "");
}

/** True for either accepted spelling of Base mainnet. */
export function isBaseNetwork(network) {
  const value = String(network ?? "").trim().toLowerCase();
  return value === BASE_CAIP2 || value === "base";
}

/**
 * The terms a payment payload names. x402 v2 nests them under `accepted`; v1
 * puts them at the top level. Reading both here keeps the validator and the
 * requirement selector from disagreeing about which payment the client made —
 * a v2 payload whose scheme lives only under `accepted` previously looked like
 * a payload with no scheme at all.
 */
export function paymentTerms(payload) {
  const accepted = payload?.accepted;
  const v2 = accepted && typeof accepted === "object" && !Array.isArray(accepted) ? accepted : undefined;
  return {
    scheme: v2?.scheme ?? payload?.scheme,
    network: v2?.network ?? payload?.network,
    asset: v2?.asset ?? payload?.asset,
  };
}

/** Reads the base64-encoded payment payload from whichever header the client used. */
export function readPaymentPayload(headers) {
  for (const name of PAYMENT_HEADERS) {
    const raw = headers[name];
    if (!raw) continue;
    try {
      const decoded = JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"));
      if (decoded && typeof decoded === "object") return { header: name, payload: decoded };
    } catch {
      return { header: name, error: `The ${name} header is not valid base64-encoded JSON.` };
    }
  }
  return undefined;
}

export function buildChallenge({ orderId, resourceUrl, payTo, asset = USDC_BASE, amountAtomic, description, maxTimeoutSeconds = 300, version }) {
  const shared = {
    scheme: "exact",
    resource: resourceUrl,
    description,
    mimeType: "application/json",
    maxAmountRequired: amountAtomic,
    payTo,
    asset,
    maxTimeoutSeconds,
    extra: { name: "USDC", version: "2", orderId },
  };
  return {
    x402Version: version,
    // v2 lifts the resource descriptor to the top level; v1 carries it per-accept.
    // Emitting both means either client finds what it expects.
    resource: { url: resourceUrl, description, mimeType: "application/json" },
    accepts: [
      { ...shared, network: BASE_CAIP2 },
      { ...shared, network: "base" },
    ],
  };
}

/** Picks the advertised requirement that matches what the client actually paid. */
export function selectRequirement(challenge, payload) {
  const terms = paymentTerms(payload);
  const wanted = normaliseNetwork(terms.network);
  const byNetwork = challenge.accepts.filter((entry) => normaliseNetwork(entry.network) === wanted);
  return byNetwork.find((entry) => entry.scheme === terms.scheme) ?? byNetwork[0];
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[0-9]+$/;
/** Payer and verifier clocks drift; only `validBefore` is a hard deadline. */
const CLOCK_SKEW_SECONDS = 60n;

const big = (value) => (typeof value === "string" && DECIMAL.test(value.trim())
  ? BigInt(value.trim())
  : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value)
    : undefined);

/**
 * Structural and economic validation of a presented payment, run BEFORE the
 * facilitator is asked anything. The facilitator answers "is this signature
 * good"; this answers "is this even the payment we asked for". A payload that
 * fails any check is rejected outright and can never reach `store.settle`.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }`.
 */
export function validatePaymentPayload({ payload, order, payTo, asset = USDC_BASE, now = Date.now() }) {
  const reject = (reason) => ({ ok: false, reason });

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return reject("Payment payload is not an object.");

  // v2 carries the terms under `accepted`; v1 carries them at the top level.
  const terms = paymentTerms(payload);
  if (String(terms.scheme ?? "").toLowerCase() !== "exact") {
    return reject(terms.scheme === undefined || terms.scheme === null
      ? 'Payment payload names no scheme; only "exact" is accepted.'
      : `Unsupported payment scheme ${JSON.stringify(terms.scheme)}; only "exact" is accepted.`);
  }

  // Unsupported network: the payload must name Base, in either CAIP-2 or v1 spelling.
  if (!isBaseNetwork(terms.network)) {
    return reject(terms.network === undefined || terms.network === null
      ? `Payment payload names no network; this resource only accepts ${BASE_CAIP2}.`
      : `Unsupported network ${JSON.stringify(terms.network)}; this resource only accepts ${BASE_CAIP2}.`);
  }

  const body = payload.payload;
  if (!body || typeof body !== "object" || Array.isArray(body)) return reject("Payment payload has no payload body.");

  const signature = body.signature ?? payload.signature;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return reject("Payment signature is missing or is not a 65-byte hex signature.");
  }

  const authorization = body.authorization ?? body.permit ?? payload.authorization;
  if (!authorization || typeof authorization !== "object") return reject("Payment payload carries no authorization.");

  if (!HEX_ADDRESS.test(String(authorization.from ?? ""))) return reject("Authorization `from` is not a valid address.");
  if (!HEX_ADDRESS.test(String(authorization.to ?? ""))) return reject("Authorization `to` is not a valid address.");

  // Recipient: the payment must be addressed to the configured payee, not merely
  // to something the facilitator is willing to sign off on.
  const payee = String(payTo ?? "");
  if (!HEX_ADDRESS.test(payee)) return reject("This deployment has no valid payee configured.");
  if (String(authorization.to).toLowerCase() !== payee.toLowerCase()) {
    return reject("Authorization `to` is not the payee configured for this resource.");
  }

  // Asset: reject anything that is not canonical Base USDC, wherever it is named.
  // v2 names it under `accepted`; v1 may name it at the top level.
  const claimedAsset = body.asset ?? terms.asset ?? asset;
  if (String(claimedAsset ?? "").toLowerCase() !== asset.toLowerCase()) {
    return reject(`Authorization asset ${JSON.stringify(claimedAsset)} is not USDC on Base.`);
  }

  // Amount: exactly the reserved total. Underpayment and overpayment are both
  // refused, so a stale or tampered quote can never be settled.
  const authorised = big(authorization.value ?? authorization.amount);
  if (authorised === undefined) return reject("Authorization `value` is not a non-negative integer.");
  if (authorised !== BigInt(order.totalAtomic)) {
    return reject(`Authorization value ${authorised} does not equal the reserved order total ${order.totalAtomic} atomic USDC.`);
  }

  // Validity window.
  const validBefore = big(authorization.validBefore);
  if (validBefore === undefined) return reject("Authorization has no `validBefore` deadline.");
  if (validBefore <= BigInt(Math.floor(now / 1000))) return reject("The payment authorization has expired.");

  const validAfter = big(authorization.validAfter ?? "0") ?? 0n;
  if (validAfter > BigInt(Math.floor(now / 1000)) + CLOCK_SKEW_SECONDS) {
    return reject("The payment authorization is not yet valid.");
  }

  if (typeof authorization.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce)) {
    return reject("Authorization `nonce` is missing or is not 32 bytes.");
  }

  return { ok: true };
}

export function paymentResponseHeader(settlement) {
  return Buffer.from(JSON.stringify(settlement), "utf8").toString("base64");
}

/**
 * Resolves the facilitator configuration once, at boot.
 *
 * Exactly one authentication mode can exist, and it is chosen here rather than
 * rebuilt per request. That is what keeps the paths from conflicting: a request
 * can never carry both a CDP JWT and a static token, because only one is ever
 * constructed.
 *
 * Precedence, and why:
 *  - both CDP vars       -> cdp-jwt. A static token, if also set, is NOT sent
 *                           (reported as a warning) so the outcome is deterministic.
 *  - exactly one CDP var -> `problem`. The pay endpoint fails closed; silently
 *                           falling back to an unauthenticated call is exactly
 *                           what makes a valid key look broken.
 *  - X402_VERIFY_TOKEN / X402_SETTLE_TOKEN -> bearer, unchanged from before.
 *  - X402_ALLOW_UNAUTHENTICATED_FACILITATOR -> an explicit `none` mode, for a
 *                           local or test facilitator only.
 *  - none                -> `problem`. Production never calls a facilitator
 *                           anonymously by accident: that is the same bug as an
 *                           invalid key, one layer earlier.
 *
 * A `problem` never contains a configured secret: it is served in a public
 * response.
 */
export function resolveFacilitator(env = process.env) {
  const raw = String(env.X402_FACILITATOR_URL ?? "").trim();
  if (!raw) return undefined;

  let url;
  try {
    url = new URL(raw).toString().replace(/\/+$/, "");
  } catch {
    return { url: raw, auth: undefined, problem: "X402_FACILITATOR_URL is not a valid absolute URL." };
  }

  const keyId = String(env.CDP_API_KEY_ID ?? "").trim();
  const keySecret = String(env.CDP_API_KEY_SECRET ?? "");
  const verifyToken = String(env.X402_VERIFY_TOKEN ?? "").trim();
  const settleToken = String(env.X402_SETTLE_TOKEN ?? "").trim();
  const allowUnauthenticated = ["1", "true", "yes"].includes(
    String(env.X402_ALLOW_UNAUTHENTICATED_FACILITATOR ?? "").trim().toLowerCase(),
  );

  if (keyId && keySecret) {
    try {
      seedFromCdpSecret(keySecret);
    } catch (error) {
      return { url, auth: undefined, problem: `CDP_API_KEY_SECRET cannot be used: ${error.message}` };
    }
    return {
      url,
      auth: { mode: "cdp-jwt", keyId, keySecret },
      warning: verifyToken || settleToken
        ? "X402_VERIFY_TOKEN/X402_SETTLE_TOKEN are set but CDP_API_KEY_ID/CDP_API_KEY_SECRET take precedence; the static tokens are not sent."
        : undefined,
    };
  }
  if (keyId || keySecret) {
    return {
      url,
      auth: undefined,
      problem: "CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set together; refusing to call the facilitator unauthenticated.",
    };
  }
  if (verifyToken || settleToken) {
    return { url, auth: { mode: "bearer", verifyToken, settleToken } };
  }
  if (allowUnauthenticated) {
    return {
      url,
      auth: { mode: "none" },
      warning: "X402_ALLOW_UNAUTHENTICATED_FACILITATOR is set — facilitator calls carry no credential. This is only valid for a local or test facilitator.",
    };
  }
  return {
    url,
    auth: undefined,
    problem:
      "No facilitator authentication is configured. Set CDP_API_KEY_ID and CDP_API_KEY_SECRET " +
      "(or X402_VERIFY_TOKEN/X402_SETTLE_TOKEN), or set X402_ALLOW_UNAUTHENTICATED_FACILITATOR=1 " +
      "for a credential-free test facilitator.",
  };
}

/** Headers for one facilitator call. The JWT is built from the endpoint actually fetched. */
function authHeadersFor(facilitator, endpoint, suffix) {
  const headers = { "content-type": "application/json" };
  const auth = facilitator.auth;
  if (!auth || auth.mode === "none") return headers;
  if (auth.mode === "cdp-jwt") {
    headers.authorization = `Bearer ${cdpJwt({
      keyId: auth.keyId,
      keySecret: auth.keySecret,
      method: "POST",
      host: endpoint.host,
      path: endpoint.path,
    })}`;
    return headers;
  }
  const token = suffix === "/settle" ? auth.settleToken : auth.verifyToken;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function callFacilitator(facilitator, suffix, body) {
  // One derivation feeds both the request and the signed claim, so a facilitator
  // behind a path prefix cannot produce a token naming a different target.
  const endpoint = facilitatorEndpoint(facilitator.url, suffix);
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: authHeadersFor(facilitator, endpoint, suffix),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Facilitator ${suffix} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    // A rejected credential is named with the target that was signed, because a
    // URI-claim mismatch is the most common cause and looks identical to a bad key.
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Facilitator ${suffix} rejected the credential (HTTP ${response.status}) for ` +
        `${endpoint.host}${endpoint.path}. Check the configured authentication.`,
      );
    }
    throw new Error(`Facilitator ${suffix} failed (HTTP ${response.status}): ${parsed.errorReason ?? parsed.invalidReason ?? text.slice(0, 200)}`);
  }
  return parsed;
}

export function verifyPayment(facilitator, { x402Version, paymentPayload, paymentRequirements }) {
  return callFacilitator(facilitator, "/verify", { x402Version, paymentPayload, paymentRequirements });
}

export function settlePayment(facilitator, { x402Version, paymentPayload, paymentRequirements }) {
  return callFacilitator(facilitator, "/settle", { x402Version, paymentPayload, paymentRequirements });
}
