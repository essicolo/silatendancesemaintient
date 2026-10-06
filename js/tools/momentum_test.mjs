/**
 * Test: slope continuation ("momentum") at the ballot box.
 *
 * Final-week direction vs final error, three elections: 2018 the CAQ
 * rose (30 -> 33) and finished above every final poll (+4.4); 2022 flat
 * slope, near-zero error; 2026 falling slope, result below the polls.
 * Hypothesis: result = nowcast(eve) + c * slope, with slope the GP mean
 * ILR derivative over the last 14 days and c (in days of continuation)
 * shared across coordinates and elections; c = 0 is the null.
 *
 * Estimation: least squares of delta = ilr(result) - nowcast against the
 * slope, pooled over the 5 coordinates. Validation: leave-one-election-
 * out -- c fitted on two elections, scored on the third (MAE of the
 * eve nowcast with and without the continuation term), plus the pooled
 * c and its per-election values for inspection.
 *
 * Run: node js/tools/momentum_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { ml, mva } from "@tangent.to/ds";
import { pivotPolls, toClosedComposition, ilrSamplingVariance } from "../src/compositional.js";
import { ChangepointKernel, toX } from "../src/gpTrend.js";

const { ilr, ilrInv } = mva.composition;

const HYPER = [
  { ls: 680, ns: 0.1, rho: 0.7, dil: 16 },
  { ls: 330, ns: 0.02, rho: 0.7, dil: 8 },
  { ls: 1000, ns: 0.01, rho: 1, dil: 8 },
  { ls: 680, ns: 0.02, rho: 1, dil: 16 },
  { ls: 330, ns: 0.1, rho: 1, dil: 8 },
];
const SLOPE_WINDOW = 14; // days

const ELECTIONS = [
  { year: 2018, eve: "2018-09-30", day: "2018-10-01", actual: { CAQ: 37.42, LIB: 24.82, QS: 16.10, PQ: 17.06, PCQ: 1.46, AUTRES: 3.14 } },
  { year: 2022, eve: "2022-10-02", day: "2022-10-03", actual: { CAQ: 40.98, LIB: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91, AUTRES: 1.70 } },
  { year: 2026, eve: "2026-10-04", day: "2026-10-05", actual: { CAQ: 13.3453, LIB: 24.2157, QS: 12.4266, PQ: 28.0189, PCQ: 20.6691, AUTRES: 1.3244 } },
];

const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows);
const comp = toClosedComposition(polls, partyCodes);
const ilrMat = ilr(comp);
const nCoord = ilrMat[0].length;
const t0 = polls.reduce((m, p) => (p.pollDate < m ? p.pollDate : m), polls[0].pollDate);
const x = toX(t0, polls.map((p) => p.pollDate));

const varC = ilrSamplingVariance(comp, polls.map((p) => p.sampleSize));
const shapeC = varC.map((col) => { const m = Math.min(...col); return col.map((v) => v / m); });

const toIlrResult = (shares) => {
  const rec = [{ shares: Object.fromEntries(partyCodes.map((p) => [p, (shares[p] ?? 0) / 100])) }];
  return ilr(toClosedComposition(rec, partyCodes))[0];
};
const minusDays = (date, n) => {
  const d = new Date(date);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const close5 = (o) => {
  const main = ["CAQ", "LIB", "QS", "PQ", "PCQ"];
  const t = main.reduce((s, p) => s + o[p], 0);
  return Object.fromEntries(main.map((p) => [p, (o[p] / t) * 100]));
};
const maeVs = (pred, actual) => {
  const a = close5(actual);
  return Object.keys(a).reduce((s, p) => s + Math.abs(pred[p] - a[p]), 0) / 5;
};
const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v.toFixed(1)}`).join("  ");

// per election: nowcast ilr, slope ilr (per day), delta ilr
const perElection = [];
for (const e of ELECTIONS) {
  const idxs = polls.map((p, i) => [p, i]).filter(([p]) => p.pollDate <= e.eve).map(([, i]) => i);
  const m = [], slope = [];
  for (let c = 0; c < nCoord; c++) {
    const gp = new ml.GaussianProcessRegressor({
      kernel: new ChangepointKernel({ lengthScale: HYPER[c].ls, rho: HYPER[c].rho, dilation: HYPER[c].dil }),
      normalizeY: true,
    });
    gp.fit(idxs.map((i) => x[i]), idxs.map((i) => ilrMat[i][c]), { alpha: idxs.map((i) => shapeC[c][i] * HYPER[c].ns) });
    const [mNow, mPast] = gp.predict(toX(t0, [e.day, minusDays(e.day, SLOPE_WINDOW)]));
    m.push(mNow);
    slope.push((mNow - mPast) / SLOPE_WINDOW);
  }
  const delta = toIlrResult(e.actual).map((v, c) => v - m[c]);
  const cHat = delta.reduce((s, d, c) => s + d * slope[c], 0) / slope.reduce((s, v) => s + v * v, 0);
  perElection.push({ ...e, m, slope, delta, cHat });
}

console.log(`pente = derivee moyenne ILR du GP sur ${SLOPE_WINDOW} jours; c en jours de continuation\n`);
console.log("c estime par election (moindres carres par election) :");
for (const e of perElection) console.log(`  ${e.year} : c = ${e.cHat.toFixed(1)} jours`);

const pooled = (list) => {
  let num = 0, den = 0;
  for (const e of list) for (let c = 0; c < nCoord; c++) { num += e.delta[c] * e.slope[c]; den += e.slope[c] * e.slope[c]; }
  return num / den;
};
console.log(`  pooled (3 elections) : c = ${pooled(perElection).toFixed(1)} jours`);

console.log("\nvalidation leave-one-out (c estime sur les 2 autres) :");
for (const e of perElection) {
  const others = perElection.filter((o) => o.year !== e.year);
  const c = pooled(others);
  const toPred = (v) => close5(Object.fromEntries(partyCodes.map((p, i) => [p, ilrInv([v])[0][i]])));
  const p0 = toPred(e.m);
  const p1 = toPred(e.m.map((v, k) => v + c * e.slope[k]));
  console.log(`  ${e.year} (c=${c.toFixed(1)} j) : sans ${maeVs(p0, e.actual).toFixed(2)} pp -> avec ${maeVs(p1, e.actual).toFixed(2)} pp`);
  console.log(`      sans : ${fmt(p0)}`);
  console.log(`      avec : ${fmt(p1)}`);
  console.log(`      reel : ${fmt(close5(e.actual))}`);
}
