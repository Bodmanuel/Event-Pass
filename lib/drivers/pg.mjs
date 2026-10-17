import pg from "pg";

/**
 * Driver binding for a real Postgres server. The store only depends on this
 * shape — `query(sql, params)` and `withTransaction(fn)` — so the adapter is
 * isolated from the pooling and TLS decisions made here.
 */

/**
 * A serverless instance handles one request at a time, so a ten-connection pool
 * is ten connections held open against a metered database for no throughput
 * gain. Managed Postgres (Supabase's pooler, Neon) also caps concurrent
 * connections per project, and every extra idle pool eats into that cap.
 */
function poolSize() {
  const configured = Number(process.env.PG_POOL_MAX);
  if (Number.isInteger(configured) && configured > 0) return configured;
  return process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? 1 : 10;
}

function hostOf(connectionString) {
  try {
    return new URL(connectionString).hostname;
  } catch {
    // A password containing an unescaped character can defeat URL parsing; the
    // host is still readable in the authority section.
    return /@([^/:?]+)/.exec(connectionString ?? "")?.[1];
  }
}

/**
 * Managed Postgres requires TLS and hands out a URL that may or may not say so:
 * Neon appends `?sslmode=require`, Supabase's pooler often does not.
 *
 *  - `sslmode=disable` (or `DATABASE_SSL=disable`) turns TLS off;
 *  - `sslmode=verify-ca|verify-full` (or `DATABASE_SSL=verify`) verifies the
 *    certificate chain — correct where the CA is in the default trust store;
 *  - `sslmode=require|prefer` encrypts without verifying;
 *  - with no sslmode at all, anything that is not plainly local is encrypted
 *    without verification, because a pooler presenting a certificate the local
 *    trust store does not know would otherwise fail the connection outright.
 *
 * Set `DATABASE_SSL=verify` in production once you have confirmed the provider's
 * CA is trusted; that is the setting that also resists an active interception.
 */
function resolveSsl(connectionString) {
  if (process.env.DATABASE_SSL === "disable") return false;
  if (process.env.DATABASE_SSL === "verify") return { rejectUnauthorized: true };

  const url = connectionString ?? "";
  if (/sslmode=disable/.test(url)) return false;
  if (/sslmode=(verify-ca|verify-full)/.test(url)) return { rejectUnauthorized: true };
  if (/sslmode=(require|prefer|allow)/.test(url)) return { rejectUnauthorized: false };

  const host = hostOf(url);
  if (!host || /^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(host)) return undefined;
  return { rejectUnauthorized: false };
}

/** The parsed URL, or undefined when the string is not one. */
function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** Percent-decoded, or verbatim if it is not valid encoding. */
function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The non-secret shape of a connection target. Enough to diagnose a failed
 * connection from the deployment's own logs, and it never includes the password —
 * only how many characters it has, which separates "the password is right but was
 * rejected" from "the URL has no password in it at all", a paste error that
 * otherwise looks identical from the driver's error message.
 *
 * The count is of the *decoded* password, because that is the string the server
 * actually receives: `%23` is one secret character, not three.
 */
export function describeDatabase(url) {
  const parsed = parseUrl(url);
  if (!parsed) return { malformed: true };
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    user: parsed.username,
    database: parsed.pathname.replace(/^\//, "") || "postgres",
    passwordChars: decoded(parsed.password).length,
    sslmode: parsed.searchParams.get("sslmode") ?? "(unset)",
  };
}

/**
 * Catches the misconfigurations that are genuinely hard to read from the driver's
 * own error, in the order they are likely to occur.
 *
 * 1. The password is still the template placeholder. Supabase's Connect panel
 *    hands out a string with `[YOUR-PASSWORD]` in it, and copying it before
 *    substituting the real password produces exactly `password authentication
 *    failed for user "postgres"` — which reads as a wrong password and sends you
 *    hunting for a credential that was never in the string.
 *
 * 2. A remote URL with no password at all, which fails identically. Localhost is
 *    exempt: trust and peer authentication legitimately need no password.
 *
 * 3. A raw `#`, `/` or `?` in the password does not parse as a URL. This is
 *    checked with the same WHATWG parser the `pg` driver uses, so refusing here
 *    means refusing a string the driver would itself have rejected — not a
 *    working URL turned away. The fix is to percent-encode that character.
 *
 * 4. Supabase's pooler routes connections by *username*: the transaction pooler
 *    (port 6543) and session pooler (5432 on a `pooler.supabase.com` host) both
 *    need `postgres.<project-ref>`, while the direct connection uses a bare
 *    `postgres`. Trimming the project ref off the username also produces
 *    `password authentication failed for user "postgres"`.
 */
export function assertUsableDatabaseUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) {
    throw new Error(
      "DATABASE_URL is not a valid connection URL. If the password contains " +
      "#, / or ?, it must be percent-encoded in the URL (# becomes %23); otherwise " +
      "the string is truncated at that character and the driver sees the wrong password.",
    );
  }

  const password = decoded(parsed.password);
  if (/your[-_ ]?password/i.test(password)) {
    throw new Error(
      "DATABASE_URL still contains the placeholder password from Supabase's Connect panel. " +
      "Replace [YOUR-PASSWORD] with the database password: open the project's Connect panel, " +
      "and use the password shown there, or reset it with Settings -> Database -> Reset database " +
      "password if it is not recorded. Percent-encode it if it contains #, / or ?.",
    );
  }

  const loopback = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(parsed.hostname);
  if (password === "" && !loopback) {
    throw new Error(
      `DATABASE_URL for ${parsed.hostname} has no password. The connection string from the ` +
      "provider includes it between the ':' after the username and the '@'; a string without " +
      "one fails as \"password authentication failed\".",
    );
  }

  const shape = describeDatabase(url);
  if (/^[a-z0-9-]+\.pooler\.supabase\.(com|net)$/.test(shape.host) && !shape.user.includes(".")) {
    throw new Error(
      `DATABASE_URL points at the Supabase pooler (${shape.host}:${shape.port}) but the username is "${shape.user}". ` +
      `The pooler routes by username, so it must be "postgres.<project-ref>" — a bare "postgres" is only correct for ` +
      `the direct connection. Copy the string verbatim from Supabase's Connect panel, "Transaction pooler" section.`,
    );
  }
  return shape;
}

export function createPgDriver(connectionString, { max, ssl } = {}) {
  assertUsableDatabaseUrl(connectionString);
  const pool = new pg.Pool({
    connectionString,
    max: max ?? poolSize(),
    ssl: ssl !== undefined ? ssl : resolveSsl(connectionString),
    // A cold serverless start can meet a paused database (Supabase free tier
    // suspends idle projects), so allow a slow first connection.
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 10_000),
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });

  return {
    query: (text, params) => pool.query(text, params),

    async withTransaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn({ query: (text, params) => client.query(text, params) });
        await client.query("commit");
        return result;
      } catch (error) {
        try { await client.query("rollback"); } catch { /* the connection is already unusable */ }
        throw error;
      } finally {
        client.release();
      }
    },

    close: () => pool.end(),
  };
}

// Exported so the platform policy above can be tested directly rather than only
// through a live connection.
export { poolSize, resolveSsl };
