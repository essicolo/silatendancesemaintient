/**
 * Test E: by-election (partielle) signal for the 2026 projection.
 *
 * Five by-elections were held on the 2017 map since 2022 (results in
 * DuckDB, boundary_year 2017):
 *   2023-03-13 Saint-Henri-Sainte-Anne  (QS won; LIB seat)
 *   2023-10-02 Jean-Talon               (PQ won; CAQ seat)
 *   2025-03-17 Terrebonne               (PQ won; CAQ seat)
 *   2025-08-11 Arthabaska               (PQ won; CAQ seat)
 *   2026-02-23 Chicoutimi               (PQ won; CAQ seat)
 *
 * The production model only sees them as OPEN SEATS (the incumbent bonus of
 * the 2022 winner is removed); the result itself -- a direct, recent
 * measurement of the riding's departure from the provincial swing -- is
 * unused. This test measures that departure and blends it into the
 * riding-effects, with shrinkage lambda:
 *
 *   dev = ilr(bye_shares) - ilr(rid2022_shares_openseat_adjusted)
 *         - [trend_ilr(t_bye) - ilr(provincial 2022 RESULT)]
 *
 * The open-seat adjustment (divide the 2022 winner's share by exp(0.118),
 * the production incumbency factor) aligns the measured departure with what
 * the projection baseline already encodes -- otherwise the incumbent-leaving
 * effect would be counted twice. The provincial anchor is the 2022 RESULT
 * (not the poll trend at 2022), so dev is a result-to-result local swing net
 * of provincial movement.
 *
 * Blend: effect_new = (1-lambda)*effect_gp + lambda*dev, applied through the
 * effectsTransform hook so point projection AND simulation both see it.
 * PRODUCTION (js/src/byelections.js, adopted 2026-09-11) goes one step
 * further: it SUBTRACTS the current regional adjustment from dev before
 * blending (the regional GP already shifts every riding of the region; not
 * subtracting would count the regional movement twice). This harness shows
 * the RAW-deviation sensitivity (upper bound on the local signal); it
 * disables production's own blend by passing byelectionRows: [] so the two
 * never stack.
 *
 * HONEST LIMITS, stated: (1) by-elections have low turnout and protest
 * dynamics -- their swings run systematically larger than general-election
 * swings, which is what lambda shrinks; (2) the by-election ran on 2017-map
 * boundaries, applied here to the same-NAME 2026 riding (Arthabaska ->
 * Arthabaska-L'Erable was redrawn); (3) a strong local candidate (part of
 * the measured swing) may not run again; (4) there is no historical
 * by-election series in the database to VALIDATE the gain -- this test
 * reports the sensitivity and the mechanics, not an out-of-sample score.
 *
 * Run: node js/tools/byelection_test.mjs   (from js/)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { mva } from "@tangent.to/ds";
import { pivotPolls } from "../src/compositional.js";
import { fitTrend, toX } from "../src/gpTrend.js";
import { residualIlr, PARTIES } from "../src/ridingEffects.js";

const { ilr, ilrInv, closure, multiplicativeReplacement } = mva.composition;

const read = (f) => JSON.parse(readFileSync(new URL("../data/" + f, import.meta.url), "utf-8"));
const features2017 = read("qc_riding_features_2017.json");
const features2026 = read("qc_riding_features_2026.json");
const ridingResults = read("qc_riding_results.json");

// ---------- helpers ----------
const nameKey = (n) =>
  String(n ?? "").normalize("NFKD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

// 2017-map name -> 2026-map name for the by-election ridings (renames).
const RENAME = { arthabaska: "Arthabaska-L'Érable" };
const code2026ByName = new Map(
  features2026.filter((f) => f.riding_name).map((f) => [nameKey(f.riding_name), String(f.riding_code)])
);
const name2017ByCode = new Map(
  features2017.filter((f) => f.riding_name).map((f) => [String(Math.round(parseFloat(f.riding_code))), f.riding_name])
);
// 2017-map numeric code by name (normalized) -- ridingResults rows carry
// numeric codes, by-election rows carry names.
const code2017ByName = new Map(
  features2017.filter((f) => f.riding_name).map((f) => [nameKey(f.riding_name), String(Math.round(parseFloat(f.riding_code)))])
);

function ilrRow(parts) {
  const delta = (1 / parts.length) ** 2;
  return ilr(closure(multiplicativeReplacement([parts], delta)))[0];
}

/** Party shares of one riding, matched by numeric code (unused now, kept for
 * reference: ridingResults keys rows by name). */
function sharesByCode(rows, date, boundary, code, partyCodes) {
  const votes = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  let tot = 0;
  for (const r of rows) {
    if (r.election_date !== date || r.boundary_year !== boundary) continue;
    if (String(Math.round(parseFloat(r.riding_code))) !== String(code)) continue;
    const party = partyCodes.includes(r.party_code) ? r.party_code : "AUTRES";
    votes[party] += r.votes;
    tot += r.votes;
  }
  if (!tot) return null;
  return partyCodes.map((p) => votes[p] / tot);
}

/** Party shares of one riding, matched by name (both files key rows by the
 * riding NAME in the riding_code column; by-election rows additionally
 * carry a boundary_year). */
function sharesByName(rows, date, name, partyCodes, boundary = null) {
  const votes = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  let tot = 0;
  for (const r of rows) {
    if (r.election_date !== date) continue;
    if (boundary !== null && String(r.boundary_year) !== String(boundary)) continue;
    if (nameKey(r.riding_code) !== nameKey(name)) continue;
    const party = partyCodes.includes(r.party_code) ? r.party_code : "AUTRES";
    votes[party] += r.votes;
    tot += r.votes;
  }
  if (!tot) return null;
  return partyCodes.map((p) => votes[p] / tot);
}

/** Provincial shares at one election on one map. */
function provinceShares(rows, date, boundary, partyCodes) {
  const votes = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  let tot = 0;
  for (const r of rows) {
    if (r.election_date !== date || r.boundary_year !== boundary) continue;
    const party = partyCodes.includes(r.party_code) ? r.party_code : "AUTRES";
    votes[party] += r.votes;
    tot += r.votes;
  }
  return partyCodes.map((p) => votes[p] / tot);
}

// ---------- by-election rows from DuckDB ----------
const DB_PATH = new URL("../../data/polls.duckdb", import.meta.url);
const inst = await DuckDBInstance.create(fileURLToPath(DB_PATH));
const con = await inst.connect();
const reader = await con.runAndReadAll(`
  SELECT election_date, boundary_year, riding_code, party_code, votes
  FROM election_results
  WHERE jurisdiction_code = 'qc-provincial'
    AND election_date IN ('2023-03-13','2023-10-02','2025-03-17','2025-08-11','2026-02-23')
  ORDER BY election_date
`);
const beRows = reader.getRowObjects().map((r) => ({
  // DuckDB returns DATE as {days} (epoch days); the by-election rows carry
  // the riding NAME in riding_code (ingested that way), not a numeric code.
  ...r,
  election_date:
    typeof r.election_date === "object" && r.election_date?.days != null
      ? new Date(r.election_date.days * 86400000).toISOString().slice(0, 10)
      : String(r.election_date),
}));

// group by (date, riding name)
const byes = new Map();
for (const r of beRows) {
  const key = `${r.election_date}|${r.riding_code}`;
  if (!byes.has(key)) byes.set(key, { date: String(r.election_date), name: String(r.riding_code) });
}
console.log(`${byes.size} partielles trouvées en base (carte 2017)\n`);

// ---------- production trend model ----------
const pollRows = read("qc_national_polls.json");
const { polls, partyCodes } = pivotPolls(pollRows);
const model = fitTrend(polls, partyCodes);
const OPEN_SEAT_FACTOR = Math.exp(0.118);

const prov2022Shares = provinceShares(ridingResults, "2022-10-03", "2017", partyCodes);
const prov2022Ilr = ilrRow(prov2022Shares);

const trendIlrAt = (date) => {
  const x = toX(model.t0, [date]);
  return model.gps.map((gp) => gp.predict(x)[0]);
};

// ---------- deviations ----------
const deviations = new Map(); // 2026 riding code -> { dev, name, date }
const details = [];
for (const { date, name: name2017 } of byes.values()) {
  const name2026 = RENAME[nameKey(name2017)] ?? name2017;
  const code26 = code2026ByName.get(nameKey(name2026));
  if (!code26) { console.log(`  ! ${name2017} introuvable sur la carte 2026, ignoré`); continue; }

  const byeShares = sharesByName(beRows, date, name2017, partyCodes);
  const rid2022 = sharesByName(ridingResults, "2022-10-03", name2017, partyCodes, "2017");
  if (!byeShares || !rid2022) { console.log(`  ! ${name2017}: parts introuvables (bye=${!!byeShares}, 2022=${!!rid2022})`); continue; }

  // open-seat-adjusted 2022 baseline (align with the projection baseline)
  let winner = 0;
  for (let j = 1; j < rid2022.length; j++) if (rid2022[j] > rid2022[winner]) winner = j;
  const adjusted = rid2022.map((v, j) => (j === winner ? v / OPEN_SEAT_FACTOR : v));
  const adjustedTot = adjusted.reduce((a, b) => a + b, 0);
  const adjustedShares = adjusted.map((v) => v / adjustedTot);

  const trendBye = trendIlrAt(date);
  const dev = ilrRow(byeShares).map(
    (v, c) => v - ilrRow(adjustedShares)[c] - (trendBye[c] - prov2022Ilr[c])
  );

  deviations.set(code26, { dev, name: name2026, date });
  details.push({ name2026, name2017, date, byeShares, rid2022, dev });
}

// ---------- readable report ----------
console.log("déviations mesurées (partielle vs swing provincial, en points de part au point 2022 ajusté) :\n");
for (const d of details) {
  const ref = ilrInv([ilrRow(d.rid2022)])[0];
  const shifted = ilrInv([ilrRow(d.rid2022).map((v, c) => v + d.dev[c])])[0];
  const deltas = partyCodes.map((p, j) => `${p} ${(100 * (shifted[j] - ref[j])).toFixed(1) >= 0 ? "+" : ""}${(100 * (shifted[j] - ref[j])).toFixed(1)}`).join("  ");
  const byeLine = partyCodes.map((p, j) => `${p} ${(100 * d.byeShares[j]).toFixed(0)}`).join(" ");
  console.log(`  ${d.name2026} (${d.date})`);
  console.log(`    partielle : ${byeLine}`);
  console.log(`    déviation vs swing provincial : ${deltas}`);
  console.log(`    vecteur ILR brut : ${d.dev.map((v) => (Number.isFinite(v) ? v.toFixed(3) : "NaN!")).join(" ")}`);
}

// ---------- full-pipeline sensitivity ----------
console.log("\n=== sensibilité λ (part du signal partielle dans l'effet local) ===");
const dataFiles = [
  ["baselineRows", "qc_2022_baseline_2026map.json"],
  ["leaders", "qc_leaders.json"],
  ["systemicParams", "qc_systemic.json"],
  ["ridingRegions", "qc_riding_regions.json"],
  ["incumbents", "qc_incumbents.json"],
  ["leaderEffect", "qc_leader_effect.json"],
  ["regionalPollRows", "qc_regional_polls.json"],
];
const data = Object.fromEntries(dataFiles.map(([k2, f]) => [k2, read(f)]));
Object.assign(data, {
  pollRows, ridingResults, features2017, features2026,
  byelectionRows: [], // production blends by-elections itself; keep this
                     // harness in control of the sensitivity knob
});
const { computeProjection } = await import("../src/computeProjection.js");
const asOf = new Date().toISOString().slice(0, 10);

for (const lambda of [0, 0.25, 0.5, 1.0]) {
  const proj = computeProjection(data, {
    asOf,
    effectsTransform: lambda === 0 ? null : (effects) => {
      const out = new Map(effects);
      for (const [code26, { dev }] of deviations) {
        const e = out.get(String(code26)) ?? null;
        const blended = dev.map((v, c) => (1 - lambda) * (e ? e[c] : 0) + lambda * v);
        out.set(String(code26), blended);
      }
      return out;
    },
  });
  const medians = Object.fromEntries(Object.entries(proj.seatDistributions).map(([p, d]) => [p, d.p50]));
  const maj = proj.scenarios.filter((s) => s.type === "majority").reduce((s, x) => s + x.probability, 0);
  const byeRidings = [...deviations.keys()];
  const winLines = byeRidings.map((code) => {
    const wp = proj.ridingWinProbs[code];
    const fav = Object.entries(wp).sort((a, b) => b[1] - a[1])[0];
    return `${deviations.get(code).name}→${fav[0]} ${(fav[1] * 100).toFixed(0)}%`;
  });
  console.log(`\n  λ=${lambda}`);
  console.log(`    sièges (médiane) : ${JSON.stringify(medians)}   P(majorité)=${maj.toFixed(3)}`);
  console.log(`    partielles       : ${winLines.join("  ")}`);
}