/**
 * Poll watch: detect new polls, ingest them, refresh the dashboard — Deno
 * port of the retired Python watcher (tag `python-archive`).
 *
 * Designed so that the common case — nothing has changed — costs almost
 * nothing. MediaWiki exposes a page's revision id, so one small API call per
 * cycle page answers "has anything been edited?" without downloading or
 * re-parsing 380 KB of HTML. Only when a revision id moves does the watcher
 * fetch and re-parse.
 *
 * A moved revision id does not mean a new poll: most edits fix typos or touch
 * prose. So the second gate is the data itself — parsed poll ids are diffed
 * against what the database holds, in BOTH directions (a poll corrected or
 * withdrawn upstream, or a parser fix changing what the same page yields,
 * must not survive a watch run). Two gates, cheap then exact.
 *
 * Once new polls land, the export refreshes the JSON inputs and the FULL
 * modelling pipeline (trend GP, regional GP, riding effects, simulation)
 * runs IN-PROCESS via writeProjection — one runtime end to end, no
 * subprocess. The dashboard only displays the resulting file.
 *
 * Usage:
 *   deno task watch              # check once, ingest if new
 *   deno task watch --force      # ingest regardless of revisions
 *   deno task watch --dry-run    # report only, touch nothing
 *
 * Scheduling stays with the OS (stateless process, failures visible in the
 * scheduler's log). On Windows:
 *
 *   schtasks /create /tn "veille-sondages" /sc hourly ^
 *     /tr "cmd /c cd /d C:\Users\parse01\documents-locaux\polls\js && deno task watch >> ..\data\watch.log 2>&1"
 */

import * as aq from "arquero";
import { DuckDBConnection } from "@duckdb/node-api";
import {
  connect, upsertJurisdiction, upsertParties, upsertPolls, upsertPollShares, upsertRegions, all,
} from "./db.ts";
import { POLL_PAGES, fetchAll, latestRevision } from "./wiki_polls.ts";

const REVISION_TABLE = "source_revisions";

async function knownRevisions(con: DuckDBConnection): Promise<Record<string, number>> {
  try {
    const rows = await all(con, `SELECT source, revid FROM ${REVISION_TABLE}`);
    return Object.fromEntries(
      rows
        .filter((r) => String(r.source).startsWith("wiki_qc_"))
        .map((r) => [String(r.source).slice("wiki_qc_".length), Number(r.revid)]),
    );
  } catch {
    return {}; // table absent: first run is a full ingest
  }
}

async function recordRevisions(con: DuckDBConnection, revisions: Record<string, number>): Promise<void> {
  await con.run(
    `CREATE TABLE IF NOT EXISTS ${REVISION_TABLE}
     (source VARCHAR PRIMARY KEY, revid BIGINT, checked_at TIMESTAMP)`,
  );
  for (const [cycle, revid] of Object.entries(revisions)) {
    await con.run(`DELETE FROM ${REVISION_TABLE} WHERE source = ?`, [`wiki_qc_${cycle}`]);
    await con.run(`INSERT INTO ${REVISION_TABLE} VALUES (?, ?, now())`, [`wiki_qc_${cycle}`, revid]);
  }
}

/** Cycles whose Wikipedia page has been edited since last processed. A
 * network failure on one page is reported and skipped, so a single flaky
 * request cannot silence the whole watch. */
async function changedCycles(con: DuckDBConnection): Promise<string[]> {
  const seen = await knownRevisions(con);
  const out: string[] = [];
  for (const [cycle, title] of Object.entries(POLL_PAGES)) {
    try {
      if (seen[cycle] !== await latestRevision(title)) out.push(cycle);
    } catch (exc) {
      console.log(`  ! ${cycle}: impossible de lire la revision (${(exc as Error).message})`);
    }
  }
  return out;
}

// Each cycle page runs from just after one general election to the next, so
// the boundaries are election dates, not calendar years: a poll taken in
// November 2018 belongs to the 2022 page, not the 2018 one.
const CYCLE_BOUNDARIES: [string, number][] = [["2018-10-01", 2018], ["2022-10-03", 2022]];

const cycleOf = (pollDate: string): number => {
  for (const [boundary, cycle] of CYCLE_BOUNDARIES) if (pollDate <= boundary) return cycle;
  return 2026;
};

async function ingestQcPolls(con: DuckDBConnection): Promise<number> {
  const { polls, shares, revisions } = await fetchAll();

  await upsertJurisdiction(con, "qc-provincial", "Québec (provincial)", "fr.wikipedia.org");
  await upsertParties(con, "qc-provincial", ["CAQ", "LIB", "QS", "PQ", "PCQ", "AUTRES"]);
  await upsertRegions(con, "qc-provincial", ["National"]);

  // Replace ONLY the National series this source provides. Regional rows
  // (MTL/QC/REG) come from other loaders — report PDFs — and a blanket
  // jurisdiction-wide delete silently destroyed them on every watch run.
  await con.run(
    `DELETE FROM poll_shares WHERE poll_id IN
     (SELECT poll_id FROM polls WHERE jurisdiction_code = 'qc-provincial' AND region_code = 'National')`,
  );
  await con.run("DELETE FROM polls WHERE jurisdiction_code = 'qc-provincial' AND region_code = 'National'");

  await upsertPolls(con, polls);
  await upsertPollShares(con, shares);
  await recordRevisions(con, revisions);
  return polls.length;
}

export async function run(force = false, dryRun = false): Promise<number> {
  let con = await connect();
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  console.log(`[${stamp}] veille des sondages`);

  const cycles = force ? Object.keys(POLL_PAGES) : await changedCycles(con);
  if (!cycles.length) {
    console.log("  aucune page modifiee, rien a faire");
    con.closeSync();
    return 0;
  }
  console.log(`  pages modifiees : ${cycles.join(", ")}`);

  const existing = await all(
    con,
    "SELECT poll_id, poll_date::VARCHAR AS poll_date FROM polls WHERE jurisdiction_code = 'qc-provincial'",
  );
  const before = new Set(existing.map((r) => String(r.poll_id)));
  const { polls, revisions } = await fetchAll(cycles);
  const parsed = new Set(polls.map((p) => p.poll_id));

  const fresh = aq
    .from(polls.filter((p) => !before.has(p.poll_id)))
    .orderby(aq.desc("poll_date"));

  // Additions are not the only kind of change: a poll can be corrected or
  // removed upstream, and a parser fix changes what the same page yields.
  // Only cycles actually re-parsed are eligible for removal, so a partial run
  // cannot delete the cycles it never looked at.
  const reparsed = new Set(cycles.map(Number));
  const stale = existing.filter(
    (r) => !parsed.has(String(r.poll_id)) && reparsed.has(cycleOf(String(r.poll_date))),
  );
  if (stale.length) console.log(`  ${stale.length} sondage(s) en base ne figurent plus a la source`);

  if (!fresh.numRows() && !stale.length) {
    console.log("  page modifiee mais aucun changement de sondage");
    if (!dryRun) {
      // Record the revision anyway: the edit was real and has been examined,
      // so the next run should not re-examine it.
      await recordRevisions(con, revisions);
    }
    con.closeSync();
    return 0;
  }

  if (fresh.numRows()) {
    console.log(`  ${fresh.numRows()} nouveau(x) sondage(s) :`);
    for (const row of fresh.slice(0, 20).objects() as { poll_date: string; firm: string; sample_size: number | null }[]) {
      console.log(`    ${row.poll_date}  ${row.firm.padEnd(22)} n=${row.sample_size ?? "?"}`);
    }
  }

  if (dryRun) {
    console.log("  --dry-run : rien n'a ete ecrit");
    con.closeSync();
    return fresh.numRows();
  }

  con.closeSync();
  con = await connect();
  const total = await ingestQcPolls(con);
  console.log(`  base rechargee : ${total} sondages provinciaux`);
  con.closeSync();

  const { exportAll } = await import("./export_json.ts");
  await exportAll();
  console.log("  JSON du dashboard reexporte");

  // The dashboard displays a PRECOMPUTED projection; recompute it now, in
  // this same process — the whole point of the single-runtime port.
  const { writeProjection } = await import("../src/writeProjection.js");
  console.log(`  projection recalculee : ${writeProjection()}`);
  return fresh.numRows();
}

if (import.meta.main) {
  const args = new Set(Deno.args);
  await run(args.has("--force"), args.has("--dry-run"));
}
