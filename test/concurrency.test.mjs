/**
 * The properties that only show up under contention: overselling, double
 * issuance, double redemption and duplicate reservations. These run against both
 * stores, because the memory adapter's claim (single-threaded atomicity) and the
 * Postgres adapter's claim (guarded UPDATEs) are different mechanisms that must
 * produce the same guarantee.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  EVENT, PAY_TO, backends, codeOf, paymentHeader, redeem, remaining, reserve,
  startApi, startFacilitator, startPostgres,
} from "./harness.mjs";

const postgres = await startPostgres();
after(async () => { await postgres.stop(); });

for (const backend of backends(postgres)) {
  const label = `[${backend.name}]`;
  const start = (env = {}) => startApi({ ...backend.env(), ...env }, backend.pg);

  test(`${label} concurrent reservations cannot oversell inventory`, async (t) => {
    const facilitator = await startFacilitator();
    const api = await start({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
    t.after(async () => { await api.close(); await facilitator.close(); });

    // General Admission has 40 seats and a per-order cap of 6. Twelve simultaneous
    // buyers ask for 6 each — 72 wanted from 40 available.
    const before = await remaining(api.base);
    const attempts = 12;
    const responses = await Promise.all(
      Array.from({ length: attempts }, (_, index) =>
        reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 6, holderName: `buyer-${index}` })),
    );
    const statuses = responses.map((response) => response.status);
    const accepted = statuses.filter((status) => status === 201).length;
    const refused = statuses.filter((status) => status === 409).length;

    assert.equal(accepted + refused, attempts, `unexpected statuses: ${[...new Set(statuses)].join(", ")}`);
    assert.equal(accepted, Math.floor(before / 6), "only as many orders as there is stock");
    assert.equal(await remaining(api.base), before - accepted * 6);
    assert.ok(await remaining(api.base) >= 0, "inventory never goes negative");

    // Every accepted order holds distinct inventory and is independently payable.
    const orders = await Promise.all(responses.filter((r) => r.status === 201).map((r) => r.json()));
    assert.equal(new Set(orders.map((order) => order.orderId)).size, orders.length);
    for (const order of orders) assert.equal(order.totalAtomic, "57000000");
  });

  test(`${label} concurrent charges for one order settle once and issue one set of tickets`, async (t) => {
    const facilitator = await startFacilitator();
    const api = await start({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
    t.after(async () => { await api.close(); await facilitator.close(); });

    const order = await (await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 2 })).json();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => fetch(order.payUrl, { headers: paymentHeader() })),
    );

    for (const response of responses) assert.equal(response.status, 200);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    const issued = new Set(bodies.flatMap((body) => body.tickets.map((ticket) => ticket.ticketId)));
    assert.equal(issued.size, 2, "exactly two tickets exist across all eight responses, not sixteen");
    assert.equal(facilitator.calls.settle, 1, "the authorization is settled exactly once");
    assert.equal(facilitator.calls.verify, 1);

    const status = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();
    assert.equal(status.tickets.length, 2);
  });

  test(`${label} concurrent scans of one pass admit exactly one entry`, async (t) => {
    const facilitator = await startFacilitator();
    const api = await start({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
    t.after(async () => { await api.close(); await facilitator.close(); });

    const order = await (await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 })).json();
    const paid = await (await fetch(order.payUrl, { headers: paymentHeader({ amount: "9500000" }) })).json();
    const code = codeOf(paid.tickets[0]);

    const results = await Promise.all(Array.from({ length: 10 }, () => redeem(api.base, code).then((r) => r.status)));
    assert.equal(results.filter((status) => status === 200).length, 1, "one admission");
    assert.equal(results.filter((status) => status === 409).length, 9, "nine replays refused");
  });

  test(`${label} a replayed idempotency key holds inventory once`, async (t) => {
    const facilitator = await startFacilitator();
    const api = await start({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
    t.after(async () => { await api.close(); await facilitator.close(); });

    const key = "concurrent-idempotency-key-0001";
    const before = await remaining(api.base);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 2, idempotencyKey: key })),
    );
    const bodies = await Promise.all(responses.map((response) => response.json()));

    assert.equal(new Set(bodies.map((body) => body.orderId)).size, 1, "one order for one key");
    assert.equal(await remaining(api.base), before - 2, "and exactly one hold");
    assert.equal(bodies.filter((body) => body.reused).length, 5, "the rest are replays");
  });

  test(`${label} a failed reservation does not burn its idempotency key`, async (t) => {
    const facilitator = await startFacilitator();
    const api = await start({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
    t.after(async () => { await api.close(); await facilitator.close(); });

    const key = "retry-after-conflict-0001";
    // VIP holds 10; asking for 4 twice over succeeds only once.
    const first = await reserve(api.base, { eventId: EVENT, tierId: "tier_vip", quantity: 4, idempotencyKey: key });
    assert.equal(first.status, 201);
    const { orderId } = await first.json();

    // The same key replays the original order rather than reserving again.
    const replay = await reserve(api.base, { eventId: EVENT, tierId: "tier_vip", quantity: 4, idempotencyKey: key });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).orderId, orderId);
    assert.equal(await remaining(api.base, "tier_vip"), 6);

    // A *different* key that is refused for stock must stay usable, or a client
    // could never retry after a restock.
    const second = await reserve(api.base, { eventId: EVENT, tierId: "tier_vip", quantity: 4, idempotencyKey: "fresh-key-0001" });
    assert.equal(second.status, 201);
    const blocked = await reserve(api.base, { eventId: EVENT, tierId: "tier_vip", quantity: 4, idempotencyKey: "fresh-key-0002" });
    assert.equal(blocked.status, 409, "only 2 of the 4 requested seats remain");
    await fetch(`${api.base}/v1/orders/${(await second.json()).orderId}/cancel`, { method: "POST" });
    const retried = await reserve(api.base, { eventId: EVENT, tierId: "tier_vip", quantity: 4, idempotencyKey: "fresh-key-0002" });
    assert.equal(retried.status, 201, "the refused attempt released its key, so the retry can succeed");
  });
}
