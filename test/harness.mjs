/**
 * Test fixtures shared by the suites.
 *
 * The interesting part is that the whole API suite runs twice: once against the
 * in-process store and once against a real PostgreSQL 18 server started by
 * `embedded-postgres`. The Postgres run goes through the exact production path —
 * `DATABASE_URL` -> `createPgDriver` -> `pg.Pool` -> `createPostgresStore` — so
 * the SQL, the transactions and the connection pool are all genuinely exercised
 * rather than mocked.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

export const PAY_TO = "0x1111111111111111111111111111111111111111";
export const ORGANIZER_KEY = "organizer-test-key";
export const EVENT = "evt_afrogroove_2026";
export const FACILITATOR_TX = `0x${"ab".repeat(32)}`;
export const PAYER = "0x00000000000000000000000000000000000000a1";

/** Stand-in for a Base facilitator. Proves the server's flow, not the chain. */
export async function startFacilitator({ valid = true, settle = true } = {}) {
  const calls = { verify: 0, settle: 0, settled: [], payloads: [] };
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.post("/verify", (req, res) => {
    calls.verify += 1;
    calls.payloads.push(req.body);
    res.json(valid ? { isValid: true, payer: PAYER } : { isValid: false, invalidReason: "insufficient_funds" });
  });
  app.post("/settle", (req, res) => {
    calls.settle += 1;
    calls.settled.push(req.body.paymentRequirements?.maxAmountRequired);
    res.json(settle
      ? { success: true, transaction: FACILITATOR_TX, network: "eip155:8453", payer: PAYER }
      : { success: false, errorReason: "unexpected_settle_error" });
  });
  const server = await new Promise((resolve) => { const started = app.listen(0, () => resolve(started)); });
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Boots a throwaway PostgreSQL 18 server. `reset()` drops and recreates the
 * schema so each test starts from the seeded state, and `stop()` removes the
 * data directory.
 */
export async function startPostgres() {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dataDir = await mkdtemp(join(tmpdir(), "eventpass-pg-"));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = 55_000 + Math.floor(Math.random() * 4_000);
    const pg = new EmbeddedPostgres({
      databaseDir: dataDir, user: "eventpass", password: "eventpass", port, persistent: false,
    });
    try {
      await pg.initialise();
      await pg.start();
      await pg.createDatabase("eventpass");
      const url = `postgres://eventpass:eventpass@127.0.0.1:${port}/eventpass`;
      // `getPgClient()` connects to the cluster's default database, not to the one
      // the API uses, so resets go through the same URL the application is given.
      const pgModule = await import("pg");
      const admin = new pgModule.default.Client({ connectionString: url });
      await admin.connect();
      return {
        url,
        async reset() {
          // A fresh schema is the cheapest true isolation between tests.
          await admin.query("drop schema if exists public cascade");
          await admin.query("create schema public");
        },
        async stop() {
          await admin.end().catch(() => {});
          await pg.stop().catch(() => {});
          await rm(dataDir, { recursive: true, force: true }).catch(() => {});
        },
      };
    } catch {
      await pg.stop().catch(() => {});
    }
  }
  throw new Error("could not start an embedded PostgreSQL server");
}

/** Both storage backends, as `{ name, env(), pg }` entries the suites can loop over. */
export function backends(postgres) {
  const list = [{ name: "memory", env: () => ({}), pg: undefined }];
  if (postgres) list.push({ name: "postgres", env: () => ({ DATABASE_URL: postgres.url }), pg: postgres });
  return list;
}

export async function startApi(env = {}, postgres) {
  const { createEventPass } = await import("../server.mjs");
  if (env.DATABASE_URL && postgres) await postgres.reset();
  const { app, store, config, close } = await createEventPass({ TICKET_SECRET: "test-secret", ORGANIZER_KEY, ...env });
  const server = await new Promise((resolve) => { const started = app.listen(0, () => resolve(started)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    store,
    config,
    close: async () => { await new Promise((r) => server.close(r)); await close(); },
  };
}

/** A well-formed EIP-3009 `exact` payload, base64-encoded for the payment header. */
export function paymentHeader(overrides = {}) {
  const {
    network = "eip155:8453", x402Version = 2, amount = "19000000", to = PAY_TO,
    asset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", scheme = "exact",
    validAfter = "0", validBefore = "9999999999", nonce = `0x${"ef".repeat(32)}`,
    signature = `0x${"cd".repeat(65)}`, from = PAYER, header = "PAYMENT-SIGNATURE", raw,
  } = overrides;
  if (raw !== undefined) return { [header]: raw };
  const payload = {
    x402Version,
    scheme,
    network,
    asset,
    payload: { signature, authorization: { from, to, value: amount, validAfter, validBefore, nonce } },
  };
  return { [header]: Buffer.from(JSON.stringify(payload), "utf8").toString("base64") };
}

export const reserve = (base, body) =>
  fetch(`${base}/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const payUrl = (base, orderId) => `${base}/v1/orders/${orderId}/pay`;

export const options = async (base) => (await (await fetch(`${base}/v1/events/${EVENT}/options`)).json());
export const remaining = async (base, tierId = "tier_ga") =>
  (await options(base)).tiers.find((tier) => tier.tierId === tierId).remaining;

export const redeem = (base, code) =>
  fetch(`${base}/v1/organizer/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-organizer-key": ORGANIZER_KEY },
    body: JSON.stringify({ code }),
  });

export const codeOf = (ticket) => decodeURIComponent(new URL(ticket.qrPayload).pathname.split("/t/")[1]);
