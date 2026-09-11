/**
 * Predictive validation of the ICM prototype (see icm_test.mjs): 5-fold
 * cross-validation over polls, comparing the coregionalized model against
 * the production structure (independent per-coordinate GPs, own kernels) on
 * held-out 90% interval coverage and mean predictive log-likelihood per
 * observation. The marginal-likelihood comparison favoured ICM by +7 nats;
 * this is the out-of-sample check the project requires before anything
 * reaches production.
 *
 * Both models use the hyperkernels selected on the FULL data (a symmetric,
 * documented optimism); B, kappa and the per-coordinate scalars are refit
 * inside each training fold.
 *
 * Run: node js/tools/icm_cv.mjs   (from js/)
 */

import { readFileSync } from "node:fs";
import { core, mva } from "@tangent.to/ds";
import { pivotPolls, toClosedComposition, sampleSizeWeight } from "../src/compositional.js";
import { toX } from "../src/gpTrend.js";

const { eig, toMatrix } = core.linalg;
const { ilr } = mva.composition;

const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows);
const ilrMat = ilr(toClosedComposition(polls, partyCodes));
const n = ilrMat.length, d = ilrMat[0].length;
const t0 = polls.reduce((m, p) => (p.pollDate < m ? p.pollDate : m), polls[0].pollDate);
const X = toX(t0, polls.map((p) => p.pollDate));
const w = sampleSizeWeight(polls);
const wMax = Math.max(...w);
const base = w.map((v) => 1 / Math.max(v / wMax, 0.05));
const bMin = Math.min(...base);
const relNoise = base.map((v) => v / bMin);
const s2 = relNoise.map((v) => 1 / Math.sqrt(v));

// Hyperkernels selected on the full data (icm_test.mjs output).
const ICM_K = { ls: 470, rho: 1, dil: 8 };
const M0_K = [
  { ls: 230, rho: 0.4, dil: 16 },
  { ls: 330, rho: 1, dil: 8 },
  { ls: 1000, rho: 1, dil: 8 },
  { ls: 680, rho: 1, dil: 16 },
  { ls: 230, rho: 1, dil: 8 },
];

const kt = (a, b, { ls, rho, dil }) => {
  const dt = (X[a][0] - X[b][0]) + (dil - 1) * (X[a][2] - X[b][2]);
  const s = (Math.sqrt(3) * Math.abs(dt)) / ls;
  return (1 + s) * Math.exp(-s) * Math.pow(rho, Math.abs(X[a][1] - X[b][1]));
};

function branchesOf(tr, cfg, Yc) {
  const m = tr.length;
  const K = [];
  for (let i = 0; i < m; i++) {
    const row = new Array(m);
    for (let j = 0; j < m; j++) row[j] = kt(tr[i], tr[j], cfg) * s2[tr[i]] * s2[tr[j]];
    K[i] = row;
  }
  const { values, vectors } = eig(toMatrix(K));
  const lam = values.map((v) => Math.max(v, 0));
  const Z = [];
  for (let s = 0; s < m; s++) {
    const z = new Array(Yc.length);
    for (let c = 0; c < Yc.length; c++) {
      let acc = 0;
      for (let i = 0; i < m; i++) acc += vectors.get(i, s) * Yc[c][i] * s2[tr[i]];
      z[c] = acc;
    }
    Z.push(z);
  }
  return { lam, U: vectors, Z };
}

function chol5(C) {
  const m = C.length;
  const L = C.map((r) => r.slice());
  for (let a = 0; a < m; a++) {
    for (let b = 0; b <= a; b++) {
      let sum = L[a][b];
      for (let k = 0; k < b; k++) sum -= L[a][k] * L[b][k];
      if (a === b) { if (sum <= 1e-12) return null; L[a][a] = Math.sqrt(sum); }
      else L[a][b] = sum / L[b][b];
    }
  }
  return L;
}
const solveChol = (L, y) => {
  const m = y.length;
  const u = new Array(m);
  for (let a = 0; a < m; a++) { let s = y[a]; for (let k = 0; k < a; k++) s -= L[a][k] * u[k]; u[a] = s / L[a][a]; }
  const x = new Array(m);
  for (let a = m - 1; a >= 0; a--) { let s = u[a]; for (let k = a + 1; k < m; k++) s -= L[k][a] * x[k]; x[a] = s / L[a][a]; }
  return x;
};

function lmlFull(lam, Z, B, kappa) {
  let ll = 0;
  for (let s = 0; s < lam.length; s++) {
    const C = B.map((r, a) => r.map((v, b) => lam[s] * v + (a === b ? kappa[a] : 0)));
    const L = chol5(C);
    if (!L) return -Infinity;
    const u = new Array(d);
    for (let a = 0; a < d; a++) { let sm = Z[s][a]; for (let k = 0; k < a; k++) sm -= L[a][k] * u[k]; u[a] = sm / L[a][a]; }
    for (let a = 0; a < d; a++) ll += -0.5 * u[a] * u[a] - Math.log(L[a][a]);
  }
  return ll;
}

function adam(f, theta0, { iters = 500, lr = 0.05 } = {}) {
  const th = theta0.slice();
  const m = th.map(() => 0), v = th.map(() => 0);
  const eps = 1e-4;
  let best = f(th), bestTh = th.slice();
  for (let t = 1; t <= iters; t++) {
    for (let j = 0; j < th.length; j++) {
      const keep = th[j];
      th[j] = keep + eps; const fp = f(th);
      th[j] = keep - eps; const fm = f(th);
      th[j] = keep;
      const g = (fp - fm) / (2 * eps);
      m[j] = 0.9 * m[j] + 0.1 * g;
      v[j] = 0.999 * v[j] + 0.001 * g * g;
      th[j] += (lr * m[j] / (1 - 0.9 ** t)) / (Math.sqrt(v[j] / (1 - 0.999 ** t)) + 1e-8);
    }
    const cur = f(th);
    if (cur > best) { best = cur; bestTh = th.slice(); }
  }
  return bestTh;
}

const nLtri = (d * (d + 1)) / 2;
function unpack(theta) {
  const L = Array.from({ length: d }, () => new Array(d).fill(0));
  let idx = 0;
  for (let a = 0; a < d; a++) for (let b = 0; b <= a; b++) L[a][b] = a === b ? Math.exp(theta[idx++]) : theta[idx++];
  const B = Array.from({ length: d }, (_, a) => Array.from({ length: d }, (_, b) => {
    let acc = 0; for (let k = 0; k < d; k++) acc += L[a][k] * L[b][k]; return acc;
  }));
  return { B, kappa: theta.slice(nLtri).map(Math.exp) };
}

// ---- 5-fold CV -------------------------------------------------------------
let state = 20260911;
const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff), state / 0x7fffffff);
const idx = Array.from({ length: n }, (_, i) => i);
for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
const K = 5;
const folds = Array.from({ length: K }, (_, k) => idx.filter((_, i) => i % K === k));
const Z90 = 1.6449;

const stats = {
  icm: { inside: 0, total: 0, ll: 0 },
  m0: { inside: 0, total: 0, ll: 0 },
};

for (const test of folds) {
  const testSet = new Set(test);
  const tr = idx.filter((i) => !testSet.has(i)).sort((a, b) => a - b);
  const mu = [];
  const Yc = [];
  for (let c = 0; c < d; c++) {
    const col = tr.map((i) => ilrMat[i][c]);
    const m = col.reduce((a, b) => a + b, 0) / col.length;
    mu.push(m);
    Yc.push(tr.map((i) => ilrMat[i][c] - m));
  }

  // ---- ICM: refit B, kappa on the fold ----
  {
    const { lam, U, Z } = branchesOf(tr, ICM_K, Yc);
    const varc = Yc.map((col) => col.reduce((a, b) => a + b * b, 0) / col.length);
    const th0 = [];
    for (let a = 0; a < d; a++) for (let b = 0; b <= a; b++) th0.push(a === b ? 0.5 * Math.log(varc[a] * 0.7 + 1e-6) : 0);
    for (let c = 0; c < d; c++) th0.push(Math.log(varc[c] * 0.3 + 1e-6));
    const th = adam((t) => { const { B, kappa } = unpack(t); return lmlFull(lam, Z, B, kappa); }, th0, { iters: 600, lr: 0.05 });
    const { B, kappa } = unpack(th);

    // Precompute w_s = (lam_s B + kappa)^{-1} z_s and M_s = B C_s^{-1} B.
    const m = tr.length;
    const ws = [], Ms = [];
    for (let s = 0; s < m; s++) {
      const C = B.map((r, a) => r.map((v, b) => lam[s] * v + (a === b ? kappa[a] : 0)));
      const L = chol5(C);
      ws.push(solveChol(L, Z[s]));
      const M = Array.from({ length: d }, () => new Array(d).fill(0));
      for (let col = 0; col < d; col++) {
        const x = solveChol(L, B.map((r) => r[col])); // C^{-1} B[:,col]
        for (let a = 0; a < d; a++) { let acc = 0; for (let k = 0; k < d; k++) acc += B[a][k] * x[k]; M[a][col] = acc; }
      }
      Ms.push(M);
    }

    for (const i of test) {
      const ktr = tr.map((j) => kt(i, j, ICM_K) * s2[j]);
      const a = new Array(m);
      for (let s = 0; s < m; s++) { let acc = 0; for (let j = 0; j < m; j++) acc += U.get(j, s) * ktr[j]; a[s] = acc; }
      const kss = kt(i, i, ICM_K);
      for (let c = 0; c < d; c++) {
        let mean = 0, expl = 0;
        for (let s = 0; s < m; s++) {
          let bw = 0;
          for (let k = 0; k < d; k++) bw += B[c][k] * ws[s][k];
          mean += a[s] * bw;
          expl += a[s] * a[s] * Ms[s][c][c];
        }
        const varLat = Math.max(kss * B[c][c] - expl, 1e-10);
        const varObs = varLat + kappa[c] * relNoise[i];
        const y = ilrMat[i][c] - mu[c];
        stats.icm.total++;
        if (Math.abs(y - mean) <= Z90 * Math.sqrt(varObs)) stats.icm.inside++;
        stats.icm.ll += -0.5 * Math.log(2 * Math.PI * varObs) - 0.5 * (y - mean) ** 2 / varObs;
      }
    }
  }

  // ---- M0: per coordinate, own kernel, scalar refit ----
  for (let c = 0; c < d; c++) {
    const { lam, U, Z } = branchesOf(tr, M0_K[c], [Yc[c]]);
    const zc = Z.map((z) => z[0]);
    const varc = Yc[c].reduce((a, b) => a + b * b, 0) / Yc[c].length;
    const th = adam((t) => {
      const b = Math.exp(t[0]), k2 = Math.exp(t[1]);
      let ll = 0;
      for (let s = 0; s < zc.length; s++) { const v = lam[s] * b + k2; ll += -0.5 * zc[s] * zc[s] / v - 0.5 * Math.log(v); }
      return ll;
    }, [Math.log(varc * 0.7 + 1e-6), Math.log(varc * 0.3 + 1e-6)], { iters: 300, lr: 0.1 });
    const b = Math.exp(th[0]), k2 = Math.exp(th[1]);
    const m = tr.length;
    const wsc = lam.map((l, s) => zc[s] / (l * b + k2));

    for (const i of test) {
      const ktr = tr.map((j) => kt(i, j, M0_K[c]) * s2[j]);
      const a = new Array(m);
      for (let s = 0; s < m; s++) { let acc = 0; for (let j = 0; j < m; j++) acc += U.get(j, s) * ktr[j]; a[s] = acc; }
      let mean = 0, expl = 0;
      for (let s = 0; s < m; s++) { mean += a[s] * b * wsc[s]; expl += a[s] * a[s] * b * b / (lam[s] * b + k2); }
      const varLat = Math.max(kt(i, i, M0_K[c]) * b - expl, 1e-10);
      const varObs = varLat + k2 * relNoise[i];
      const y = ilrMat[i][c] - mu[c];
      stats.m0.total++;
      if (Math.abs(y - mean) <= Z90 * Math.sqrt(varObs)) stats.m0.inside++;
      stats.m0.ll += -0.5 * Math.log(2 * Math.PI * varObs) - 0.5 * (y - mean) ** 2 / varObs;
    }
  }
  console.log(`  pli termine (${test.length} sondages)`);
}

console.log(`\nCouverture 90 % :  ICM ${(100 * stats.icm.inside / stats.icm.total).toFixed(1)} %` +
  `   M0 ${(100 * stats.m0.inside / stats.m0.total).toFixed(1)} %`);
console.log(`Log-vraisemblance predictive / observation :  ICM ${(stats.icm.ll / stats.icm.total).toFixed(4)}` +
  `   M0 ${(stats.m0.ll / stats.m0.total).toFixed(4)}`);
console.log(`Delta total (ICM - M0) : ${(stats.icm.ll - stats.m0.ll).toFixed(1)} nats sur ${stats.icm.total} observations`);
