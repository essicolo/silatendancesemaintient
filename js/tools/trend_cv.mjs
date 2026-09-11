/**
 * Cross-validated comparison of trend-model variants, on held-out POLLS.
 *
 * Every variant is fit with the full production procedure (fitTrend's
 * hyperparameter grids, changepoints, campaign dilation) on the TRAIN polls
 * only; held-out polls are scored on:
 *   - MAE (pp): |posterior-mean shares - (de-biased) poll shares| per party
 *   - coverage: share of held-out poll-coordinates inside the 90% predictive
 *     interval (latent GP std + that poll's own assumed noise, under the
 *     normalization the fit used)
 *   - CRPS (pp): proper scoring rule on the full predictive density of the
 *     de-biased observation (samples = posterior + poll noise), per party
 *
 * Variants:
 *   V1 baseline (production)
 *   V2 + house effects (ILR, EB-shrunk, re-centered)
 *   V3 + per-firm noise multipliers
 *   V4 + house & noise
 *   V5 noise shape 1/n (sampling theory) instead of 1/sqrt(n)
 *   V6 house & noise & shape 1/n
 *
 * House effects and multipliers are estimated on TRAIN only; a held-out
 * poll's firm inherits its train-estimated bias/multiplier (0/1 when the
 * firm is absent -- the honest forecasting situation).
 *
 * Two split schemes:
 *   random 5-fold      -- interpolation + house-effect consistency
 *   temporal blocks     -- true forecasting (train ≤ election, test after)
 *
 * VERDICT (2026-09-11): house effects help interpolation (~-5% MAE/CRPS,
 * borderline) but NOT forecasting (T2 neutral 6.386 vs 6.362; T1 clearly
 * degraded when biases are estimated on the PCQ-amalgamation era, 8.755 vs
 * 8.413; the >=2021-estimated variant removes the T1 damage but adds
 * nothing). Firm-noise multipliers: nothing. Shape 1/n: within noise. The
 * best combined variant gains -0.29pp on T2 -- under one standard error on
 * 73 polls. NOTHING ADOPTED; this file is the evidence record.
 *
 * Run: node js/tools/trend_cv.mjs            (from js/)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { pivotPolls, toClosedComposition } from "../src/compositional.js";
import { fitTrend, toX, relativeNoiseShape } from "../src/gpTrend.js";
import { estimateHouseEffects, debiasPolls, estimateFirmNoise, normalizeFirmName } from "../src/houseEffects.js";

const { ilr, ilrInv } = mva.composition;
const Z90 = 1.6449;

const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows);
console.log(`${polls.length} sondages nationaux, ${partyCodes.length} partis\n`);

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

/** CRPS of a sorted sample against an observation. */
function crpsFromSorted(sorted, x) {
  const n = sorted.length;
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    s1 += Math.abs(sorted[i] - x);
    s2 += sorted[i] * (2 * (i + 1) - n - 1);
  }
  return s1 / n - s2 / (n * n);
}

/**
 * Score held-out polls under a fitted variant. biasFor: poll -> ILR bias
 * vector or null (the bias SUBTRACTED from that poll for comparison --
 * must match what was subtracted at fit time); multFor: poll -> SD
 * multiplier (null = 1); noiseShape: 'sqrt' | 'n'.
 */
function scoreHeldOut({ model, trainPolls, testPolls, biasFor = null, multFor = null, noiseShape = "sqrt" }) {
  const x = toX(model.t0, testPolls.map((p) => p.pollDate));
  const k = model.gps.length;
  const preds = model.gps.map((gp) => gp.predict(x, { returnStd: true }));
  const noiseScale = model.gps.map((gp) => gp.chosenHyperparams.noiseScale);
  const yStd = model.gps.map((gp) => gp._yStd ?? 1);

  const comp = toClosedComposition(testPolls, partyCodes);
  const Y = ilr(comp);
  const relNoise = relativeNoiseShape(testPolls, trainPolls);

  const rng = mulberry32(98765);
  let mae = 0, maeN = 0, cov = 0, covN = 0, crps = 0, crpsN = 0;
  const maeByParty = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  const S = 200;

  testPolls.forEach((p, i) => {
    const b = biasFor ? biasFor(p) : null;
    const debAct = Y[i].map((v, c) => v - (b ? b[c] : 0));
    const m = multFor ? multFor(p) : 1;

    const predIlr = preds.map((pr) => pr.mean[i]);
    const predShares = ilrInv([predIlr])[0];
    const actShares = ilrInv([debAct])[0];

    partyCodes.forEach((party, j) => {
      const e = Math.abs(predShares[j] - actShares[j]) * 100;
      mae += e; maeN++;
      maeByParty[party] += e;
    });

    // predictive sd of the de-biased observation, per coordinate
    const obsVar = [];
    for (let c = 0; c < k; c++) {
      const relVar = (noiseShape === "n" ? relNoise[i] * relNoise[i] : relNoise[i]) * m * m;
      obsVar.push(preds[c].std[i] ** 2 + relVar * noiseScale[c] * yStd[c] * yStd[c]);
    }
    let inside = 0;
    for (let c = 0; c < k; c++) {
      if (Math.abs(debAct[c] - preds[c].mean[i]) <= Z90 * Math.sqrt(obsVar[c])) inside++;
    }
    cov += inside / k; covN++;

    const samplesIlr = Array.from({ length: S }, () =>
      predIlr.map((mu, c) => mu + Math.sqrt(obsVar[c]) * randn(rng)));
    const samplesShares = ilrInv(samplesIlr);
    partyCodes.forEach((party, j) => {
      const col = samplesShares.map((s) => s[j] * 100).sort((a, b2) => a - b2);
      crps += crpsFromSorted(col, actShares[j] * 100); crpsN++;
    });
  });

  return {
    n: testPolls.length,
    mae: mae / maeN,
    coverage: cov / covN,
    crps: crps / crpsN,
    maeByParty: Object.fromEntries(partyCodes.map((p) => [p, maeByParty[p] / testPolls.length])),
  };
}

/**
 * Fit all six variants on `trainPolls`; returns a map variant -> scoring
 * closure data. The house-effect estimation reuses the baseline fit (no
 * extra trend fit for pass 1). V2b estimates biases on post-2021 train
 * polls only (all six parties reported -- no PCQ-amalgamation artifact)
 * and applies them only there too; firms without post-2021 polls get zero
 * bias, which is the honest forecasting situation.
 */
const RECENT = (p) => p.pollDate >= "2021-01-01";

function fitVariants(trainPolls) {
  const fit1 = fitTrend(trainPolls, partyCodes); // V1 baseline
  const bias = estimateHouseEffects(fit1, trainPolls, partyCodes);
  const debiased = debiasPolls(trainPolls, partyCodes, bias);
  const fit2 = fitTrend(debiased, partyCodes); // V2 house

  const recentTrain = trainPolls.filter(RECENT);
  const biasB = recentTrain.length >= 30 ? estimateHouseEffects(fit1, recentTrain, partyCodes) : new Map();
  const debiasedB = debiasPolls(trainPolls, partyCodes, biasB, { where: RECENT });
  const fit2b = fitTrend(debiasedB, partyCodes); // V2b house, post-2021 estimated & applied

  const noise1 = estimateFirmNoise(fit1, trainPolls, partyCodes); // from raw residuals
  const fit3 = fitTrend(trainPolls, partyCodes, { noiseMultiplier: noise1.mult }); // V3 noise
  const noise2 = estimateFirmNoise(fit2, debiased, partyCodes); // from de-biased residuals
  const fit4 = fitTrend(debiased, partyCodes, { noiseMultiplier: noise2.mult }); // V4 house+noise
  const noise2b = estimateFirmNoise(fit2b, debiasedB, partyCodes); // residuals net of V2b bias
  const fit4b = fitTrend(debiasedB, partyCodes, { noiseMultiplier: noise2b.mult }); // V4b
  const fit5 = fitTrend(trainPolls, partyCodes, { noiseShape: "n" }); // V5 shape 1/n
  const fit6 = fitTrend(debiased, partyCodes, { noiseMultiplier: noise2.mult, noiseShape: "n" }); // V6
  const fit6b = fitTrend(debiasedB, partyCodes, { noiseMultiplier: noise2b.mult, noiseShape: "n" }); // V6b

  return {
    V1: { model: fit1, biasFor: null, multFor: null, noiseShape: "sqrt" },
    V2: { model: fit2, biasFor: (p) => bias.get(normalizeFirmName(p.firm)) ?? null, multFor: null, noiseShape: "sqrt" },
    V2b: { model: fit2b, biasFor: (p) => (RECENT(p) ? biasB.get(normalizeFirmName(p.firm)) ?? null : null), multFor: null, noiseShape: "sqrt" },
    V3: { model: fit3, biasFor: null, multFor: noise1.forPoll, noiseShape: "sqrt" },
    V4: { model: fit4, biasFor: (p) => bias.get(normalizeFirmName(p.firm)) ?? null, multFor: noise2.forPoll, noiseShape: "sqrt" },
    V4b: { model: fit4b, biasFor: (p) => (RECENT(p) ? biasB.get(normalizeFirmName(p.firm)) ?? null : null), multFor: noise2b.forPoll, noiseShape: "sqrt" },
    V5: { model: fit5, biasFor: null, multFor: null, noiseShape: "n" },
    V6: { model: fit6, biasFor: (p) => bias.get(normalizeFirmName(p.firm)) ?? null, multFor: noise2.forPoll, noiseShape: "n" },
    V6b: { model: fit6b, biasFor: (p) => (RECENT(p) ? biasB.get(normalizeFirmName(p.firm)) ?? null : null), multFor: noise2b.forPoll, noiseShape: "n" },
  };
}

function averageScores(list) {
  const nTot = list.reduce((s, r) => s + r.n, 0);
  const avg = (f) => list.reduce((s, r) => s + f(r) * r.n, 0) / nTot;
  const byParty = {};
  for (const p of partyCodes) byParty[p] = avg((r) => r.maeByParty[p]);
  return { n: nTot, mae: avg((r) => r.mae), coverage: avg((r) => r.coverage), crps: avg((r) => r.crps), maeByParty: byParty };
}

function fmtRow(tag, s) {
  const partyMae = partyCodes.map((p) => `${p} ${s.maeByParty[p].toFixed(2)}`).join("  ");
  return `${tag.padEnd(22)} MAE ${s.mae.toFixed(3)}pp  cov ${(s.coverage * 100).toFixed(1)}%  CRPS ${s.crps.toFixed(3)}   [${partyMae}]`;
}

const VARIANTS = ["V1", "V2", "V2b", "V3", "V4", "V4b", "V5", "V6", "V6b"];
const VARIANT_LABEL = {
  V1: "baseline (prod.)",
  V2: "+ maison (toute période)",
  V2b: "+ maison (est. ≥2021)",
  V3: "+ bruit par firme",
  V4: "+ maison & bruit",
  V4b: "+ maison ≥21 & bruit",
  V5: "forme bruit 1/n",
  V6: "maison+bruit+1/n",
  V6b: "maison≥21+bruit+1/n",
};

// ---------- Scheme 1: random 5-fold ----------
console.log("=== CV aléatoire 5 folds (par sondage) ===");
{
  const K = 5;
  let state = 20260910;
  const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff), state / 0x7fffffff);
  const idx = polls.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const folds = Array.from({ length: K }, (_, k) => idx.filter((_, i) => i % K === k));

  const acc = Object.fromEntries(VARIANTS.map((v) => [v, []]));
  for (let k = 0; k < K; k++) {
    const testSet = new Set(folds[k]);
    const trainPolls = polls.filter((_, i) => !testSet.has(i));
    const testPolls = polls.filter((_, i) => testSet.has(i));
    const variants = fitVariants(trainPolls);
    for (const v of VARIANTS) {
      acc[v].push(scoreHeldOut({ ...variants[v], trainPolls, testPolls }));
    }
    console.log(`  fold ${k + 1}/${K} fait`);
  }
  console.log();
  for (const v of VARIANTS) console.log("  " + fmtRow(VARIANT_LABEL[v], averageScores(acc[v])));
}

// ---------- Scheme 2: temporal blocks ----------
console.log("\n=== CV temporelle (prévision réelle) ===");
const BLOCKS = [
  ["T1: train ≤2018, test 2018-2022", "2018-10-01", "2022-10-03"],
  ["T2: train ≤2022, test 2022-2026", "2022-10-03", "9999-12-31"],
];
for (const [label, cut, end] of BLOCKS) {
  const trainPolls = polls.filter((p) => p.pollDate <= cut);
  const testPolls = polls.filter((p) => p.pollDate > cut && p.pollDate <= end);
  console.log(`\n  --- ${label} (train ${trainPolls.length}, test ${testPolls.length}) ---`);
  const variants = fitVariants(trainPolls);
  for (const v of VARIANTS) {
    console.log("  " + fmtRow(VARIANT_LABEL[v], scoreHeldOut({ ...variants[v], trainPolls, testPolls })));
  }
}

// ---------- Full-data nowcast per variant (material impact) ----------
console.log("\n=== Impact matériel : nowcast du jour, ajusté sur TOUS les sondages ===");
{
  const variants = fitVariants(polls);
  for (const v of VARIANTS) {
    const model = variants[v].model;
    const x = toX(model.t0, [new Date().toISOString().slice(0, 10)]);
    const meanIlr = model.gps.map((gp) => gp.predict(x)[0]);
    const shares = ilrInv([meanIlr])[0];
    // interval width via the GP std (latent, per-coordinate -> simplex MC)
    const stds = model.gps.map((gp) => gp.predict(x, { returnStd: true }).std[0]);
    const rng = mulberry32(42);
    const draws = ilrInv(Array.from({ length: 500 }, () => meanIlr.map((m, c) => m + stds[c] * randn(rng))));
    const width = partyCodes.map((_, j) => {
      const col = draws.map((d) => d[j]).sort((a, b) => a - b);
      return (col[Math.floor(0.95 * col.length)] - col[Math.floor(0.05 * col.length)]) * 100;
    });
    const s = partyCodes.map((p, j) => `${p} ${(shares[j] * 100).toFixed(1)}±${width[j].toFixed(1)}`).join("  ");
    console.log(`  ${VARIANT_LABEL[v].padEnd(22)} ${s}`);
  }
}