import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { atomicAmount, proposeX402, x402OutputSchema } from "./paybox.js";
import { SEED_EVENTS, centsToUsdc, lowestTotalCents, tierTotalCents, type SeedTier } from "./catalog.js";
import { apiGet, apiPost, resolveApiUrl } from "./eventpass.js";

const PROTOCOL_VERSION = "2026-07-28";
const NETWORK = "eip155:8453";
const USDC_DECIMALS = 6;

const decimalUsdc = z.string().regex(/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/);

const eventSummary = z.object({
  eventId: z.string(),
  name: z.string(),
  genre: z.string(),
  city: z.string(),
  venue: z.string(),
  startsAt: z.string(),
  timezone: z.string(),
  organizer: z.string(),
  organizerVerified: z.boolean(),
  priceFromUsdc: z.string(),
  ticketsAvailable: z.number().int(),
  tiersOnSale: z.number().int(),
}).strict();

const ticketTier = z.object({
  tierId: z.string(),
  name: z.string(),
  faceValueUsdc: z.string(),
  serviceFeeUsdc: z.string(),
  totalPerTicketUsdc: z.string(),
  remaining: z.number().int(),
  maxPerOrder: z.number().int(),
  onSale: z.boolean(),
}).strict();

const issuedTicket = z.object({
  ticketId: z.string(),
  tierId: z.string(),
  tierName: z.string(),
  holderName: z.string().optional(),
  status: z.enum(["valid", "redeemed", "void"]),
  redeemedAt: z.string().optional(),
  qrPayload: z.string(),
  redeemUrl: z.string(),
  qrImageUrl: z.string(),
}).strict();

/**
 * The declared output shapes, hoisted so the handlers can validate live responses
 * against the same schema they advertise. Deriving them from the tool definitions
 * instead would drift the moment one is edited and the other is not.
 */
const searchOutput = z.object({
  source: z.enum(["live", "catalog"]),
  count: z.number().int(),
  events: z.array(eventSummary),
  note: z.string().optional(),
}).strict();

const ticketOptionsOutput = z.object({
  eventId: z.string(),
  name: z.string(),
  genre: z.string(),
  city: z.string(),
  venue: z.string(),
  startsAt: z.string(),
  timezone: z.string(),
  organizer: z.string(),
  organizerVerified: z.boolean(),
  currency: z.literal("USDC"),
  network: z.literal(NETWORK),
  tiers: z.array(ticketTier),
  purchaseNote: z.string(),
}).strict();

/**
 * Order states the API can report.
 *
 * `paid` is deliberately absent: neither store ever assigns it, and it appears
 * nowhere in the API's own status vocabulary, so accepting it would advertise a
 * state that cannot occur. `failed` is kept even though nothing assigns it yet —
 * the API maps it to a next step in its own `NEXT_STEP` table, so it is a state
 * the API has reserved. Dropping it here would turn a future legitimate order
 * into a hard error, which is the more expensive mistake of the two.
 */
const orderStatusOutput = z.object({
  orderId: z.string(),
  status: z.enum(["awaiting_payment", "tickets_issued", "expired", "cancelled", "failed"]),
  quantity: z.number().int(),
  totalUsdc: z.string(),
  currency: z.literal("USDC"),
  network: z.literal(NETWORK),
  expiresAt: z.string(),
  paidAt: z.string().optional(),
  transactionHash: z.string().optional(),
  tickets: z.array(issuedTicket),
  receipt: z.object({
    eventName: z.string(),
    tierName: z.string(),
    faceValueUsdc: z.string(),
    serviceFeeUsdc: z.string(),
    totalUsdc: z.string(),
    asset: z.string(),
    network: z.string(),
    transactionHash: z.string().optional(),
    issuedAt: z.string(),
  }).strict().optional(),
  nextStep: z.string(),
}).strict();

type EventSummary = z.infer<typeof eventSummary>;

function text(value: string) {
  return { type: "text" as const, text: value };
}

function fail(message: string) {
  return { content: [text(message)], isError: true as const };
}

function apiFailure(prefix: string, failure: { message: string; status?: number }): string {
  return `${prefix} ${failure.message} Check that the EventPass API host is reachable and configured in Variables & Secrets.`;
}

/**
 * Explains a live response the declared schema cannot accept.
 *
 * The API is a separate deployment that can ship ahead of this plugin, so a shape
 * mismatch is ordinary drift rather than an impossible state. The payload is never
 * echoed — it is remote data that could carry anything — and every name taken from
 * it is filtered down to `[A-Za-z0-9_.-]`, so no key or path from the response can
 * carry SQL, a credential or a control character into the agent's context.
 */
function drift(label: string, endpoint: string, error: z.ZodError): string {
  const names = new Set<string>();
  for (const issue of error.issues) {
    const path = issue.path.map(String).join(".");
    if (path) names.add(path);
    if (issue.code === "unrecognized_keys") for (const key of issue.keys) names.add(key);
  }
  const fields = [...names]
    .map((name) => name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40))
    .filter((name) => name.length > 0)
    .slice(0, 6);
  // "mismatched" covers both a missing/extra key and a value of the wrong type or
  // literal, which is what these paths actually are.
  const detail = fields.length > 0 ? ` Mismatched or unexpected field(s): ${fields.join(", ")}.` : "";
  return `${label} returned a response this plugin cannot interpret.${detail} The response was discarded. ` +
    `This usually means ${endpoint} and this plugin have drifted apart, so the API host may need updating.`;
}

function summarize(event: {
  eventId: string; name: string; genre: string; city: string; venue: string; startsAt: string;
  timezone: string; organizer: string; organizerVerified: boolean;
}): Omit<EventSummary, "priceFromUsdc" | "ticketsAvailable" | "tiersOnSale"> {
  return {
    eventId: event.eventId, name: event.name, genre: event.genre, city: event.city, venue: event.venue,
    startsAt: event.startsAt, timezone: event.timezone, organizer: event.organizer,
    organizerVerified: event.organizerVerified,
  };
}

function matchesFilters(event: (typeof SEED_EVENTS)[number], filters: { city?: string; genre?: string; onDate?: string; maxTicketPriceUsdc?: string }) {
  if (filters.city && event.city.toLowerCase() !== filters.city.toLowerCase()) return false;
  if (filters.genre && event.genre.toLowerCase() !== filters.genre.toLowerCase()) return false;
  if (filters.onDate && event.startsAt.slice(0, 10) !== filters.onDate) return false;
  if (filters.maxTicketPriceUsdc !== undefined) {
    if (BigInt(atomicAmount(centsToUsdc(lowestTotalCents(event)), USDC_DECIMALS)) > BigInt(atomicAmount(filters.maxTicketPriceUsdc, USDC_DECIMALS))) return false;
  }
  return true;
}

function catalogSearch(filters: { city?: string; genre?: string; onDate?: string; maxTicketPriceUsdc?: string }, limit: number) {
  return SEED_EVENTS.filter((event) => matchesFilters(event, filters))
    .slice(0, limit)
    .map((event) => ({
      ...summarize(event),
      priceFromUsdc: centsToUsdc(lowestTotalCents(event)),
      ticketsAvailable: event.tiers.reduce((total, tier) => total + tier.remaining, 0),
      tiersOnSale: event.tiers.filter((tier) => tier.remaining > 0).length,
    }));
}

function catalogOptions(eventId: string) {
  const event = SEED_EVENTS.find((candidate) => candidate.eventId === eventId);
  if (!event) return undefined;
  return {
    ...summarize(event),
    currency: "USDC" as const,
    network: NETWORK,
    tiers: event.tiers.map((tier: SeedTier) => ({
      tierId: tier.tierId,
      name: tier.name,
      faceValueUsdc: centsToUsdc(tier.faceCents),
      serviceFeeUsdc: centsToUsdc(tier.feeCents),
      totalPerTicketUsdc: centsToUsdc(tierTotalCents(tier)),
      remaining: tier.remaining,
      maxPerOrder: tier.maxPerOrder,
      onSale: tier.remaining > 0,
    })),
    purchaseNote: "Prices are per ticket and include the EventPass service fee. The payable total is fixed for the life of an order reservation.",
  };
}

function createServer() {
  const server = new McpServer(
    { name: "eventpass", version: "1.0.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  server.registerTool(
    "search_events",
    {
      title: "Search events",
      description: "Find events and ticket inventory by city, genre, date or maximum ticket price. Returns event ids for get_ticket_options.",
      inputSchema: z.object({
        city: z.string().min(1).max(64).optional(),
        genre: z.string().min(1).max(64).optional(),
        onDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        maxTicketPriceUsdc: decimalUsdc.optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }).strict(),
      outputSchema: searchOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ city, genre, onDate, maxTicketPriceUsdc, limit }) => {
      const filters = { city, genre, onDate, maxTicketPriceUsdc };
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value !== undefined) query.set(key, String(value));
      query.set("limit", String(limit ?? 5));

      const live = await apiGet<{ events: EventSummary[] }>(`/v1/events?${query}`);
      if (live.ok) {
        // Checked against the schema this tool advertises rather than trusted: the
        // API is a separate deployment, and this is the only place that notices when
        // the two have drifted apart.
        const events = live.data.events ?? [];
        const parsed = searchOutput.safeParse({ source: "live", count: events.length, events });
        if (!parsed.success) return fail(drift("Event search", "GET /v1/events", parsed.error));
        return {
          content: [text(events.length === 0 ? "No events matched those filters." : `${events.length} event(s) found.`)],
          structuredContent: parsed.data,
        };
      }
      if (live.kind === "http") return fail(apiFailure("Event search failed.", live));

      const events = catalogSearch(filters, limit ?? 5);
      return {
        content: [text(`EventPass API unreachable — showing the bundled catalogue (${events.length} event(s)). Availability here is not authoritative.`)],
        structuredContent: {
          source: "catalog" as const,
          count: events.length,
          events,
          note: `Live API at ${resolveApiUrl()} was unreachable. This is the bundled catalogue, not authoritative inventory; set EVENTPASS_API_URL to restore live results.`,
        },
      };
    },
  );

  server.registerTool(
    "get_ticket_options",
    {
      title: "Get ticket options",
      description: "List the ticket tiers for one event with per-ticket fees, the payable total and remaining inventory.",
      inputSchema: z.object({ eventId: z.string().min(1).max(64) }).strict(),
      outputSchema: ticketOptionsOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ eventId }) => {
      const live = await apiGet<Record<string, unknown>>(`/v1/events/${encodeURIComponent(eventId)}/options`);
      if (live.ok) {
        const parsed = ticketOptionsOutput.safeParse(live.data);
        if (!parsed.success) return fail(drift("Ticket options", "GET /v1/events/{eventId}/options", parsed.error));
        const options = parsed.data;
        const stock = options.tiers.reduce((total, tier) => total + tier.remaining, 0);
        return {
          content: [text(`${options.name}: ${options.tiers.length} tier(s), ${stock} ticket(s) remaining.`)],
          structuredContent: options,
        };
      }
      if (live.kind === "http" && live.status === 404) return fail(`No event with id ${eventId}. Use search_events to find a valid event id.`);
      if (live.kind === "http") return fail(apiFailure("Could not load ticket options.", live));

      const fallback = catalogOptions(eventId);
      if (!fallback) return fail(`No event with id ${eventId} in the bundled catalogue, and the live EventPass API is unreachable.`);
      return fail(`Ticket options must come from the live API, which is unreachable. The bundled catalogue lists ${fallback.name}, but its inventory is not authoritative — set EVENTPASS_API_URL before purchasing.`);
    },
  );

  server.registerTool(
    "purchase_ticket",
    {
      title: "Purchase tickets",
      description: "Reserves inventory at the live price and returns a Base USDC x402 payment proposal. Nothing is charged until the user approves the PayBox request.",
      inputSchema: z.object({
        eventId: z.string().min(1).max(64),
        tierId: z.string().min(1).max(64),
        quantity: z.number().int().min(1).max(10),
        maxTotalUsdc: decimalUsdc.describe("The most the user authorised for this order, in USDC."),
        holderName: z.string().min(1).max(80).optional(),
        idempotencyKey: z.string().min(8).max(128).optional(),
      }).strict(),
      outputSchema: x402OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ eventId, tierId, quantity, maxTotalUsdc, holderName, idempotencyKey }) => {
      const reservation = await apiPost<{
        orderId: string; status: string; quantity: number; totalUsdc: string; totalAtomic: string;
        payUrl: string; expiresAt: string; eventName: string; tierName: string;
      }>("/v1/orders", { eventId, tierId, quantity, holderName, idempotencyKey });

      if (!reservation.ok) {
        if (reservation.kind === "http" && reservation.status === 409) return fail(`Not enough inventory: ${reservation.message}`);
        if (reservation.kind === "http" && (reservation.status === 404 || reservation.status === 400)) return fail(`Order rejected: ${reservation.message}`);
        return fail(apiFailure("Could not reserve tickets.", reservation));
      }

      const order = reservation.data;
      const budgetAtomic = BigInt(atomicAmount(maxTotalUsdc, USDC_DECIMALS));
      const totalAtomic = BigInt(order.totalAtomic);

      if (totalAtomic > budgetAtomic) {
        await apiPost(`/v1/orders/${encodeURIComponent(order.orderId)}/cancel`, {});
        return fail(
          `Declined without charging: ${quantity} x ${order.tierName} for ${order.eventName} costs ${order.totalUsdc} USDC, ` +
          `which exceeds the authorised maximum of ${maxTotalUsdc} USDC. The reservation was released. Lower the quantity or raise the budget.`,
        );
      }

      const proposal = proposeX402({ chain: NETWORK, url: order.payUrl, maxAmount: order.totalAtomic });
      return {
        ...proposal,
        content: [
          text(
            `Reserved ${quantity} x ${order.tierName} for ${order.eventName}. Order ${order.orderId} is held until ${order.expiresAt}.\n` +
            `Payable: ${order.totalUsdc} USDC on Base (eip155:8453) — exactly the reserved price, capped at your ${maxTotalUsdc} USDC authorisation.\n` +
            `After PayBox settles, call get_order_status with orderId ${order.orderId} to collect the tickets. Do not call purchase_ticket again to poll.`,
          ),
          ...proposal.content,
        ],
      };
    },
  );

  server.registerTool(
    "get_order_status",
    {
      title: "Get order status",
      description: "Check an order after payment and collect its issued tickets, QR payloads and receipt. Safe to call repeatedly.",
      inputSchema: z.object({ orderId: z.string().min(1).max(128) }).strict(),
      outputSchema: orderStatusOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ orderId }) => {
      const live = await apiGet<Record<string, unknown>>(`/v1/orders/${encodeURIComponent(orderId)}`);
      if (!live.ok) {
        if (live.kind === "http" && live.status === 404) return fail(`No order with id ${orderId}.`);
        return fail(apiFailure("Could not load order status.", live));
      }
      const parsed = orderStatusOutput.safeParse(live.data);
      if (!parsed.success) return fail(drift("Order status", "GET /v1/orders/{orderId}", parsed.error));
      const order = parsed.data;
      // The ticket count and the next step are only meaningful once the shape is
      // known good; before that the payload is not evidence of anything.
      const summary = order.status === "tickets_issued"
        ? `Order ${orderId} is paid and ${order.tickets.length} ticket(s) were issued.`
        : `Order ${orderId} is ${order.status}. ${order.nextStep}`;
      return { content: [text(summary)], structuredContent: order };
    },
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
