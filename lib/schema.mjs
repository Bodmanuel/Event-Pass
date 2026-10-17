/**
 * Schema and seed for the Postgres adapter. Single source of truth: the adapter
 * migrates from here, and `pnpm migrate` runs the same DDL from the CLI.
 */

export const SCHEMA_SQL = `
create table if not exists events (
  event_id           text primary key,
  name               text not null,
  genre              text not null,
  city               text not null,
  venue              text not null,
  address            text,
  starts_at          timestamptz not null,
  doors_at           timestamptz,
  timezone           text not null,
  organizer          text not null,
  organizer_verified boolean not null default false
);

create table if not exists tiers (
  tier_id       text primary key,
  event_id      text not null references events(event_id) on delete cascade,
  name          text not null,
  face_cents    integer not null check (face_cents >= 0),
  fee_cents     integer not null check (fee_cents >= 0),
  -- Inventory is only ever mutated by a guarded UPDATE, so this can never go negative.
  remaining     integer not null check (remaining >= 0),
  max_per_order integer not null check (max_per_order > 0)
);
create index if not exists tiers_event_idx on tiers (event_id);

create table if not exists orders (
  order_id        text primary key,
  event_id        text not null references events(event_id),
  tier_id         text not null references tiers(tier_id),
  quantity        integer not null check (quantity > 0),
  holder_name     text,
  unit_face_cents integer not null check (unit_face_cents >= 0),
  unit_fee_cents  integer not null check (unit_fee_cents >= 0),
  total_cents     integer not null check (total_cents >= 0),
  status          text not null check (status in ('awaiting_payment','tickets_issued','expired','cancelled','failed')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  paid_at         timestamptz,
  transaction_hash text,
  payer           text
);
create index if not exists orders_status_expiry_idx on orders (status, expires_at);

-- The key is claimed before the order row is written (that ordering is what makes
-- concurrent replays serialise), so the FK is deferred to commit time.
create table if not exists idempotency (
  key      text primary key,
  order_id text not null references orders(order_id) on delete cascade deferrable initially deferred
);

create table if not exists tickets (
  ticket_id   text primary key,
  order_id    text not null references orders(order_id) on delete cascade,
  event_id    text not null,
  tier_id     text not null,
  tier_name   text not null,
  holder_name text,
  status      text not null check (status in ('valid','redeemed','void')),
  nonce       text not null,
  code        text not null unique,
  issued_at   timestamptz not null default now(),
  redeemed_at timestamptz
);
create index if not exists tickets_order_idx on tickets (order_id);
create index if not exists tickets_event_idx on tickets (event_id);
`;

/**
 * The DDL split into individual statements. `pg` sends parameterised and
 * multi-statement SQL through the extended protocol, which permits exactly one
 * statement per Parse — so multi-statement strings have to be issued one at a
 * time. (Safe to split on `;` here: no statement contains a semicolon inside a
 * literal.)
 */
export const SCHEMA_STATEMENTS = SCHEMA_SQL.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);

/** Applies the schema in one transaction, so a partial migration cannot land. */
export async function applySchema(driver) {
  await driver.withTransaction(async (tx) => {
    for (const statement of SCHEMA_STATEMENTS) await tx.query(statement);
  });
}

/**
 * Seeds the launch event. `do nothing` on conflict so a restart never resets
 * inventory that has already been sold.
 */
export function seedStatements(event) {
  return [
    {
      text: `
        insert into events (event_id, name, genre, city, venue, address, starts_at, doors_at, timezone, organizer, organizer_verified)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        on conflict (event_id) do nothing
      `,
      values: [
        event.eventId, event.name, event.genre, event.city, event.venue, event.address,
        event.startsAt, event.doorsAt, event.timezone, event.organizer, event.organizerVerified,
      ],
    },
    {
      text: `
        insert into tiers (tier_id, event_id, name, face_cents, fee_cents, remaining, max_per_order)
        values ($1,$2,$3,$4,$5,$6,$7), ($8,$2,$9,$10,$11,$12,$13)
        on conflict (tier_id) do nothing
      `,
      values: [
        event.tiers[0].tierId, event.eventId, event.tiers[0].name,
        event.tiers[0].faceCents, event.tiers[0].feeCents, event.tiers[0].remaining, event.tiers[0].maxPerOrder,
        event.tiers[1].tierId, event.tiers[1].name,
        event.tiers[1].faceCents, event.tiers[1].feeCents, event.tiers[1].remaining, event.tiers[1].maxPerOrder,
      ],
    },
  ];
}
