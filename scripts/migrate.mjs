/**
 * Applies the schema and seeds the launch event against DATABASE_URL.
 *
 *   DATABASE_URL=postgres://... node scripts/migrate.mjs
 *
 * Safe to run repeatedly: the DDL is `if not exists` and the seed inserts with
 * `on conflict do nothing`, so a redeploy never resets sold inventory.
 */
import { createPgDriver } from "../lib/drivers/pg.mjs";
import { applySchema, seedStatements } from "../lib/schema.mjs";
import { SEED_EVENT } from "../lib/seed.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Nothing to migrate.");
  process.exit(1);
}

const driver = createPgDriver(url);
try {
  await applySchema(driver);
  for (const statement of seedStatements(SEED_EVENT)) await driver.query(statement.text, statement.values);
  const { rows } = await driver.query("select count(*)::int as events from events");
  console.log(`[migrate] schema applied; ${rows[0].events} event(s) present.`);
} finally {
  await driver.close();
}
