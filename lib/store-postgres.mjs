import { randomUUID } from "node:crypto";
import { centsToAtomic, usdcToCents } from "./money.mjs";
import { createTicketCode, verifyTicketCode } from "./tickets.mjs";
import { HttpError, eventOptions as tierOptions, eventSummary, orderView as buildOrderView, ticketView } from "./store.mjs";
import { applySchema, seedStatements } from "./schema.mjs";
import { SEED_EVENT } from "./seed.mjs";

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? undefined);

/**
 * Persistent store. Every safety property is enforced by the database rather
 * than by process memory, which is what makes it correct across restarts and
 * across more than one API instance:
 *
 *  - inventory is only ever decremented by a guarded UPDATE (`remaining >= $n`),
 *    so concurrent reservations cannot oversell;
 *  - settlement is a guarded UPDATE on the order status, so a double callback
 *    cannot issue a second set of tickets;
 *  - redemption is a guarded UPDATE on the ticket status, so a code burns once.
 *
 * `driver` is `{ query, withTransaction, close }` (see lib/drivers/pg.mjs), which
 * is also what lets the test suite run this exact SQL against PGlite.
 */
export async function createPostgresStore({ driver, secret, baseUrl, holdMinutes = 15 }) {
  await applySchema(driver);
  for (const statement of seedStatements(SEED_EVENT)) await driver.query(statement.text, statement.values);

  // Postgres cannot infer a bare placeholder's type in `values ($1,...)`-only
  // statements, so every bind is cast explicitly where it is used as a filter.
  async function expireStale() {
    await driver.query(`
      with stale as (
        update orders set status = 'expired'
         where status = 'awaiting_payment' and expires_at <= now()
        returning tier_id, quantity
      ), totals as (
        select tier_id, sum(quantity)::int as quantity from stale group by tier_id
      )
      update tiers t set remaining = t.remaining + tot.quantity
        from totals tot where t.tier_id = tot.tier_id
    `);
  }

  /**
   * Expires one reservation and returns its inventory. The UPDATE is guarded on
   * the current status, so two concurrent callers cannot both release the same
   * hold and inflate availability.
   */
  async function expireOne(orderId) {
    await driver.query(`
      with stale as (
        update orders set status = 'expired'
         where order_id = $1 and status = 'awaiting_payment' and expires_at <= now()
        returning tier_id, quantity
      )
      update tiers t set remaining = t.remaining + s.quantity
        from stale s where t.tier_id = s.tier_id
    `, [orderId]);
  }

  async function loadOrder(query, orderId) {
    const { rows } = await query(`
      select o.*, e.name as event_name, t.name as tier_name
        from orders o
        join events e on e.event_id = o.event_id
        join tiers  t on t.tier_id  = o.tier_id
       where o.order_id = $1
    `, [orderId]);
    if (rows.length === 0) throw new HttpError(404, `No order with id ${orderId}`);
    const ticketRows = await query("select ticket_id from tickets where order_id = $1 order by issued_at, ticket_id", [orderId]);
    return toOrder(rows[0], ticketRows.rows.map((row) => row.ticket_id));
  }

  function toOrder(row, ticketIds = []) {
    return {
      orderId: row.order_id,
      eventId: row.event_id,
      eventName: row.event_name,
      tierId: row.tier_id,
      tierName: row.tier_name,
      quantity: row.quantity,
      holderName: row.holder_name ?? undefined,
      unitFaceCents: row.unit_face_cents,
      unitFeeCents: row.unit_fee_cents,
      totalCents: row.total_cents,
      totalAtomic: centsToAtomic(row.total_cents),
      status: row.status,
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      paidAt: iso(row.paid_at),
      transactionHash: row.transaction_hash ?? undefined,
      payer: row.payer ?? undefined,
      ticketIds,
    };
  }

  function toTicket(row) {
    return {
      ticketId: row.ticket_id,
      orderId: row.order_id,
      eventId: row.event_id,
      tierId: row.tier_id,
      tierName: row.tier_name,
      holderName: row.holder_name ?? undefined,
      status: row.status,
      nonce: row.nonce,
      code: row.code,
      issuedAt: iso(row.issued_at),
      redeemedAt: iso(row.redeemed_at),
    };
  }

  return {
    async listEvents({ city, genre, onDate, maxTicketPriceUsdc, limit = 5 } = {}) {
      await expireStale();
      const maxCents = maxTicketPriceUsdc === undefined ? null : usdcToCents(maxTicketPriceUsdc);
      const { rows } = await driver.query(`
        select e.*,
               min(t.face_cents + t.fee_cents) as price_from_cents,
               sum(t.remaining)::int           as tickets_available,
               count(*) filter (where t.remaining > 0)::int as tiers_on_sale
          from events e join tiers t on t.event_id = e.event_id
         where ($1::text is null or lower(e.city)  = lower($1))
           and ($2::text is null or lower(e.genre) = lower($2))
           and ($3::text is null or (e.starts_at at time zone 'UTC')::date = $3::date)
         group by e.event_id
        having ($4::int is null or min(t.face_cents + t.fee_cents) <= $4)
         order by e.starts_at
         limit $5::int
      `, [city ?? null, genre ?? null, onDate ?? null, maxCents, limit]);

      return rows.map((row) =>
        eventSummary({
          eventId: row.event_id,
          name: row.name,
          genre: row.genre,
          city: row.city,
          venue: row.venue,
          startsAt: iso(row.starts_at),
          timezone: row.timezone,
          organizer: row.organizer,
          organizerVerified: row.organizer_verified,
          tiers: [],
          priceFromCents: row.price_from_cents,
          ticketsAvailable: row.tickets_available,
          tiersOnSale: row.tiers_on_sale,
        }));
    },

    async getEventOptions(eventId) {
      await expireStale();
      const { rows } = await driver.query(`
        select e.*, t.tier_id, t.name as tier_name, t.face_cents, t.fee_cents, t.remaining, t.max_per_order
          from events e join tiers t on t.event_id = e.event_id
         where e.event_id = $1
         order by t.face_cents, t.tier_id
      `, [eventId]);
      if (rows.length === 0) throw new HttpError(404, `No event with id ${eventId}`);
      const [head] = rows;
      return tierOptions({
        eventId: head.event_id,
        name: head.name,
        genre: head.genre,
        city: head.city,
        venue: head.venue,
        startsAt: iso(head.starts_at),
        timezone: head.timezone,
        organizer: head.organizer,
        organizerVerified: head.organizer_verified,
        tiers: rows.map((row) => ({
          tierId: row.tier_id,
          name: row.tier_name,
          faceCents: row.face_cents,
          feeCents: row.fee_cents,
          remaining: row.remaining,
          maxPerOrder: row.max_per_order,
        })),
      });
    },

    async reserve({ eventId, tierId, quantity, holderName, idempotencyKey }) {
      if (!Number.isInteger(quantity) || quantity < 1) throw new HttpError(400, "quantity must be a positive integer");
      await expireStale();

      return driver.withTransaction(async (tx) => {
        // One id for both the claim and the order it will point at; the deferred
        // FK is what lets the claim be written before the order exists.
        const orderId = `ord_${randomUUID().replaceAll("-", "")}`;

        // Claim the idempotency key before touching inventory. The unique index
        // makes concurrent replays serialise here, so only one request can hold it.
        if (idempotencyKey) {
          const claimed = await tx.query(
            "insert into idempotency (key, order_id) values ($1, $2) on conflict (key) do nothing returning order_id",
            [idempotencyKey, orderId],
          );
          if (claimed.rows.length === 0) {
            const winner = await tx.query("select order_id from idempotency where key = $1", [idempotencyKey]);
            return { order: await loadOrder(tx.query, winner.rows[0].order_id), reused: true };
          }
        }

        const { rows } = await tx.query(`
          select e.name as event_name, t.*
            from events e join tiers t on t.event_id = e.event_id
           where t.tier_id = $1 and t.event_id = $2
        `, [tierId, eventId]);
        if (rows.length === 0) {
          const exists = await tx.query("select 1 from events where event_id = $1", [eventId]);
          if (exists.rows.length === 0) throw new HttpError(404, `No event with id ${eventId}`);
          throw new HttpError(404, `Event ${eventId} has no tier ${tierId}`);
        }
        const tier = rows[0];
        if (quantity > tier.max_per_order) {
          throw new HttpError(400, `At most ${tier.max_per_order} tickets per order for ${tier.name}`);
        }

        // The hold: a single guarded statement. If two requests race, Postgres
        // re-evaluates `remaining >= $2` after the row lock is released, so the
        // loser matches no row and is rejected instead of overselling.
        const held = await tx.query(
          "update tiers set remaining = remaining - $2::int where tier_id = $1 and remaining >= $2::int returning remaining",
          [tierId, quantity],
        );
        if (held.rows.length === 0) {
          const left = await tx.query("select remaining from tiers where tier_id = $1", [tierId]);
          throw new HttpError(409, `Only ${left.rows[0].remaining} ${tier.name} ticket(s) remain, but ${quantity} were requested`);
        }

        const totalCents = (tier.face_cents + tier.fee_cents) * quantity;
        await tx.query(`
          insert into orders (order_id, event_id, tier_id, quantity, holder_name,
                              unit_face_cents, unit_fee_cents, total_cents, status, expires_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,'awaiting_payment', now() + ($9::numeric * interval '1 minute'))
        `, [orderId, eventId, tierId, quantity, holderName ?? null,
            tier.face_cents, tier.fee_cents, totalCents, holdMinutes]);

        return { order: await loadOrder(tx.query, orderId), reused: false };
      });
    },

    async cancel(orderId) {
      return driver.withTransaction(async (tx) => {
        const cancelled = await tx.query(
          "update orders set status = 'cancelled' where order_id = $1 and status = 'awaiting_payment' returning tier_id, quantity",
          [orderId],
        );
        if (cancelled.rows.length > 0) {
          const row = cancelled.rows[0];
          await tx.query("update tiers set remaining = remaining + $2::int where tier_id = $1", [row.tier_id, row.quantity]);
        }
        return loadOrder(tx.query, orderId);
      });
    },

    async getOrder(orderId) {
      await expireOne(orderId);
      return loadOrder(driver.query, orderId);
    },

    /**
     * Records a settled payment. The guarded UPDATE means exactly one caller can
     * move the order out of `awaiting_payment`, so a replayed webhook returns the
     * original tickets rather than issuing a second set.
     */
    async settle(orderId, { transactionHash, payer }) {
      return driver.withTransaction(async (tx) => {
        const settled = await tx.query(`
          update orders set status = 'tickets_issued', paid_at = now(), transaction_hash = $2, payer = $3
           where order_id = $1 and status = 'awaiting_payment'
          returning quantity
        `, [orderId, transactionHash ?? null, payer ?? null]);

        if (settled.rows.length === 0) {
          const existing = await loadOrder(tx.query, orderId);
          if (existing.status === "tickets_issued") return existing;
          throw new HttpError(409, `Order ${orderId} is ${existing.status} and cannot be settled`);
        }

        // Re-read through the join so each ticket carries the event and tier names.
        const order = await loadOrder(tx.query, orderId);
        for (let index = 0; index < order.quantity; index += 1) {
          const ticketId = `tkt_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
          const { nonce, code } = createTicketCode(secret, { eventId: order.eventId, ticketId });
          await tx.query(`
            insert into tickets (ticket_id, order_id, event_id, tier_id, tier_name, holder_name, status, nonce, code)
            values ($1,$2,$3,$4,$5,$6,'valid',$7,$8)
          `, [ticketId, orderId, order.eventId, order.tierId, order.tierName, order.holderName ?? null, nonce, code]);
        }

        return loadOrder(tx.query, orderId);
      });
    },

    async redeem(code) {
      const parts = String(code).trim().split(".");
      if (parts.length !== 4) return { result: "invalid" };
      const found = await driver.query("select * from tickets where ticket_id = $1", [parts[1]]);
      if (found.rows.length === 0) return { result: "invalid" };
      const ticket = toTicket(found.rows[0]);
      // The signature binds eventId|ticketId|nonce, so a forged or edited code cannot verify.
      if (!verifyTicketCode(secret, ticket.eventId, code)) return { result: "invalid" };

      // Guarded on status: of N simultaneous scans of one code, exactly one wins.
      const burned = await driver.query(
        "update tickets set status = 'redeemed', redeemed_at = now() where ticket_id = $1 and status = 'valid' returning *",
        [ticket.ticketId],
      );
      if (burned.rows.length > 0) return { result: "redeemed", ticket: toTicket(burned.rows[0]) };

      const current = await driver.query("select * from tickets where ticket_id = $1", [ticket.ticketId]);
      const settled = toTicket(current.rows[0]);
      return { result: settled.status === "redeemed" ? "already_redeemed" : "void", ticket: settled };
    },

    async listTicketsForEvent(eventId, viewBaseUrl = baseUrl) {
      const { rows } = await driver.query(
        "select * from tickets where event_id = $1 order by issued_at, ticket_id",
        [eventId],
      );
      return rows.map((row) => ticketView(toTicket(row), viewBaseUrl));
    },

    async getTickets(ticketIds) {
      if (ticketIds.length === 0) return [];
      const { rows } = await driver.query("select * from tickets where ticket_id = any($1::text[])", [ticketIds]);
      const byId = new Map(rows.map((row) => [row.ticket_id, toTicket(row)]));
      return ticketIds.map((id) => byId.get(id)).filter(Boolean);
    },

    async stats() {
      const { rows } = await driver.query(`
        select (select count(*)::int from orders)  as orders,
               (select count(*)::int from tickets) as tickets,
               (select count(*)::int from events)  as events
      `);
      return rows[0];
    },

    orderView: buildOrderView,
    expireStale,
  };
}
