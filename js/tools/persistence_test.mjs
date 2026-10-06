/**
 * Remodelling test, part 2: PERSISTENCE of riding departure levels.
 *
 * pooled_effects_test showed every static-feature mapping of departure
 * CHANGES anti-transfers between transitions (R2 -0.10 to -0.52). The
 * alternative structure: the departure LEVEL of a riding persists with a
 * coefficient rho < 1 (mean reversion),
 *
 *   L_t = rho * L_{t-1} + eps,   predicted change = (rho - 1) * L_{t-1},
 *
 * rho = 1 being the null (pure carry-forward of the baseline, no effects
 * layer at all). L_t = centred ILR departure of the riding from the
 * cross-riding mean at election t.
 *
 * Estimation: rho per ILR coordinate (OLS through the origin) and shared;
 * validation inter-transition: rho fitted on 2014->2018 and/or
 * 2018->2022, scored on predicting the 2022->2026 changes (and the
 * reverse directions). Metric: R2 against the zero-change null -- the
 * first spatial structure to beat it transfers.
 *
 * Run: node js/tools/persistence_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { sharesByRiding, ilrMatrix, PARTIES } from "../src/ridingEffects.js";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const results = load("../data/qc_riding_results.json");
const baseline26 = load("../data/qc_2022_baseline_2026map.json");
const dgeq = JSON.parse(readFileSync(new URL("../../data/raw/lus/2026-10-05-resultats-dgeq.json", import.meta.url), "utf-8"));

const MAP = { "PQ": "PQ", "PLQ/QLP": "LIB", "PCOQ": "PCQ", "ÉCF-CAQ": "CAQ", "QS": "QS" };
const rows2026 = [];
for (const c of dgeq.circonscriptions) {
  for (const cand of c.candidats) {
    rows2026.push({
      election_date: "2026-10-05", boundary_year: "2026", riding_code: String(c.numeroCirconscription),
      party_code: MAP[cand.abreviationPartiPolitique] ?? "AUTRES", votes: cand.nbVoteTotal,
    });
  }
}
const rows2022on26 = baseline26.map((r) => ({
  election_date: "2022-10-03", boundary_year: "2026", riding_code: String(r.riding_code),
  party_code: r.party_code, votes: r.votes,
}));
const allRows = [...results, ...rows2022on26, ...rows2026];

/** Centred ILR departure levels per riding for one election. */
function levels(date, boundary) {
  const shares = sharesByRiding(allRows, date, boundary, PARTIES);
  const keys = [...shares.keys()];
  const M = ilrMatrix(keys.map((k) => shares.get(k)));
  const k = M[0].length;
  const mean = Array.from({ length: k }, (_, j) => M.reduce((s, r) => s + r[j], 0) / M.length);
  return new Map(keys.map((key, i) => [key, M[i].map((v, j) => v - mean[j])]));
}

// Transition pairs: [L_prev, L_next] aligned by riding key.
const pair = (La, Lb) => {
  const out = [];
  for (const [k, a] of La) if (Lb.has(k)) out.push([a, Lb.get(k)]);
  return out;
};
const L14 = levels("2014-04-07", "2011");
const L18 = levels("2018-10-01", "2017");
const L18on26 = levels("2018-10-01", "2026");
const L22 = levels("2022-10-03", "2017");
const L22on26 = levels("2022-10-03", "2026");
const L26 = levels("2026-10-05", "2026");
const P1 = pair(L14, L18);      // by name across 2011/2017 maps
const P2 = pair(L18, L22);      // 2017 map
const P2b = pair(L18on26, L22on26); // same transition, 2026 map (for rho pooling with P3 geometry)
const P3 = pair(L22on26, L26);  // 2026 map
console.log(`paires : P1 ${P1.length}, P2 ${P2.length}, P3 ${P3.length}`);

const nC = P2[0][0].length;
const rhoOf = (pairs, perCoord = true) => {
  if (!perCoord) {
    let num = 0, den = 0;
    for (const [a, b] of pairs) for (let j = 0; j < nC; j++) { num += a[j] * b[j]; den += a[j] * a[j]; }
    return new Array(nC).fill(num / den);
  }
  return Array.from({ length: nC }, (_, j) => {
    let num = 0, den = 0;
    for (const [a, b] of pairs) { num += a[j] * b[j]; den += a[j] * a[j]; }
    return num / den;
  });
};

// score: predict change (rho-1)*L_prev on target pairs; R2 vs zero-change null
const score = (rho, pairs) => {
  let sseM = 0, sse0 = 0;
  for (const [a, b] of pairs) {
    for (let j = 0; j < nC; j++) {
      const change = b[j] - a[j];
      sseM += (change - (rho[j] - 1) * a[j]) ** 2;
      sse0 += change * change;
    }
  }
  return 1 - sseM / sse0;
};

console.log("\nrho par coordonnee (OLS par transition) :");
for (const [name, p] of [["P1 2014->18", P1], ["P2 2018->22", P2], ["P3 2022->26", P3]]) {
  console.log(`  ${name} : [${rhoOf(p).map((v) => v.toFixed(2)).join(", ")}]  partage ${rhoOf(p, false)[0].toFixed(3)}`);
}

console.log("\ntransfert inter-transitions (R2 vs nul = report pur rho=1) :");
const cases = [
  ["rho(P1) -> P2", rhoOf(P1), P2],
  ["rho(P2) -> P3", rhoOf(P2), P3],
  ["rho(P1+P2) -> P3", rhoOf([...P1, ...P2]), P3],
  ["rho(P3) -> P2", rhoOf(P3), P2],
  ["rho(P2) -> P1", rhoOf(P2), P1],
  ["rho partage (P1+P2) -> P3", rhoOf([...P1, ...P2], false), P3],
  ["rho(P1+P3) -> P2", rhoOf([...P1, ...P3]), P2],
  ["rho(P2+P3) -> P1", rhoOf([...P2, ...P3]), P1],
];
for (const [label, rho, target] of cases) {
  console.log(`  ${label.padEnd(28)} : R2 = ${score(rho, target).toFixed(3)}`);
}
