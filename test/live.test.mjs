/**
 * Live verification against the deployed API.
 *
 * Skipped by default, because it needs the network and a running deployment:
 *
 *   EVENTPASS_LIVE=1 pnpm test
 *
 * Everything here is read-only with respect to money: no payment header is ever
 * presented, no authorization is ever signed, and nothing is submitted to a
 * facilitator. It answers the two questions the local suites cannot:
 *
 *   1. does the *built* `dist/plugin.mjs` reach the deployed host, and
 *   2. does the deployment actually run the code in this repository.
 *
 * Because the deployed instance holds its inventory in memory, the reservations
 * this file creates are ephemeral and disappear with the instance. Nothing here
 * is evidence of a real payment.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EVENT } from "./harness.mjs";
import { startPlugin } from "./mcp-client.mjs";

const LIVE = process.env.EVENTPASS_LIVE === "1";
const BASE = process.env.EVENTPASS_LIVE_URL ?? "https://eventpass-api.vercel.app";
const timeout = { skip: LIVE ? false : "set EVENTPASS_LIVE=1 to run against the deployed API", timeout: 60_000 };

test("the deployment is up and reports its configuration honestly", timeout, async () => {
  const response = await fetch(`${BASE}/healthz`);
  assert.equal(response.status, 200, `${BASE}/healthz did not answer`);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.events, 1, "the launch event should be seeded");

  // Whatever the host is configured with, it must report the truth about it.
  assert.equal(typeof health.x402.payToConfigured, "boolean");
  assert.equal(typeof health.x402.facilitatorConfigured, "boolean");
  assert.ok([1, 2].includes(health.x402.version));
  // No secret is exposed, only the fact that one is set.
  assert.deepEqual(Object.keys(health.x402).sort(), ["facilitatorConfigured", "payToConfigured", "version"]);
});

test("discovery answers with live inventory", timeout, async () => {
  const { events } = await (await fetch(`${BASE}/v1/events`)).json();
  const event = events.find((candidate) => candidate.eventId === EVENT);
  assert.ok(event, `the deployment should serve ${EVENT}`);
  assert.equal(event.name, "AfroGroove Fest");
  assert.ok(Number(event.priceFromUsdc) > 0);
  assert.ok(event.ticketsAvailable > 0, "a demo with no inventory left cannot be demonstrated");
});

test("the built artifact reaches the deployment with no environment configured", timeout, async () => {
  // No EVENTPASS_API_URL and no NODE_ENV — the hosted case. If the bundle still
  // pointed at a placeholder this would answer from the bundled catalogue, and
  // `source` would not be "live".
  const plugin = startPlugin({});
  try {
    const result = await plugin.call("search_events", { genre: "Afrobeat" });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.source, "live",
      "the artifact must call the deployed API, not answer from its bundled fallback");
    assert.equal(result.structuredContent.count, 1);
    assert.equal(result.structuredContent.events[0].eventId, EVENT);
  } finally {
    plugin.stop();
  }
});

test("the payment gate is read-only-probeable and never issues tickets unpaid", timeout, async () => {
  const created = await fetch(`${BASE}/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: EVENT, tierId: "tier_ga", quantity: 1 }),
  });
  const raw = await created.text();
  assert.equal(created.status, 201, raw);
  const order = JSON.parse(raw);
  assert.ok(order.totalAtomic > 0);

  // An unpaid request that reaches this point must never produce tickets. Which
  // refusal it gets depends on whether the host has payment configured, so the
  // test accepts both and asserts the shape of each.
  const probe = await fetch(order.payUrl);
  if (probe.status === 501) {
    const body = await probe.json();
    assert.ok(Array.isArray(body.missing) && body.missing.length > 0,
      "an unconfigured host must name what is missing rather than fail vaguely");
  } else {
    assert.equal(probe.status, 402, `unpaid pay returned ${probe.status}`);
    const challenge = await probe.json();
    const accept = challenge.accepts.find((entry) => entry.network === "eip155:8453");
    assert.ok(accept, "the challenge must advertise Base mainnet");
    assert.equal(accept.asset.toLowerCase(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    assert.equal(accept.amount ?? accept.maxAmountRequired, order.totalAtomic,
      "the challenge must ask for exactly the reserved total, not a price the caller supplied");
    assert.ok(probe.headers.get("payment-required"), "the v2 header must be present");
  }

  const after = await (await fetch(`${BASE}/v1/orders/${order.orderId}`)).json();
  assert.deepEqual(after.tickets, [], "no ticket may exist before a payment settles");
  assert.equal(after.status, "awaiting_payment");
});

test("an order created by one request is visible to the next", timeout, async () => {
  // On a platform that starts a fresh instance per request this would 404, and
  // the demo would lose its inventory between steps.
  const order = await (await fetch(`${BASE}/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: EVENT, tierId: "tier_ga", quantity: 1 }),
  })).json();

  const fetched = await fetch(`${BASE}/v1/orders/${order.orderId}`);
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json()).orderId, order.orderId);
});

test("an unknown order is a plain 404 with no hint about near misses", timeout, async () => {
  const response = await fetch(`${BASE}/v1/orders/ord_00000000000000000000000000000000`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "No order with id ord_00000000000000000000000000000000" });
});
