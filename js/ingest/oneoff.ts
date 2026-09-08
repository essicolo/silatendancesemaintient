/**
 * Shared helper for one-off poll loaders (report PDFs transcribed by hand).
 * Convention inherited from the Python loaders (tag `python-archive`):
 *
 *  - a NATIONAL row may be loaded ahead of Wikipedia; the watch's wholesale
 *    reload of the National series replaces it with Wikipedia's version of
 *    the same poll once their table carries it (same poll_id key:
 *    firm|date|sample), so convergence is automatic and double counting
 *    impossible.
 *  - REGIONAL rows (MTL/QC/REG) survive watch runs (the reload only touches
 *    National) and feed the joint regional GP.
 *  - re-running a loader is idempotent (delete + insert on its own ids).
 */

import { connect } from "./db.ts";
import { pollId } from "./wiki_polls.ts";

export interface OneOffRegion {
  n: number;
  shares: Record<string, number>; // party code -> pct as published
}

export async function loadOneOff(
  firm: string,
  fieldEnd: string, // ISO date used as poll_date (match Wikipedia's convention)
  source: string,
  regions: Record<string, OneOffRegion>, // keys: "National", "MTL", "QC", "REG"
): Promise<void> {
  const con = await connect();
  for (const [region, { n, shares }] of Object.entries(regions)) {
    const pid = pollId("qc-provincial", region, firm, fieldEnd, String(n));
    await con.run("DELETE FROM poll_shares WHERE poll_id = ?", [pid]);
    await con.run("DELETE FROM polls WHERE poll_id = ?", [pid]);
    await con.run(
      "INSERT INTO polls VALUES (?, 'qc-provincial', ?, ?, ?::DATE, ?, false, NULL, NULL, ?, now())",
      [pid, region, firm, fieldEnd, n, source],
    );
    for (const [party, pct] of Object.entries(shares)) {
      await con.run("INSERT INTO poll_shares VALUES (?, ?, ?)", [pid, party, pct]);
    }
    console.log(`  ${region}: n=${n}`, shares);
  }
  con.closeSync();
}
