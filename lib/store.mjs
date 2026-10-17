import { randomUUID } from "node:crypto";
import { atomicToCents, centsToAtomic, centsToUsdc, usdcToCents } from "./money.mjs";
import { createTicketCode, qrImageUrl, redeemUrl, verifyTicketCode } from "./tickets.mjs";
import { EVENTS } from "./seed.mjs";

export const NETWORK = "eip155:8453";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const tierTotal = (tier) => tier.faceCents + tier.feeCents;

/**
 * Single-process store. Reservation and redemption run synchronously with no
 * await between the availability check and the inventory decrement, so Node's
 * event loop makes them atomic. Swap this module for Postgres to scale out —
 * the interface is the contract the server depends on.
 */
export function createStore({ secret, baseUrl, holdMinutes = 15, clock = () => Date.now() }) {
  const events = structuredClone(EVENTS);
  const orders = new Map();
  const tickets = new Map();
  const idempotency = new Map();

  function findEvent(eventId) {
    const event = events.find((candidate) => candidate.eventId === eventId);
    if (!event) throw new HttpError(404, `No event with id ${eventId}`);
    return event;
  }

  function findTier(event, tierId) {
    const tier = event.tiers.find((candidate) => candidate.tierId === tierId);
    if (!tier) throw new HttpError(404, `Event ${event.eventId} has no tier ${tierId}`);
    return tier;
  }

  function release(order) {
    const tier = findTier(findEvent(order.eventId), order.tierId);
    tier.remaining += order.quantity;
  }

  function expireStaleOrders() {
    const now = clock();
    for (const order of orders.values()) {
      if (order.status === "awaiting_payment" && Date.parse(order.expiresAt) <= now) {
        order.status = "expired";
        release(order);
      }
    }
  }

  function issue(order) {
    for (let index = 0; index < order.quantity; index += 1) {
      const ticketId = `tkt_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const { nonce, code } = createTicketCode(secret, { eventId: order.eventId, ticketId });
      tickets.set(ticketId, {
        ticketId,
        orderId: order.orderId,
        eventId: order.eventId,
        tierId: order.tierId,
        tierName: order.tierName,
        holderName: order.holderName,
        status: "valid",
        nonce,
        code,
        issuedAt: new Date(clock()).toISOString(),
        redeemedAt: undefined,
      });
      order.ticketIds.push(ticketId);
    }
    order.status = "tickets_issued";
  }

  function getOrder(orderId) {
    expireStaleOrders();
    const order = orders.get(orderId);
    if (!order) throw new HttpError(404, `No order with id ${orderId}`);
    return order;
  }

  // Every method is async so the memory and Postgres adapters are interchangeable
  // behind one interface; the server never has to know which one it was given.
  return {
    async listEvents({ city, genre, onDate, maxTicketPriceUsdc, limit = 5 } = {}) {
      expireStaleOrders();
      const maxCents = maxTicketPriceUsdc === undefined ? undefined : usdcToCents(maxTicketPriceUsdc);
      return events
        .filter((event) => !city || event.city.toLowerCase() === city.toLowerCase())
        .filter((event) => !genre || event.genre.toLowerCase() === genre.toLowerCase())
        .filter((event) => !onDate || event.startsAt.slice(0, 10) === onDate)
        .filter((event) => maxCents === undefined || Math.min(...event.tiers.map(tierTotal)) <= maxCents)
        .slice(0, limit)
        .map((event) => eventSummary(event));
    },

    async getEventOptions(eventId) {
      expireStaleOrders();
      return eventOptions(findEvent(eventId));
    },

    /** Holds inventory for a fixed window. Replaying the same idempotency key returns the original order. */
    async reserve({ eventId, tierId, quantity, holderName, idempotencyKey }) {
      expireStaleOrders();

      if (idempotencyKey) {
        const existingId = idempotency.get(idempotencyKey);
        if (existingId) return { order: orders.get(existingId), reused: true };
      }

      const event = findEvent(eventId);
      const tier = findTier(event, tierId);

      if (!Number.isInteger(quantity) || quantity < 1) throw new HttpError(400, "quantity must be a positive integer");
      if (quantity > tier.maxPerOrder) throw new HttpError(400, `At most ${tier.maxPerOrder} tickets per order for ${tier.name}`);
      if (tier.remaining < quantity) {
        throw new HttpError(409, `Only ${tier.remaining} ${tier.name} ticket(s) remain, but ${quantity} were requested`);
      }

      // No await between the check above and this decrement: the hold is atomic.
      tier.remaining -= quantity;

      const totalCents = tierTotal(tier) * quantity;
      const order = {
        orderId: `ord_${randomUUID().replaceAll("-", "")}`,
        eventId,
        eventName: event.name,
        tierId,
        tierName: tier.name,
        quantity,
        holderName,
        unitFaceCents: tier.faceCents,
        unitFeeCents: tier.feeCents,
        totalCents,
        totalAtomic: centsToAtomic(totalCents),
        status: "awaiting_payment",
        createdAt: new Date(clock()).toISOString(),
        expiresAt: new Date(clock() + holdMinutes * 60_000).toISOString(),
        idempotencyKey,
        paidAt: undefined,
        transactionHash: undefined,
        payer: undefined,
        ticketIds: [],
      };
      orders.set(order.orderId, order);
      if (idempotencyKey) idempotency.set(idempotencyKey, order.orderId);
      return { order, reused: false };
    },

    async cancel(orderId) {
      const order = getOrder(orderId);
      if (order.status === "awaiting_payment") {
        order.status = "cancelled";
        release(order);
      }
      return order;
    },

    getOrder,

    /**
     * Records a settled payment. Idempotent: an already-issued order returns its
     * existing tickets rather than issuing a second set.
     */
    async settle(orderId, { transactionHash, payer }) {
      const order = getOrder(orderId);
      if (order.status === "tickets_issued") return order;
      if (order.status !== "awaiting_payment") {
        throw new HttpError(409, `Order ${orderId} is ${order.status} and cannot be settled`);
      }
      order.paidAt = new Date(clock()).toISOString();
      order.transactionHash = transactionHash;
      order.payer = payer;
      issue(order);
      return order;
    },

    /** Verifies a scanned code and burns it. A second scan of the same code is rejected. */
    async redeem(code) {
      const parts = String(code).trim().split(".");
      if (parts.length !== 4) return { result: "invalid" };
      const ticket = tickets.get(parts[1]);
      if (!ticket) return { result: "invalid" };
      // The signature binds eventId|ticketId|nonce, so a forged or edited code cannot verify.
      if (!verifyTicketCode(secret, ticket.eventId, code)) return { result: "invalid" };
      if (ticket.status === "redeemed") return { result: "already_redeemed", ticket };
      if (ticket.status !== "valid") return { result: "void", ticket };
      ticket.status = "redeemed";
      ticket.redeemedAt = new Date(clock()).toISOString();
      return { result: "redeemed", ticket };
    },

    async listTicketsForEvent(eventId, viewBaseUrl = baseUrl) {
      return [...tickets.values()]
        .filter((ticket) => ticket.eventId === eventId)
        .map((ticket) => ticketView(ticket, viewBaseUrl));
    },

    async getTickets(ticketIds) {
      return ticketIds.map((ticketId) => tickets.get(ticketId)).filter(Boolean);
    },

    async stats() {
      return { orders: orders.size, tickets: tickets.size, events: events.length };
    },

    _events: events,
    _orders: orders,
    _tickets: tickets,
  };
}

/**
 * `priceFromCents`, `ticketsAvailable` and `tiersOnSale` may be supplied directly
 * (the Postgres adapter computes them in SQL); otherwise they are derived from the
 * tier list. `??` rather than `||` so a genuine zero survives.
 */
export function eventSummary(event) {
  return {
    eventId: event.eventId,
    name: event.name,
    genre: event.genre,
    city: event.city,
    venue: event.venue,
    startsAt: event.startsAt,
    timezone: event.timezone,
    organizer: event.organizer,
    organizerVerified: event.organizerVerified,
    priceFromUsdc: centsToUsdc(event.priceFromCents ?? Math.min(...event.tiers.map(tierTotal))),
    ticketsAvailable: event.ticketsAvailable ?? event.tiers.reduce((total, tier) => total + tier.remaining, 0),
    tiersOnSale: event.tiersOnSale ?? event.tiers.filter((tier) => tier.remaining > 0).length,
  };
}

export function eventOptions(event) {
  return {
    eventId: event.eventId,
    name: event.name,
    genre: event.genre,
    city: event.city,
    venue: event.venue,
    startsAt: event.startsAt,
    timezone: event.timezone,
    organizer: event.organizer,
    organizerVerified: event.organizerVerified,
    currency: "USDC",
    network: NETWORK,
    tiers: event.tiers.map((tier) => ({
      tierId: tier.tierId,
      name: tier.name,
      faceValueUsdc: centsToUsdc(tier.faceCents),
      serviceFeeUsdc: centsToUsdc(tier.feeCents),
      totalPerTicketUsdc: centsToUsdc(tierTotal(tier)),
      remaining: tier.remaining,
      maxPerOrder: tier.maxPerOrder,
      onSale: tier.remaining > 0,
    })),
    purchaseNote:
      "Prices are per ticket in USDC and include the EventPass service fee. The payable total is fixed for the life of the order reservation.",
  };
}

export function ticketView(ticket, baseUrl) {
  const view = {
    ticketId: ticket.ticketId,
    tierId: ticket.tierId,
    tierName: ticket.tierName,
    status: ticket.status,
    qrPayload: redeemUrl(baseUrl, ticket.code),
    redeemUrl: redeemUrl(baseUrl, ticket.code),
    qrImageUrl: qrImageUrl(baseUrl, ticket.code),
  };
  if (ticket.holderName) view.holderName = ticket.holderName;
  if (ticket.redeemedAt) view.redeemedAt = ticket.redeemedAt;
  return view;
}

const NEXT_STEP = {
  awaiting_payment: "Complete the PayBox payment request, then call get_order_status again with this orderId. Do not call purchase_ticket to poll.",
  tickets_issued: "Tickets are issued and valid. Each QR code redeems exactly once at the entrance.",
  expired: "The reservation expired and its inventory was released. Call purchase_ticket again to reserve at the current price.",
  cancelled: "The reservation was cancelled and its inventory was released.",
  failed: "The order failed. No tickets were issued and no payment was taken.",
};

export function orderView(order, tickets, baseUrl) {
  const view = {
    orderId: order.orderId,
    status: order.status,
    quantity: order.quantity,
    totalUsdc: centsToUsdc(order.totalCents),
    currency: "USDC",
    network: NETWORK,
    expiresAt: order.expiresAt,
    tickets: tickets.map((ticket) => ticketView(ticket, baseUrl)),
    nextStep: NEXT_STEP[order.status] ?? "Check the order status again.",
  };
  if (order.paidAt) view.paidAt = order.paidAt;
  if (order.transactionHash) view.transactionHash = order.transactionHash;
  if (order.status === "tickets_issued") {
    const receipt = {
      eventName: order.eventName,
      tierName: order.tierName,
      faceValueUsdc: centsToUsdc(order.unitFaceCents * order.quantity),
      serviceFeeUsdc: centsToUsdc(order.unitFeeCents * order.quantity),
      totalUsdc: centsToUsdc(order.totalCents),
      asset: "USDC",
      network: NETWORK,
      issuedAt: order.paidAt,
    };
    if (order.transactionHash) receipt.transactionHash = order.transactionHash;
    view.receipt = receipt;
  }
  return view;
}

export { atomicToCents };
