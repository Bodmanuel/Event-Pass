/**
 * Production x402 authentication.
 *
 * These drive `/v1/orders/:id/pay` end to end against a loopback facilitator, so
 * what is asserted is the header the payment path actually sends — not a helper
 * in isolation. No real network, no real payment, no production secret.
 *
 * The facilitator records the Authorization header and the URL it was reached
 * on, which is what lets a test prove the JWT names the request actually made.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";

import { PAY_TO, paymentHeader, reserve, startApi, startFacilitator } from "./harness.mjs";
import { ed25519FromSeed, ed25519PublicKeyFromSeed } from "../lib/cdp-auth.mjs";

const CDP_PREFIX = "/platform/v2/x402";

/**
 * A CDP-shaped secret: base64 of 64 bytes, the 32-byte seed followed by the
 * public key that seed actually derives. CDP emits this pairing; a fixture with
 * an unrelated random second half would let a wrong-key bug pass unnoticed.
 */
function cdpSecret() {
  const seed = randomBytes(32);
  const publicKey = ed25519PublicKeyFromSeed(seed);
  return { seed, publicKey, secret: Buffer.concat([seed, publicKey]).toString("base64") };
}

function decodeJwt(authorization) {
  const token = String(authorization ?? "");
  assert.ok(token.startsWith("Bearer "), `expected a bearer token, got ${JSON.stringify(token)}`);
  const [header, claims, signature] = token.slice("Bearer ".length).split(".");
  return {
    token,
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(claims, "base64url").toString("utf8")),
    signature: Buffer.from(signature, "base64url"),
    signingInput: `${header}.${claims}`,
  };
}

/** Reserves one ticket and returns the order and its settlement header fixture. */
async function orderAndPay(api) {
  const created = await reserve(api.base, { eventId: "evt_afrogroove_2026", tierId: "tier_ga", quantity: 1 });
  assert.equal(created.status, 201);
  const order = await created.json();
  const response = await fetch(`${api.base}/v1/orders/${order.orderId}/pay`, {
    headers: paymentHeader({ amount: order.totalAtomic }),
  });
  return { order, response };
}

const cdpEnv = (facilitator, secret, extra = {}) => ({
  X402_PAY_TO: PAY_TO,
  X402_FACILITATOR_URL: facilitator.url,
  CDP_API_KEY_ID: "test-key-id",
  CDP_API_KEY_SECRET: secret,
  ...extra,
});

test("the production pay path signs a CDP JWT naming the whole facilitator path", async (t) => {
  const { seed, publicKey, secret } = cdpSecret();
  // The fixture is a real key pair, not a seed with arbitrary trailing bytes.
  assert.deepEqual(
    Buffer.from(secret, "base64").subarray(32),
    publicKey,
    "the secret's second half must be the public key derived from its seed",
  );

  const facilitator = await startFacilitator({ prefix: CDP_PREFIX });
  const api = await startApi(cdpEnv(facilitator, secret, {
    X402_FACILITATOR_URL: `${facilitator.url}${CDP_PREFIX}`,
  }));
  t.after(async () => { await api.close(); await facilitator.close(); });

  const { response } = await orderAndPay(api);
  assert.equal(response.status, 200);

  const host = new URL(facilitator.url).host;
  assert.deepEqual(
    facilitator.calls.urls,
    [`${CDP_PREFIX}/verify`, `${CDP_PREFIX}/settle`],
    "the calls must land on the prefixed endpoints",
  );

  const [verify, settle] = facilitator.calls.authorization.map(decodeJwt);
  assert.equal(verify.claims.uri, `POST ${host}${CDP_PREFIX}/verify`, "verify must name the prefixed path");
  assert.equal(settle.claims.uri, `POST ${host}${CDP_PREFIX}/settle`, "settle must name the prefixed path");

  // A fresh token per request, never a shared one.
  assert.notEqual(verify.token, settle.token, "each facilitator call must carry its own JWT");

  for (const jwt of [verify, settle]) {
    assert.equal(jwt.header.alg, "EdDSA");
    assert.equal(jwt.header.typ, "JWT");
    assert.equal(jwt.header.kid, "test-key-id");
    assert.ok(typeof jwt.header.nonce === "string" && jwt.header.nonce.length > 0);

    assert.equal(jwt.claims.sub, "test-key-id");
    assert.equal(jwt.claims.iss, "cdp");
    assert.deepEqual(jwt.claims.aud, ["cdp_service"]);
    assert.equal(jwt.claims.exp - jwt.claims.nbf, 120, "tokens must be short lived");

    assert.equal(jwt.signature.length, 64, "Ed25519 signatures are 64 bytes");
    assert.ok(
      verifySignature(null, Buffer.from(jwt.signingInput, "utf8"), createPublicKey(ed25519FromSeed(seed)), jwt.signature),
      "the signature must verify against the public key derived from the seed",
    );
  }
});

test("the signed path and the fetched URL cannot diverge when the base URL has a prefix", async (t) => {
  const { secret } = cdpSecret();
  const facilitator = await startFacilitator({ prefix: CDP_PREFIX });
  const api = await startApi(cdpEnv(facilitator, secret, {
    X402_FACILITATOR_URL: `${facilitator.url}${CDP_PREFIX}`,
  }));
  t.after(async () => { await api.close(); await facilitator.close(); });

  const { response } = await orderAndPay(api);
  assert.equal(response.status, 200);

  const host = new URL(facilitator.url).host;
  for (const [index, authorization] of facilitator.calls.authorization.entries()) {
    const jwt = decodeJwt(authorization);
    const reached = facilitator.calls.urls[index];
    assert.equal(jwt.claims.uri, `POST ${host}${reached}`, "the claim must name exactly the endpoint that was called");
  }
});

test("mocked verification and settlement issue tickets and record one settlement", async (t) => {
  const { secret } = cdpSecret();
  const facilitator = await startFacilitator();
  const api = await startApi(cdpEnv(facilitator, secret));
  t.after(async () => { await api.close(); await facilitator.close(); });

  const { order, response } = await orderAndPay(api);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "tickets_issued");
  assert.equal(body.tickets.length, 1);
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 1);
  assert.equal(facilitator.calls.settled.at(-1), order.totalAtomic);
  assert.ok(response.headers.get("payment-response"), "the settlement receipt header must be present");
});

for (const status of [401, 403]) {
  test(`a credential rejected with HTTP ${status} is a 502 that names the signed target and leaks nothing`, async (t) => {
    const { secret } = cdpSecret();
    const facilitator = await startFacilitator({ prefix: CDP_PREFIX, verifyStatus: status });
    const api = await startApi(cdpEnv(facilitator, secret, {
      X402_FACILITATOR_URL: `${facilitator.url}${CDP_PREFIX}`,
    }));
    t.after(async () => { await api.close(); await facilitator.close(); });

    const { order, response } = await orderAndPay(api);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error, new RegExp(`rejected the credential \\(HTTP ${status}\\)`));
    assert.match(body.error, new RegExp(`${CDP_PREFIX}/verify`), "the error must name the target that was signed");

    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes(secret), "the secret must not be echoed");
    assert.ok(!serialised.includes("eyJ"), "no JWT may appear in a response");

    assert.equal(facilitator.calls.settle, 0, "a rejected verification must never settle");
    const view = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();
    assert.equal(view.status, "awaiting_payment", "a rejected payment must leave the order unpaid");
    assert.equal(view.tickets.length, 0, "no ticket may be issued without a settlement");
  });
}

test("a declined verification stays a 402 and never settles", async (t) => {
  const { secret } = cdpSecret();
  const facilitator = await startFacilitator({ valid: false });
  const api = await startApi(cdpEnv(facilitator, secret));
  t.after(async () => { await api.close(); await facilitator.close(); });

  const { order, response } = await orderAndPay(api);
  assert.equal(response.status, 402);
  assert.equal(facilitator.calls.settle, 0, "an invalid payment must not be settled");
  const view = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();
  assert.equal(view.status, "awaiting_payment");
  assert.equal(view.tickets.length, 0);
});

test("a facilitator error on settle is a 502 and issues no ticket", async (t) => {
  const { secret } = cdpSecret();
  const facilitator = await startFacilitator({ settleStatus: 500 });
  const api = await startApi(cdpEnv(facilitator, secret));
  t.after(async () => { await api.close(); await facilitator.close(); });

  const { order, response } = await orderAndPay(api);
  assert.equal(response.status, 502);
  const view = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();
  assert.equal(view.status, "awaiting_payment", "a failed settlement must leave the order payable");
  assert.equal(view.tickets.length, 0, "a failed settlement must issue no ticket");
});

test("a declined settlement is a 402 and issues no ticket", async (t) => {
  const { secret } = cdpSecret();
  const facilitator = await startFacilitator({ settle: false });
  const api = await startApi(cdpEnv(facilitator, secret));
  t.after(async () => { await api.close(); await facilitator.close(); });

  const { order, response } = await orderAndPay(api);
  assert.equal(response.status, 402);
  const view = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();
  assert.equal(view.status, "awaiting_payment");
  assert.equal(view.tickets.length, 0);
});

test("an idempotent retry returns the same tickets without a second settlement", async (t) => {
  const { secret } = cdpSecret();
  const facilitator = await startFacilitator();
  const api = await startApi(cdpEnv(facilitator, secret));
  t.after(async () => { await api.close(); await facilitator.close(); });

  const { order } = await orderAndPay(api);
  assert.equal(facilitator.calls.settle, 1);

  const replay = await fetch(`${api.base}/v1/orders/${order.orderId}/pay`, {
    headers: paymentHeader({ amount: order.totalAtomic }),
  });
  assert.equal(replay.status, 200);
  const first = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();
  assert.equal(first.status, "tickets_issued");

  assert.equal(facilitator.calls.settle, 1, "a replay must not settle a second time");
  assert.equal(facilitator.calls.verify, 1, "a replay must not verify a second time");
});

test("static bearer tokens are still used when no CDP key is configured", async (t) => {
  const facilitator = await startFacilitator();
  const api = await startApi({
    X402_PAY_TO: PAY_TO,
    X402_FACILITATOR_URL: facilitator.url,
    X402_VERIFY_TOKEN: "verify-token",
    X402_SETTLE_TOKEN: "settle-token",
  });
  t.after(async () => { await api.close(); await facilitator.close(); });

  const { response } = await orderAndPay(api);
  assert.equal(response.status, 200);
  assert.deepEqual(facilitator.calls.authorization, ["Bearer verify-token", "Bearer settle-token"]);
});

test("CDP wins deterministically when static tokens are also set", async (t) => {
  const { secret } = cdpSecret();
  const facilitator = await startFacilitator();
  const api = await startApi(cdpEnv(facilitator, secret, {
    X402_VERIFY_TOKEN: "verify-token",
    X402_SETTLE_TOKEN: "settle-token",
  }));
  t.after(async () => { await api.close(); await facilitator.close(); });

  const { response } = await orderAndPay(api);
  assert.equal(response.status, 200);
  for (const authorization of facilitator.calls.authorization) {
    assert.notEqual(authorization, "Bearer verify-token", "a static token must never be sent alongside a CDP key");
    assert.notEqual(authorization, "Bearer settle-token");
    assert.equal(decodeJwt(authorization).header.kid, "test-key-id");
  }
});

test("a half-set CDP pair fails closed and never calls the facilitator", async (t) => {
  const facilitator = await startFacilitator();
  const api = await startApi({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url, CDP_API_KEY_ID: "test-key-id" });
  t.after(async () => { await api.close(); await facilitator.close(); });

  const created = await reserve(api.base, { eventId: "evt_afrogroove_2026", tierId: "tier_ga", quantity: 1 });
  const order = await created.json();
  const response = await fetch(`${api.base}/v1/orders/${order.orderId}/pay`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.problems[0], /must be set together/);
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle, 0);
});

test("a malformed CDP secret fails closed without echoing it", async (t) => {
  const bad = Buffer.alloc(16).toString("base64");
  const facilitator = await startFacilitator();
  const api = await startApi({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url, CDP_API_KEY_ID: "k", CDP_API_KEY_SECRET: bad });
  t.after(async () => { await api.close(); await facilitator.close(); });

  const created = await reserve(api.base, { eventId: "evt_afrogroove_2026", tierId: "tier_ga", quantity: 1 });
  const order = await created.json();
  const response = await fetch(`${api.base}/v1/orders/${order.orderId}/pay`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.ok(!JSON.stringify(body).includes(bad), "the secret must not be echoed");
  assert.equal(facilitator.calls.verify, 0);
});

test("a payment logs neither the secret nor a JWT", async (t) => {
  const { secret } = cdpSecret();
  const facilitator = await startFacilitator();
  const captured = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(original)) console[level] = (...args) => captured.push(args.join(" "));

  const api = await startApi(cdpEnv(facilitator, secret));
  t.after(async () => {
    await api.close();
    await facilitator.close();
    Object.assign(console, original);
  });

  const { response } = await orderAndPay(api);
  assert.equal(response.status, 200);

  const output = captured.join("\n");
  assert.ok(!output.includes(secret), "the CDP secret must never be logged");
  assert.ok(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(output), "a JWT must never be logged");
});

test("healthz reports the authentication mode and no credential", async (t) => {
  const { secret } = cdpSecret();
  const facilitator = await startFacilitator();
  const api = await startApi(cdpEnv(facilitator, secret));
  t.after(async () => { await api.close(); await facilitator.close(); });

  const body = await (await fetch(`${api.base}/healthz`)).json();
  assert.equal(body.x402.authentication, "cdp-jwt");
  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes(secret), "healthz must not expose the secret");
  assert.ok(!serialised.includes("eyJ"), "healthz must not expose a JWT");
});
