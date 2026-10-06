/**
 * Test: election-result ANCHORS in the trend GP, with and without the
 * per-firm random intercept (synthesis of the campaign-reactivity and
 * firm-bias diagnoses of the 2026 post-mortem).
 *
 * An election result is an observation of the same latent trend with
 * near-zero sampling noise and NO house effect. Adding the 2014/2018/2022
 * results as anchor rows (firm index -1, observation variance 0.01 x the
 * best poll's) does two things: it pins the trend level at elections, and
 * it makes the firm random intercept identified in ABSOLUTE terms near
 * anchors instead of relative-only. Hypothesis from the post-mortem: with
 * both, the final Mainstreet poll (CAQ +6.9 vs result, the series' last
 * point) gets discounted into its house bias instead of anchoring the
 * nowcast.
 *
 * 2x2 design, non-firm hyperparameters fixed at the production top choice
 * per coordinate; sigmaF2 chosen by marginal likelihood on its own grid
 * (0 included):
 *   A: production (no anchor, no firm term)     C: anchors only
 *   B: firm term only                            D: anchors + firm term
 * Validation at 2022 (train <= 2022-10-02, anchors 2014+2018 only) and
 * application at 2026 (all data, anchors 2014/2018/2022). MAE in pp on
 * the five main parties closed, against the official results.
 *
 * Run: node js/tools/anchored_trend_test.mjs   (from the repo root)
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
const SIGMA_F2 = [0, 0.01, 0.04, 0.09, 0.25];
const ANCHOR_SHAPE = 0.01; // observation variance relative to the best poll

// Official results as compositions (AUTRES = remainder to 100).
const ANCHORS = [
  { date: "2014-04-07", shares: { LIB: 41.52, PQ: 25.38, CAQ: 23.05, QS: 7.63, PCQ: 0.39, AUTRES: 2.03 } },
  { date: "2018-10-01", shares: { CAQ: 37.42, LIB: 24.82, PQ: 17.06, QS: 16.10, PCQ: 1.46, AUTRES: 3.14 } },
  { date: "2022-10-03", shares: { CAQ: 40.98, LIB: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91, AUTRES: 1.70 } },
];
const ACTUALS = {
  2022: { CAQ: 40.98, LIB: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91 },
  2026: { CAQ: 13.3453, LIB: 24.2157, QS: 12.4266, PQ: 28.0189, PCQ: 20.6691 },
};

class FirmBiasKernel extends ml.Kernel {
  constructor({ ls, rho, dil, sigmaF2 = 0 }) {
    super();
    this.base = new ChangepointKernel({ lengthScale: ls, rho, dilation: dil });
    this.sigmaF2 = sigmaF2;
  }
  compute(a, b) {
    const firm = this.sigmaF2 > 0 && a[3] >= 0 && a[3] === b[3] ? this.sigmaF2 : 0;
    return this.base.compute(a, b) + firm;
  }
  getParams() { return { ...this.base.getParams(), sigmaF2: this.sigmaF2 }; }
}

// --- data ----------------------------------------------------------------
const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows);
const nPolls = polls.length;
const records = [
  ...polls.map((p) => ({ date: p.pollDate, firm: p.firm, shares: p.shares, n: p.sampleSize })),
  ...ANCHORS.map((a) => ({
    date: a.date, firm: null, n: 0,
    shares: Object.fromEntries(partyCodes.map((p) => [p, (a.shares[p] ?? 0) / 100])),
  })),
];
const comp = toClosedComposition(records, partyCodes);
const ilrMat = ilr(comp);
const nCoord = ilrMat[0].length;
const t0 = records.reduce((m, r) => (r.date < m ? r.date : m), records[0].date);

const firmNames = [...new Set(polls.map((p) => p.firm))].sort();
const firmIdx = new Map(firmNames.map((f, i) => [f, i]));
const x = toX(t0, records.map((r) => r.date)).map((r, i) =>
  [...r, i < nPolls ? firmIdx.get(records[i].firm) : -1]);

const varC = ilrSamplingVariance(comp.slice(0, nPolls), polls.map((p) => p.sampleSize));
const shapeC = varC.map((col) => {
  const m = Math.min(...col);
  return [...col.map((v) => v / m), ...ANCHORS.map(() => ANCHOR_SHAPE)];
});

// --- variants --------------------------------------------------------------
const fitOne = (idxs, c, sigmaF2) => {
  const gp = new ml.GaussianProcessRegressor({
    kernel: new FirmBiasKernel({ ...HYPER[c], sigmaF2 }),
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

function runVariant(label, idxs, target, useFirm) {
  const ilrMean = [];
  const chosen = [];
  for (let c = 0; c < nCoord; c++) {
    let best = null;
    for (const s2 of useFirm ? SIGMA_F2 : [0]) {
      const gp = fitOne(idxs, c, s2);
      if (!best || gp.logMarginalLikelihood_ > best.lml) best = { gp, lml: gp.logMarginalLikelihood_, s2 };
    }
    chosen.push(best.s2);
    ilrMean.push(best.gp.predict([[...toX(t0, [target])[0], -1]])[0]);
  }
  const share = ilrInv([ilrMean])[0];
  const pred = close5(Object.fromEntries(partyCodes.map((p, i) => [p, share[i]])));
  const year = target.startsWith("2022") ? 2022 : 2026;
  console.log(`  ${label.padEnd(26)} : ${fmt(pred)}   MAE ${maeVs(pred, ACTUALS[year]).toFixed(2)} pp` +
    (useFirm ? `   s2=[${chosen.join(",")}]` : ""));
  return pred;
}

// --- validation at 2022 ------------------------------------------------
const pollsPre22 = records.map((r, i) => [r, i]).filter(([r, i]) => i < nPolls && r.date <= "2022-10-02").map(([, i]) => i);
const anchorsPre22 = [nPolls, nPolls + 1]; // 2014, 2018
console.log("VALIDATION 2022 (train <= 2022-10-02; ancres 2014+2018) :");
console.log(`  officiel : ${fmt(close5(ACTUALS[2022]))}`);
runVariant("A production", pollsPre22, "2022-10-03", false);
runVariant("B firme", pollsPre22, "2022-10-03", true);
runVariant("C ancres", [...pollsPre22, ...anchorsPre22], "2022-10-03", false);
runVariant("D ancres + firme", [...pollsPre22, ...anchorsPre22], "2022-10-03", true);

// --- application at 2026 -------------------------------------------------
const allPolls = records.map((_, i) => i).filter((i) => i < nPolls);
const allIdx = records.map((_, i) => i);
console.log("\nAPPLICATION 2026 (toutes donnees; ancres 2014/2018/2022) :");
console.log(`  officiel : ${fmt(close5(ACTUALS[2026]))}`);
runVariant("A production", allPolls, "2026-10-05", false);
runVariant("B firme", allPolls, "2026-10-05", true);
runVariant("C ancres", allIdx, "2026-10-05", false);
runVariant("D ancres + firme", allIdx, "2026-10-05", true);

// --- sensitivity: 2026 without the final Mainstreet poll ------------------
const sansMainstreet = allPolls.filter((i) => !(records[i].firm === "Mainstreet Research" && records[i].date === "2026-10-03"));
console.log("\nSENSIBILITE (A sans le Mainstreet final du 3 oct) :");
runVariant("A production", sansMainstreet, "2026-10-05", false);
