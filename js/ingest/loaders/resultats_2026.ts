/**
 * One-off loader: official results of the 2026-10-05 general election, from
 * the Elections Quebec open-data feed (final counts, 127/127 ridings,
 * saved raw as data/raw/lus/2026-10-05-resultats-dgeq.json; source
 * https://donnees.electionsquebec.qc.ca/production/provincial/resultats/resultats.json).
 *
 * Rows go into election_results with boundary_year '2026' and riding_code =
 * the DGEQ riding NUMBER as a string, matching the 2022-reprojected baseline
 * rows. Major parties map to the project codes (PLQ/QLP -> LIB, PCOQ -> PCQ,
 * ECF-CAQ -> CAQ); small parties and independents keep the 2022 convention
 * AUTRES:<candidate + abbreviation>. No province-wide NULL row (the PK
 * forbids NULL); national totals stay in the raw JSON.
 *
 * Idempotent: deletes (2026-10-05, '2026') rows before inserting.
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/resultats_2026.ts
 */

import { connect } from "../db.ts";

const PARTY_MAP: Record<string, string> = {
  "PQ": "PQ",
  "PLQ/QLP": "LIB",
  "PCOQ": "PCQ",
  "ÉCF-CAQ": "CAQ",
  "QS": "QS",
};

const raw = JSON.parse(await Deno.readTextFile(
  new URL("../../../data/raw/lus/2026-10-05-resultats-dgeq.json", import.meta.url),
));

const rows: [string, string, number, number, boolean][] = [];
for (const circ of raw.circonscriptions) {
  const code = String(circ.numeroCirconscription);
  const maxVotes = Math.max(...circ.candidats.map((c: { nbVoteTotal: number }) => c.nbVoteTotal));
  for (const cand of circ.candidats) {
    const abbr = cand.abreviationPartiPolitique ?? "Ind";
    const party = PARTY_MAP[abbr] ?? `AUTRES:${cand.prenom} ${cand.nom} ${abbr}`;
    rows.push([code, party, cand.nbVoteTotal, cand.tauxVote, cand.nbVoteTotal === maxVotes]);
  }
}

const con = await connect();
await con.run(
  `DELETE FROM election_results
   WHERE jurisdiction_code = 'qc-provincial' AND election_date = '2026-10-05'::DATE AND boundary_year = '2026'`,
);
for (const [code, party, votes, share, won] of rows) {
  await con.run(
    `INSERT INTO election_results VALUES ('qc-provincial', '2026-10-05'::DATE, '2026', ?, ?, ?, ?, ?)`,
    [code, party, votes, share, won],
  );
}
con.closeSync();

const winners: Record<string, number> = {};
for (const [, party, , , won] of rows) {
  if (won) {
    const p = party.startsWith("AUTRES") ? "AUTRES" : party;
    winners[p] = (winners[p] ?? 0) + 1;
  }
}
console.log(`${rows.length} lignes inserees (${raw.circonscriptions.length} circonscriptions)`);
console.log("sieges :", JSON.stringify(winners));
