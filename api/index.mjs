/**
 * Vercel serverless entrypoint.
 *
 * This is the same Express app the container build runs — no routes are
 * duplicated here — wrapped so the platform's `(req, res)` pair drives it.
 *
 * The instance is built once per warm lambda and reused, because building it
 * opens the Postgres pool, applies the schema and seeds the launch event. That
 * is worth doing once per instance and wasteful per request. On a cold start
 * the first request pays for it; every later request on that instance does not.
 */
import { createEventPass } from "../server.mjs";
import { describeDatabase } from "../lib/drivers/pg.mjs";

let instance;

function boot() {
  if (!instance) {
    instance = createEventPass(process.env).catch((error) => {
      // Do not cache a failed cold start: a bad DATABASE_URL should recover on
      // the next request once the environment is fixed, not poison the instance.
      instance = undefined;
      throw error;
    });
  }
  return instance;
}

export default async function handler(req, res) {
  try {
    const { app } = await boot();
    return app(req, res);
  } catch (error) {
    // Never let a boot failure surface as an opaque platform error page: this
    // says what happened without echoing a connection string or a driver stack.
    console.error(`[eventpass] cold start failed: ${error?.name ?? "Error"}: ${error?.message ?? error}`);
    // Host, port, username and password *length* — never the password. This is
    // what turns "authentication failed" into "the pooler username is wrong",
    // and it is only ever written to this deployment's own logs.
    if (process.env.DATABASE_URL) {
      console.error(`[eventpass] database target: ${JSON.stringify(describeDatabase(process.env.DATABASE_URL))}`);
    }
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "EventPass could not start. Check DATABASE_URL and TICKET_SECRET." }));
  }
}
