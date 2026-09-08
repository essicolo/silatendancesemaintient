/**
 * Smooth party-support trend + uncertainty over time via Gaussian process
 * regression in ILR space.
 *
 * ILR, not CLR. The previous version fit CLR coordinates, dropped the last
 * one and reconstructed it at sampling time as minus-the-sum of independent
 * draws -- which made that coordinate's variance the SUM of the other five,
 * and because pivotPolls sorts parties alphabetically, the party carrying
 * the inflated variance was QS. An alphabetical accident deciding whose
 * credible band is widest is exactly the degenerate-basis trap the project's
 * own notes warn about. ILR gives k-1 orthonormal, full-rank coordinates:
 * every party is treated symmetrically and nothing is reconstructed.
 *
 * One GP per ILR coordinate, still independent across coordinates: the
 * cross-coordinate covariance (e.g. CAQ losses flowing to the PQ) is NOT
 * modelled. That is a real simplification, stated here rather than hidden.
 *
 * Since @tangent.to/ds 0.13 the GP machinery lives in the library:
 * GaussianProcessRegressor takes a per-observation noise VECTOR as `alpha`
 * (verified to match the previous hand-rolled implementation to 1e-6 on lml,
 * mean and std), and kernels are composable objects -- so the changepoint
 * structure is a small Kernel subclass rather than a whole parallel GP
 * implementation. The overall noise scale stays a grid-searched
 * hyperparameter: it decides how much poll-to-poll scatter is sampling error
 * versus real movement, i.e. the width of every interval downstream.
 */

import { ml, mva } from "@tangent.to/ds";
import { toClosedComposition, sampleSizeWeight } from "./compositional.js";

const { ilr, ilrInv } = mva.composition;

function daysSince(t0, date) {
  return (new Date(date).getTime() - new Date(t0).getTime()) / 86_400_000;
}

// Documented regime changes in the party system: Legault's resignation
// announcement opened the realignment, Fréchette's accession as premier
// closed it. A stationary kernel assumes the dynamics never change regime,
// so the post-changepoint CAQ surge was dragged toward the pre-Fréchette
// trough (GP nowcast 19.4 against an ascending 19-20-20-23-23-27 poll
// sequence -- every OTHER party tracked its polls). Crossing a changepoint
// multiplies the kernel by rho <= 1, letting the fit partially decorrelate
// regimes. rho is a fitted hyperparameter chosen by marginal likelihood, and
// rho = 1 recovers the stationary model exactly -- the evidence decides
// whether the changepoints matter, not an editorial judgement.
const CHANGEPOINTS = ["2026-01-14", "2026-04-12"];
const RHO_GRID = [0.15, 0.4, 0.7, 1.0];

// Opinion moves faster during a campaign than the twelve-year average the
// length scale is fitted on -- with 1500-day scales, six consecutive CAQ
// residuals came out one-signed (~+1.7pp) in the first two 2026 campaign
// weeks. The fix is a change of CLOCK, not of regime: inside a campaign
// window one calendar day counts as `dilation` days of kernel time, which
// shortens the effective length scale by that factor there and only there.
// Unlike a changepoint this does not decorrelate the campaign from the
// pre-campaign -- it accelerates it, which is the right shape. The dilation
// factor is shared across ALL campaign windows, so it is identified mostly
// by the three PAST campaigns in the training data, not by the current one;
// dilation = 1 is on the grid and recovers the undilated model, so the
// evidence decides. Windows are writ drop -> election day; 2026's writ date
// is approximate (Wikipedia does not carry it yet), which is immaterial:
// between two dates inside the campaign only elapsed campaign time matters.
const CAMPAIGNS = [
  ["2014-03-05", "2014-04-07"],
  ["2018-08-23", "2018-10-01"],
  ["2022-08-28", "2022-10-03"],
  ["2026-08-26", "2026-10-05"],
];
// The grid ends at 16 even though some coordinates choose it: inside a
// campaign only the EFFECTIVE scale lengthScale/dilation is identified, so
// past 8 the likelihood slides along a (lengthScale x dilation) ridge --
// extending the grid moves the pair (680x8 -> 1000x16) without moving the
// posterior (nowcast stable to 0.1pp). The boundary-maximum rule is about a
// clipped optimum; a ridge endpoint is not one.
const DILATION_GRID = [1, 2, 4, 8, 16];

function regimeOf(day, cpDays) {
  let r = 0;
  for (const c of cpDays) if (day >= c) r++;
  return r;
}

/** Cumulative campaign days elapsed before `day`. */
function campaignDaysOf(day, windows) {
  let c = 0;
  for (const [a, b] of windows) c += Math.max(0, Math.min(day, b) - a);
  return c;
}

/** Matérn-3/2 over campaign-dilated time, multiplied by rho^|regime
 * difference|. Input rows are [day, regime, campaignDays] -- regime index and
 * cumulative campaign days are data, precomputed per observation, so the
 * kernel stays a pure function of two rows, which is all the library's
 * Kernel contract asks for. The dilated coordinate is w(t) = t +
 * (dilation-1)*c(t), a monotone 1-D warp, so the kernel remains a valid
 * Matérn on a transformed axis (PSD by construction). rho = 1 and
 * dilation = 1 recover the plain stationary Matérn exactly. */
export class ChangepointKernel extends ml.Kernel {
  constructor({ lengthScale = 100, rho = 1, dilation = 1 } = {}) {
    super();
    this.lengthScale = lengthScale;
    this.rho = rho;
    this.dilation = dilation;
  }

  compute(a, b) {
    const dt = (a[0] - b[0]) + (this.dilation - 1) * (a[2] - b[2]);
    const s = (Math.sqrt(3) * Math.abs(dt)) / this.lengthScale;
    return (1 + s) * Math.exp(-s) * Math.pow(this.rho, Math.abs(a[1] - b[1]));
  }

  getParams() {
    return { lengthScale: this.lengthScale, rho: this.rho, dilation: this.dilation };
  }
}

/** [day, regime, campaignDays] rows for the GPs, from ISO dates. */
export function toX(t0, dates) {
  const cpDays = CHANGEPOINTS.map((d) => daysSince(t0, d));
  const windows = CAMPAIGNS.map(([a, b]) => [daysSince(t0, a), daysSince(t0, b)]);
  return dates.map((d) => {
    const day = daysSince(t0, d);
    return [day, regimeOf(day, cpDays), campaignDaysOf(day, windows)];
  });
}

/**
 * @param {Array<object>} polls
 * @param {string[]} partyCodes
 * @returns {{gps: ml.GaussianProcessRegressor[], t0: string, partyCodes: string[]}}
 */
export function fitTrend(polls, partyCodes) {
  const comp = toClosedComposition(polls, partyCodes);
  const ilrMat = ilr(comp); // k-1 orthonormal coordinates, full rank

  const t0 = polls.reduce((min, p) => (p.pollDate < min ? p.pollDate : min), polls[0].pollDate);
  const x = toX(t0, polls.map((p) => p.pollDate));

  const w = sampleSizeWeight(polls);
  const wMax = Math.max(...w);
  const wNorm = w.map((v) => Math.max(v / wMax, 0.05));
  const baseNoise = wNorm.map((v) => 1 / v);
  const baseMin = Math.min(...baseNoise);
  const relNoise = baseNoise.map((v) => v / baseMin); // relative shape: best poll = 1

  // The library's own optimizer (optimize: true) tunes kernel parameters by
  // gradient ascent, but the noise SCALE multiplying the per-poll vector is
  // not a kernel parameter, and the changepoint grid must compare marginal
  // likelihoods across discrete rho values anyway -- so both stay on explicit
  // grids over the heteroscedastic marginal likelihood.
  // Both grids were extended after the first coverage check: the marginal
  // likelihood kept choosing the boundary values, and a maximum on the edge
  // of the grid means the grid is clipping the optimum, not finding it.
  const LENGTH_SCALE_CANDIDATES = [10, 20, 30, 50, 75, 110, 160, 230, 330, 470, 680, 1000, 1500, 2200];
  const NOISE_SCALE_CANDIDATES = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8];

  const fitOne = (y, lengthScale, rho, dilation, noiseScale) => {
    const gp = new ml.GaussianProcessRegressor({
      kernel: new ChangepointKernel({ lengthScale, rho, dilation }),
      normalizeY: true,
    });
    gp.fit(x, y, { alpha: relNoise.map((v) => v * noiseScale) });
    return gp;
  };

  const gps = [];
  for (let coord = 0; coord < ilrMat[0].length; coord++) {
    const y = ilrMat.map((row) => row[coord]);

    // Stage 1: stationary grid (rho = 1, dilation = 1) over
    // (lengthScale, noiseScale).
    let stat = null;
    for (const lengthScale of LENGTH_SCALE_CANDIDATES) {
      for (const noiseScale of NOISE_SCALE_CANDIDATES) {
        const gp = fitOne(y, lengthScale, 1, 1, noiseScale);
        if (!stat || gp.logMarginalLikelihood_ > stat.lml) {
          stat = { lml: gp.logMarginalLikelihood_, lengthScale, noiseScale };
        }
      }
    }

    // Stage 2: JOINT grid over (lengthScale x rho) with the noise scale
    // carried from stage 1. Length scale and changepoints interact -- with a
    // changepoint absorbing the regime shift, a long smooth scale becomes
    // admissible again, and freezing the scale at its STATIONARY optimum
    // biases the search toward rho = 1. Every candidate is the same
    // implementation so marginal likelihoods are comparable; rho = 1 IS the
    // stationary model, so keeping it is always on the table. Affordable
    // because this runs at build time (compute.mjs), not per visitor.
    // Dilation joins the same joint grid: it interacts with the length scale
    // the same way the changepoints do (a dilated campaign makes a long
    // smooth base scale admissible again).
    let best = null;
    for (const lengthScale of LENGTH_SCALE_CANDIDATES) {
      for (const rho of RHO_GRID) {
        for (const dilation of DILATION_GRID) {
          let gp;
          try {
            gp = fitOne(y, lengthScale, rho, dilation, stat.noiseScale);
          } catch {
            continue;
          }
          if (!best || gp.logMarginalLikelihood_ > best.logMarginalLikelihood_) {
            best = gp;
            best.chosenHyperparams = { lengthScale, noiseScale: stat.noiseScale, rho, dilation };
          }
        }
      }
    }
    gps.push(best);
  }

  return { gps, t0, partyCodes };
}

function randnBoxMuller(rng) {
  const u1 = rng(), u2 = rng();
  return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draw `nSamples` joint composition samples at `asOf`: one independent
 * Normal draw per ILR coordinate from its own GP posterior, then inverse-ILR
 * back to the simplex. All k-1 coordinates are sampled -- none is
 * reconstructed from the others.
 */
export function sampleTrendDraws(model, asOf, nSamples = 2000, seed = null) {
  const x = toX(model.t0, [asOf]);
  const rng = seed !== null ? mulberry32(seed) : Math.random;

  const means = [], stds = [];
  for (const gp of model.gps) {
    const { mean, std } = gp.predict(x, { returnStd: true });
    means.push(mean[0]);
    stds.push(std[0]);
  }

  const samplesIlr = [];
  for (let s = 0; s < nSamples; s++) {
    samplesIlr.push(means.map((m, i) => m + stds[i] * randnBoxMuller(rng)));
  }
  const samplesSimplex = ilrInv(samplesIlr);
  return samplesSimplex.map((row) => Object.fromEntries(model.partyCodes.map((p, i) => [p, row[i]])));
}

/**
 * Same marginal summary as predictTrend, but for many dates at once via a
 * single batched gp.predict() call per coordinate instead of one call per
 * date -- calling predictTrend() in a per-date loop over a multi-year
 * history means hundreds of separate {predict + 2000-sample MC} passes,
 * slow enough in a browser to look like the chart never rendered at all.
 *
 * `mean` here is the deterministic inverse-ILR of the GP's own posterior
 * mean at each date, NOT a Monte Carlo sample average: averaging even a few
 * hundred *independent* samples per date leaves visible sampling noise from
 * one date to the next, which shows up as the trend line jittering faster
 * than the data could possibly support even though the underlying GP mean
 * is smooth. Only the credible band (p05/p95) still needs sampling, since
 * inverse-ILR is nonlinear.
 */
export function predictTrendSeries(model, dates, { nSamples = 300, seed = null } = {}) {
  const rng = seed !== null ? mulberry32(seed) : Math.random;
  const x = toX(model.t0, dates);

  const meansByCoord = [], stdsByCoord = [];
  for (const gp of model.gps) {
    const { mean, std } = gp.predict(x, { returnStd: true });
    meansByCoord.push(mean);
    stdsByCoord.push(std);
  }

  const meanShareByDate = ilrInv(x.map((_, di) => meansByCoord.map((means) => means[di])));

  return dates.map((date, di) => {
    const samplesIlr = [];
    for (let s = 0; s < nSamples; s++) {
      samplesIlr.push(meansByCoord.map((means, ci) => means[di] + stdsByCoord[ci][di] * randnBoxMuller(rng)));
    }
    const samplesSimplex = ilrInv(samplesIlr);

    const result = { date };
    model.partyCodes.forEach((party, i) => {
      const col = samplesSimplex.map((row) => row[i]).sort((a, b) => a - b);
      const pct = (p) => col[Math.floor((p / 100) * (col.length - 1))];
      result[party] = { mean: meanShareByDate[di][i], p05: pct(5), p50: pct(50), p95: pct(95) };
    });
    return result;
  });
}

/**
 * Point estimate + Monte Carlo credible interval per party at `asOf`
 * (marginal summary of sampleTrendDraws -- inverse-ILR is nonlinear, so
 * simplex-space quantiles come from samples rather than analytic
 * propagation of the ILR-space Gaussian).
 */
export function predictTrend(model, asOf, { nSamples = 2000, seed = null } = {}) {
  const x = toX(model.t0, [asOf]);
  const ilrMean = model.gps.map((gp) => gp.predict(x)[0]);
  const meanShare = ilrInv([ilrMean])[0];

  const draws = sampleTrendDraws(model, asOf, nSamples, seed);
  const result = {};
  model.partyCodes.forEach((party, i) => {
    const col = draws.map((d) => d[party]).sort((a, b) => a - b);
    const pct = (p) => col[Math.floor((p / 100) * (col.length - 1))];
    result[party] = { mean: meanShare[i], p05: pct(5), p50: pct(50), p95: pct(95) };
  });
  return result;
}
