/**
 * House effects (per-pollster systematic bias) and per-firm noise levels,
 * estimated -- not editorially rated -- from the polls themselves, in ILR
 * space (the Python prototype was CLR; per the project's own lesson #2 the
 * modelling basis must be ILR).
 *
 * Two-pass scheme (538-style, one iteration): fit the trend once, take each
 * poll's residual (its ILR value minus the trend's posterior mean at its
 * date), average residuals per FIRM weighted by sample size, shrink toward
 * zero for firms with few polls (empirical-Bayes pseudo-counts: a house with
 * 2 polls that happen to run high is not confidently biased), re-center the
 * whole set so the weighted mean bias across polls is zero (preserves the
 * trend level -- otherwise de-biasing shifts it by an arbitrary constant),
 * then refit the trend on de-biased polls.
 *
 * Identification caveat, stated rather than hidden: a firm's bias is only
 * identified relative to the OTHER firms polling at the same dates, and the
 * pre-2021 polls never report the PCQ (its support sits inside the reported
 * "AUTRES" residual), so part of a pre-2021-heavy firm's estimated bias is
 * the amalgamation artifact rather than house style. The cross-validation
 * harness (tools/trend_cv.mjs) is the arbiter: if a firm's estimated bias
 * does not generalize to its held-out polls, subtracting it cannot improve
 * held-out error, whatever the in-sample story.
 *
 * Firm names are normalized ("Léger." -> "Léger") -- a one-poll spelling
 * variant that would otherwise be treated as its own firm.
 */

import { mva } from "@tangent.to/ds";
import { toClosedComposition, sampleSizeWeight } from "./compositional.js";
import { fitTrend, toX } from "./gpTrend.js";

const { ilr, ilrInv } = mva.composition;

/** Pseudo-counts before trusting a firm's estimated bias at full strength. */
export const FIRM_SHRINKAGE_K = 4;
/** Pseudo-counts for the per-firm noise-level ratio. */
export const NOISE_SHRINKAGE_K = 6;

/** "Léger." and "Léger" are the same firm; trailing punctuation is noise. */
export function normalizeFirmName(firm) {
  return String(firm ?? "").replace(/[.\s]+$/, "").trim() || "inconnu";
}

/**
 * Residuals of each poll against a fitted trend, in ILR space (raw units).
 * @returns {{resid: number[][], x: number[][]}} aligned with `polls`
 */
function residualsAgainstModel(model, polls, partyCodes) {
  const comp = toClosedComposition(polls, partyCodes);
  const Y = ilr(comp);
  const x = toX(model.t0, polls.map((p) => p.pollDate));
  const k = Y[0].length;
  // gp.predict returns raw-unit means (normalizeY is inverted by the library)
  const means = model.gps.map((gp) => gp.predict(x));
  return { resid: Y.map((row, i) => row.map((v, c) => v - means[c][i])), x, k };
}

/**
 * Per-firm ILR bias from a fitted trend's residuals: sample-size-weighted
 * mean per firm, shrunk toward zero, re-centered to weighted mean zero
 * across polls. Does NOT refit anything -- pass the trend you already have.
 *
 * @param {Object} model a fitTrend() result (fit on the same `polls`)
 * @param {Array<object>} polls the polls `model` was fit on
 * @param {string[]} partyCodes
 * @param {Object} [opts] { shrinkK }
 * @returns {Map<string, number[]>} firm -> ILR bias vector (k-1 coords)
 */
export function estimateHouseEffects(model, polls, partyCodes, { shrinkK = FIRM_SHRINKAGE_K } = {}) {
  const firms = polls.map((p) => normalizeFirmName(p.firm));
  const { resid, k } = residualsAgainstModel(model, polls, partyCodes);
  const w = sampleSizeWeight(polls);

  const acc = new Map();
  polls.forEach((_, i) => {
    const f = firms[i];
    if (!acc.has(f)) acc.set(f, { n: 0, wsum: 0, rsum: new Array(k).fill(0) });
    const e = acc.get(f);
    e.n += 1;
    e.wsum += w[i];
    for (let c = 0; c < k; c++) e.rsum[c] += w[i] * resid[i][c];
  });

  const bias = new Map();
  for (const [f, e] of acc) {
    const shrink = e.n / (e.n + shrinkK);
    bias.set(f, e.rsum.map((s) => (s / e.wsum) * shrink));
  }

  // Re-center: the weighted mean bias across POLLS must be zero, so that
  // subtracting the biases does not shift the trend's overall level.
  const wTot = w.reduce((a, b) => a + b, 0);
  const meanBias = new Array(k).fill(0);
  polls.forEach((_, i) => {
    const b = bias.get(firms[i]);
    for (let c = 0; c < k; c++) meanBias[c] += ((w[i] / wTot) * b[c]);
  });
  for (const b of bias.values()) for (let c = 0; c < k; c++) b[c] -= meanBias[c];
  return bias;
}

/**
 * Polls with their firm's bias removed: new poll objects whose `.shares` are
 * the inverse-ILR of (ilr(shares) - bias_firm). Feeds straight back into
 * fitTrend, which reads `.shares` via toClosedComposition.
 *
 * `where` (optional) restricts WHICH polls get debiased -- e.g. only those
 * from the era the biases were estimated on, leaving other stretches at
 * their raw level (see tools/trend_cv.mjs V2b).
 *
 * @returns {Array<object>} copies with adjusted shares
 */
export function debiasPolls(polls, partyCodes, bias, { where = () => true } = {}) {
  const firms = polls.map((p) => normalizeFirmName(p.firm));
  const apply = polls.map((p, i) => where(p) && bias.has(firms[i]));
  const comp = toClosedComposition(polls, partyCodes);
  const Y = ilr(comp);
  const adjusted = Y.map((row, i) => {
    if (!apply[i]) return row;
    const b = bias.get(firms[i]);
    return row.map((v, c) => v - b[c]);
  });
  const shares = ilrInv(adjusted);
  return polls.map((p, i) => ({
    ...p,
    shares: Object.fromEntries(partyCodes.map((c, j) => [c, shares[i][j]])),
  }));
}

/** The relative noise shape fitTrend uses (variance ~ 1/sqrt(n)), min = 1. */
function relativeNoiseShape(polls) {
  const w = sampleSizeWeight(polls);
  const wMax = Math.max(...w);
  const wNorm = w.map((v) => Math.max(v / wMax, 0.05));
  const baseNoise = wNorm.map((v) => 1 / v);
  const baseMin = Math.min(...baseNoise);
  return baseNoise.map((v) => v / baseMin);
}

/**
 * Per-firm noise MULTIPLIERS (SD scale) from a fitted trend's residuals.
 *
 * Scale-free statistic per poll: chi_i,c = (resid_i,c / yStd_c)^2 / alpha_i,c,
 * where alpha is the variance the fit actually assumed for that poll
 * (relVar * noiseScale_c, in the library's raw-alpha-on-standardized-y
 * convention -- hence the yStd scaling). If the assumed noise is right,
 * E[chi] ~ 1. A firm whose polls scatter more than assumed shows mean chi
 * above the pool. The SD multiplier is sqrt(shrunk ratio), EB-shrunk toward
 * 1 with NOISE_SHRINKAGE_K pseudo-counts, capped to [0.5, 2.5], re-centered
 * so the poll-count-weighted mean of m^2 is exactly 1 (the grid-searched
 * noiseScale would absorb any constant anyway; re-centering keeps it
 * comparable).
 *
 * @returns {{byFirm: Map<string, number>, forPoll: (poll: object) => number,
 *           mult: number[]}} multiplier per poll, aligned with `polls`
 */
export function estimateFirmNoise(model, polls, partyCodes, { shrinkK = NOISE_SHRINKAGE_K } = {}) {
  const firms = polls.map((p) => normalizeFirmName(p.firm));
  const { resid, k } = residualsAgainstModel(model, polls, partyCodes);
  const relVar = relativeNoiseShape(polls);
  const noiseScale = model.gps.map((gp) => gp.chosenHyperparams.noiseScale);
  const yStd = model.gps.map((gp) => gp._yStd ?? 1);

  // chi per poll: average across coordinates of the scaled squared residual.
  const chi = polls.map((_, i) => {
    let s = 0;
    for (let c = 0; c < k; c++) {
      const alpha = relVar[i] * noiseScale[c] * (yStd[c] * yStd[c]);
      s += (resid[i][c] / yStd[c]) ** 2 / Math.max(alpha, 1e-12);
    }
    return s / k;
  });

  const byFirm = new Map();
  const firmNames = [...new Set(firms)];
  const pooled =
    chi.reduce((a, b) => a + b, 0) / Math.max(chi.length, 1) || 1;
  for (const f of firmNames) {
    const idx = polls.map((_, i) => i).filter((i) => firms[i] === f);
    const meanChi = idx.reduce((s, i) => s + chi[i], 0) / idx.length;
    const shrunk = (idx.length * meanChi + shrinkK * pooled) / (idx.length + shrinkK);
    byFirm.set(f, Math.min(2.5, Math.max(0.5, Math.sqrt(shrunk / pooled))));
  }
  // Re-center mean m^2 to 1 (poll-count weighted).
  const meanSq = firms.reduce((s, f) => s + byFirm.get(f) ** 2, 0) / firms.length;
  const c = 1 / Math.sqrt(meanSq);
  for (const [f, m] of byFirm) byFirm.set(f, Math.min(2.5, Math.max(0.5, m * c)));

  const mult = polls.map((_, i) => byFirm.get(firms[i]));
  return { byFirm, mult, forPoll: (p) => byFirm.get(normalizeFirmName(p.firm)) ?? 1 };
}