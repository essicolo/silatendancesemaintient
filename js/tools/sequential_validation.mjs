/**
 * Sequential (leave-future-out) validation of the trend GP -- the
 * calibration measurement the methodology should cite instead of the
 * random-fold coverage (five-agent review, 2026-10-06: the published
 * 90.5% validates interpolation, not the edge nowcast the model
 * publishes).
 *
 * For a monthly grid of cutoff dates (2016-01 .. 2026-10), fit the
 * production GP on the polls dated <= cutoff and score the NEXT poll
 * after the cutoff: predictive log-density, 90%-interval coverage and
 * PIT value (predictive includes that poll's own observation noise).
 * Known optimism left in by design and stated: the non-firm
 * hyperparameters stay at the production choice (re-selecting at every
 * cutoff would multiply cost ~150x); the measured coverage is therefore
 * an UPPER bound on the honest one.
 *
 * Run: node js/tools/sequential_validation.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { ml, mva } from "@tangent.to/ds";
import { pivotPolls, toClosedComposition, ilrSamplingVariance } from "../src/compositional.js";
import { ChangepointKernel, toX } from "../src/gpTrend.js";

const { ilr } = mva.composition;
const Z90 = 1.6449;
const LOG2PI = Math.log(2 * Math.PI);

const HYPER = [
  { ls: 680, ns: 0.1, rho: 0.7, dil: 16 },
  { ls: 330, ns: 0.02, rho: 0.7, dil: 8 },
  { ls: 1000, ns: 0.01, rho: 1, dil: 8 },
  { ls: 680, ns: 0.02, rho: 1, dil: 16 },
  { ls: 330, ns: 0.1, rho: 1, dil: 8 },
];

const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls } = pivotPolls(rows);
const comp = toClosedComposition(polls, polls.length ? Object.keys(polls[0].shares) : []);
const ilrMat = ilr(comp);
const nCoord = ilrMat[0].length;
const t0 = polls.reduce((m, p) => (p.pollDate < m ? p.pollDate : m), polls[0].pollDate);
const x = toX(t0, polls.map((p) => p.pollDate));
const varC = ilrSamplingVariance(comp, polls.map((p) => p.sampleSize));
const shapeC = varC.map((col) => { const m = Math.min(...col); return col.map((v) => v / m); });

// monthly cutoffs
const cutoffs = [];
for (let y = 2016; y <= 2026; y++) {
  for (let m = 1; m <= 12; m++) {
    const d = `${y}-${String(m).padStart(2, "0")}-01`;
    if (d > "2026-10-04") break;
    cutoffs.push(d);
  }
}

const normal = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return z >= 0 ? y : -y;
}

let inside = 0, total = 0, lpdSum = 0;
const pits = [];
const byCampaign = { inCamp: { inside: 0, total: 0 }, out: { inside: 0, total: 0 } };
const CAMP = [["2018-08-23", "2018-10-01"], ["2022-08-28", "2022-10-03"], ["2026-08-26", "2026-10-05"]];
const inCampaign = (d) => CAMP.some(([a, b]) => d >= a && d <= b);

for (const cut of cutoffs) {
  const trIdx = [], teIdx = [];
  let nextDate = null;
  for (let i = 0; i < polls.length; i++) {
    if (polls[i].pollDate <= cut) trIdx.push(i);
  }
  if (trIdx.length < 30) continue;
  // the next poll(s): all polls at the earliest date after the cutoff
  for (let i = 0; i < polls.length; i++) {
    if (polls[i].pollDate > cut) {
      if (nextDate === null) nextDate = polls[i].pollDate;
      if (polls[i].pollDate === nextDate) teIdx.push(i);
    }
  }
  if (!teIdx.length) continue;

  for (let c = 0; c < nCoord; c++) {
    const gp = new ml.GaussianProcessRegressor({
      kernel: new ChangepointKernel({ lengthScale: HYPER[c].ls, rho: HYPER[c].rho, dilation: HYPER[c].dil }),
      normalizeY: true,
    });
    gp.fit(trIdx.map((i) => x[i]), trIdx.map((i) => ilrMat[i][c]), {
      alpha: trIdx.map((i) => shapeC[c][i] * HYPER[c].ns),
    });
    const { mean, std } = gp.predict(teIdx.map((i) => x[i]), { returnStd: true });
    const yStd = gp._yStd ?? 1;
    teIdx.forEach((i, k) => {
      const obsSd = Math.sqrt(shapeC[c][i] * HYPER[c].ns) * yStd;
      const sd = Math.sqrt(std[k] ** 2 + obsSd ** 2);
      const z = (ilrMat[i][c] - mean[k]) / sd;
      lpdSum += -0.5 * (z * z + LOG2PI) - Math.log(sd);
      pits.push(normal(z));
      const ok = Math.abs(z) <= Z90;
      if (ok) inside++;
      total++;
      const bucket = inCampaign(polls[i].pollDate) ? byCampaign.inCamp : byCampaign.out;
      bucket.total++;
      if (ok) bucket.inside++;
    });
  }
}

console.log(`validation sequentielle (prochain sondage apres chaque coupure mensuelle) :`);
console.log(`  ${total} predictions; couverture 90% = ${(inside / total * 100).toFixed(1)} %  (aleatoire/interpolation : 90,5 %)`);
console.log(`  log-densite moyenne : ${(lpdSum / total).toFixed(3)}`);
console.log(`  en campagne : ${(byCampaign.inCamp.inside / byCampaign.inCamp.total * 100).toFixed(1)} % (${byCampaign.inCamp.total})` +
  `   hors campagne : ${(byCampaign.out.inside / byCampaign.out.total * 100).toFixed(1)} % (${byCampaign.out.total})`);

pits.sort((a, b) => a - b);
const deciles = Array.from({ length: 10 }, (_, d) => pits.filter((p) => p >= d / 10 && p < (d + 1) / 10).length);
console.log(`  histogramme PIT (10 classes, uniforme attendu ~${(total / 10).toFixed(0)}/classe) : [${deciles.join(", ")}]`);
console.log(`  PIT aux bords (p<0,05 ou p>0,95) : ${(pits.filter((p) => p < 0.05 || p > 0.95).length / pits.length * 100).toFixed(1)} % (attendu 10 %)`);