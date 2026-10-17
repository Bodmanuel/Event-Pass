/**
 * The public surface must not describe its own internals. These checks exist
 * because the interesting failures here are silent: a leaked constraint name or
 * exception message looks like a normal error response.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EVENT, PAY_TO, paymentHeader, reserve, startApi, startFacilitator } from "./harness.mjs";

test("a malformed body is a 400 that does not echo the body back", async (t) => {
  const api = await startApi({});
  t.after(() => api.close());

  const response = await fetch(`${api.base}/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ this is not json",
  });
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.equal(text, JSON.stringify({ error: "Request body is not valid JSON." }));
  assert.ok(!text.includes("is not json"), "the rejected body is not reflected back");
});

test("an unknown route is a plain 404", async (t) => {
  const api = await startApi({});
  t.after(() => api.close());

  const response = await fetch(`${api.base}/v1/nope`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "No route for GET /v1/nope" });
});

test("no response leaks a secret, a credential or a database detail", async (t) => {
  const facilitator = await startFacilitator();
  const api = await startApi({
    X402_PAY_TO: PAY_TO,
    X402_FACILITATOR_URL: facilitator.url,
    X402_VERIFY_TOKEN: "super-secret-verify-token",
    X402_SETTLE_TOKEN: "super-secret-settle-token",
    TICKET_SECRET: "super-secret-ticket-secret",
    ORGANIZER_KEY: "super-secret-organizer-key",
  });
  t.after(async () => { await api.close(); await facilitator.close(); });

  const order = await (await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 })).json();
  const probes = [
    await fetch(`${api.base}/`),
    await fetch(`${api.base}/healthz`),
    await fetch(`${api.base}/v1/events`),
    await fetch(`${api.base}/v1/events/${EVENT}/options`),
    await fetch(`${api.base}/v1/orders/${order.orderId}`),
    await fetch(order.payUrl),
    await fetch(order.payUrl, { headers: paymentHeader({ amount: "1" }) }),
    await fetch(`${api.base}/v1/orders/ord_unknown`),
    await fetch(`${api.base}/v1/organizer/tickets?eventId=${EVENT}`),
  ];

  const secrets = [
    "super-secret-verify-token", "super-secret-settle-token",
    "super-secret-ticket-secret", "super-secret-organizer-key",
    "select ", "insert ", "update ", "idempotency_order_id_fkey", "pg_", "at Object.",
  ];
  for (const response of probes) {
    const text = await response.text();
    for (const secret of secrets) {
      assert.ok(!text.toLowerCase().includes(secret.toLowerCase()),
        `${response.url} leaked ${JSON.stringify(secret)}: ${text.slice(0, 200)}`);
    }
  }

  // The health endpoint reports whether payment is configured, never the values.
  const health = await (await fetch(`${api.base}/healthz`)).json();
  assert.deepEqual(Object.keys(health.x402).sort(), ["facilitatorConfigured", "payToConfigured", "version"]);
  assert.equal(health.x402.payToConfigured, true);
});
