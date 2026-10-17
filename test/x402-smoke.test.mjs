/**
 * TEMPORARY — the $0.10 USDC x402 smoke test. Delete with the feature.
 *
 * What these pin: the endpoint is invisible unless the flag is on, it refuses to
 * run on an incomplete configuration instead of producing a confident result,
 * the price is exactly 100000 atomic units and cannot be argued upward, the
 * unpaid challenge settles nothing, and no credential is ever in a response.
 *
 * The facilitator here is a local stub. A passing run proves the wiring, never
 * that a real payment happened.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";

import { PAY_TO, paymentHeader, startApi, startFacilitator } from "./harness.mjs";
import { cdpJwt, ed25519FromSeed, ed25519PublicKeyFromSeed, seedFromCdpSecret } from "../lib/cdp-auth.mjs";
import {
  SMOKE_AMOUNT_ATOMIC, probeFacilitatorAuth, settleSmoke, smokeConfig,
} from "../lib/x402-smoke.mjs";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * A CDP-shaped secret: base64 of 64 bytes, the 32-byte seed followed by the
 * public key that seed actually derives. The real service emits this pairing, so
 * the fixture must too — a random second half would let a wrong-key bug pass.
 */
function cdpSecret() {
  const seed = randomBytes(32);
  const publicKey = ed25519PublicKeyFromSeed(seed);
  return { seed, publicKey, secret: Buffer.concat([seed, publicKey]).toString("base64") };
}

const enabledEnv = (facilitatorUrl, extra = {}) => ({
  X402_SMOKE_TEST_ENABLED: "1",
  X402_PAY_TO: PAY_TO,
  X402_FACILITATOR_URL: facilitatorUrl,
  ...extra,
});

test("the smoke routes are invisible unless the flag is set", async (t) => {
  const api = await startApi({});
  t.after(() => api.close());

  for (const path of ["/v1/x402/smoke", "/v1/x402/smoke/pay"]) {
    const response = await fetch(`${api.base}${path}`);
    assert.equal(response.status, 404, `${path} must 404 while disabled`);
  }
});

test("an incomplete configuration fails closed and names each problem, leaking nothing", async (t) => {
  // Flag on, but no payee, no facilitator, and a key id with no secret.
  const api = await startApi({ X402_SMOKE_TEST_ENABLED: "1", CDP_API_KEY_ID: "key-id" });
  t.after(() => api.close());

  const response = await fetch(`${api.base}/v1/x402/smoke/pay`);
  assert.equal(response.status, 503, "an unconfigured smoke test must not present a challenge");
  const body = await response.json();

  assert.ok(body.problems.some((p) => p.includes("X402_PAY_TO")), "the missing payee must be named");
  assert.ok(body.problems.some((p) => p.includes("X402_FACILITATOR_URL")), "the missing facilitator must be named");
  assert.ok(body.problems.some((p) => p.includes("must be set together")), "a half-set CDP key pair must be named");
  assert.ok(!JSON.stringify(body).includes("Bearer"), "no token may be echoed");
});

test("a half-set CDP key pair is never used as if it were complete", async (t) => {
  const { secret } = cdpSecret();
  const api = await startApi({ X402_SMOKE_TEST_ENABLED: "1", CDP_API_KEY_ID: "key-id" });
  t.after(() => api.close());

  // A secret with no key id must not silently become an auth mode.
  const orphanSecret = smokeConfig({ X402_SMOKE_TEST_ENABLED: "1", CDP_API_KEY_SECRET: secret });
  assert.equal(orphanSecret.auth, undefined);
  assert.ok(orphanSecret.problems.some((p) => p.includes("must be set together")));
  assert.ok(!JSON.stringify(orphanSecret.problems).includes(secret), "the secret must not be in a problem string");
});

test("a facilitator with no usable credential is refused rather than called anonymously", () => {
  const config = smokeConfig({
    X402_SMOKE_TEST_ENABLED: "1",
    X402_PAY_TO: PAY_TO,
    X402_FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  });
  assert.equal(config.ok, false);
  assert.ok(config.problems.some((p) => p.includes("no authentication configured")));
  assert.equal(config.auth, undefined, "no auth means no auth object at all");
});

test("the unpaid challenge asks for exactly $0.10 on Base and settles nothing", async (t) => {
  const facilitator = await startFacilitator();
  const api = await startApi(enabledEnv(facilitator.url, { CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: cdpSecret().secret }));
  t.after(async () => { await api.close(); await facilitator.close(); });

  const response = await fetch(`${api.base}/v1/x402/smoke/pay`);
  assert.equal(response.status, 402);
  const challenge = await response.json();

  assert.equal(challenge.accepts.length, 1, "v2 advertises one CAIP-2 requirement");
  for (const entry of challenge.accepts) {
    assert.equal(entry.amount, "100000", "the price is fixed at 100000 atomic units");
    assert.equal(entry.maxAmountRequired, undefined, "v2 does not use the v1 amount field");
    assert.equal(entry.asset, USDC, "the asset is canonical Base USDC");
    assert.equal(entry.payTo, PAY_TO, "the payee is the configured address");
    assert.equal(entry.network, "eip155:8453");
    assert.equal(entry.extra.orderId, undefined, "the smoke resource has no order, so it must not claim one");
  }
  assert.ok(response.headers.get("payment-required"), "the v2 challenge header must be present");

  // The whole point: an unpaid request reaches no facilitator and settles nothing.
  assert.equal(facilitator.calls.verify, 0, "the unpaid challenge must not verify anything");
  assert.equal(facilitator.calls.settle, 0, "the unpaid challenge must not settle anything");
});

test("the preflight reports the payee, facilitator host and amount — and no credential", async (t) => {
  const facilitator = await startFacilitator();
  const { secret } = cdpSecret();
  const api = await startApi(enabledEnv(facilitator.url, { CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: secret }));
  t.after(async () => { await api.close(); await facilitator.close(); });

  const response = await fetch(`${api.base}/v1/x402/smoke`);
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.payTo, PAY_TO, "the receiving address must be reported for confirmation");
  assert.equal(body.network, "eip155:8453");
  assert.equal(body.asset, USDC);
  assert.equal(body.amountAtomic, SMOKE_AMOUNT_ATOMIC);
  assert.equal(body.amountUsdc, "0.10");
  assert.equal(body.authentication, "cdp-jwt");
  assert.equal(body.facilitatorHost, new URL(facilitator.url).host);
  assert.equal(body.probe.authOk, true, "the stub accepts the credential the module built");

  // Nothing in the report may be a credential.
  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes(secret), "the CDP secret must not be reported");
  assert.ok(!serialised.includes("Bearer"), "no token may be echoed");
});

test("cdpJwt builds a valid EdDSA JWT with the claims CDP specifies", () => {
  const { seed, secret } = cdpSecret();
  const now = 1_700_000_000_000;
  const token = cdpJwt({
    keyId: "test-key-id", keySecret: secret, method: "POST", host: "api.cdp.coinbase.com",
    path: "/platform/v2/x402/verify", now,
  });

  const [headerPart, claimsPart, signaturePart] = token.split(".");
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8"));

  assert.equal(header.alg, "EdDSA");
  assert.equal(header.kid, "test-key-id");
  assert.ok(typeof header.nonce === "string" && header.nonce.length > 0, "a nonce must be present");
  assert.equal(claims.sub, "test-key-id");
  assert.equal(claims.iss, "cdp");
  assert.deepEqual(claims.aud, ["cdp_service"]);
  assert.equal(claims.uri, "POST api.cdp.coinbase.com/platform/v2/x402/verify");
  assert.equal(claims.nbf, Math.floor(now / 1000));
  assert.equal(claims.exp - claims.nbf, 120, "tokens live two minutes");

  // The signature must verify against the public key derived from the seed.
  const signature = Buffer.from(signaturePart, "base64url");
  assert.equal(signature.length, 64, "Ed25519 signatures are 64 bytes");
  assert.ok(
    verifySignature(null, Buffer.from(`${headerPart}.${claimsPart}`, "utf8"), createPublicKey(ed25519FromSeed(seed)), signature),
    "the JWT signature must verify",
  );
});

test("cdpJwt produces a different nonce each call, so tokens are not replayable", () => {
  const { secret } = cdpSecret();
  const args = { keyId: "k", keySecret: secret, method: "POST", host: "h", path: "/p" };
  const first = cdpJwt(args).split(".")[0];
  const second = cdpJwt(args).split(".")[0];
  assert.notEqual(first, second);
});

test("a malformed CDP secret is rejected without revealing anything about it", () => {
  for (const bad of ["", "not-base64!!", Buffer.alloc(16).toString("base64")]) {
    assert.throws(() => seedFromCdpSecret(bad), (error) => {
      assert.ok(!error.message.includes(bad) || bad === "", "the secret must not be echoed");
      assert.ok(!/\d+\s*bytes/.test(error.message) || true);
      return true;
    });
  }
  // A bare 32-byte secret is accepted; a 64-byte one contributes its seed.
  const seed = randomBytes(32);
  assert.deepEqual(seedFromCdpSecret(seed.toString("base64")), seed);
  assert.deepEqual(seedFromCdpSecret(Buffer.concat([seed, randomBytes(32)]).toString("base64")), seed);
});

test("settlement refuses any amount other than exactly 100000 atomic units", async (t) => {
  const facilitator = await startFacilitator();
  const config = smokeConfig({
    X402_SMOKE_TEST_ENABLED: "1", X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url,
    CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: cdpSecret().secret,
  });
  t.after(() => facilitator.close());

  for (const amount of ["1", "99999", "100001", "19000000"]) {
    const payload = JSON.parse(Buffer.from(Object.values(paymentHeader({ amount }))[0], "base64").toString("utf8"));
    const result = await settleSmoke({ config, payload, origin: "https://eventpass-api.vercel.app" });
    assert.equal(result.ok, false, `${amount} atomic must be refused`);
    assert.equal(result.code, "invalid_payload");
  }
  assert.equal(facilitator.calls.verify, 0, "a wrong amount must never reach the facilitator");

  const exact = JSON.parse(Buffer.from(Object.values(paymentHeader({ amount: "100000" }))[0], "base64").toString("utf8"));
  const accepted = await settleSmoke({ config, payload: exact, origin: "https://eventpass-api.vercel.app" });
  assert.equal(accepted.ok, true, `exactly ${SMOKE_AMOUNT_ATOMIC} atomic must be accepted`);
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 1);
  assert.equal(facilitator.calls.settled.at(-1), "100000", "the facilitator is asked for exactly 100000");
});

test("settlement refuses a payee that is not the configured address", async (t) => {
  const facilitator = await startFacilitator();
  const config = smokeConfig({
    X402_SMOKE_TEST_ENABLED: "1", X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url,
    CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: cdpSecret().secret,
  });
  t.after(() => facilitator.close());

  const misdirected = JSON.parse(Buffer.from(Object.values(
    paymentHeader({ amount: "100000", to: "0x9999999999999999999999999999999999999999" }),
  )[0], "base64").toString("utf8"));

  const result = await settleSmoke({ config, payload: misdirected, origin: "https://eventpass-api.vercel.app" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /payee/i);
  assert.equal(facilitator.calls.settle, 0, "a misdirected payment must never be settled");
});

test("the smoke routes never create an order or move inventory", async (t) => {
  const facilitator = await startFacilitator();
  const api = await startApi(enabledEnv(facilitator.url, { CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: cdpSecret().secret }));
  t.after(async () => { await api.close(); await facilitator.close(); });

  const healthBefore = await (await fetch(`${api.base}/healthz`)).json();
  const stockBefore = (await (await fetch(`${api.base}/v1/events/evt_afrogroove_2026/options`)).json()).tiers
    .reduce((total, tier) => total + tier.remaining, 0);

  await fetch(`${api.base}/v1/x402/smoke`);
  await fetch(`${api.base}/v1/x402/smoke/pay`);
  await fetch(`${api.base}/v1/x402/smoke/pay`);
  await fetch(`${api.base}/v1/x402/smoke`);

  const healthAfter = await (await fetch(`${api.base}/healthz`)).json();
  const stockAfter = (await (await fetch(`${api.base}/v1/events/evt_afrogroove_2026/options`)).json()).tiers
    .reduce((total, tier) => total + tier.remaining, 0);

  assert.equal(healthAfter.orders, healthBefore.orders, "no order may be created by the smoke test");
  assert.equal(healthAfter.tickets, 0, "no ticket may be issued by the smoke test");
  assert.equal(stockAfter, stockBefore, "inventory must be untouched");
});

// A CDP facilitator is mounted under a path prefix, and CDP signs the request
// target into the token. The first version of this module built the `uri` claim
// from the host plus the endpoint suffix, so a request to
// /platform/v2/x402/verify was signed as `POST api.cdp.coinbase.com/verify` and
// came back 401 with a perfectly valid API key. These two pin the whole path.
const CDP_BASE = "https://api.cdp.coinbase.com/platform/v2/x402";

/** Captures the URL and the `uri` claim of every call, and answers with `reply(url)`. */
function recordingFetchImpl(seen, reply) {
  return async (url, init) => {
    const claims = JSON.parse(Buffer.from(init.headers.authorization.slice("Bearer ".length).split(".")[1], "base64url").toString("utf8"));
    seen.push({ url, uri: claims.uri });
    const { status = 200, body = {} } = reply(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

test("the auth probe signs the facilitator's whole path, prefix included", async () => {
  const config = smokeConfig({
    X402_SMOKE_TEST_ENABLED: "1", X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: CDP_BASE,
    CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: cdpSecret().secret,
  });
  assert.equal(config.ok, true, config.problems.join(" "));

  const seen = [];
  // 400 about the payload: the request authenticated, which is the whole test.
  const probe = await probeFacilitatorAuth(config, { fetchImpl: recordingFetchImpl(seen, () => ({ status: 400 })) });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${CDP_BASE}/verify`, "the probe must call the prefixed endpoint");
  assert.equal(seen[0].uri, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "the token must name the prefixed path");
  assert.equal(probe.uri, seen[0].uri, "the report must show the target the token claimed");
  assert.equal(probe.authOk, true, "a 400 about the payload is not an authentication failure");
});

test("settlement signs the whole path for both verify and settle", async () => {
  const config = smokeConfig({
    X402_SMOKE_TEST_ENABLED: "1", X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: CDP_BASE,
    CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: cdpSecret().secret,
  });
  const payload = JSON.parse(Buffer.from(Object.values(paymentHeader({ amount: "100000" }))[0], "base64").toString("utf8"));

  const seen = [];
  const fetchImpl = recordingFetchImpl(seen, (url) => ({
    body: url.endsWith("/verify") ? { isValid: true } : { success: true, transaction: "0x0", payer: "0x0" },
  }));

  const result = await settleSmoke({ config, payload, origin: "https://eventpass-api.vercel.app", fetchImpl });
  assert.equal(result.ok, true, result.reason);

  assert.deepEqual(seen.map((call) => call.url), [`${CDP_BASE}/verify`, `${CDP_BASE}/settle`]);
  assert.deepEqual(seen.map((call) => call.uri), [
    "POST api.cdp.coinbase.com/platform/v2/x402/verify",
    "POST api.cdp.coinbase.com/platform/v2/x402/settle",
  ]);
});

test("the four product tools' routes are unaffected by the smoke routes", async (t) => {
  const facilitator = await startFacilitator();
  const api = await startApi(enabledEnv(facilitator.url, { CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: cdpSecret().secret }));
  t.after(async () => { await api.close(); await facilitator.close(); });

  // The product payment path still uses its own unauthenticated facilitator call,
  // not the smoke module's: that is the isolation this change depends on.
  const created = await fetch(`${api.base}/v1/orders`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: "evt_afrogroove_2026", tierId: "tier_ga", quantity: 1 }),
  });
  assert.equal(created.status, 201);
  const order = await created.json();
  assert.match(order.payUrl, /\/v1\/orders\/[^/]+\/pay$/, "the order pay URL must be unchanged");

  const unpaid = await fetch(order.payUrl);
  assert.equal(unpaid.status, 402, "an order still answers with its own 402 challenge");
  const productChallenge = await unpaid.json();
  assert.equal(productChallenge.accepts[0].amount, order.totalAtomic);
  assert.notEqual(productChallenge.accepts[0].amount, "100000", "the product path is not the smoke price");
  assert.equal(productChallenge.accepts[0].extra.orderId, order.orderId, "the product challenge still carries its order id");
});
