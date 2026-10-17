import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  EVENT, ORGANIZER_KEY, PAY_TO, codeOf, options, payUrl, paymentHeader,
  redeem, remaining, reserve, startApi, startFacilitator, startPostgres,
} from "./harness.mjs";

// One real PostgreSQL server for the file; each Postgres test resets the schema.
const postgres = await startPostgres();
after(async () => { await postgres.stop(); });

/**
 * Every scenario runs against both stores. The Postgres pass goes through the
 * production path (`DATABASE_URL` -> pg.Pool -> SQL), so the two adapters are
 * held to identical observable behaviour rather than to identical code.
 */
const BACKENDS = [
  { name: "memory", env: () => ({}), pg: undefined },
  { name: "postgres", env: () => ({ DATABASE_URL: postgres.url }), pg: postgres },
];

for (const backend of BACKENDS) {
  const label = `[${backend.name}]`;
  const start = (env = {}) => startApi({ ...backend.env(), ...env }, backend.pg);

  test(`${label} reserves at the live price, charges only after settlement, and issues unique tickets`, async (t) => {
    const facilitator = await startFacilitator();
    const api = await start({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
    t.after(async () => { await api.close(); await facilitator.close(); });

    // 2 x General Admission = 2 x ($8.00 + $1.50) = $19.00
    const created = await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 2, holderName: "Ada" });
    assert.equal(created.status, 201);
    const order = await created.json();
    assert.equal(order.totalUsdc, "19.00");
    assert.equal(order.totalAtomic, "19000000");
    assert.equal(order.status, "awaiting_payment");
    assert.match(order.payUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1\/orders\/.+\/pay$/);

    // Inventory is held, not yet sold.
    assert.equal(await remaining(api.base), 38);

    // The unpaid request must produce a challenge stating the exact reserved price.
    const challenge = await fetch(order.payUrl);
    assert.equal(challenge.status, 402);
    const body = await challenge.json();
    assert.equal(body.x402Version, 2);
    assert.equal(body.accepts.length, 2);
    assert.deepEqual(body.accepts.map((entry) => entry.network).sort(), ["base", "eip155:8453"]);
    for (const entry of body.accepts) {
      assert.equal(entry.maxAmountRequired, "19000000");
      assert.equal(entry.scheme, "exact");
      assert.equal(entry.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
      assert.equal(entry.payTo, PAY_TO);
    }
    assert.ok(challenge.headers.get("payment-required"), "PAYMENT-REQUIRED header is set");

    // No tickets before payment.
    const prereq = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();
    assert.equal(prereq.tickets.length, 0);
    assert.equal(facilitator.calls.settle, 0);

    // Paid retry.
    const paid = await fetch(order.payUrl, { headers: paymentHeader() });
    assert.equal(paid.status, 200);
    assert.ok(paid.headers.get("payment-response"), "PAYMENT-RESPONSE header is set");
    const settled = await paid.json();
    assert.equal(settled.status, "tickets_issued");
    assert.equal(settled.tickets.length, 2);
    assert.equal(new Set(settled.tickets.map((ticket) => ticket.qrPayload)).size, 2, "each ticket has its own QR payload");
    assert.equal(facilitator.calls.verify, 1);
    assert.equal(facilitator.calls.settle, 1);
    assert.deepEqual(facilitator.calls.settled, ["19000000"]);

    // Receipt and QR artefacts.
    const after = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();
    assert.equal(after.status, "tickets_issued");
    assert.equal(after.receipt.totalUsdc, "19.00");
    assert.equal(after.receipt.serviceFeeUsdc, "3.00");
    assert.equal(after.receipt.faceValueUsdc, "16.00");
    assert.equal(after.transactionHash, `0x${"ab".repeat(32)}`);
    assert.equal(after.tickets[0].holderName, "Ada");
    const qr = await fetch(after.tickets[0].qrImageUrl);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get("content-type"), /svg/);

    // A redeemed code cannot be reused.
    const first = await redeem(api.base, codeOf(after.tickets[0]));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).admitted, true);

    const second = await redeem(api.base, codeOf(after.tickets[0]));
    assert.equal(second.status, 409);
    const repeated = await second.json();
    assert.equal(repeated.result, "already_redeemed");
    assert.equal(repeated.admitted, false);

    assert.equal((await redeem(api.base, "EVPP1.tkt_forged.nonce.deadbeef")).status, 404);

    // The second ticket is untouched by the first redemption.
    assert.equal((await (await redeem(api.base, codeOf(after.tickets[1]))).json()).admitted, true);
  });

  test(`${label} the organizer ticket list carries absolute QR URLs`, async (t) => {
    const facilitator = await startFacilitator();
    const api = await start({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
    t.after(async () => { await api.close(); await facilitator.close(); });

    const order = await (await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 })).json();
    await fetch(order.payUrl, { headers: paymentHeader({ amount: "9500000" }) });

    const listed = await (await fetch(`${api.base}/v1/organizer/tickets?eventId=${EVENT}`, {
      headers: { "x-organizer-key": ORGANIZER_KEY },
    })).json();
    assert.equal(listed.tickets.length, 1);
    // The dashboard renders these URLs directly; a relative or host-less URL
    // would produce a broken QR image.
    assert.ok(listed.tickets[0].qrImageUrl.startsWith(`${api.base}/q/`), listed.tickets[0].qrImageUrl);
    assert.ok(listed.tickets[0].qrPayload.startsWith(`${api.base}/t/`), listed.tickets[0].qrPayload);
    assert.equal((await fetch(listed.tickets[0].qrImageUrl)).status, 200);
  });

  test(`${label} replaying the paid endpoint does not settle or issue twice`, async (t) => {
    const facilitator = await startFacilitator();
    const api = await start({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
    t.after(async () => { await api.close(); await facilitator.close(); });

    const order = await (await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 })).json();
    const first = await (await fetch(order.payUrl, { headers: paymentHeader({ amount: "9500000" }) })).json();
    const second = await fetch(order.payUrl, { headers: paymentHeader({ amount: "9500000" }) });

    assert.equal(second.status, 200);
    const replay = await second.json();
    assert.equal(replay.tickets.length, 1);
    assert.deepEqual(replay.tickets.map((t) => t.ticketId), first.tickets.map((t) => t.ticketId));
    assert.equal(facilitator.calls.settle, 1, "the facilitator is not asked to settle a second time");
  });

  test(`${label} accepts the v1 'base' alias, the X-PAYMENT header and a v1 envelope`, async (t) => {
    const facilitator = await startFacilitator();
    const api = await start({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
    t.after(async () => { await api.close(); await facilitator.close(); });

    const order = await (await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 })).json();
    const paid = await fetch(order.payUrl, {
      headers: paymentHeader({ network: "base", x402Version: 1, amount: "9500000", header: "X-PAYMENT" }),
    });
    assert.equal(paid.status, 200, JSON.stringify(await paid.clone().json()));
    assert.equal((await paid.json()).tickets.length, 1);
  });

  test(`${label} releases inventory on cancel and on expiry`, async (t) => {
    const facilitator = await startFacilitator();
    const api = await start({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url, ORDER_HOLD_MINUTES: "0.001" });
    t.after(async () => { await api.close(); await facilitator.close(); });

    const start0 = await remaining(api.base);

    const cancelled = await (await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 3 })).json();
    assert.equal(await remaining(api.base), start0 - 3);
    await fetch(`${api.base}/v1/orders/${cancelled.orderId}/cancel`, { method: "POST" });
    assert.equal(await remaining(api.base), start0);

    await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 4 });
    assert.equal(await remaining(api.base), start0 - 4);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await remaining(api.base), start0, "an expired hold returns its inventory");
  });

  test(`${label} refuses to issue tickets when payment is unconfigured`, async (t) => {
    const api = await start();
    t.after(() => api.close());

    const order = await (await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 2 })).json();
    const response = await fetch(order.payUrl, { headers: paymentHeader() });

    assert.equal(response.status, 501);
    assert.deepEqual((await response.json()).missing.sort(), ["X402_FACILITATOR_URL", "X402_PAY_TO"]);
    const status = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();
    assert.equal(status.status, "awaiting_payment");
    assert.equal(status.tickets.length, 0, "no tickets are issued without a verified payment");
  });

  test(`${label} rejects a payment the facilitator refuses`, async (t) => {
    const facilitator = await startFacilitator({ valid: false });
    const api = await start({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
    t.after(async () => { await api.close(); await facilitator.close(); });

    const order = await (await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 })).json();
    const response = await fetch(order.payUrl, { headers: paymentHeader({ amount: "9500000" }) });

    assert.equal(response.status, 402);
    assert.equal((await response.json()).error, "insufficient_funds");
    assert.equal(facilitator.calls.settle, 0, "a failed verification never reaches settlement");
    const status = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();
    assert.equal(status.tickets.length, 0);
  });

  test(`${label} issues nothing when settlement fails after verification`, async (t) => {
    const facilitator = await startFacilitator({ settle: false });
    const api = await start({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
    t.after(async () => { await api.close(); await facilitator.close(); });

    const order = await (await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 })).json();
    const response = await fetch(order.payUrl, { headers: paymentHeader({ amount: "9500000" }) });

    assert.equal(response.status, 402);
    assert.equal((await response.json()).error, "unexpected_settle_error");
    // Verified but not settled: the order stays open and no ticket exists.
    const status = await (await fetch(`${api.base}/v1/orders/${order.orderId}`)).json();
    assert.equal(status.status, "awaiting_payment");
    assert.equal(status.tickets.length, 0);
  });

  test(`${label} enforces per-order caps, availability and organizer auth`, async (t) => {
    const facilitator = await startFacilitator();
    const api = await start({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: facilitator.url });
    t.after(async () => { await api.close(); await facilitator.close(); });

    const overCap = await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 99 });
    assert.equal(overCap.status, 400);
    assert.match((await overCap.json()).error, /At most 6/);

    // Drain General Admission to 4 so a cap-legal request is refused for stock.
    for (let index = 0; index < 6; index += 1) {
      assert.equal((await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 6 })).status, 201);
    }
    const soldOut = await reserve(api.base, { eventId: EVENT, tierId: "tier_ga", quantity: 6 });
    assert.equal(soldOut.status, 409);
    assert.match((await soldOut.json()).error, /Only 4/);

    assert.equal((await reserve(api.base, { eventId: "evt_nope", tierId: "tier_ga", quantity: 1 })).status, 404);
    assert.equal((await reserve(api.base, { eventId: EVENT, tierId: "tier_vip", quantity: 0 })).status, 400);

    const unauthorised = await fetch(`${api.base}/v1/organizer/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-organizer-key": "wrong" },
      body: JSON.stringify({ code: "EVPP1.a.b.c" }),
    });
    assert.equal(unauthorised.status, 401);
  });

  test(`${label} discloses nothing for an order id that does not exist`, async (t) => {
    const api = await start();
    t.after(() => api.close());

    const response = await fetch(`${api.base}/v1/orders/ord_0000000000000000000000000000`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "No order with id ord_0000000000000000000000000000" });
  });

  test(`${label} discovers events by city, genre, date and price`, async (t) => {
    const api = await start();
    t.after(() => api.close());

    const all = await (await fetch(`${api.base}/v1/events`)).json();
    assert.equal(all.count, 1);
    assert.equal(all.events[0].eventId, EVENT);
    assert.equal(all.events[0].priceFromUsdc, "9.50");
    assert.equal(all.events[0].ticketsAvailable, 50);
    assert.equal(all.events[0].tiersOnSale, 2);
    assert.equal(all.events[0].organizerVerified, true);

    assert.equal((await (await fetch(`${api.base}/v1/events?genre=afrobeat`)).json()).count, 1);
    assert.equal((await (await fetch(`${api.base}/v1/events?city=New%20York`)).json()).count, 1);
    assert.equal((await (await fetch(`${api.base}/v1/events?onDate=2026-10-17`)).json()).count, 1);
    assert.equal((await (await fetch(`${api.base}/v1/events?onDate=2026-11-01`)).json()).count, 0);
    assert.equal((await (await fetch(`${api.base}/v1/events?maxTicketPriceUsdc=5`)).json()).count, 0);
    assert.equal((await (await fetch(`${api.base}/v1/events?maxTicketPriceUsdc=10`)).json()).count, 1);

    // inventory reflects a sale
    const tier = (await options(api.base)).tiers.find((t) => t.tierId === "tier_vip");
    assert.equal(tier.totalPerTicketUsdc, "24.50");
    assert.equal(tier.remaining, 10);
  });
}
