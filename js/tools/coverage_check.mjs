/**
 * Interval-coverage check for the poll-trend GP.
 *
 * The backtests so far measured point error (MAE in percentage points); none
 * measured whether the INTERVALS mean what they claim. This runs 5-fold
 * cross-validation with the hyperparameters the production fit selects, and
 * counts how often each held-out poll falls inside the GP's 90% predictive
 * interval (posterior variance + that poll's own observation noise).
 *
 * Read the result per coordinate: ~90% means calibrated; far above means the
 * noise scale is too large (intervals too wide); far below, too small.
 *
 * Run: node js/tools/coverage_check.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { HeteroscedasticGP } from "../src/heteroscedasticGP.js";
import { pivotPolls, toClosedComposition, sampleSizeWeight } from "../src/compositional.js";
import { fitTrend } from "../src/gpTrend.js";

const { ilr } = mva.composition;
const Z90 = 1.6449;

const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows);

const comp = toClosedComposition(polls, partyCodes);
const ilrMat = ilr(comp);
const t0 = polls.reduce((min, p) => (p.pollDate < min ? p.pollDate : min), polls[0].pollDate);
const x = polls.map((p) => [(new Date(p.pollDate) - new Date(t0)) / 86_400_000]);

const w = sampleSizeWeight(polls);
const wMax = Math.max(...w);
const relNoise = w.map((v) => Math.max(v / wMax, 0.05)).map((v) => 1 / v);
const relMin = Math.min(...relNoise);
const noiseShape = relNoise.map((v) => v / relMin);

console.log(`${polls.length} sondages, ${ilrMat[0].length} coordonnees ILR\n`);
console.log("hyperparametres retenus par le fit de production :");
const production = fitTrend(polls, partyCodes);
production.gps.forEach((gp, c) =>
  console.log(`  coord ${c}: lengthScale=${gp.chosenHyperparams.lengthScale}, noiseScale=${gp.chosenHyperparams.noiseScale}`)
);

// 5-fold with a fixed shuffle; hyperparams fixed to the production choice
// (re-selecting per fold would be stricter but 72x more fits).
let state = 12345;
const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff), state / 0x7fffffff);
const idx = x.map((_, i) => i);
for (let i = idx.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [idx[i], idx[j]] = [idx[j], idx[i]];
}
const K = 5;
const folds = Array.from({ length: K }, (_, k) => idx.filter((_, i) => i % K === k));

console.log("\ncouverture des intervalles a 90% (par coordonnee ILR) :");
const coordCoverage = [];
for (let c = 0; c < ilrMat[0].length; c++) {
  const y = ilrMat.map((row) => row[c]);
  const { lengthScale, noiseScale } = production.gps[c].chosenHyperparams;
  let inside = 0, total = 0;

  for (const test of folds) {
    const testSet = new Set(test);
    const tr = idx.filter((i) => !testSet.has(i));
    const gp = new HeteroscedasticGP({ kernel: "matern", lengthScale, nu: 1.5, normalizeY: true });
    gp.fit(tr.map((i) => x[i]), tr.map((i) => y[i]), tr.map((i) => noiseShape[i] * noiseScale));
    const { mean, std } = gp.predict(test.map((i) => x[i]), { returnStd: true });

    // The predictive interval for an OBSERVED poll includes that poll's own
    // observation noise, in the GP's normalized-y units.
    const yStd = gp._yStd ?? 1; // normalizeY scale, if exposed; else raw
    test.forEach((i, k) => {
      const obsSd = Math.sqrt(noiseShape[i] * noiseScale) * (typeof yStd === "number" ? yStd : 1);
      const sd = Math.sqrt(std[k] ** 2 + obsSd ** 2);
      if (Math.abs(y[i] - mean[k]) <= Z90 * sd) inside++;
      total++;
    });
  }
  const cov = inside / total;
  coordCoverage.push(cov);
  console.log(`  coord ${c}: ${(cov * 100).toFixed(1)}%  (${inside}/${total})`);
}

const overall = coordCoverage.reduce((a, b) => a + b, 0) / coordCoverage.length;
console.log(`\nmoyenne: ${(overall * 100).toFixed(1)}%  (cible 90%)`);
