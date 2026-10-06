/**
 * Test: hyperparameter weighting by END-OF-CAMPAIGN predictive density.
 *
 * Production marginalizes the stage-2 grid by GLOBAL marginal likelihood
 * (12 years of polls), which barely rewards tracking a final-stretch
 * plunge: in 2026 the nowcast ended at CAQ 18.1 against final polls of
 * 14-16. Alternative weighting tested here: for each grid cell, fit on all
 * polls BEFORE a past campaign's final three weeks and score the log
 * predictive density of the polls INSIDE that window; weight cells by
 * exp(sum of window lpd). The grid, kernels and noise model are exactly
 * production's; only the weights change, so production remains the
 * lml-weighting special case.
 *
 * Protocol:
 *  - validation: weights from the 2018 window only -> nowcast at the 2022
 *    election vs official result (vs production weighting);
 *  - application: weights from 2018 + 2022 windows -> nowcast at the 2026
 *    election vs official result. 2014 is skipped (too few prior polls).
 *  - weightings compared: lml (production), cv (window lpd), lml+cv (sum).
 *
 * Run: node js/tools/campaign_weighting_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { ml, mva } from "@tangent.to/ds";
import { pivotPolls, toClosedComposition, ilrSamplingVariance } from "../src/compositional.js";
import { ChangepointKernel, toX } from "../src/gpTrend.js";

const { ilr, ilrInv } = mva.composition;
const LOG2PI = Math.log(2 * Math.PI);

const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows);
const comp = toClosedComposition(polls, partyCodes);
const ilrMat = ilr(comp);
const nCoord = ilrMat[0].length;
const t0 = polls.reduce((m, p) => (p.pollDate < m ? p.pollDate : m), polls[0].pollDate);
const x = toX(t0, polls.map((p) => p.pollDate));
const dates = polls.map((p) => p.pollDate);

const varC = ilrSamplingVariance(comp, polls.map((p) => p.sampleSize));
const shapeC = varC.map((col) => { const m = Math.min(...col); return col.map((v) => v / m); });

const LS = [10, 20, 30, 50, 75, 110, 160, 230, 330, 470, 680, 1000, 1500, 2200];
const NS = [0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8];
const RHO = [0.15, 0.4, 0.7, 1.0];
const DIL = [1, 2, 4, 8, 16];
const DELTA_NS = 4;

// campaign windows: [window start (election-21d), election date]
const WINDOWS = { 2018: ["2018-09-10", "2018-10-01"], 2022: ["2022-09-12", "2022-10-03"] };
const ACTUALS = {
  2022: { CAQ: 40.98, LIB: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91 },
  2026: { CAQ: 13.3453, LIB: 24.2157, QS: 12.4266, PQ: 28.0189, PCQ: 20.6691 },
};
const ELECTION = { 2022: "2022-10-03", 2026: "2026-10-05" };

const fitGp = (idxs, c, h) => {
  const gp = new ml.GaussianProcessRegressor({
    kernel: new ChangepointKernel({ lengthScale: h.ls, rho: h.rho, dilation: h.dil }),
    normalizeY: true,
  });
  gp.fit(idxs.map((i) => x[i]), idxs.map((i) => ilrMat[i][c]), {
    alpha: idxs.map((i) => shapeC[c][i] * h.ns),
  });
  return gp;
};

/** Log predictive density of window polls under a fit on pre-window polls. */
const windowLpd = (c, h, year) => {
  const [start, end] = WINDOWS[year];
  const train = dates.map((d, i) => [d, i]).filter(([d]) => d < start).map(([, i]) => i);
  const test = dates.map((d, i) => [d, i]).filter(([d]) => d >= start && d <= end).map(([, i]) => i);
  if (!test.length) return 0;
  const gp = fitGp(train, c, h);
  const { mean, std } = gp.predict(test.map((i) => x[i]), { returnStd: true });
  const yStd = gp._yStd ?? 1;
  let lpd = 0;
  test.forEach((i, k) => {
    const obsSd = Math.sqrt(shapeC[c][i] * h.ns) * yStd;
    const sd = Math.sqrt(std[k] ** 2 + obsSd ** 2);
    const z = (ilrMat[i][c] - mean[k]) / sd;
    lpd += -0.5 * (z * z + LOG2PI) - Math.log(sd);
  });
  return lpd;
};

// --- build candidate grids per coordinate (production stage 1 + 2) -----
console.log(`${polls.length} sondages; construction des grilles...`);
const candidates = []; // [coord] -> [{h, lml, cv2018, cv2022, nowIlr: {year: value}}]
for (let c = 0; c < nCoord; c++) {
  const nsBest = new Map();
  const all = dates.map((_, i) => i);
  for (const ls of LS) for (const ns of NS) {
    const gp = fitGp(all, c, { ls, ns, rho: 1, dil: 1 });
    const cur = nsBest.get(ns);
    if (cur === undefined || gp.logMarginalLikelihood_ > cur) nsBest.set(ns, gp.logMarginalLikelihood_);
  }
  const statMax = Math.max(...nsBest.values());
  const nsKept = [...nsBest.entries()].filter(([, l]) => l >= statMax - DELTA_NS).map(([ns]) => ns);

  const list = [];
  for (const ns of nsKept) for (const ls of LS) for (const rho of RHO) for (const dil of DIL) {
    const h = { ls, ns, rho, dil };
    let gp;
    try { gp = fitGp(all, c, h); } catch { continue; }
    list.push({ h, lml: gp.logMarginalLikelihood_ });
  }
  // prune to within 10 nats of the lml max before the expensive CV pass:
  // cells further out get negligible weight under EVERY weighting that
  // includes the lml term, and pure-cv weights are reported on this same
  // support for comparability.
  const lmax = Math.max(...list.map((e) => e.lml));
  const kept = list.filter((e) => e.lml >= lmax - 10);
  console.log(`  coord ${c}: ${list.length} cellules, ${kept.length} retenues (lml max ${lmax.toFixed(1)})`);
  candidates.push(kept);
}

// --- CV scores and nowcasts per candidate ------------------------------
for (let c = 0; c < nCoord; c++) {
  for (const cand of candidates[c]) {
    cand.cv2018 = windowLpd(c, cand.h, 2018);
    cand.cv2022 = windowLpd(c, cand.h, 2022);
    // nowcasts: 2022 from pre-election-2022 data; 2026 from all data
    const pre22 = dates.map((d, i) => [d, i]).filter(([d]) => d <= "2022-10-02").map(([, i]) => i);
    cand.now2022 = fitGp(pre22, c, cand.h).predict(toX(t0, [ELECTION[2022]]))[0];
    cand.now2026 = fitGp(dates.map((_, i) => i), c, cand.h).predict(toX(t0, [ELECTION[2026]]))[0];
  }
  console.log(`  coord ${c}: scores CV calcules`);
}

// --- weighted nowcasts ---------------------------------------------------
const close5 = (shares) => {
  const main = ["CAQ", "LIB", "QS", "PQ", "PCQ"];
  const tot = main.reduce((s, p) => s + shares[p], 0);
  return Object.fromEntries(main.map((p) => [p, (shares[p] / tot) * 100]));
};
const maeVs = (pred, actual) => {
  const a = close5(actual);
  return Object.keys(a).reduce((s, p) => s + Math.abs(pred[p] - a[p]), 0) / 5;
};

function nowcast(year, scoreOf) {
  const ilrMean = [];
  for (let c = 0; c < nCoord; c++) {
    const scores = candidates[c].map(scoreOf);
    const smax = Math.max(...scores);
    const w = scores.map((s) => Math.exp(s - smax));
    const wsum = w.reduce((a, b) => a + b, 0);
    const field = year === 2022 ? "now2022" : "now2026";
    ilrMean.push(candidates[c].reduce((s, cand, i) => s + w[i] * cand[field], 0) / wsum);
  }
  const share = ilrInv([ilrMean])[0];
  const raw = Object.fromEntries(partyCodes.map((p, i) => [p, share[i]]));
  return close5(raw);
}

const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v.toFixed(1)}`).join("  ");
console.log("\nVALIDATION 2022 (poids tires de la fenetre 2018 seulement) :");
console.log(`  officiel : ${fmt(close5(ACTUALS[2022]))}`);
for (const [label, f] of [
  ["lml (production)", (e) => e.lml],
  ["cv fenetre 2018", (e) => e.cv2018],
  ["lml + cv", (e) => e.lml + e.cv2018],
]) {
  const p = nowcast(2022, f);
  console.log(`  ${label.padEnd(18)} : ${fmt(p)}   MAE ${maeVs(p, ACTUALS[2022]).toFixed(2)} pp`);
}

console.log("\nAPPLICATION 2026 (poids tires des fenetres 2018 + 2022) :");
console.log(`  officiel : ${fmt(close5(ACTUALS[2026]))}`);
for (const [label, f] of [
  ["lml (production)", (e) => e.lml],
  ["cv 2018+2022", (e) => e.cv2018 + e.cv2022],
  ["lml + cv", (e) => e.lml + e.cv2018 + e.cv2022],
]) {
  const p = nowcast(2026, f);
  console.log(`  ${label.padEnd(18)} : ${fmt(p)}   MAE ${maeVs(p, ACTUALS[2026]).toFixed(2)} pp`);
}

// top cells per weighting, for inspection
console.log("\ncellules dominantes (coord, poids lml vs lml+cv) :");
for (let c = 0; c < nCoord; c++) {
  const byLml = [...candidates[c]].sort((a, b) => b.lml - a.lml)[0];
  const byMix = [...candidates[c]].sort((a, b) => (b.lml + b.cv2018 + b.cv2022) - (a.lml + a.cv2018 + a.cv2022))[0];
  console.log(`  coord ${c}: lml -> ls=${byLml.h.ls} ns=${byLml.h.ns} rho=${byLml.h.rho} dil=${byLml.h.dil}` +
    `  | lml+cv -> ls=${byMix.h.ls} ns=${byMix.h.ns} rho=${byMix.h.rho} dil=${byMix.h.dil}`);
}
