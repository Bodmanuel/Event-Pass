/**
 * End-to-end: drives the built dist/plugin.mjs over MCP stdio against a running
 * EventPass API, exactly as PayBox would.
 *
 * The payment resource URL is https (as PayBox requires) but nothing listens
 * there — PayBox is the only party that fetches it. This script plays PayBox's
 * part: it reads the order id out of the proposal, settles that order against
 * the API, then asks the plugin to collect the tickets.
 */
import assert from "node:assert/strict";
import express from "express";
import { createEventPass } from "../server.mjs";
import { PLUGIN_PATH, startPlugin } from "./mcp-client.mjs";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const ORGANIZER_KEY = "organizer-test-key";
const EVENT = "evt_afrogroove_2026";
const PAYMENT_RESOURCE_ORIGIN = "https://pay.eventpass.test";
const PAYER = "0x00000000000000000000000000000000000000a1";

let step = 0;
const ok = (message) => console.log(`  ✓ ${message}`);
const heading = (message) => console.log(`\n${++step}. ${message}`);

async function startStubFacilitator() {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.post("/verify", (_req, res) => res.json({ isValid: true, payer: PAYER }));
  app.post("/settle", (_req, res) =>
    res.json({ success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:8453", payer: PAYER }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function startApi(facilitatorUrl) {
  const { app, close } = await createEventPass({
    TICKET_SECRET: "e2e-secret",
    ORGANIZER_KEY,
    X402_PAY_TO: PAY_TO,
    X402_FACILITATOR_URL: facilitatorUrl,
    // The demo facilitator below accepts anything; the unauthenticated mode is
    // opt-in in production, so this script opts in explicitly.
    X402_ALLOW_UNAUTHENTICATED_FACILITATOR: "1",
    PUBLIC_BASE_URL: PAYMENT_RESOURCE_ORIGIN,
    // Set DATABASE_URL to run the same demo against PostgreSQL rather than memory.
    ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => { await new Promise((r) => server.close(r)); await close(); },
  };
}

const orderIdFrom = (proposalUrl) => new URL(proposalUrl).pathname.split("/")[3];

function paymentPayload(amount) {
  return {
    x402Version: 2,
    scheme: "exact",
    network: "eip155:8453",
    payload: {
      signature: `0x${"cd".repeat(65)}`,
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"ef".repeat(32)}`,
      },
    },
  };
}

async function main() {
  console.log(`\nDriving ${PLUGIN_PATH} over MCP stdio.`);

  const facilitator = await startStubFacilitator();
  const api = await startApi(facilitator.url);
  const plugin = startPlugin({ EVENTPASS_API_URL: api.base });

  try {
    heading("Scene 1 — the agent searches for the event");
    const search = await plugin.call("search_events", { genre: "Afrobeat" });
    assert.equal(search.isError, undefined);
    assert.equal(search.structuredContent.source, "live", "the plugin must reach the API, not the bundled fallback");
    assert.equal(search.structuredContent.count, 1);
    const [event] = search.structuredContent.events;
    assert.equal(event.name, "AfroGroove Fest");
    assert.equal(event.city, "New York");
    ok(`found "${event.name}" in ${event.city}, from ${event.priceFromUsdc} USDC, ${event.ticketsAvailable} tickets left`);

    heading("Scene 2 — the agent compares ticket options");
    const options = await plugin.call("get_ticket_options", { eventId: EVENT });
    assert.equal(options.isError, undefined);
    const ga = options.structuredContent.tiers.find((tier) => tier.tierId === "tier_ga");
    assert.equal(ga.totalPerTicketUsdc, "9.50");
    assert.equal(ga.faceValueUsdc, "8.00");
    assert.equal(ga.serviceFeeUsdc, "1.50");
    ok(`${options.structuredContent.tiers.length} tiers; GA is ${ga.faceValueUsdc} + ${ga.serviceFeeUsdc} fee = ${ga.totalPerTicketUsdc} USDC each`);

    heading("Scene 3 — the agent buys 2 GA tickets inside a $20 budget");
    const purchase = await plugin.call("purchase_ticket", {
      eventId: EVENT, tierId: "tier_ga", quantity: 2, maxTotalUsdc: "20", holderName: "Ada",
    });
    assert.equal(purchase.isError, undefined);
    const proposal = purchase.structuredContent["io.paybox/transactionProposal"];
    assert.ok(proposal, "the proposal must be under the io.paybox/transactionProposal key");
    assert.equal(proposal.version, "1");
    assert.equal(proposal.kind, "x402");
    assert.equal(proposal.chain, "eip155:8453");
    assert.equal(proposal.payment.asset.toLowerCase(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    assert.equal(proposal.payment.maxAmount, "19000000", "19.00 USDC at 6 decimals");
    assert.equal(new URL(proposal.request.url).origin, PAYMENT_RESOURCE_ORIGIN);
    assert.ok(proposal.request.url.startsWith("https://"), "x402 requires an https resource URL");
    const expiresIn = Date.parse(proposal.expiresAt) - Date.now();
    assert.ok(expiresIn > 0 && expiresIn <= 300_000, "expiry must be inside the five-minute window");
    ok(`proposal built: maxAmount ${proposal.payment.maxAmount} atomic USDC on ${proposal.chain}`);

    heading("Scene 4 — the agent refuses to exceed the budget");
    const overspend = await plugin.call("purchase_ticket", {
      eventId: EVENT, tierId: "tier_ga", quantity: 2, maxTotalUsdc: "5",
    });
    assert.equal(overspend.isError, true, "an over-budget purchase must fail, not propose a payment");
    assert.equal(overspend.structuredContent, undefined, "no proposal may ride along with an error result");
    assert.match(overspend.content[0].text, /exceeds the authorised maximum of 5 USDC/);
    const afterOverspend = await (await fetch(`${api.base}/v1/events/${EVENT}/options`)).json();
    assert.equal(afterOverspend.tiers.find((tier) => tier.tierId === "tier_ga").remaining, 38,
      "the declined reservation must release its inventory");
    ok("declined, nothing charged, and the 2 held tickets were released");

    heading("Scene 5 — PayBox settles the proposal, then the agent collects the tickets");
    const orderId = orderIdFrom(proposal.request.url);
    const settled = await fetch(`${api.base}/v1/orders/${orderId}/pay`, {
      headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(paymentPayload(proposal.payment.maxAmount))).toString("base64") },
    });
    const settledBody = await settled.json();
    assert.equal(settled.status, 200, `settlement failed: ${JSON.stringify(settledBody)}`);
    ok(`PayBox paid ${proposal.payment.maxAmount} atomic USDC; the resource returned ${settledBody.tickets.length} tickets`);

    const order = await plugin.call("get_order_status", { orderId });
    assert.equal(order.isError, undefined);
    assert.equal(order.structuredContent.status, "tickets_issued");
    assert.equal(order.structuredContent.tickets.length, 2);
    assert.equal(order.structuredContent.receipt.totalUsdc, "19.00");
    assert.equal(order.structuredContent.transactionHash, `0x${"ab".repeat(32)}`);
    assert.equal(new Set(order.structuredContent.tickets.map((t) => t.qrPayload)).size, 2);
    ok(`2 tickets issued, receipt ${order.structuredContent.receipt.totalUsdc} USDC, tx ${order.structuredContent.transactionHash.slice(0, 12)}…`);

    heading("Scene 6 — the organizer scans a pass twice");
    const code = decodeURIComponent(new URL(order.structuredContent.tickets[0].qrPayload).pathname.split("/t/")[1]);
    const redeem = (value) => fetch(`${api.base}/v1/organizer/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-organizer-key": ORGANIZER_KEY },
      body: JSON.stringify({ code: value }),
    });
    const first = await redeem(code);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).admitted, true);
    ok("first scan: admitted");

    const second = await redeem(code);
    assert.equal(second.status, 409);
    const replay = await second.json();
    assert.equal(replay.result, "already_redeemed");
    assert.equal(replay.admitted, false);
    ok("second scan: rejected as already redeemed");

    console.log("\nAll scenes passed — discovery, priced quote, budget guard, x402 settlement, issuance and one-time redemption.\n");
  } finally {
    plugin.stop();
    await api.close();
    await facilitator.close();
  }
}

main().catch((error) => {
  console.error(`\nE2E FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
