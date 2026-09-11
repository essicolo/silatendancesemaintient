/**
 * Test C: cross-COORDINATE covariance of the national trend draws.
 *
 * The trend GP fits each ILR coordinate independently, so sampleTrendDraws
 * draws them independently: the joint covariance of the ILR vector is
 * isotropic-diagonal by construction. Real poll scatter is not: when the CAQ
 * is under-estimated at a date, the excess has to show up somewhere, and
 * WHERE it shows up (PQ? LIB? both?) is a measurable, persistent pattern.
 *
 * This script:
 *   1. measures the empirical correlation matrix of ILR poll residuals
 *      (poll - trend posterior mean) -- recent polls only (2021+, all six
 *      parties reported, no PCQ-amalgamation artifact), and the same
 *      correlation in party-SHARE space;
 *   2. measures what the current independent-ILR draws imply in share
 *      space -- inverse-ILR of independent coordinates is NOT independent
 *      shares, so the comparison must be made there;
 *   3. re-draws with a shrunk empirical correlation (Cholesky) and checks
 *      the share-space correlation now matches the empirical one;
 *   4. runs the production seat simulation with correlated vs independent
 *      draws and reports the shift in marginals and joint scenarios.
 *
 * VERDICT (2026-09-11): REJECTED. The empirical ILR-residual correlation is
 * all-positive (0.33-0.70) but injecting it moves the share-space joint
 * FARTHER from the empirical scatter (mean |Δcorr| 0.145 -> 0.185): poll
 * residuals include sampling noise and house scatter, which is not the
 * latent-trend posterior correlation; and the independent-ILR draws already
 * imply share correlations broadly consistent with the data. Seat impact
 * is MC noise (identical medians, scenarios +-2 points). The {corr} option
 * stays in sampleTrendDraws/computeProjection; this file is the record.
 *
 * Run: node js/tools/coord_covariance.mjs   (from js/)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { pivotPolls, toClosedComposition } from "../src/compositional.js";
import { fitTrend, toX, sampleTrendDraws } from "../src/gpTrend.js";

const { ilr, ilrInv } = mva.composition;

const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows);

// ---------- 1. empirical residual correlation ----------
const model = fitTrend(polls, partyCodes);
const recent = polls.filter((p) => p.pollDate >= "2021-01-01");
console.log(`${polls.length} sondages; corrélation empirique mesurée sur les ${recent.length} sondages ≥2021 (6 partis rapportés)`);

const x = toX(model.t0, recent.map((p) => p.pollDate));
const comp = toClosedComposition(recent, partyCodes);
const Y = ilr(comp);
const means = model.gps.map((gp) => gp.predict(x));
const R_ilr = Y.map((row, i) => row.map((v, c) => v - means[c][i]));

function corr(mat, k) {
  const n = mat.length;
  const mu = Array.from({ length: k }, (_, j) => mat.reduce((s, r) => s + r[j], 0) / n);
  const cov = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const r of mat) for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) cov[a][b] += (r[a] - mu[a]) * (r[b] - mu[b]);
  for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) cov[a][b] /= n - 1;
  const sd = cov.map((r, a) => Math.sqrt(r[a]));
  return cov.map((r, a) => r.map((v, b) => v / (sd[a] * sd[b])));
}

const k = R_ilr[0].length;
const Cemp = corr(R_ilr, k);
console.log("\ncorrélation ILR des résidus (firmes confondues):");
Cemp.forEach((r, a) => console.log("  " + r.map((v) => v.toFixed(2).padStart(6)).join("")));

// share-space version of the same residuals: ilrInv(mean+resid) - ilrInv(mean)
const baseShares = ilrInv(means[0].map((_, i) => means.map((m) => m[i])));
const shiftedShares = ilrInv(R_ilr.map((r, i) => r.map((v, c) => v + means[c][i])));
const residShares = shiftedShares.map((s, i) => s.map((v, j) => v - baseShares[i][j]));
const CsharesEmp = corr(residShares, partyCodes.length);
console.log("\ncorrélation des parts (résidus):");
console.log("  " + partyCodes.map((p) => p.padStart(6)).join(""));
CsharesEmp.forEach((r, a) => console.log("  " + partyCodes[a].padEnd(4) + r.map((v) => v.toFixed(2).padStart(6)).join("")));

// ---------- 2. what independent draws imply ----------
const asOf = new Date().toISOString().slice(0, 10);
const x0 = toX(model.t0, [asOf]);
const mean0 = model.gps.map((gp) => gp.predict(x0)[0]);
const std0 = model.gps.map((gp) => gp.predict(x0, { returnStd: true }).std[0]);

function shareCorrOfDraws(drawsIlr) {
  const shares = ilrInv(drawsIlr);
  return corr(shares, partyCodes.length);
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randn(rng) {
  const u1 = rng(), u2 = rng();
  return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
}

const N = 5000;
const indep = Array.from({ length: N }, (_, s) => {
  const rng = mulberry32(1000 + s);
  return mean0.map((m, c) => m + std0[c] * randn(rng));
});
const CsharesIndep = shareCorrOfDraws(indep);

console.log("\ncorrélation des parts impliquée par les tirages ACTUELS (ILR indépendants):");
console.log("  " + partyCodes.map((p) => p.padStart(6)).join(""));
CsharesIndep.forEach((r, a) => console.log("  " + partyCodes[a].padEnd(4) + r.map((v) => v.toFixed(2).padStart(6)).join("")));

// ---------- 3. correlated draws ----------
// shrink the empirical ILR correlation toward identity: lambda = k/n is the
// classic simple shrinkage intensity for a k x k correlation from n draws.
const nEff = R_ilr.length;
const lam = Math.min(1, k / nEff);
const Cshrunk = Cemp.map((r, a) => r.map((v, b) => (1 - lam) * v + (a === b ? 1 : 0) * lam));
console.log(`\nshrinkage lambda = k/n = ${lam.toFixed(3)} (quasi nul: ${nEff} sondages, ${k} coordonnées)`);

// Cholesky of the shrunk correlation
function chol(m) {
  const n = m.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = m[i][j];
      for (let r = 0; r < j; r++) s -= L[i][r] * L[j][r];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
    }
  }
  return L;
}
const L = chol(Cshrunk);
const correl = Array.from({ length: N }, (_, s) => {
  const rng = mulberry32(1000 + s);
  const z = Array.from({ length: k }, () => randn(rng));
  return mean0.map((m, c) => {
    let v = 0;
    for (let j = 0; j <= c; j++) v += L[c][j] * z[j];
    return m + std0[c] * v;
  });
});
const CsharesCorr = shareCorrOfDraws(correl);
console.log("\ncorrélation des parts avec tirages CORRÉLÉS (Cholesky de R shrunk):");
console.log("  " + partyCodes.map((p) => p.padStart(6)).join(""));
CsharesCorr.forEach((r, a) => console.log("  " + partyCodes[a].padEnd(4) + r.map((v) => v.toFixed(2).padStart(6)).join("")));

// distance summary: mean |Δ| against the empirical target
const dist = (A, B) => {
  let s = 0, n = 0;
  for (let a = 0; a < A.length; a++) for (let b = 0; b < A.length; b++) { s += Math.abs(A[a][b] - B[a][b]); n++; }
  return s / n;
};
console.log(`\nécarts moyens |Δcorr| contre l'empirique : indépendants ${dist(CsharesIndep, CsharesEmp).toFixed(3)}  corrélés ${dist(CsharesCorr, CsharesEmp).toFixed(3)}`);

// ---------- 4. full seat simulation, independent vs correlated ----------
console.log("\n=== simulation de sièges complète : tirages indépendants vs corrélés ===");
const dataFiles = [
  ["pollRows", "qc_national_polls.json"],
  ["baselineRows", "qc_2022_baseline_2026map.json"],
  ["leaders", "qc_leaders.json"],
  ["ridingResults", "qc_riding_results.json"],
  ["features2017", "qc_riding_features_2017.json"],
  ["features2026", "qc_riding_features_2026.json"],
  ["systemicParams", "qc_systemic.json"],
  ["ridingRegions", "qc_riding_regions.json"],
  ["incumbents", "qc_incumbents.json"],
  ["leaderEffect", "qc_leader_effect.json"],
  ["regionalPollRows", "qc_regional_polls.json"],
];
const data = Object.fromEntries(
  dataFiles.map(([k2, f]) => [k2, JSON.parse(readFileSync(new URL("../data/" + f, import.meta.url), "utf-8"))])
);
const { computeProjection } = await import("../src/computeProjection.js");

const asOf2 = asOf;
const projIndep = computeProjection(data, { asOf });
const projCorr = computeProjection(data, { asOf, trendCorr: Cshrunk });

const row = (proj) => Object.fromEntries(
  Object.entries(proj.seatDistributions).map(([p, d]) => [p, `${d.p05}-${d.p50}-${d.p95}`])
);
console.log("indépendants :", JSON.stringify(row(projIndep)));
console.log("corrélés     :", JSON.stringify(row(projCorr)));

const summarizeScenarios = (proj) => {
  const maj = {};
  for (const s of proj.scenarios) {
    const key = s.type === "majority" ? `majorité ${s.leader}` : `minorité ${s.leader}${s.balanceOfPower ? " (bal. " + s.balanceOfPower + ")" : ""}`;
    maj[key] = (maj[key] ?? 0) + s.probability;
  }
  const byType = { "majorité": 0, "minorité": 0 };
  for (const s of proj.scenarios) byType[s.type] += s.probability;
  return { byType, top: Object.entries(maj).sort((a, b) => b[1] - a[1]).slice(0, 5) };
};
const sInd = summarizeScenarios(projIndep);
const sCor = summarizeScenarios(projCorr);
console.log("\nscénarios indépendants : P(majorité)=" + sInd.byType["majorité"].toFixed(3));
for (const [k2, v] of sInd.top) console.log("   " + k2.padEnd(30) + (v).toFixed(3));
console.log("scénarios corrélés      : P(majorité)=" + sCor.byType["majorité"].toFixed(3));
for (const [k2, v] of sCor.top) console.log("   " + k2.padEnd(30) + (v).toFixed(3));

// expected-seat sanity: column sums of winProbs (should match between runs)
const expSeats = (proj) => Object.fromEntries(
  Object.entries(proj.ridingWinProbs[Object.keys(proj.ridingWinProbs)[0]]).map(([p]) => [
    p,
    Object.values(proj.ridingWinProbs).reduce((s, r) => s + (r[p] ?? 0), 0),
  ])
);
console.log("\nsièges espérés (somme des P(win)):");
console.log("  indépendants :", JSON.stringify(expSeats(projIndep)));
console.log("  corrélés     :", JSON.stringify(expSeats(projCorr)));