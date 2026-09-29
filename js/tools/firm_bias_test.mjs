/**
 * Firm-bias (house-effect) test for the national trend GP.
 *
 * Model: additive random intercept per polling firm in each ILR coordinate,
 * expressed as a kernel term sigmaF2 * [same firm] added to the production
 * ChangepointKernel. sigmaF2 = 0 is on the grid and recovers the production
 * model exactly; the zero-mean prior shrinks small firms automatically, so
 * no sum-to-zero constraint and no minimum poll count per firm is needed.
 * Trend predictions use a firm index of -1 (matches nothing), so the latent
 * trend excludes any firm's bias; CV predictions of held-out polls use the
 * poll's real firm index, so same-firm training polls inform the prediction.
 *
 * Decision evidence, in doctrine order:
 *  1. marginal likelihood over the sigmaF2 grid (in-sample evidence);
 *  2. 5-fold CV: held-out predictive log-density + 90% coverage,
 *     sigmaF2 = 0 vs the per-coordinate ML-best sigmaF2;
 *  3. 2022 backtest: latent-trend prediction at 2022-10-03 vs the official
 *     result, MAE with and without the firm term (same hyperparameters);
 *  4. posterior firm biases (pp on today's nowcast) for inspection.
 *
 * Non-firm hyperparameters are fixed at the production top-member choice per
 * coordinate (as in coverage_check.mjs): the test isolates the firm term.
 *
 * Run: node js/tools/firm_bias_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { ml, mva } from "@tangent.to/ds";
import { pivotPolls, toClosedComposition, ilrSamplingVariance } from "../src/compositional.js";
import { ChangepointKernel, fitTrend, toX } from "../src/gpTrend.js";

const { ilr, ilrInv } = mva.composition;
const Z90 = 1.6449;
const LOG2PI = Math.log(2 * Math.PI);

class FirmBiasKernel extends ml.Kernel {
  constructor({ lengthScale, rho, dilation, sigmaF2 = 0 }) {
    super();
    this.base = new ChangepointKernel({ lengthScale, rho, dilation });
    this.sigmaF2 = sigmaF2;
  }
  compute(a, b) {
    const firm = this.sigmaF2 > 0 && a[3] >= 0 && a[3] === b[3] ? this.sigmaF2 : 0;
    return this.base.compute(a, b) + firm;
  }
  getParams() {
    return { ...this.base.getParams(), sigmaF2: this.sigmaF2 };
  }
}

// --- data -------------------------------------------------------------
const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows);
const comp = toClosedComposition(polls, partyCodes);
const ilrMat = ilr(comp);
const nCoord = ilrMat[0].length;
const t0 = polls.reduce((min, p) => (p.pollDate < min ? p.pollDate : min), polls[0].pollDate);

const firmNames = [...new Set(polls.map((p) => p.firm))].sort();
const firmIdx = new Map(firmNames.map((f, i) => [f, i]));
const x = toX(t0, polls.map((p) => p.pollDate)).map((r, i) => [...r, firmIdx.get(polls[i].firm)]);

const varC = ilrSamplingVariance(comp, polls.map((p) => p.sampleSize));
const noiseShapeC = varC.map((col) => {
  const m = Math.min(...col);
  return col.map((v) => v / m);
});

console.log(`${polls.length} sondages, ${firmNames.length} maisons, ${nCoord} coordonnees ILR`);
const counts = {};
for (const p of polls) counts[p.firm] = (counts[p.firm] || 0) + 1;
console.log("sondages par maison :", Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(", "));

// --- production hyperparameters (top ensemble member per coordinate) ---
console.log("\nfit de production (selection des hyperparametres)...");
const production = fitTrend(polls, partyCodes);
const hyper = production.gps.map((gp) => gp.chosenHyperparams);
hyper.forEach((h, c) =>
  console.log(`  coord ${c}: ls=${h.lengthScale} ns=${h.noiseScale} rho=${h.rho} dil=${h.dilation}`));

const fitVariant = (xs, ys, alpha, h, sigmaF2) => {
  const gp = new ml.GaussianProcessRegressor({
    kernel: new FirmBiasKernel({ lengthScale: h.lengthScale, rho: h.rho, dilation: h.dilation, sigmaF2 }),
    normalizeY: true,
  });
  gp.fit(xs, ys, { alpha });
  return gp;
};

// --- 1. evidence over the sigmaF2 grid --------------------------------
// sigmaF2 in normalized-y variance units (signal variance ~ 1): SD grid
// 0, 0.05, 0.1, 0.2, 0.3, 0.5.
const SIGMA_F2 = [0, 0.0025, 0.01, 0.04, 0.09, 0.25];
console.log("\n1. log-vraisemblance marginale, delta vs sigmaF2 = 0 :");
const bestS2 = [];
for (let c = 0; c < nCoord; c++) {
  const y = ilrMat.map((r) => r[c]);
  const alpha = noiseShapeC[c].map((v) => v * hyper[c].noiseScale);
  const lmls = SIGMA_F2.map((s2) => fitVariant(x, y, alpha, hyper[c], s2).logMarginalLikelihood_);
  const deltas = lmls.map((l) => l - lmls[0]);
  const iBest = deltas.indexOf(Math.max(...deltas));
  bestS2.push(SIGMA_F2[iBest]);
  console.log(`  coord ${c}: ${SIGMA_F2.map((s2, i) => `s2=${s2}:${deltas[i] >= 0 ? "+" : ""}${deltas[i].toFixed(1)}`).join("  ")}  -> best s2=${SIGMA_F2[iBest]}`);
}

// --- 2. 5-fold CV: predictive log-density + coverage -------------------
let state = 12345;
const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff), state / 0x7fffffff);
const idx = x.map((_, i) => i);
for (let i = idx.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [idx[i], idx[j]] = [idx[j], idx[i]];
}
const K = 5;
const folds = Array.from({ length: K }, (_, k) => idx.filter((_, i) => i % K === k));

const cvScore = (sigmaF2ByCoord) => {
  let lpd = 0, inside = 0, total = 0;
  for (let c = 0; c < nCoord; c++) {
    const y = ilrMat.map((r) => r[c]);
    for (const test of folds) {
      const testSet = new Set(test);
      const tr = idx.filter((i) => !testSet.has(i));
      const alpha = tr.map((i) => noiseShapeC[c][i] * hyper[c].noiseScale);
      const gp = fitVariant(tr.map((i) => x[i]), tr.map((i) => y[i]), alpha, hyper[c], sigmaF2ByCoord[c]);
      const { mean, std } = gp.predict(test.map((i) => x[i]), { returnStd: true });
      const yStd = gp._yStd ?? 1;
      test.forEach((i, k2) => {
        const obsSd = Math.sqrt(noiseShapeC[c][i] * hyper[c].noiseScale) * yStd;
        const sd = Math.sqrt(std[k2] ** 2 + obsSd ** 2);
        const z = (y[i] - mean[k2]) / sd;
        lpd += -0.5 * (z * z + LOG2PI) - Math.log(sd);
        if (Math.abs(z) <= Z90) inside++;
        total++;
      });
    }
  }
  return { lpd, coverage: inside / total, total };
};

console.log("\n2. validation croisee 5 plis (predictif hors echantillon) :");
const cv0 = cvScore(new Array(nCoord).fill(0));
const cvF = cvScore(bestS2);
console.log(`  sigmaF2 = 0     : log-densite ${cv0.lpd.toFixed(1)}, couverture 90% = ${(cv0.coverage * 100).toFixed(1)}%`);
console.log(`  sigmaF2 = best  : log-densite ${cvF.lpd.toFixed(1)}, couverture 90% = ${(cvF.coverage * 100).toFixed(1)}%`);
console.log(`  delta log-densite (firme - sans) : ${(cvF.lpd - cv0.lpd).toFixed(1)} nats sur ${cvF.total} predictions`);

// --- 3. 2022 backtest: latent trend at election day --------------------
const ACTUAL_2022 = { CAQ: 40.98, LIB: 14.37, PQ: 14.61, QS: 15.43, PCQ: 12.91, AUTRES: 1.70 };
const trainIdx = polls.map((p, i) => [p, i]).filter(([p]) => p.pollDate <= "2022-10-02").map(([, i]) => i);
const xStar = [[...toX(t0, ["2022-10-03"])[0], -1]];

const backtest = (sigmaF2ByCoord) => {
  const ilrPred = [];
  for (let c = 0; c < nCoord; c++) {
    const y = ilrMat.map((r) => r[c]);
    const alpha = trainIdx.map((i) => noiseShapeC[c][i] * hyper[c].noiseScale);
    const gp = fitVariant(trainIdx.map((i) => x[i]), trainIdx.map((i) => y[i]), alpha, hyper[c], sigmaF2ByCoord[c]);
    ilrPred.push(gp.predict(xStar)[0]);
  }
  const share = ilrInv([ilrPred])[0];
  const pred = Object.fromEntries(partyCodes.map((p, i) => [p, share[i] * 100]));
  const main = partyCodes.filter((p) => p !== "AUTRES");
  const mae = main.reduce((s, p) => s + Math.abs(pred[p] - ACTUAL_2022[p]), 0) / main.length;
  return { pred, mae };
};

console.log(`\n3. backtest 2022 (${trainIdx.length} sondages d'entrainement, prediction du 2022-10-03) :`);
const bt0 = backtest(new Array(nCoord).fill(0));
const btF = backtest(bestS2);
const fmt = (o) => partyCodes.map((p) => `${p} ${o[p].toFixed(1)}`).join("  ");
console.log(`  resultat officiel : ${fmt(ACTUAL_2022)}`);
console.log(`  sans biais firme  : ${fmt(bt0.pred)}   MAE(5 partis) = ${bt0.mae.toFixed(3)} pp`);
console.log(`  avec biais firme  : ${fmt(btF.pred)}   MAE(5 partis) = ${btF.mae.toFixed(3)} pp`);

// --- 4. posterior firm biases on today's nowcast -----------------------
// b_f[c] = sigmaF2 * sum_{i in f} alphaVector_i (normalized y) * yStd.
const asOf = new Date().toISOString().slice(0, 10);
const xNow = [[...toX(t0, [asOf])[0], -1]];
const biasIlr = firmNames.map(() => new Array(nCoord).fill(0));
const ilrNow = [];
for (let c = 0; c < nCoord; c++) {
  const y = ilrMat.map((r) => r[c]);
  const alpha = noiseShapeC[c].map((v) => v * hyper[c].noiseScale);
  const gp = fitVariant(x, y, alpha, hyper[c], bestS2[c]);
  ilrNow.push(gp.predict(xNow)[0]);
  const av = gp._alphaVector, yStd = gp._yStd ?? 1;
  polls.forEach((p, i) => {
    biasIlr[firmIdx.get(p.firm)][c] += bestS2[c] * (av.get ? av.get(i, 0) : av[i]) * yStd;
  });
}
const shareNow = ilrInv([ilrNow])[0];
console.log(`\n4. biais a posteriori par maison (pp sur le nowcast du ${asOf}, s2 = best par coordonnee) :`);
const cycleFirms = Object.entries(counts).filter(([f]) => polls.some((p) => p.firm === f && p.pollDate >= "2025-10-05"));
for (const [f] of cycleFirms.sort((a, b) => b[1] - a[1])) {
  const b = biasIlr[firmIdx.get(f)];
  const shifted = ilrInv([ilrNow.map((m, c) => m + b[c])])[0];
  const diff = partyCodes.map((p, i) => `${p} ${((shifted[i] - shareNow[i]) * 100 >= 0 ? "+" : "")}${((shifted[i] - shareNow[i]) * 100).toFixed(1)}`).join("  ");
  console.log(`  ${f.padEnd(22)} (${counts[f]} sondages au total) : ${diff}`);
}
