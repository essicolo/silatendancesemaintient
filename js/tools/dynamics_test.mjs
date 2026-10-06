/**
 * Test: two-timescale dynamics for the trend GP.
 *
 * The post-mortem localized the end-of-campaign lag in the smoothness
 * prior itself (grid reweighting and robust likelihoods both failed).
 * This tests the classic decomposition: slow trend + fast local level,
 *
 *   k = ChangepointKernel(production) + s2 * Matern12(lsFast)
 *
 * where the fast component uses the SAME dilated campaign clock and
 * regime factor (a fast level should not survive a changepoint either),
 * Matern-1/2 (OU) because a local level has no momentum, and s2 = 0 is
 * the null recovering production exactly.
 *
 * Grid: lsFast in {5,10,20,40} dilated days x s2 in {0.01,0.04,0.09,0.25}
 * + the null. Per election, hyperparameters are selected by marginal
 * likelihood ON THE TRAINING SET ONLY (as production does), then the
 * eve-of-election nowcast is scored against the official result --
 * 2018/2022/2026, MAE over the five main parties closed.
 *
 * Run: node js/tools/dynamics_test.mjs   (from the repo root)
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
const LS_FAST = [5, 10, 20, 40];
const S2_GRID = [0.01, 0.04, 0.09, 0.25];

class TwoScaleKernel extends ml.Kernel {
  constructor({ ls, rho, dil, lsFast = 10, s2 = 0 }) {
    super();
    this.slow = new ChangepointKernel({ lengthScale: ls, rho, dilation: dil });
    this.rho = rho;
    this.dil = dil;
    this.lsFast = lsFast;
    this.s2 = s2;
  }
  compute(a, b) {
    let k = this.slow.compute(a, b);
    if (this.s2 > 0) {
      const dt = (a[0] - b[0]) + (this.dil - 1) * (a[2] - b[2]);
      k += this.s2 * Math.exp(-Math.abs(dt) / this.lsFast) * Math.pow(this.rho, Math.abs(a[1] - b[1]));
    }
    return k;
  }
  getParams() { return { lsFast: this.lsFast, s2: this.s2 }; }
}

const ELECTIONS = [
  { year: 2018, eve: "2018-09-30", day: "2018-10-01", actual: { CAQ: 37.42, LIB: 24.82, QS: 16.10, PQ: 17.06, PCQ: 1.46 } },
  { year: 2022, eve: "2022-10-02", day: "2022-10-03", actual: { CAQ: 40.98, LIB: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91 } },
  { year: 2026, eve: "2026-10-04", day: "2026-10-05", actual: { CAQ: 13.3453, LIB: 24.2157, QS: 12.4266, PQ: 28.0189, PCQ: 20.6691 } },
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

const fit = (idxs, c, lsFast, s2) => {
  const gp = new ml.GaussianProcessRegressor({
    kernel: new TwoScaleKernel({ ...HYPER[c], lsFast, s2 }),
    normalizeY: true,
  });
  gp.fit(idxs.map((i) => x[i]), idxs.map((i) => ilrMat[i][c]), {
    alpha: idxs.map((i) => shapeC[c][i] * HYPER[c].ns),
  });
  return gp;
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

for (const e of ELECTIONS) {
  const idxs = polls.map((p, i) => [p, i]).filter(([p]) => p.pollDate <= e.eve).map(([, i]) => i);
  const ilrNull = [], ilrBest = [], picks = [];
  for (let c = 0; c < nCoord; c++) {
    const gp0 = fit(idxs, c, 10, 0);
    let best = { gp: gp0, lml: gp0.logMarginalLikelihood_, lsFast: null, s2: 0 };
    for (const lsFast of LS_FAST) for (const s2 of S2_GRID) {
      let gp;
      try { gp = fit(idxs, c, lsFast, s2); } catch { continue; }
      if (gp.logMarginalLikelihood_ > best.lml) best = { gp, lml: gp.logMarginalLikelihood_, lsFast, s2 };
    }
    picks.push(best.s2 === 0 ? "null" : `lsF=${best.lsFast},s2=${best.s2} (dlml +${(best.lml - gp0.logMarginalLikelihood_).toFixed(1)})`);
    ilrNull.push(gp0.predict(toX(t0, [e.day]))[0]);
    ilrBest.push(best.gp.predict(toX(t0, [e.day]))[0]);
  }
  const toPred = (v) => close5(Object.fromEntries(partyCodes.map((p, i) => [p, ilrInv([v])[0][i]])));
  const p0 = toPred(ilrNull), p1 = toPred(ilrBest);
  console.log(`\n=== ${e.year}  (officiel : ${fmt(close5(e.actual))})`);
  console.log(`  production (s2=0)   : ${fmt(p0)}   MAE ${maeVs(p0, e.actual).toFixed(2)} pp`);
  console.log(`  + composante rapide : ${fmt(p1)}   MAE ${maeVs(p1, e.actual).toFixed(2)} pp`);
  console.log(`  retenu par lml      : ${picks.join(" | ")}`);
}
