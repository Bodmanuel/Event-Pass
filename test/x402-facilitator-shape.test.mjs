/**
 * The facilitator request body for an x402 v2 payment.
 *
 * CDP rejected a real PayBox payment with "'paymentPayload' is invalid: must
 * match one of [x402V2PaymentPayload…]". Two shapes were wrong on our side:
 * the 402 challenge advertised v1 requirement fields (`maxAmountRequired`) to a
 * v2 client, so the `accepted` it echoed was not v2; and the requirement we
 * sent to the facilitator was likewise rebuilt in the v1 vocabulary. These
 * tests pin the wire body: the client's payload forwarded untouched, and
 * `paymentRequirements` exactly equal to `paymentPayload.accepted`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EVENT, PAY_TO, paymentHeaderV2, reserve, startApi, startFacilitator } from "./harness.mjs";

/** One General Admission ticket is 9.50 USDC. */
const AMOUNT = "9500000";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** The shape of CDP's `invalid-request` body, as seen in production. */
const CDP_SCHEMA_ERROR =
  "'paymentPayload' is invalid: must match one of [x402V2PaymentPayload, x402V1PaymentPayload]: " +
  "accepted.amount: Required";

async function boot(t, facilitatorOptions = {}) {
  const facilitator = await startFacilitator(facilitatorOptions);
  const api = await startApi({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
  t.after(async () => { await api.close(); await facilitator.close(); });
  return { facilitator, api };
}

async function orderFor(api) {
  const response = await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 });
  assert.equal(response.status, 201);
  return response.json();
}

test("the v2 challenge advertises one CAIP-2 requirement in the v2 vocabulary", async (t) => {
  const { api } = await boot(t);
  const order = await orderFor(api);

  const response = await fetch(order.payUrl);
  assert.equal(response.status, 402);
  const challenge = await response.json();

  assert.equal(challenge.x402Version, 2);
  assert.equal(challenge.accepts.length, 1, "v2 must not advertise the legacy 'base' spelling as a second entry");
  const [requirement] = challenge.accepts;
  assert.equal(requirement.network, "eip155:8453");
  assert.equal(requirement.scheme, "exact");
  assert.equal(requirement.amount, AMOUNT);
  assert.equal(requirement.maxAmountRequired, undefined, "v2 renamed the amount field");
  assert.equal(requirement.asset, USDC);
  assert.equal(requirement.payTo, PAY_TO);
  assert.deepEqual(challenge.resource, {
    url: order.payUrl, description: challenge.resource.description, mimeType: "application/json",
  });
});

test("sends { x402Version, paymentPayload, paymentRequirements } with the client's payload untouched", async (t) => {
  const { facilitator, api } = await boot(t);
  const order = await orderFor(api);

  const headers = paymentHeaderV2({ amount: AMOUNT });
  const decoded = JSON.parse(Buffer.from(headers["PAYMENT-SIGNATURE"], "base64").toString("utf8"));

  const response = await fetch(order.payUrl, { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "tickets_issued");

  const body = facilitator.calls.payloads[0];
  assert.deepEqual(Object.keys(body), ["x402Version", "paymentPayload", "paymentRequirements"]);
  assert.equal(body.x402Version, 2);

  // As received: same envelope, same nesting, no fields dropped or renamed.
  assert.deepEqual(body.paymentPayload, decoded);
  assert.deepEqual(Object.keys(body.paymentPayload), ["x402Version", "resource", "accepted", "payload"]);

  // The requirement is the entry the client signed, not a rebuilt one.
  assert.deepEqual(body.paymentRequirements, decoded.accepted);
  assert.equal(body.paymentRequirements.amount, AMOUNT);
  assert.equal(body.paymentRequirements.maxAmountRequired, undefined);

  // Settle receives the same two structures, only after verify succeeded.
  assert.deepEqual(facilitator.calls.settlePayloads[0], body);
  assert.equal(facilitator.calls.settled.at(-1), AMOUNT);
});

test("a facilitator 400 surfaces the full error and marks nothing paid", async (t) => {
  const captured = [];
  const originalWarn = console.warn;
  console.warn = (...args) => captured.push(args.join(" "));
  t.after(() => { console.warn = originalWarn; });

  const { facilitator, api } = await boot(t, {
    verifyStatus: 400,
    errorBody: {
      correlationId: "a4bec73b6bc21b59-IAD",
      errorLink: "https://docs.cdp.coinbase.com/api-reference/v2/errors#invalid-request",
      errorMessage: CDP_SCHEMA_ERROR,
    },
  });
  const order = await orderFor(api);

  const response = await fetch(order.payUrl, { headers: paymentHeaderV2({ amount: AMOUNT }) });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.match(body.error, /Facilitator \/verify failed \(HTTP 400\)/);
  assert.ok(body.error.includes(CDP_SCHEMA_ERROR), "the untruncated upstream message reaches the caller");

  const log = captured.join("\n");
  assert.ok(log.includes(CDP_SCHEMA_ERROR), "the full facilitator error body is logged");
  assert.match(log, /facilitator verify failed/);
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 0, "a failed verify must never reach settle");

  const view = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();
  assert.equal(view.status, "awaiting_payment", "a failed verify must not mark the order paid");
  assert.equal(view.tickets.length, 0, "a failed verify must issue no tickets");
});

test("a v2 payload whose accepted still uses the v1 amount field is refused before the facilitator", async (t) => {
  const { facilitator, api } = await boot(t);
  const order = await orderFor(api);

  const response = await fetch(order.payUrl, { headers: paymentHeaderV2({ amount: AMOUNT, v1Accepted: true }) });
  assert.equal(response.status, 402);
  const body = await response.json();
  assert.match(String(body.error), /`accepted` terms are not x402 v2: `amount` is missing/);

  assert.equal(facilitator.calls.verify, 0, "a non-v2 requirement is refused locally, not sent to CDP");
  const view = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();
  assert.equal(view.status, "awaiting_payment");
  assert.equal(view.tickets.length, 0);
});
