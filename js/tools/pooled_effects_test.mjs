/**
 * Remodelling test for the riding-effects layer: WHAT transfers between
 * transitions, and what should the 2030 model train on?
 *
 * Finding that motivates this (federal_features_test): the production
 * model (demographics + previous departure, trained on 2018->2022)
 * predicts the 2022->2026 departures at R2 = -0.16 -- worse than zero --
 * while interpolating at 0.39-0.47 inside any single transition.
 *
 * Questions, answered by inter-transition validation (train on one or
 * more transitions, test on a DIFFERENT one; R2 against the zero null,
 * responses being centred departures):
 *  1. ABLATION: which block fails to transfer -- demographics (D), the
 *     riding's previous departure (P), or both? Variants D, P, DP in both
 *     directions (T2->T3 and T3->T2).
 *  2. POOLING: with demographics only (available for all three
 *     transitions), leave-one-transition-out: does training on the two
 *     other transitions pooled beat training on the single adjacent one?
 *
 * Transitions: T1 = 2014->2018 (2017-map names, demographics only; its
 * previous departure would need 2011 results), T2 = 2018->2022 (2017
 * map), T3 = 2022->2026 (2026 map, official results).
 *
 * Run: node js/tools/pooled_effects_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { buildFeatureMatrix, residualIlr, PARTIES } from "../src/ridingEffects.js";
import { fitMultivariate } from "../src/ridingModel.js";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const f17 = load("../data/qc_riding_features_2017.json");
const f26 = load("../data/qc_riding_features_2026.json");
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

// --- assemble transitions ------------------------------------------------
const { X: X17, ridings: codes17 } = buildFeatureMatrix(f17);
const { X: X26, ridings: codes26 } = buildFeatureMatrix(f26);
const nameByCode17 = new Map(f17.map((r) => [String(r.riding_code), r.riding_name]));
const demo17ByName = new Map(codes17.map((c, i) => [nameByCode17.get(c), X17[i]]));
const demo26ByCode = new Map(codes26.map((c, i) => [c, X26[i]]));

const byKey = (res) => new Map(res.ridings.map((r, i) => [String(r), res.Y[i]]));
const r1418 = byKey(residualIlr(allRows, "2014-04-07", "2011", "2018-10-01", "2017", PARTIES)); // by name
const r1822 = byKey(residualIlr(allRows, "2018-10-01", "2017", "2022-10-03", "2017", PARTIES)); // by name
const r1822on26 = byKey(residualIlr(allRows, "2018-10-01", "2026", "2022-10-03", "2026", PARTIES)); // by code
const r2226 = byKey(residualIlr(allRows, "2022-10-03", "2026", "2026-10-05", "2026", PARTIES)); // by code

const T1 = [], T2 = [], T3 = [];
for (const [name, demo] of demo17ByName) {
  const y1 = r1418.get(name);
  if (y1) T1.push({ demo, prev: null, y: y1 });
  const y2 = r1822.get(name), p2 = r1418.get(name);
  if (y2 && p2) T2.push({ demo, prev: p2, y: y2 });
}
for (const [code, demo] of demo26ByCode) {
  const y3 = r2226.get(code), p3 = r1822on26.get(code);
  if (y3 && p3) T3.push({ demo, prev: p3, y: y3 });
}
console.log(`T1 2014->2018 : ${T1.length} | T2 2018->2022 : ${T2.length} | T3 2022->2026 : ${T3.length}`);

const mat = (rows, variant) => ({
  X: rows.map((r) =>
    variant === "D" ? r.demo : variant === "P" ? r.prev : [...r.demo, ...r.prev]),
  Y: rows.map((r) => r.y),
});
const sse = (A, B) => A.reduce((s, r, i) => s + r.reduce((t, v, j) => t + (v - B[i][j]) ** 2, 0), 0);
const centre = (M) => {
  const k = M[0].length;
  const mean = Array.from({ length: k }, (_, j) => M.reduce((s, r) => s + r[j], 0) / M.length);
  return M.map((r) => r.map((v, j) => v - mean[j]));
};
const transfer = (train, test, variant) => {
  const tr = mat(train, variant), te = mat(test, variant);
  const model = fitMultivariate(tr.X, tr.Y);
  const pred = centre(model.predict(te.X));
  return 1 - sse(te.Y, pred) / sse(te.Y, te.Y.map((r) => r.map(() => 0)));
};

// --- 1. ablation ----------------------------------------------------------
console.log("\n1. ABLATION (R2 de transfert inter-transitions; production = DP) :");
for (const variant of ["D", "P", "DP"]) {
  const a = transfer(T2, T3, variant);
  const b = transfer(T3, T2, variant);
  console.log(`   ${variant.padEnd(3)} : T2->T3 ${a.toFixed(3).padStart(7)}   T3->T2 ${b.toFixed(3).padStart(7)}`);
}

// --- 2. pooling (demographics only, three transitions) --------------------
console.log("\n2. POOLING (demographie seule, leave-one-transition-out) :");
const sets = { T1, T2, T3 };
const order = ["T1", "T2", "T3"];
for (const target of order) {
  const others = order.filter((t) => t !== target);
  const single = target === "T3" ? "T2" : target === "T2" ? "T1" : "T2"; // adjacent previous (T1 has no previous -> next)
  const rPooled = transfer([...sets[others[0]], ...sets[others[1]]], sets[target], "D");
  const rSingle = transfer(sets[single], sets[target], "D");
  console.log(`   test ${target} : poolé(${others.join("+")}) ${rPooled.toFixed(3).padStart(7)}   seule(${single}) ${rSingle.toFixed(3).padStart(7)}`);
}
