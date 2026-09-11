/**
 * Test D: ARD (per-feature length scales) for the riding-effects GP.
 *
 * Production fits one Matérn-3/2 GP per ILR coordinate with an ISOTROPIC
 * length scale over the 18 standardized predictors, grid-searched by lml.
 * The library's optimizer supports ARD (one length scale per dimension,
 * analytic gradients) -- the natural upgrade of the project's own
 * "no variable selection, let the GP attenuate" philosophy: ARD IS the GP
 * attenuating, continuously instead of all-or-nothing.
 *
 * Three arms, same repeated-50%-holdout multivariate protocol (identical
 * folds, same seed) as the production R²:
 *   A1 production grid (isotropic, variance fixed by normalizeY)
 *   A2 isotropic + lml optimization (length scale AND variance tuned)
 *   A3 ARD + lml optimization (18 length scales + variance)
 *
 * If A3 beats A1 out-of-sample, the gain is from per-feature scales; if A2
 * already matches A3, the grid was the bottleneck, not isotropy.
 *
 * VERDICT (2026-09-11): REJECTED. A1 0.461 ± 0.028, A2 0.474 ± 0.025 (within
 * noise of A1), A3 0.418 ± 0.033 -- ARD OVERFITS: 19 length scales on n=54
 * per fold maximize the marginal likelihood, not held-out prediction; the
 * learned scales show the symptom (half the features pushed to 10^5-10^7,
 * effectively removed). The production isotropic grid stands. Evidence
 * record below.
 *
 * Run: node js/tools/ard_test.mjs   (from js/)
 */

import { readFileSync } from "node:fs";
import { ml } from "@tangent.to/ds";
import { buildFeatureMatrix, residualIlr, PARTIES } from "../src/ridingEffects.js";

const { lengthScales: LENGTH_SCALE_GRID, noiseLevels: NOISE_GRID } = { lengthScales: [2, 3, 4.5, 7, 11, 18], noiseLevels: [0.1, 0.25, 0.5, 1] };

const features2017 = JSON.parse(readFileSync(new URL("../data/qc_riding_features_2017.json", import.meta.url), "utf-8"));
const ridingResults = JSON.parse(readFileSync(new URL("../data/qc_riding_results.json", import.meta.url), "utf-8"));

// ---------- build the exact production training set ----------
// (replicates trainRidingEffects in ridingProjection.js)
function align(featureRows, residual) {
  const { X, ridings: codes } = buildFeatureMatrix(featureRows);
  const codeByName = new Map(featureRows.filter((f) => f.riding_name).map((f) => [f.riding_name, String(f.riding_code)]));
  const rowByCode = new Map(codes.map((c, i) => [c, i]));
  const Xa = [], Ya = [], names = [];
  residual.ridings.forEach((name, i) => {
    const code = codeByName.get(String(name)) ?? String(name);
    const row = rowByCode.get(code);
    if (row === undefined) return;
    Xa.push(X[row]);
    Ya.push(residual.Y[i]);
    names.push(String(name));
  });
  return { X: Xa, Y: Ya, names };
}

const prev = residualIlr(ridingResults, "2014-04-07", "2011", "2018-10-01", "2017", PARTIES);
const curr = residualIlr(ridingResults, "2018-10-01", "2017", "2022-10-03", "2017", PARTIES);
const prevByName = new Map(prev.ridings.map((r, i) => [String(r), prev.Y[i]]));
const target = align(features2017, curr);
const X = [], Y = [];
target.names.forEach((name, i) => {
  const p = prevByName.get(name);
  if (!p) return;
  X.push([...target.X[i], ...p]);
  Y.push(target.Y[i]);
});
console.log(`n=${X.length} circonscriptions d'entraînement, ${X[0].length} prédicteurs, ${Y[0].length} coordonnées ILR\n`);

// ---------- fitters ----------
function standardizer(Xtr) {
  const n = Xtr.length, p = Xtr[0].length;
  const mean = Array.from({ length: p }, (_, j) => Xtr.reduce((s, r) => s + r[j], 0) / n);
  const sd = Array.from({ length: p }, (_, j) => {
    const v = Xtr.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / Math.max(n - 1, 1);
    return Math.sqrt(v) || 1;
  });
  return (rows) => rows.map((r) => r.map((v, j) => (v - mean[j]) / sd[j]));
}

/** Production arm: isotropic grid per coordinate. */
function fitA1(Xtr, Ytr) {
  const scale = standardizer(Xtr);
  const Xs = scale(Xtr);
  const models = [];
  for (let j = 0; j < Ytr[0].length; j++) {
    const y = Ytr.map((r) => r[j]);
    let best = null;
    for (const ls of LENGTH_SCALE_GRID) {
      for (const alpha of NOISE_GRID) {
        const gp = new ml.GaussianProcessRegressor({ kernel: "matern", lengthScale: ls, nu: 1.5, alpha, normalizeY: true });
        gp.fit(Xs, y);
        if (!best || gp.logMarginalLikelihood_ > best.logMarginalLikelihood_) best = gp;
      }
    }
    models.push({ gp: best, scale });
  }
  return { predict(Xnew) { const Xn = scale(Xnew); return Xn.map((_, i) => models.map((m) => m.gp.predict([Xn[i]])[0])); } };
}

/** Optimized arms: grid for alpha, then lml optimization of kernel params. */
function fitOpt(Xtr, Ytr, { ard = false }) {
  const scale = standardizer(Xtr);
  const Xs = scale(Xtr);
  const p = Xtr[0].length;
  const models = [];
  for (let j = 0; j < Ytr[0].length; j++) {
    const y = Ytr.map((r) => r[j]);
    // stage 1: production grid to find (ls, alpha)
    let bestLs = null, bestAlpha = null, bestLml = -Infinity;
    for (const ls of LENGTH_SCALE_GRID) {
      for (const alpha of NOISE_GRID) {
        const gp = new ml.GaussianProcessRegressor({ kernel: "matern", lengthScale: ls, nu: 1.5, alpha, normalizeY: true });
        gp.fit(Xs, y);
        if (gp.logMarginalLikelihood_ > bestLml) { bestLml = gp.logMarginalLikelihood_; bestLs = ls; bestAlpha = alpha; }
      }
    }
    // stage 2: optimize with ARD (or isotropic) init at the grid optimum
    const gp = new ml.GaussianProcessRegressor({
      kernel: new ml.Matern({ lengthScale: ard ? Array(p).fill(bestLs) : bestLs, nu: 1.5 }),
      alpha: bestAlpha,
      normalizeY: true,
      optimize: true,
      nRestarts: 2,
    });
    gp.fit(Xs, y);
    models.push({ gp, scale });
  }
  return { predict(Xnew) { const Xn = scale(Xnew); return Xn.map((_, i) => models.map((m) => m.gp.predict([Xn[i]])[0])); } };
}

// ---------- identical holdout protocol ----------
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function totalSquaredError(Yt, P) {
  let s = 0;
  for (let i = 0; i < Yt.length; i++) for (let j = 0; j < Yt[i].length; j++) s += (Yt[i][j] - P[i][j]) ** 2;
  return s;
}
function columnMeans(Yt) {
  const k = Yt[0].length;
  return Array.from({ length: k }, (_, j) => Yt.reduce((s, r) => s + r[j], 0) / Yt.length);
}

function holdoutR2(fitter, { repeats = 15, seed = 0 } = {}) {
  const rng = mulberry32(seed);
  let errModel = 0, errNull = 0;
  const foldErrs = [];
  for (let rep = 0; rep < repeats; rep++) {
    const idx = X.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const half = Math.floor(idx.length / 2);
    const tr = idx.slice(0, half), te = idx.slice(half);
    const model = fitter(tr.map((i) => X[i]), tr.map((i) => Y[i]));
    const pred = model.predict(te.map((i) => X[i]));
    const Yte = te.map((i) => Y[i]);
    const e = totalSquaredError(Yte, pred);
    const mean = columnMeans(tr.map((i) => Y[i]));
    errModel += e;
    errNull += totalSquaredError(Yte, Yte.map(() => mean));
    foldErrs.push(1 - e / totalSquaredError(Yte, Yte.map(() => mean)));
  }
  const r2 = 1 - errModel / errNull;
  // naive sd of per-fold R² for a rough sense of noise
  const m = foldErrs.reduce((a, b) => a + b, 0) / foldErrs.length;
  const sd = Math.sqrt(foldErrs.reduce((s, v) => s + (v - m) ** 2, 0) / (foldErrs.length - 1));
  return { r2, foldSd: sd / Math.sqrt(foldErrs.length) };
}

// ---------- timing probe ----------
console.log("calibration du coût d'un fit ARD optimisé...");
{
  const t0 = Date.now();
  const half = Math.floor(X.length / 2);
  fitOpt(X.slice(0, half), Y.slice(0, half), { ard: true });
  console.log(`  un fit ARD (5 coordonnées, n=${half}): ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ---------- run arms ----------
for (const [label, , fitter] of [
  ["A1 grille isotrope (prod.)", null, (Xtr, Ytr) => fitA1(Xtr, Ytr)],
  ["A2 isotrope + optimisation", null, (Xtr, Ytr) => fitOpt(Xtr, Ytr, { ard: false })],
  ["A3 ARD + optimisation", null, (Xtr, Ytr) => fitOpt(Xtr, Ytr, { ard: true })],
]) {
  const t0 = Date.now();
  const { r2, foldSd } = holdoutR2(fitter);
  console.log(`${label.padEnd(28)} R² multivarié = ${r2.toFixed(3)} ± ${(2 * foldSd).toFixed(3)}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

// ---------- inspect what ARD learns (full-data fit) ----------
console.log("\nlongueurs d'échelle ARD apprises (fit complet, coordonnée 0):");
{
  const scale = standardizer(X);
  const Xs = scale(X);
  const { names: baseNames } = buildFeatureMatrix(features2017);
  const featureNames = [...baseNames];
  for (let i = 0; i < 5; i++) featureNames.push(`prev_resid_ilr${i}`);

  // stage 1 grid then ARD optimize on coord 0
  const y = Y.map((r) => r[0]);
  let bestLs = null, bestAlpha = null, bestLml = -Infinity;
  for (const ls of LENGTH_SCALE_GRID) for (const alpha of NOISE_GRID) {
    const gp = new ml.GaussianProcessRegressor({ kernel: "matern", lengthScale: ls, nu: 1.5, alpha, normalizeY: true });
    gp.fit(Xs, y);
    if (gp.logMarginalLikelihood_ > bestLml) { bestLml = gp.logMarginalLikelihood_; bestLs = ls; bestAlpha = alpha; }
  }
  const gp = new ml.GaussianProcessRegressor({
    kernel: new ml.Matern({ lengthScale: Array(X[0].length).fill(bestLs), nu: 1.5 }),
    alpha: bestAlpha, normalizeY: true, optimize: true, nRestarts: 2,
  });
  gp.fit(Xs, y);
  const ls = gp.kernel.lengthScale;
  const ranked = featureNames.map((n, i) => [n, ls[i]]).sort((a, b) => a[1] - b[1]);
  console.log("  (petite échelle = caractéristique pertinente; grande = atténuée)");
  for (const [n, v] of ranked) console.log(`    ${n.padEnd(28)} ${v.toFixed(2)}`);
}