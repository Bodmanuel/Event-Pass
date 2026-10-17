/**
 * The origin every x402 resource URL is built on.
 *
 * PayBox fetches that URL and requires HTTPS on port 443; the plugin's own
 * `proposeX402` refuses anything else before a proposal is ever shown to a user.
 * So this file pins three things: an explicit `PUBLIC_BASE_URL` is honoured, a
 * public origin that cannot carry a payment is refused *before* it can hold
 * inventory, and local loopback stays usable over plain http.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EVENT, reserve, startApi } from "./harness.mjs";

const ORDER = { eventId: EVENT, tierId: "tier_ga", quantity: 1 };
const ordersHeld = async (base) => (await (await fetch(`${base}/healthz`)).json()).orders;

test("PUBLIC_BASE_URL sets the payment origin, and a trailing slash cannot double up", async (t) => {
  const api = await startApi({ PUBLIC_BASE_URL: "https://eventpass-api.vercel.app/" });
  t.after(() => api.close());

  const created = await reserve(api.base, ORDER);
  assert.equal(created.status, 201);
  const { payUrl } = await created.json();
  assert.match(payUrl, /^https:\/\/eventpass-api\.vercel\.app\/v1\/orders\/[^/]+\/pay$/);
});

test("an origin that cannot carry a payment is refused, and holds no inventory doing it", async (t) => {
  const unpayable = [
    ["plain http on a public host", "http://eventpass-api.vercel.app"],
    ["https on a port PayBox does not use", "https://eventpass-api.vercel.app:8443"],
  ];

  for (const [why, origin] of unpayable) {
    const api = await startApi({ PUBLIC_BASE_URL: origin });
    t.after(() => api.close());

    const created = await reserve(api.base, ORDER);
    assert.equal(created.status, 500, `${why}: must not mint a payable URL`);

    const body = await created.json();
    assert.match(body.error, /HTTPS on port 443/, `${why}: the refusal must name the requirement`);
    // It has to say which origin is wrong without echoing anything sensitive.
    assert.ok(body.error.includes(new URL(origin).origin), `${why}: the refusal must name the origin`);
    assert.ok(!/postgres:\/\//.test(JSON.stringify(body)), `${why}: the refusal must not leak a connection string`);

    // The point of resolving the origin first: a failed sale leaves no held seat
    // behind for the whole hold window.
    assert.equal(await ordersHeld(api.base), 0, `${why}: no order may be reserved`);
  }
});

test("a malformed PUBLIC_BASE_URL is refused without echoing the value", async (t) => {
  const api = await startApi({ PUBLIC_BASE_URL: "not-a-url" });
  t.after(() => api.close());

  const created = await reserve(api.base, ORDER);
  assert.equal(created.status, 500);
  const body = await created.json();
  assert.match(body.error, /not a valid absolute URL/);
  assert.ok(!body.error.includes("not-a-url"), "the configured value must not be echoed back");
});

test("loopback stays payable over plain http, which is where local development runs", async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const created = await reserve(api.base, ORDER);
  assert.equal(created.status, 201);
  assert.match((await created.json()).payUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1\/orders\/[^/]+\/pay$/);
});
