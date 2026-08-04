// One-time migration: copy all data from the legacy bun:sqlite database
// (data/sharpedge.db) into Supabase Postgres. Idempotent: it TRUNCATEs the
// Postgres tables first, so it can be re-run safely.
//
// Run: bun run scripts/migrate-to-supabase.ts
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { readFileSync } from "fs";
import { join } from "path";
import { config } from "../src/config";

if (!config.databaseUrl) {
  console.error("DATABASE_URL is not set (see .env). Aborting.");
  process.exit(1);
}

const sqlite = new Database(config.dbPath, { readonly: true });
const pg = new SQL(config.databaseUrl);

// FK-safe insertion order: parents before children.
const TABLES = [
  "users", "ideas", "trade_outcomes", "tracked_trades", "sessions", "broker_links",
  "broker_positions", "risk_prefs", "events", "signals", "briefings", "bars",
  "daily_stats", "screener", "settings", "universe", "market_snapshot",
  "sector_history", "ai_spend", "alerts",
];

// Postgres param limit is 65535; stay well under it per bulk insert.
const MAX_PARAMS = 60000;

async function main() {
  // 1. Ensure the schema exists (idempotent CREATE TABLE IF NOT EXISTS ...).
  await pg.unsafe(readFileSync(join(import.meta.dir, "../src/schema.sql"), "utf8")).simple();
  console.log("[migrate] schema applied");

  // 2. Clear existing Postgres data so the run is idempotent.
  await pg.unsafe(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`).simple();
  console.log("[migrate] truncated target tables");

  const summary: { table: string; src: number; dst: number }[] = [];

  // 3. Copy each table.
  for (const table of TABLES) {
    const cols = (sqlite.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.length) { console.warn(`[migrate] ${table}: no such table in SQLite, skipping`); continue; }
    const rows = sqlite.query(`SELECT ${cols.join(", ")} FROM ${table}`).all() as Record<string, unknown>[];

    if (rows.length) {
      const rowsPerChunk = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
      for (let i = 0; i < rows.length; i += rowsPerChunk) {
        const chunk = rows.slice(i, i + rowsPerChunk);
        const params: unknown[] = [];
        const valueGroups = chunk.map((row) => {
          const ph = cols.map((c) => {
            params.push(row[c]);
            return `$${params.length}`;
          });
          return `(${ph.join(", ")})`;
        });
        await pg.unsafe(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${valueGroups.join(", ")}`,
          params
        );
      }
    }

    const dst = Number((await pg.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
    summary.push({ table, src: rows.length, dst });
    console.log(`[migrate] ${table}: ${rows.length} → ${dst}`);
  }

  // 4. Reset serial sequences so future inserts don't collide with copied ids.
  for (const table of ["users", "ideas", "trade_outcomes", "events", "signals", "briefings", "alerts"]) {
    await pg.unsafe(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`
    );
  }
  console.log("[migrate] sequences reset");

  // 5. Report.
  const mismatch = summary.filter((s) => s.src !== s.dst);
  console.log("\n=== migration summary ===");
  for (const s of summary) console.log(`${s.table.padEnd(18)} src=${s.src}  dst=${s.dst}  ${s.src === s.dst ? "✓" : "✗ MISMATCH"}`);
  if (mismatch.length) {
    console.error(`\n✗ ${mismatch.length} table(s) did not match row counts.`);
    process.exit(1);
  }
  console.log("\n✓ All tables migrated with matching row counts.");

  await pg.end();
  sqlite.close();
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
