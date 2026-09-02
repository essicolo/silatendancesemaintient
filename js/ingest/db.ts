/**
 * DuckDB access for the Deno pipeline (ported from the retired Python
 * loader, tag `python-archive`). The schema lives beside this module in
 * schema.sql and is applied on connect, so a fresh clone bootstraps an
 * empty base by itself.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { PollRow, ShareRow } from "./wiki_polls.ts";

export const DB_PATH = new URL("../../data/polls.duckdb", import.meta.url);
const SCHEMA_PATH = new URL("./schema.sql", import.meta.url);

export async function connect(): Promise<DuckDBConnection> {
  const inst = await DuckDBInstance.create(fileURLToPath(DB_PATH));
  const con = await inst.connect();
  await con.run(readFileSync(SCHEMA_PATH, "utf-8"));
  return con;
}

export async function upsertJurisdiction(
  con: DuckDBConnection, code: string, label: string, sourceSite: string,
): Promise<void> {
  await con.run(
    `INSERT INTO jurisdictions VALUES (?, ?, ?)
     ON CONFLICT (jurisdiction_code) DO UPDATE SET label = excluded.label, source_site = excluded.source_site`,
    [code, label, sourceSite],
  );
}

export async function upsertParties(
  con: DuckDBConnection, jurisdiction: string, partyOrder: string[],
): Promise<void> {
  for (const [i, code] of partyOrder.entries()) {
    await con.run(
      `INSERT INTO parties VALUES (?, ?, NULL, ?)
       ON CONFLICT (jurisdiction_code, party_code) DO UPDATE SET display_order = excluded.display_order`,
      [jurisdiction, code, i],
    );
  }
  await con.run(
    `INSERT INTO parties VALUES (?, 'AUTRES', 'Autres / indépendants', ?)
     ON CONFLICT (jurisdiction_code, party_code) DO NOTHING`,
    [jurisdiction, partyOrder.length],
  );
}

export async function upsertRegions(
  con: DuckDBConnection, jurisdiction: string, regionCodes: string[],
): Promise<void> {
  for (const code of regionCodes) {
    await con.run(
      `INSERT INTO regions VALUES (?, ?, ?)
       ON CONFLICT (jurisdiction_code, region_code) DO UPDATE SET region_label = excluded.region_label`,
      [jurisdiction, code, code],
    );
  }
}

export async function upsertPolls(con: DuckDBConnection, polls: PollRow[]): Promise<void> {
  if (!polls.length) return;
  const stmt = await con.prepare(
    `INSERT INTO polls VALUES (?, ?, ?, ?, ?::DATE, ?, ?, ?, ?, ?, now())
     ON CONFLICT (poll_id) DO UPDATE SET
       sample_size = excluded.sample_size,
       firm_rating = excluded.firm_rating,
       scraped_at = excluded.scraped_at`,
  );
  for (const p of polls) {
    stmt.bind([
      p.poll_id, p.jurisdiction_code, p.region_code, p.firm, p.poll_date,
      p.sample_size, p.is_rolling, p.firm_rating, p.general_election, p.source_url,
    ]);
    await stmt.run();
  }
}

export async function upsertPollShares(con: DuckDBConnection, shares: ShareRow[]): Promise<void> {
  if (!shares.length) return;
  const stmt = await con.prepare(
    `INSERT INTO poll_shares VALUES (?, ?, ?)
     ON CONFLICT (poll_id, party_code) DO UPDATE SET pct_reported = excluded.pct_reported`,
  );
  for (const s of shares) {
    stmt.bind([s.poll_id, s.party_code, s.pct_reported]);
    await stmt.run();
  }
}

/** Query helper: rows as plain objects, DATE/TIMESTAMP columns cast to
 * VARCHAR at the SQL level by the caller (strings end to end, no driver
 * date-type surprises). */
export async function all(
  con: DuckDBConnection, sql: string, params?: unknown[],
): Promise<Record<string, unknown>[]> {
  const reader = params?.length
    ? await (async () => {
      const stmt = await con.prepare(sql);
      stmt.bind(params as never);
      return await stmt.runAndReadAll();
    })()
    : await con.runAndReadAll(sql);
  return reader.getRowObjects() as Record<string, unknown>[];
}
