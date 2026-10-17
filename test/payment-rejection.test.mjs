/**
 * The gate must refuse a payment on its own merits, not merely pass whatever the
 * facilitator is willing to bless. Each case below is a payload the facilitator
 * would happily accept (`isValid: true`) — the server has to say no first, and
 * must do so without ever calling `/settle` or issuing a ticket.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EVENT, PAY_TO, paymentHeader, reserve, startApi, startFacilitator } from "./harness.mjs";

async function attempt(t, headers, { quantity = 1 } = {}) {
  const facilitator = await startFacilitator();
  const api = await startApi({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
  t.after(async () => { await api.close(); await facilitator.close(); });

  const order = await (await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity })).json();
  const response = await fetch(order.payUrl, { headers });
  const body = await response.json();
  const status = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();

  assert.equal(facilitator.calls.settle, 0, "an invalid payment never reaches settlement");
  assert.equal(status.tickets.length, 0, "an invalid payment issues no tickets");
  assert.equal(status.status, "awaiting_payment", "the reservation is left intact and retryable");
  return { response, body, facilitator };
}

/** One General Admission ticket is 9.50 USDC; the amount must match or the
 * amount check fires first and masks whatever the case is actually testing. */
const header = (overrides = {}) => paymentHeader({ amount: "9500000", ...overrides });

const cases = [
  ["a payload that is not base64 JSON", { "PAYMENT-SIGNATURE": "not-base64-json!!" }, /not valid base64-encoded JSON/],
  ["a payload with no scheme", header({ scheme: "upto" }), /Unsupported payment scheme/],
  ["an unsupported network", header({ network: "eip155:1" }), /Unsupported network/],
  ["a Solana network", header({ network: "solana:mainnet" }), /Unsupported network/],
  ["the wrong asset", header({ asset: "0x0000000000000000000000000000000000000000" }), /is not USDC on Base/],
  ["a payment addressed to somebody else", header({ to: "0x9999999999999999999999999999999999999999" }), /not the payee configured/],
  ["an underpayment", header({ amount: "1" }), /does not equal the reserved order total/],
  ["an overpayment", header({ amount: "95000001" }), /does not equal the reserved order total/],
  ["a non-integer amount", header({ amount: "9.50" }), /not a non-negative integer/],
  ["an expired authorization", header({ validBefore: "1000000000" }), /authorization has expired/],
  ["an authorization not yet valid", header({ validAfter: "9999999999" }), /not yet valid/],
  ["a truncated signature", header({ signature: "0xdeadbeef" }), /not a 65-byte hex signature/],
  ["a missing nonce", header({ nonce: "0x00" }), /`nonce` is missing or is not 32 bytes/],
  ["a malformed payer address", header({ from: "not-an-address" }), /`from` is not a valid address/],
];

for (const [name, headers, expected] of cases) {
  test(`rejects ${name}`, async (t) => {
    const { response, body } = await attempt(t, headers);
    assert.equal(response.status, 402, `${name} must be refused with 402`);
    assert.match(String(body.error), expected);
  });
}

test("rejects a payment for an order whose reservation has expired", async (t) => {
  const facilitator = await startFacilitator();
  const api = await startApi({
    X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url, ORDER_HOLD_MINUTES: "0.001",
  });
  t.after(async () => { await api.close(); await facilitator.close(); });

  const order = await (await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 })).json();
  await new Promise((resolve) => setTimeout(resolve, 150));

  const response = await fetch(order.payUrl, { headers: paymentHeader({ amount: "9500000" }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /is expired and cannot be paid/);
  assert.equal(facilitator.calls.settle, 0);
  assert.equal(facilitator.calls.verify, 0, "an expired reservation is refused before verification");
});

test("rejects a cancelled order", async (t) => {
  const facilitator = await startFacilitator();
  const api = await startApi({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
  t.after(async () => { await api.close(); await facilitator.close(); });

  const order = await (await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 })).json();
  await fetch(`${api.base}/v1/orders/${order.orderId}/cancel`, { method: "POST" });

  const response = await fetch(order.payUrl, { headers: paymentHeader({ amount: "9500000" }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /is cancelled and cannot be paid/);
  assert.equal(facilitator.calls.settle, 0);
});

test("rejects a payment presented for a different order's amount", async (t) => {
  // The same authorization replayed against an order reserved at another price.
  const {
    response, body,
  } = await attempt(t, paymentHeader({ amount: "19000000" }), { quantity: 1 });
  assert.equal(response.status, 402);
  assert.match(String(body.error), /does not equal the reserved order total 9500000/);
});

test("returns a challenge, and no error, when no payment is presented at all", async (t) => {
  const facilitator = await startFacilitator();
  const api = await startApi({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
  t.after(async () => { await api.close(); await facilitator.close(); });

  const order = await (await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 })).json();
  const response = await fetch(order.payUrl);
  assert.equal(response.status, 402);
  const body = await response.json();
  assert.equal(body.error, undefined, "an unpaid request is a challenge, not an error");
  assert.equal(body.accepts[0].amount, "9500000");
});
