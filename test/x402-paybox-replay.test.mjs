/**
 * Replays the x402 v2 payment payload PayBox actually built.
 *
 * The key order and nesting match the live request logged for order
 * ord_2ecb9eaeb43943789ebc33a28366b1de: top-level `accepted, payload, resource,
 * x402Version`, and `accepted` with exactly the seven v2 fields. The signature
 * and nonce are fixtures; everything else is the real shape.
 *
 * The facilitator's rejection of that live request was not a shape problem —
 * CDP accepted the body and then reverted its on-chain simulation. The cause
 * was `accepted.extra.name`: we advertised the ticker ("USDC") instead of the
 * USDC contract's EIP-712 domain name ("USD Coin"), so the client signed
 * against the wrong domain. These tests pin both the body and the domain.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT, PAY_TO, PAYER, reserve, startApi, startFacilitator,
} from "./harness.mjs";
import { redactForDiagnostics } from "../lib/x402.mjs";

const AMOUNT = "9500000";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** The payload PayBox built, with its signature and nonce replaced by fixtures. */
function payboxPayload(order) {
  return {
    accepted: {
      amount: AMOUNT,
      asset: USDC,
      extra: { name: "USD Coin", version: "2", orderId: order.orderId },
      maxTimeoutSeconds: 300,
      network: "eip155:8453",
      payTo: PAY_TO,
      scheme: "exact",
    },
    payload: {
      signature: `0x${"cd".repeat(65)}`,
      authorization: {
        from: PAYER, to: PAY_TO, value: AMOUNT,
        validAfter: "0", validBefore: "9999999999", nonce: `0x${"ef".repeat(32)}`,
      },
    },
    resource: {
      url: order.payUrl,
      description: `1 x General Admission — AfroGroove Fest`,
      mimeType: "application/json",
    },
    x402Version: 2,
  };
}

async function boot(t) {
  const facilitator = await startFacilitator();
  const api = await startApi({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
  t.after(async () => { await api.close(); await facilitator.close(); });
  const response = await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 });
  assert.equal(response.status, 201);
  return { facilitator, api, order: await response.json() };
}

test("the challenge names the USDC contract's EIP-712 domain, not its ticker", async (t) => {
  const { api, order } = await boot(t);

  const response = await fetch(order.payUrl);
  assert.equal(response.status, 402);
  const { accepts } = await response.json();
  assert.equal(accepts[0].extra.name, "USD Coin", "USDC on Base reports name() = 'USD Coin'");
  assert.equal(accepts[0].extra.version, "2");
});

test("the replayed PayBox body is forwarded unchanged, with matching requirements", async (t) => {
  const { facilitator, api, order } = await boot(t);
  const payload = payboxPayload(order);
  const headers = { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload), "utf8").toString("base64") };

  const response = await fetch(order.payUrl, { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "tickets_issued");

  const body = facilitator.calls.payloads[0];
  assert.deepEqual(Object.keys(body), ["x402Version", "paymentPayload", "paymentRequirements"]);
  assert.equal(body.x402Version, 2);
  assert.deepEqual(body.paymentPayload, payload, "paymentPayload is the decoded header, untouched");

  // Structural comparison against the x402 v2 schema.
  assert.deepEqual(Object.keys(body.paymentPayload), ["accepted", "payload", "resource", "x402Version"]);
  assert.equal(Number.isInteger(body.paymentPayload.x402Version), true);
  assert.equal(body.paymentPayload.x402Version, 2);
  assert.deepEqual(Object.keys(body.paymentPayload.resource), ["url", "description", "mimeType"]);
  assert.deepEqual(Object.keys(body.paymentPayload.payload), ["signature", "authorization"]);
  assert.deepEqual(Object.keys(body.paymentPayload.payload.authorization),
    ["from", "to", "value", "validAfter", "validBefore", "nonce"]);
  for (const field of ["value", "validAfter", "validBefore"]) {
    assert.equal(typeof body.paymentPayload.payload.authorization[field], "string", `${field} must be a string`);
  }
  assert.match(body.paymentPayload.payload.signature, /^0x[0-9a-fA-F]{130}$/);
  assert.match(body.paymentPayload.payload.authorization.nonce, /^0x[0-9a-fA-F]{64}$/);

  // paymentRequirements is the same object the client echoed — no rebuild.
  assert.deepEqual(body.paymentRequirements, payload.accepted);
  assert.deepEqual(Object.keys(body.paymentRequirements),
    ["amount", "asset", "extra", "maxTimeoutSeconds", "network", "payTo", "scheme"]);
  assert.equal(body.paymentRequirements.maxAmountRequired, undefined);
  assert.equal(body.paymentRequirements.extra.name, "USD Coin");
  assert.deepEqual(facilitator.calls.settlePayloads[0], body);
  assert.equal(facilitator.calls.settled.at(-1), AMOUNT);
});

test("the diagnostic view masks secrets but keeps structure and types", () => {
  const payload = payboxPayload({ orderId: "ord_fixture", payUrl: "https://example.test/pay" });
  const redacted = redactForDiagnostics({
    x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted,
  });

  assert.deepEqual(Object.keys(redacted.paymentPayload), ["accepted", "payload", "resource", "x402Version"]);
  assert.equal(redacted.paymentPayload.payload.signature, "<redacted-signature>");
  assert.equal(redacted.paymentPayload.payload.authorization.nonce, "<redacted-nonce>");
  assert.equal(redacted.paymentPayload.payload.authorization.from, "<redacted-address>");
  assert.equal(redacted.paymentPayload.payload.authorization.to, "<redacted-address>");
  assert.equal(redacted.paymentPayload.accepted.payTo, "<redacted-address>");
  assert.equal(redacted.paymentPayload.accepted.asset, "<redacted-address>");
  assert.equal(redacted.paymentPayload.accepted.amount, AMOUNT, "the amount is not a secret");
  assert.equal(redacted.paymentPayload.accepted.extra.name, "USD Coin");
  assert.equal(redacted.paymentRequirements.scheme, "exact");
});
