/**
 * The serverless deployment path.
 *
 * `api/index.mjs` is what the platform invokes, and it differs from `lib/app.mjs`
 * in one way that matters here: the whole app is built once per warm instance
 * rather than once per process.
 *
 * The simulator below also reproduces a host that buffers the body and invokes
 * the handler with a drained stream, because that is the failure mode the
 * `_body` guard in `lib/app.mjs` exists to prevent.
 *
 * Vercel is not such a host. That was checked directly: the middleware was
 * removed, deployed to production, and POSTs still returned 201 — Vercel hands
 * the function a readable stream. The guard is kept for the hosts that do buffer
 * (and to keep this failure mode covered), not because the deployment needs it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import test, { after } from "node:test";

import { EVENT, ORGANIZER_KEY, backends, reserve, startPostgres } from "./harness.mjs";
import { poolSize, resolveSsl, describeDatabase, assertUsableDatabaseUrl } from "../lib/drivers/pg.mjs";

/** Serves the serverless handler the way the platform does. */
async function startPlatform(env = {}, postgres) {
  if (env.DATABASE_URL && postgres) await postgres.reset();

  const saved = { ...process.env };
  Object.assign(process.env, env);
  // A distinct specifier gives this test its own module instance, and therefore
  // its own cold start. Without it the singleton would leak between tests.
  const { default: handler } = await import(`../api/index.mjs?instance=${randomUUID()}`);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      // Stand in for a host that buffers the body before invoking the function
      // and leaves the stream drained. Vercel does not do this (see the note at
      // the top of the file), but other integrations do.
      if (/application\/json/.test(req.headers["content-type"] ?? "") && raw) {
        try { req.body = JSON.parse(raw); } catch { /* the platform rejects this itself */ }
      }
      Promise.resolve(handler(req, res)).catch((error) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.message }));
      });
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => server.closeAllConnections?.() ?? resolve());
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    },
  };
}

const postgres = await startPostgres();
after(async () => { await postgres.stop(); });

// The platform path is Postgres-only by construction: `createEventPass` refuses
// to serve from the in-process store on a serverless host, so `VERCEL` is set
// here and the memory backend is exercised by its own test below.
const platformBackends = backends(postgres).filter((backend) => backend.name === "postgres");
const platformEnv = (backend) => ({ TICKET_SECRET: "test-secret", VERCEL: "1", ...backend.env() });

test("a serverless host with no DATABASE_URL refuses to start rather than serve from memory", async (t) => {
  const platform = await startPlatform({ TICKET_SECRET: "test-secret", VERCEL: "1" });
  t.after(() => platform.close());

  // A per-instance store would lose every order on a cold start and let two
  // instances sell the same seat. Refusing is the only honest answer.
  const response = await fetch(`${platform.base}/healthz`);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.error, /could not start/i);
  assert.ok(!/postgres:\/\//.test(JSON.stringify(body)), "the boot failure must not echo the connection string");
});

for (const backend of platformBackends) {
  test(`[${backend.name}] the handler serves the app the platform invokes`, async (t) => {
    const platform = await startPlatform(platformEnv(backend), backend.pg);
    t.after(() => platform.close());

    const health = await (await fetch(`${platform.base}/healthz`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.storage, "postgres", "a serverless deployment must never report memory storage");
    assert.equal(health.x402.payToConfigured, false, "payment is deliberately unconfigured here");
  });

  test(`[${backend.name}] a body the platform already parsed still reaches the route`, async (t) => {
    const platform = await startPlatform(platformEnv(backend), backend.pg);
    t.after(() => platform.close());

    // If the consumed-stream guard were missing this would hang until the test
    // timed out, on any host that buffers the body before invoking the handler.
    const created = await reserve(platform.base, { eventId: EVENT, tierId: "tier_ga", quantity: 2 });
    const raw = await created.text();
    assert.equal(created.status, 201, raw);
    const order = JSON.parse(raw);
    assert.equal(order.quantity, 2);
    assert.equal(order.totalAtomic, "19000000");
    assert.ok(order.payUrl.startsWith(platform.base), "the pay URL must point at the deployment, not at a stale base");
  });

  test(`[${backend.name}] a warm instance reuses one app instead of rebuilding it`, async (t) => {
    const platform = await startPlatform(platformEnv(backend), backend.pg);
    t.after(() => platform.close());

    const created = await (await reserve(platform.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 })).json();
    // A second request sees the first request's order. That is only true if both
    // ran against the same instance; a per-request cold start would 404 here and,
    // more importantly, would lose inventory on every request.
    const fetched = await fetch(`${platform.base}/v1/orders/${created.orderId}`);
    assert.equal(fetched.status, 200);
    assert.equal((await fetched.json()).orderId, created.orderId);
  });

  test(`[${backend.name}] unconfigured payment fails closed on the deployed path`, async (t) => {
    const platform = await startPlatform(platformEnv(backend), backend.pg);
    t.after(() => platform.close());

    const order = await (await reserve(platform.base, { eventId: EVENT, tierId: "tier_ga", quantity: 1 })).json();
    const paid = await fetch(order.payUrl);
    assert.equal(paid.status, 501, "no payment configuration must mean no tickets, not a pretend settlement");
    const body = await paid.json();
    assert.deepEqual(body.missing, ["X402_PAY_TO", "X402_FACILITATOR_URL"]);
    assert.equal((await (await fetch(`${platform.base}/v1/orders/${order.orderId}`)).json()).tickets.length, 0);
  });

  test(`[${backend.name}] a truncated body is a 400, not a hang`, async (t) => {
    const platform = await startPlatform(platformEnv(backend), backend.pg);
    t.after(() => platform.close());

    // The platform drains the stream but the JSON does not parse, so no body is
    // attached. The guard still has to mark the request as read.
    const response = await fetch(`${platform.base}/v1/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not json",
    });
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.ok(!text.includes("this is not json"), "the rejected body is never echoed back");
  });

  test(`[${backend.name}] the organizer surface stays locked without ORGANIZER_KEY`, async (t) => {
    const platform = await startPlatform(platformEnv(backend), backend.pg);
    t.after(() => platform.close());

    const response = await fetch(`${platform.base}/v1/organizer/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-organizer-key": ORGANIZER_KEY },
      body: JSON.stringify({ code: "anything" }),
    });
    assert.equal(response.status, 503, "an unset key disables check-in; a wrong key is not silently accepted");
  });
}

// ---------------------------------------------------------------- driver policy

test("a deployed instance refuses to start without TICKET_SECRET", async () => {
  const { createEventPass } = await import("../server.mjs");

  // The old fallback was a fixed string in this repository, so every host that
  // forgot the variable signed tickets with a published value while looking
  // healthy. A deployment must fail loudly instead.
  await assert.rejects(() => createEventPass({ VERCEL: "1" }), /TICKET_SECRET is required/);
  await assert.rejects(() => createEventPass({ AWS_LAMBDA_FUNCTION_NAME: "fn" }), /TICKET_SECRET is required/);
  await assert.rejects(() => createEventPass({ NODE_ENV: "production" }), /TICKET_SECRET is required/);

  // Locally, a random per-process secret is safe: tickets issued before a restart
  // stop verifying rather than becoming forgeable.
  const first = await createEventPass({});
  const second = await createEventPass({});
  assert.equal(first.config.ticketSecretEphemeral, true);
  assert.ok(first.config.ticketSecret.length >= 32, "an ephemeral secret is still a full-strength key");
  assert.notEqual(first.config.ticketSecret, second.config.ticketSecret);

  // A configured secret is used verbatim and is not flagged ephemeral.
  const configured = await createEventPass({ TICKET_SECRET: "a-real-configured-secret" });
  assert.equal(configured.config.ticketSecret, "a-real-configured-secret");
  assert.equal(configured.config.ticketSecretEphemeral, false);
});

test("a pooler URL with a bare username is named as the problem, not left as an auth failure", () => {
  // Supabase's pooler routes by username and answers a bare `postgres` with
  // "password authentication failed", which reads as a wrong password. This was
  // not what broke the first production deploy (that was the placeholder
  // password, below) but it is the same misleading error and the same fix.
  const pooler = "postgresql://postgres:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
  assert.throws(() => assertUsableDatabaseUrl(pooler), /must be "postgres\.<project-ref>"/);

  // The correctly-formed pooler string, and the direct connection it is confused
  // with, both pass.
  assert.doesNotThrow(() => assertUsableDatabaseUrl(
    "postgresql://postgres.abcdefghijklmnop:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres"));
  assert.doesNotThrow(() => assertUsableDatabaseUrl(
    "postgresql://postgres:secret@db.abcdefghijklmnop.supabase.co:5432/postgres"));
  assert.doesNotThrow(() => assertUsableDatabaseUrl(
    "postgres://eventpass:eventpass@127.0.0.1:5432/eventpass"));

  assert.throws(() => assertUsableDatabaseUrl("not a url"), /not a valid connection URL/);

  // A raw #, / or ? does not parse as a URL — checked against the same WHATWG
  // parser `pg` itself uses, so this refuses a string the driver would reject
  // anyway rather than turning away a working one.
  assert.throws(() => assertUsableDatabaseUrl(
    "postgresql://postgres.abc:pa#ss@aws-0-us-east-1.pooler.supabase.com:6543/postgres"),
  /percent-encoded/);
  // Percent-encoded, the same password is a valid URL.
  assert.doesNotThrow(() => assertUsableDatabaseUrl(
    "postgresql://postgres.abc:pa%23ss@aws-0-us-east-1.pooler.supabase.com:6543/postgres"));
});

test("the template placeholder is named, because it fails exactly like a wrong password", () => {
  // Supabase's Connect panel hands out the connection string with the password
  // left as a placeholder. Pasted as-is it reaches Postgres, which answers
  // "password authentication failed" — the one error that does not tell you the
  // string was never finished. This is what the live deployment was doing.
  assert.throws(
    () => assertUsableDatabaseUrl(
      "postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"),
    /placeholder password/);
  // The spelling other panels use is caught too.
  assert.throws(
    () => assertUsableDatabaseUrl("postgresql://postgres.abc:<your-password>@host:6543/postgres"),
    /placeholder password/);

  // A real password that merely contains the word is not the placeholder.
  assert.doesNotThrow(() => assertUsableDatabaseUrl(
    "postgresql://postgres.abc:nottheplaceholder@host:6543/postgres"));

  // A remote URL with no password fails identically and is worth separating;
  // localhost is exempt because trust auth legitimately needs no password.
  assert.throws(
    () => assertUsableDatabaseUrl(
      "postgresql://postgres.abcdefghijklmnop@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"),
    /has no password/);
  assert.doesNotThrow(() => assertUsableDatabaseUrl("postgres://eventpass@127.0.0.1:5432/eventpass"));
});

test("the database shape is diagnosable without exposing the password", () => {
  const shape = describeDatabase(
    "postgresql://postgres.abcdefghijklmnop:sup3r-s3cret-value@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require");
  assert.deepEqual(shape, {
    host: "aws-0-us-east-1.pooler.supabase.com",
    port: "6543",
    user: "postgres.abcdefghijklmnop",
    database: "postgres",
    passwordChars: "sup3r-s3cret-value".length,
    sslmode: "require",
  });
  assert.ok(!JSON.stringify(shape).includes("sup3r-s3cret-value"),
    "the shape reports the password's length, never the password");

  // The count is of what the server receives, not of the URL text: %23 is one
  // character of password. Reading the raw URL would report three and make a
  // correct password look truncated.
  assert.equal(
    describeDatabase("postgresql://postgres.abc:pa%23ss@host:6543/postgres").passwordChars, 5);

  // The case the count exists for: a URL pasted without its password. From the
  // driver's error alone this is indistinguishable from a wrong password.
  assert.equal(
    describeDatabase("postgresql://postgres.abcdefghijklmnop@host:6543/postgres").passwordChars, 0);

  // No sslmode is normal for Supabase's pooler, and is reported as such rather
  // than as an empty value.
  assert.equal(describeDatabase("postgresql://u:p@host:6543/postgres").sslmode, "(unset)");

  const malformed = describeDatabase("postgresql://u:pa#ss@host/db");
  assert.deepEqual(malformed, { malformed: true });
  assert.ok(!JSON.stringify(malformed).includes("pa#ss"));
});

test("a serverless instance holds one connection, a long-lived one holds more", () => {
  const saved = { ...process.env };
  try {
    delete process.env.PG_POOL_MAX;
    delete process.env.VERCEL;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    assert.equal(poolSize(), 10, "a normal process may keep a pool");

    process.env.VERCEL = "1";
    assert.equal(poolSize(), 1, "a lambda handles one request at a time; a wider pool just holds connections open");

    process.env.PG_POOL_MAX = "4";
    assert.equal(poolSize(), 4, "an explicit setting wins on either platform");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("TLS is on for a managed host, off for localhost, and never silently unverified when asked to verify", () => {
  const saved = process.env.DATABASE_SSL;
  try {
    delete process.env.DATABASE_SSL;

    // Local development must keep working without a certificate.
    assert.equal(resolveSsl("postgres://u:p@127.0.0.1:5432/db"), undefined);
    assert.equal(resolveSsl("postgres://u:p@localhost:5432/db"), undefined);

    // Supabase's pooler often omits sslmode but still requires TLS.
    assert.deepEqual(resolveSsl("postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres"),
      { rejectUnauthorized: false });
    assert.deepEqual(resolveSsl("postgres://u:p@ep-cool.neon.tech/db?sslmode=require"),
      { rejectUnauthorized: false });
    assert.equal(resolveSsl("postgres://u:p@h/db?sslmode=disable"), false);

    process.env.DATABASE_SSL = "verify";
    assert.deepEqual(resolveSsl("postgres://u:p@ep-cool.neon.tech/db"),
      { rejectUnauthorized: true }, "asking to verify must not be downgraded to an unverified connection");

    process.env.DATABASE_SSL = "disable";
    assert.equal(resolveSsl("postgres://u:p@ep-cool.neon.tech/db"), false);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_SSL; else process.env.DATABASE_SSL = saved;
  }
});
