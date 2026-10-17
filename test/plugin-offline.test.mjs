/**
 * The plugin must degrade honestly when the EventPass API is unreachable:
 * discovery may fall back to its bundled catalogue, but anything that could lead
 * to a purchase must fail rather than answer from stale data.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startPlugin } from "./mcp-client.mjs";

const EVENT = "evt_afrogroove_2026";
// Reserved port on a reserved TLD: nothing can be listening.
const DEAD_API = "http://127.0.0.1:9";

test("discovery falls back to the bundled catalogue and says so", async (t) => {
  const plugin = startPlugin({ EVENTPASS_API_URL: DEAD_API });
  t.after(() => plugin.stop());

  const result = await plugin.call("search_events", { genre: "Afrobeat" });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.source, "catalog");
  assert.equal(result.structuredContent.count, 1);
  assert.equal(result.structuredContent.events[0].name, "AfroGroove Fest");
  assert.match(result.structuredContent.note, /not authoritative/);
  assert.match(result.structuredContent.note, /EVENTPASS_API_URL/);
});

// There was a test here asserting that an unconfigured plugin resolved to the
// reserved `api.eventpass.invalid` host and answered from its bundled catalogue.
// That is no longer the intended behaviour: the artifact now defaults to the
// deployed API (see `resolveApiUrl` in the plugin's src/eventpass.ts), because a
// plugin that answers from a stale catalogue looks identical to a working one.
// The property that replaced it — an unconfigured artifact reaching the live
// deployment — needs the network, and lives in live.test.mjs.

test("ticket options must be live and never come from stale inventory", async (t) => {
  const plugin = startPlugin({ EVENTPASS_API_URL: DEAD_API });
  t.after(() => plugin.stop());

  const result = await plugin.call("get_ticket_options", { eventId: EVENT });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(result.content[0].text, /live API, which is unreachable/);
});

test("an unreachable API cannot produce a payment proposal", async (t) => {
  const plugin = startPlugin({ EVENTPASS_API_URL: DEAD_API });
  t.after(() => plugin.stop());

  const result = await plugin.call("purchase_ticket", {
    eventId: EVENT, tierId: "tier_ga", quantity: 2, maxTotalUsdc: "20",
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined, "no proposal may be returned when nothing was reserved");
  assert.match(result.content[0].text, /Could not reserve tickets/);
});

test("an unknown order is reported as an error rather than a blank success", async (t) => {
  const plugin = startPlugin({ EVENTPASS_API_URL: DEAD_API });
  t.after(() => plugin.stop());

  const result = await plugin.call("get_order_status", { orderId: "ord_missing" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Could not load order status/);
});
