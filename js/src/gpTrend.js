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
 * It widens joint statements slightly (a draw can move two parties up
 * together more often than reality would); the marginal bands are unaffected.
 *
 * The observation-noise vector is per-poll (sample size), and its overall
 * scale is now a fitted hyperparameter (NOISE_SCALE_CANDIDATES) rather than
 * the previous convention "best poll = unit noise", which was calibrated on
 * nothing and silently set the width of every interval downstream.
 */

import { mva, core } from "@tangent.to/ds";
import { HeteroscedasticGP } from "./heteroscedasticGP.js";
import { toClosedComposition, sampleSizeWeight } from "./compositional.js";

const { ilr, ilrInv } = mva.composition;
const { cholesky, choleskySolve } = core.linalg;

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

function regimeOf(day, cpDays) {
  let r = 0;
  for (const c of cpDays) if (day >= c) r++;
  return r;
}

/** Minimal heteroscedastic Matérn-3/2 GP with a changepoint factor.
 * Same predict() surface as the library GP (mean array, or {mean, std}). */
class ChangepointGP {
  constructor({ lengthScale, rho, cpDays }) {
    this.ls = lengthScale; this.rho = rho; this.cpDays = cpDays;
  }

  _k(ta, ra, tb, rb) {
    const K = [];
    for (let i = 0; i < ta.length; i++) {
      const row = [];
      for (let j = 0; j < tb.length; j++) {
        const s = (Math.sqrt(3) * Math.abs(ta[i] - tb[j])) / this.ls;
        row.push((1 + s) * Math.exp(-s) * Math.pow(this.rho, Math.abs(ra[i] - rb[j])));
      }
      K.push(row);
    }
    return K;
  }

  fit(x, y, noiseVec) {
    this.t = x.map((r) => r[0]);
    this.r = this.t.map((d) => regimeOf(d, this.cpDays));
    this.yMean = y.reduce((a, b) => a + b, 0) / y.length;
    const yc = y.map((v) => v - this.yMean);
    this.yStd = Math.sqrt(Math.max(yc.reduce((s, v) => s + v * v, 0) / y.length, 1e-12));
    const yn = yc.map((v) => v / this.yStd);

    const K = this._k(this.t, this.r, this.t, this.r);
    for (let i = 0; i < K.length; i++) K[i][i] += noiseVec[i] + 1e-9;
    this.L = cholesky(core.linalg.toMatrix(K));
    this.alpha = choleskySolve(this.L, yn);
    const a = (i) => (Array.isArray(this.alpha) ? this.alpha[i] : this.alpha.get(i, 0));
    let quad = 0, logDet = 0;
    for (let i = 0; i < yn.length; i++) { quad += yn[i] * a(i); logDet += Math.log(this.L.get(i, i)); }
    this.logMarginalLikelihood_ = -0.5 * quad - logDet - 0.5 * yn.length * Math.log(2 * Math.PI);
    return this;
  }

  predict(X, { returnStd = false } = {}) {
    const tS = X.map((r) => r[0]);
    const rS = tS.map((d) => regimeOf(d, this.cpDays));
    const a = (i) => (Array.isArray(this.alpha) ? this.alpha[i] : this.alpha.get(i, 0));
    const mean = [], std = [];
    for (let s = 0; s < tS.length; s++) {
      const ks = this._k([tS[s]], [rS[s]], this.t, this.r)[0];
      let m = 0;
      for (let i = 0; i < ks.length; i++) m += ks[i] * a(i);
      mean.push(this.yMean + this.yStd * m);
      if (returnStd) {
        const u = forwardSolve(this.L, ks);
        let kv = 0;
        for (let i = 0; i < u.length; i++) kv += u[i] * u[i]; // k* K^-1 k* = ||L^-1 k*||^2
        std.push(this.yStd * Math.sqrt(Math.max(1 - kv, 1e-12)));
      }
    }
    return returnStd ? { mean, std } : mean;
  }
}

/** Forward solve L u = b (L lower-triangular). */
function forwardSolve(L, b) {
  const n = b.length;
  const u = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let j = 0; j < i; j++) s -= L.get(i, j) * u[j];
    u[i] = s / L.get(i, i);
  }
  return u;
}

/**
 * @param {Array<object>} polls
 * @param {string[]} partyCodes
 * @returns {{gps: HeteroscedasticGP[], t0: string, partyCodes: string[]}}
 */
export function fitTrend(polls, partyCodes) {
  const comp = toClosedComposition(polls, partyCodes);
  const ilrMat = ilr(comp); // k-1 orthonormal coordinates, full rank

  const t0 = polls.reduce((min, p) => (p.pollDate < min ? p.pollDate : min), polls[0].pollDate);
  const x = polls.map((p) => [daysSince(t0, p.pollDate)]);

  const w = sampleSizeWeight(polls);
  const wMax = Math.max(...w);
  const wNorm = w.map((v) => Math.max(v / wMax, 0.05));
  const baseNoise = wNorm.map((v) => 1 / v);
  const baseMin = Math.min(...baseNoise);
  const relNoise = baseNoise.map((v) => v / baseMin); // relative shape: best poll = 1

  // @tangent.to/ds's built-in hyperparameter optimizer tunes the kernel
  // assuming a scalar `alpha`, which would ignore the per-observation noise
  // vector `_refit()` actually uses (see heteroscedasticGP.js) -- so both the
  // length scale AND the absolute noise scale are picked by grid search over
  // the heteroscedastic marginal likelihood. The noise scale is what decides
  // how much of the poll-to-poll scatter is treated as sampling error versus
  // real movement, i.e. the width of the posterior.
  // Both grids were extended after the first coverage check: the marginal
  // likelihood kept choosing the boundary values (noiseScale 0.25, length
  // scale 1000), and a maximum on the edge of the grid means the grid is
  // clipping the optimum, not finding it.
  const LENGTH_SCALE_CANDIDATES = [10, 20, 30, 50, 75, 110, 160, 230, 330, 470, 680, 1000, 1500, 2200];
  const NOISE_SCALE_CANDIDATES = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8];

  const cpDays = CHANGEPOINTS.map((d) => daysSince(t0, d));

  const gps = [];
  for (let coord = 0; coord < ilrMat[0].length; coord++) {
    const y = ilrMat.map((row) => row[coord]);

    // Stage 1: stationary grid over (lengthScale, noiseScale), as before.
    let stat = null;
    for (const lengthScale of LENGTH_SCALE_CANDIDATES) {
      for (const noiseScale of NOISE_SCALE_CANDIDATES) {
        const gp = new HeteroscedasticGP({ kernel: "matern", lengthScale, nu: 1.5, normalizeY: true });
        gp.fit(x, y, relNoise.map((v) => v * noiseScale));
        if (!stat || gp.logMarginalLikelihood_ > stat.lml) {
          stat = { lml: gp.logMarginalLikelihood_, lengthScale, noiseScale };
        }
      }
    }

    // Stage 2: JOINT grid over (lengthScale x rho) with the noise scale
    // carried from stage 1. Length scale and changepoints interact -- with a
    // changepoint absorbing the regime shift, a long smooth scale becomes
    // admissible again, and freezing the scale at its STATIONARY optimum
    // biases the search toward rho = 1. All candidates are fit with the same
    // implementation so marginal likelihoods are comparable; rho = 1 IS the
    // stationary model, so keeping it is always on the table. Affordable
    // because this runs at build time (compute.mjs), not per visitor.
    let best = null;
    for (const lengthScale of LENGTH_SCALE_CANDIDATES) {
      for (const rho of RHO_GRID) {
        const gp = new ChangepointGP({ lengthScale, rho, cpDays });
        try {
          gp.fit(x, y, relNoise.map((v) => v * stat.noiseScale));
        } catch {
          continue;
        }
        if (!best || gp.logMarginalLikelihood_ > best.logMarginalLikelihood_) {
          best = gp;
          best.chosenHyperparams = { lengthScale, noiseScale: stat.noiseScale, rho };
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
  const x = [[daysSince(model.t0, asOf)]];
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
  const x = dates.map((d) => [daysSince(model.t0, d)]);

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
  const x = [[daysSince(model.t0, asOf)]];
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
