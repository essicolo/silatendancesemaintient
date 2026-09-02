/**
 * Riding-effects model: one Gaussian process per ILR coordinate, Matérn 3/2,
 * over standardized features, with @tangent.to/ds.
 *
 * The GP replaced the ridge after a head-to-head on the same repeated-50%-
 * holdout multivariate criterion (Python prototype, n=109, 18 predictors):
 * ridge +0.380, GP Matérn +0.457. Ridge survives only as a benchmark in the
 * Python backtests -- it was scaffolding, not the model. A ridge is the MAP
 * of a GP with a linear kernel anyway; the Matérn kernel is what buys the
 * improvement, i.e. the demographic response is measurably nonlinear.
 *
 * Hyperparameters (length scale, observation noise) are chosen per
 * coordinate by log marginal likelihood over a grid -- the library's own
 * optimizer is not used for the same reason as in gpTrend.js. Scoring and
 * validation remain MULTIVARIATE: total squared error across coordinates
 * jointly, repeated 50% holdout, against a predict-the-mean null.
 */

import { ml } from "@tangent.to/ds";

// Standardized 18-dim features: typical pairwise distances sit around
// sqrt(2p) ~ 6, so the grid brackets that from "very local" to "nearly
// linear". Noise grid is relative to normalize-y variance 1.
export const LENGTH_SCALES = [2, 3, 4.5, 7, 11, 18];
export const NOISE_LEVELS = [0.1, 0.25, 0.5, 1];

function standardizer(X) {
  const n = X.length, p = X[0].length;
  const mean = Array.from({ length: p }, (_, j) => X.reduce((s, r) => s + r[j], 0) / n);
  const sd = Array.from({ length: p }, (_, j) => {
    const v = X.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / Math.max(n - 1, 1);
    return Math.sqrt(v) || 1;
  });
  return (rows) => rows.map((r) => r.map((v, j) => (v - mean[j]) / sd[j]));
}

/** One GP per response coordinate; returns a predict(X) closure. */
export function fitMultivariate(X, Y) {
  const scale = standardizer(X);
  const Xs = scale(X);
  const models = [], hyper = [];

  for (let j = 0; j < Y[0].length; j++) {
    const yj = Y.map((r) => r[j]);
    let best = null, bestHyper = null;
    for (const lengthScale of LENGTH_SCALES) {
      for (const alpha of NOISE_LEVELS) {
        const gp = new ml.GaussianProcessRegressor({
          kernel: "matern", lengthScale, nu: 1.5, alpha, normalizeY: true,
        });
        gp.fit(Xs, yj);
        if (!best || gp.logMarginalLikelihood_ > best.logMarginalLikelihood_) {
          best = gp;
          bestHyper = { lengthScale, alpha };
        }
      }
    }
    models.push(best);
    hyper.push(bestHyper);
  }

  return {
    hyper,
    predict(Xnew) {
      const Xn = scale(Xnew);
      const cols = models.map((m) => m.predict(Xn));
      return Xn.map((_, i) => cols.map((c) => c[i]));
    },
  };
}

function totalSquaredError(Y, P) {
  let s = 0;
  for (let i = 0; i < Y.length; i++) for (let j = 0; j < Y[i].length; j++) s += (Y[i][j] - P[i][j]) ** 2;
  return s;
}

function columnMeans(Y) {
  const k = Y[0].length;
  return Array.from({ length: k }, (_, j) => Y.reduce((s, r) => s + r[j], 0) / Y.length);
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Repeated 50% holdout, multivariate R^2 against a predict-the-mean null.
 * The GP re-selects its hyperparameters inside every training half -- the
 * same no-leak discipline the ridge version applied to its penalty. */
export function multivariateR2(X, Y, { repeats = 15, seed = 0 } = {}) {
  const rng = mulberry32(seed);
  let errModel = 0, errNull = 0;

  for (let rep = 0; rep < repeats; rep++) {
    const idx = X.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const half = Math.floor(idx.length / 2);
    const tr = idx.slice(0, half), te = idx.slice(half);

    const Xtr = tr.map((i) => X[i]), Ytr = tr.map((i) => Y[i]);
    const Xte = te.map((i) => X[i]), Yte = te.map((i) => Y[i]);

    const model = fitMultivariate(Xtr, Ytr);
    errModel += totalSquaredError(Yte, model.predict(Xte));

    const mean = columnMeans(Ytr);
    errNull += totalSquaredError(Yte, Yte.map(() => mean));
  }
  return 1 - errModel / errNull;
}
