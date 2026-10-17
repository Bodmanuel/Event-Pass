/**
 * x402 v1/v2 payload shapes.
 *
 * PayBox sends v2, which nests `scheme`, `network` and `asset` under `accepted`;
 * the legacy v1 shape keeps them at the top level. The gate must accept both,
 * and must still refuse a payload that names no scheme at all — the original
 * bug was a valid v2 payment being read as scheme `undefined`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EVENT, PAY_TO, paymentHeader, paymentHeaderV2, reserve, startApi, startFacilitator } from "./harness.mjs";

/** One General Admission ticket is 9.50 USDC. */
const AMOUNT = "9500000";

async function boot(t) {
  const facilitator = await startFacilitator();
  const api = await startApi({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
  t.after(async () => { await api.close(); await facilitator.close(); });
  return { facilitator, api };
}

async function orderFor(api) {
  const response = await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 });
  assert.equal(response.status, 201);
  return response.json();
}

/** Pays an order, asserts the refusal, and proves nothing was verified or issued. */
async function reject(t, headers) {
  const { facilitator, api } = await boot(t);
  const order = await orderFor(api);
  const response = await fetch(order.payUrl, { headers });
  const body = await response.json();

  assert.equal(response.status, 402);
  assert.equal(facilitator.calls.verify, 0, "a structurally invalid payment is refused before verification");
  assert.equal(facilitator.calls.settle, 0, "a structurally invalid payment is never settled");
  const view = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();
  assert.equal(view.status, "awaiting_payment");
  assert.equal(view.tickets.length, 0, "a refused payment issues no tickets");
  return body;
}

test("accepts a v2 payload with the terms under `accepted`", async (t) => {
  const { facilitator, api } = await boot(t);
  const order = await orderFor(api);

  const response = await fetch(order.payUrl, { headers: paymentHeaderV2({ amount: AMOUNT }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "tickets_issued");
  assert.equal(body.tickets.length, 1);
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 1);
  assert.equal(facilitator.calls.settled.at(-1), AMOUNT);
});

test("still accepts a v1 payload with the terms at the top level", async (t) => {
  const { facilitator, api } = await boot(t);

  const order = await orderFor(api);
  const response = await fetch(order.payUrl, { headers: paymentHeader({ amount: AMOUNT }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "tickets_issued");
  assert.equal(facilitator.calls.settle, 1);
});

test("a v2 payload with no scheme anywhere is 402 with a clear error", async (t) => {
  const body = await reject(t, paymentHeaderV2({ amount: AMOUNT, omitScheme: true }));
  assert.match(String(body.error), /names no scheme.*only "exact" is accepted/);
});

test("a v2 payload with no network anywhere is 402 with a clear error", async (t) => {
  const body = await reject(t, paymentHeaderV2({ amount: AMOUNT, omitNetwork: true }));
  assert.match(String(body.error), /names no network.*eip155:8453/);
});

for (const [name, overrides, expected] of [
  ["a wrong scheme", { scheme: "upto" }, /Unsupported payment scheme "upto"/],
  ["a wrong network", { network: "eip155:1" }, /Unsupported network "eip155:1"/],
  ["the wrong asset", { asset: "0x0000000000000000000000000000000000000000" }, /is not USDC on Base/],
  ["a wrong amount", { amount: "9500001" }, /does not equal the reserved order total/],
  ["a wrong payee", { to: "0x9999999999999999999999999999999999999999" }, /not the payee configured/],
]) {
  test(`v2 rejects ${name}`, async (t) => {
    const body = await reject(t, paymentHeaderV2({ amount: AMOUNT, ...overrides }));
    assert.match(String(body.error), expected);
  });
}

test("a rejection logs the payload's top-level shape but never its contents", async (t) => {
  const captured = [];
  const originalWarn = console.warn;
  console.warn = (...args) => captured.push(args.join(" "));
  t.after(() => { console.warn = originalWarn; });

  const { facilitator, api } = await boot(t);
  const order = await orderFor(api);
  const response = await fetch(order.payUrl, { headers: paymentHeaderV2({ amount: AMOUNT, omitScheme: true }) });
  assert.equal(response.status, 402);

  const output = captured.join("\n");
  assert.match(output, /x402 payment rejected/);
  assert.match(output, /"topLevelKeys":\["x402Version","resource","accepted","payload"\]/);
  assert.match(output, /names no scheme/);
  assert.ok(!output.includes(`0x${"cd".repeat(65)}`), "the signature must never be logged");
  assert.ok(!output.includes("authorization"), "the authorization body must never be logged");
  assert.equal(facilitator.calls.verify, 0);
});
