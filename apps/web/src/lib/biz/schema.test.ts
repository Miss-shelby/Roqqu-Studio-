import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import { ensureSchema } from "./db";

// A brand-new, empty database (like a fresh Neon project): no tables at all.
let server: PGLiteSocketServer;
let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  const port = 20000 + Math.floor(Math.random() * 20000);
  server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1", maxConnections: 4 });
  await server.start();
  globalThis.__bizSchema = undefined;
  globalThis.__bizSql = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1, prepare: false, onnotice: () => {} });
}, 60_000);

afterAll(async () => {
  await globalThis.__bizSql?.end({ timeout: 1 });
  globalThis.__bizSql = undefined;
  globalThis.__bizSchema = undefined;
  await server.stop();
  await pg.close();
});

it("creates every table on first use, and running it again is harmless", async () => {
  await ensureSchema();
  globalThis.__bizSchema = undefined; // simulate a second cold start
  await ensureSchema();
  const rows = await globalThis.__bizSql!<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
  expect(rows.map((r) => r.table_name)).toEqual(["businesses", "invoices", "ledger", "products", "sends", "wallets", "webhook_events"]);
});
