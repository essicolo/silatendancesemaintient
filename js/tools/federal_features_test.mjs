/**
 * Test: federal 2025 vote composition as riding-level predictors.
 *
 * The 2026 post-mortem located ~10 seats of error in the spatial layer
 * (PCQ spread outside the Quebec City region, missed QS strongholds).
 * The federal vote per provincial riding (qc_federal_2025.json, built by
 * make_federal.mjs from the GE45 poll-by-poll counts) is a direct
 * behavioural measurement of local ideology. It enters exactly like the
 * census groups: one more ILR-transformed compositional block
 * {BQ, PLC, PCC, NPD, AUTRES} appended to the production predictors
 * (18 demographics + the riding's previous departure), mirroring
 * trainRidingEffects/predictRidingEffects column for column.
 *
 * Two evaluations:
 *  1. the production criterion: repeated-50%-holdout multivariate R2 on
 *     the 2018->2022 training transition (2017 map). CAVEAT, printed with
 *     the result: the federal vote was measured in 2025, AFTER this
 *     response -- read as structural correlation, not as a forecast.
 *  2. the decisive, temporally legitimate backtest: train on 2018->2022
 *     (2017 map), predict the 2022->2026 residuals (2026 map, official
 *     results), with and without the federal block. Federal 2025 precedes
 *     October 2026, so this is exactly the production situation.
 *
 * Run: node js/tools/federal_features_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { buildFeatureMatrix, residualIlr, ilrMatrix, PARTIES } from "../src/ridingEffects.js";
import { fitMultivariate, multivariateR2 } from "../src/ridingModel.js";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const f17 = load("../data/qc_riding_features_2017.json");
const f26 = load("../data/qc_riding_features_2026.json");
const fed = load("../data/qc_federal_2025.json");
const results = load("../data/qc_riding_results.json");
const baseline26 = load("../data/qc_2022_baseline_2026map.json");
const dgeq = JSON.parse(readFileSync(new URL("../../data/raw/lus/2026-10-05-resultats-dgeq.json", import.meta.url), "utf-8"));

// --- 2026 result rows + 2022-on-2026-map rows --------------------------
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

// --- federal ILR per riding code, per map -------------------------------
const FED_PARTS = fed.parties;
const fedIlrByCode = (mapKey) => {
  const codes = Object.keys(fed[mapKey]);
  const M = ilrMatrix(codes.map((c) => FED_PARTS.map((p) => fed[mapKey][c][p])));
  return new Map(codes.map((c, i) => [c, M[i]]));
};
const fed17 = fedIlrByCode("map2017");
const fed26 = fedIlrByCode("map2026");

// --- TRAIN: mirror trainRidingEffects (2017 map, names) -----------------
const prev = residualIlr(results, "2014-04-07", "2011", "2018-10-01", "2017", PARTIES);
const curr = residualIlr(results, "2018-10-01", "2017", "2022-10-03", "2017", PARTIES);
const prevByName = new Map(prev.ridings.map((r, i) => [String(r), prev.Y[i]]));
const currByName = new Map(curr.ridings.map((r, i) => [String(r), curr.Y[i]]));

const { X: X17, ridings: codes17 } = buildFeatureMatrix(f17);
const nameByCode17 = new Map(f17.map((r) => [String(r.riding_code), r.riding_name]));

const Xprod = [], Xaug = [], Y = [];
codes17.forEach((code, i) => {
  const name = nameByCode17.get(code);
  const p = prevByName.get(name), y = currByName.get(name), fi = fed17.get(code);
  if (!p || !y || !fi) return;
  Xprod.push([...X17[i], ...p]);
  Xaug.push([...X17[i], ...p, ...fi]);
  Y.push(y);
});
console.log(`entrainement 2018->2022 : ${Y.length} circonscriptions, ${Xprod[0].length} vs ${Xaug[0].length} predicteurs`);

// --- 1. production criterion --------------------------------------------
console.log("\n1. holdout 50% x15 sur 2018->2022 (reserve : federal 2025 POSTERIEUR a la reponse) :");
console.log(`   sans federal : R2 = ${multivariateR2(Xprod, Y, { repeats: 15, seed: 0 }).toFixed(3)}`);
console.log(`   avec federal : R2 = ${multivariateR2(Xaug, Y, { repeats: 15, seed: 0 }).toFixed(3)}`);

// --- 2. backtest 2022->2026 (mirror predictRidingEffects) ---------------
const recent = residualIlr(results, "2018-10-01", "2026", "2022-10-03", "2026", PARTIES);
const recentByCode = new Map(recent.ridings.map((r, i) => [String(r), recent.Y[i]]));
const test = residualIlr([...rows2022on26, ...rows2026], "2022-10-03", "2026", "2026-10-05", "2026", PARTIES);
const testByCode = new Map(test.ridings.map((r, i) => [String(r), test.Y[i]]));

const { X: X26, ridings: codes26 } = buildFeatureMatrix(f26);
const XteProd = [], XteAug = [], Yte = [], teCodes = [];
codes26.forEach((code, i) => {
  const p = recentByCode.get(code), y = testByCode.get(code), fi = fed26.get(code);
  if (!p || !y || !fi) return;
  XteProd.push([...X26[i], ...p]);
  XteAug.push([...X26[i], ...p, ...fi]);
  Yte.push(y);
  teCodes.push(code);
});
console.log(`\n2. backtest 2022->2026 : ${Yte.length} circonscriptions testees`);

const centre = (M) => {
  const k = M[0].length;
  const mean = Array.from({ length: k }, (_, j) => M.reduce((s, r) => s + r[j], 0) / M.length);
  return M.map((r) => r.map((v, j) => v - mean[j]));
};
const sse = (A, B) => A.reduce((s, r, i) => s + r.reduce((t, v, j) => t + (v - B[i][j]) ** 2, 0), 0);
const sseNull = sse(Yte, Yte.map((r) => r.map(() => 0)));

const nameByCode26 = new Map(f26.map((r) => [String(r.riding_code), r.riding_name]));
for (const [label, Xtr, Xte] of [["sans federal", Xprod, XteProd], ["avec federal", Xaug, XteAug]]) {
  const model = fitMultivariate(Xtr, Y);
  const pred = centre(model.predict(Xte));
  const r2 = 1 - sse(Yte, pred) / sseNull;
  console.log(`   ${label} : R2 = ${r2.toFixed(3)}`);
  if (label === "avec federal") {
    // where does the federal block change predictions the most?
    const m0 = fitMultivariate(Xprod, Y);
    const p0 = centre(m0.predict(XteProd));
    const diffs = teCodes.map((c, i) => ({
      name: nameByCode26.get(c),
      gain: Math.sqrt(pred[i].reduce((s, v, j) => s + (Yte[i][j] - p0[i][j]) ** 2 - (Yte[i][j] - v) ** 2, 0) > 0 ? Math.abs(pred[i].reduce((s, v, j) => s + (Yte[i][j] - p0[i][j]) ** 2 - (Yte[i][j] - v) ** 2, 0)) : 0) * Math.sign(pred[i].reduce((s, v, j) => s + (Yte[i][j] - p0[i][j]) ** 2 - (Yte[i][j] - v) ** 2, 0)),
    })).sort((a, b) => b.gain - a.gain);
    console.log("   plus grands gains (reduction d'erreur ILR) :", diffs.slice(0, 6).map((d) => d.name).join(", "));
    console.log("   plus grandes pertes :", diffs.slice(-3).map((d) => d.name).join(", "));
  }
}
