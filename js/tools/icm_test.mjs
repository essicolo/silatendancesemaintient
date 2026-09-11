/**
 * Prototype: intrinsic coregionalization (ICM) for the national trend GP.
 *
 * Question: does modelling the CROSS-COORDINATE covariance of the ILR trend
 * (CAQ losses flowing to specific parties) earn its keep against the
 * production model of independent per-coordinate GPs? The earlier test that
 * plugged empirical residual correlations into the simulation was rejected;
 * ICM is the proper way to reopen the question, because the coupling matrix
 * B is estimated JOINTLY under the model by marginal likelihood.
 *
 * Model: vec(Y) ~ N(0, B (x) Kt + diag(kappa) (x) Dn), with Kt the
 * changepoint+campaign-dilated Matern-3/2 time kernel shared by all
 * coordinates, Dn the per-poll relative noise (1/sqrt(n) shape, as in
 * production), B a d x d PSD signal-coupling matrix and kappa per-coordinate
 * noise scales. All coordinates share the poll dates, so after whitening by
 * Dn and eigendecomposing the whitened Kt (= U L U'), the likelihood
 * factorises over eigenbranches s into d x d blocks lambda_s B + diag(kappa)
 * -- evaluating the marginal likelihood costs O(n d^3) instead of (nd)^3,
 * and B is optimized by Adam on its Cholesky factor in seconds.
 *
 * Three models, all on the SAME centred unnormalized ILR data (so their
 * marginal likelihoods are directly comparable):
 *   M0  independent per-coordinate GPs, EACH with its own time kernel
 *       (the production structure), scalar signal + noise per coordinate;
 *   M0' shared time kernel, B diagonal (isolates the cost of SHARING the
 *       kernel from the value of correlation);
 *   ICM shared time kernel, full B (rank-free Cholesky parameterization).
 * M0' is nested in ICM; the diagonal-B hypothesis stays on the table and
 * the evidence decides, per the project's rule.
 *
 * Run: node js/tools/icm_test.mjs   (from js/)
 */

import { readFileSync } from "node:fs";
import { core, mva } from "@tangent.to/ds";
import { pivotPolls, toClosedComposition, sampleSizeWeight } from "../src/compositional.js";
import { toX } from "../src/gpTrend.js";

const { eig, toMatrix } = core.linalg;
const { ilr } = mva.composition;

// ---- Data ------------------------------------------------------------------
const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows);
const ilrMat = ilr(toClosedComposition(polls, partyCodes));
const n = ilrMat.length, d = ilrMat[0].length;

const t0 = polls.reduce((m, p) => (p.pollDate < m ? p.pollDate : m), polls[0].pollDate);
const X = toX(t0, polls.map((p) => p.pollDate)); // [day, regime, campaignDays]

const w = sampleSizeWeight(polls);
const wMax = Math.max(...w);
const base = w.map((v) => 1 / Math.max(v / wMax, 0.05));
const bMin = Math.min(...base);
const relNoise = base.map((v) => v / bMin); // production shape: best poll = 1

// Centre each coordinate (means restored at prediction time; irrelevant here).
const Y = [];
for (let c = 0; c < d; c++) {
  const col = ilrMat.map((r) => r[c]);
  const mu = col.reduce((a, b) => a + b, 0) / n;
  Y.push(col.map((v) => v - mu));
}

// Whiten rows by relNoise: yTil = Dn^{-1/2} y. The Jacobian term
// d * sum(log relNoise) is common to every model and dropped.
const s2 = relNoise.map((v) => 1 / Math.sqrt(v));
const Yt = Y.map((col) => col.map((v, i) => v * s2[i]));

// ---- Time kernel (production form: dilated changepoint Matern-3/2) ---------
function ktMatrix(ls, rho, dil) {
  const K = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(n);
    for (let j = 0; j < n; j++) {
      const dt = (X[i][0] - X[j][0]) + (dil - 1) * (X[i][2] - X[j][2]);
      const s = (Math.sqrt(3) * Math.abs(dt)) / ls;
      row[j] = (1 + s) * Math.exp(-s) * Math.pow(rho, Math.abs(X[i][1] - X[j][1])) * s2[i] * s2[j];
    }
    K[i] = row;
  }
  return K; // already whitened: S Kt S
}

/** Eigendecompose whitened Kt and rotate the data: Z[s][c] = (U' yTil_c)_s. */
function branches(ls, rho, dil) {
  const { values, vectors } = eig(toMatrix(ktMatrix(ls, rho, dil)));
  const lam = values.map((v) => Math.max(v, 0));
  const Z = [];
  for (let s = 0; s < n; s++) {
    const z = new Array(d);
    for (let c = 0; c < d; c++) {
      let acc = 0;
      for (let i = 0; i < n; i++) acc += vectors.get(i, s) * Yt[c][i];
      z[c] = acc;
    }
    Z.push(z);
  }
  return { lam, Z };
}

// ---- Marginal likelihood over eigenbranches --------------------------------
/** lml (up to the common constant) for coupling B (d x d) and noise kappa. */
function lmlFull(lam, Z, B, kappa) {
  let ll = 0;
  const C = Array.from({ length: d }, () => new Array(d));
  for (let s = 0; s < n; s++) {
    for (let a = 0; a < d; a++) {
      for (let b = 0; b < d; b++) C[a][b] = lam[s] * B[a][b] + (a === b ? kappa[a] : 0);
    }
    // Cholesky of the 5x5 block, quad form + log det.
    const L = C.map((r) => r.slice());
    for (let a = 0; a < d; a++) {
      for (let b = 0; b <= a; b++) {
        let sum = L[a][b];
        for (let k = 0; k < b; k++) sum -= L[a][k] * L[b][k];
        if (a === b) {
          if (sum <= 1e-12) return -Infinity;
          L[a][a] = Math.sqrt(sum);
        } else L[a][b] = sum / L[b][b];
      }
    }
    const u = new Array(d);
    for (let a = 0; a < d; a++) {
      let sum = Z[s][a];
      for (let k = 0; k < a; k++) sum -= L[a][k] * u[k];
      u[a] = sum / L[a][a];
    }
    for (let a = 0; a < d; a++) ll += -0.5 * u[a] * u[a] - Math.log(L[a][a]);
  }
  return ll - 0.5 * n * d * Math.log(2 * Math.PI);
}

/** Scalar branch fit: one coordinate, signal b and noise kappa. */
function lmlScalar(lam, zc, b, kappa) {
  let ll = 0;
  for (let s = 0; s < zc.length; s++) {
    const v = lam[s] * b + kappa;
    ll += -0.5 * (zc[s] * zc[s]) / v - 0.5 * Math.log(v);
  }
  return ll - 0.5 * zc.length * Math.log(2 * Math.PI);
}

// ---- Optimizers ------------------------------------------------------------
function adam(f, theta0, { iters = 600, lr = 0.05 } = {}) {
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
      const g = (fp - fm) / (2 * eps); // ascent
      m[j] = 0.9 * m[j] + 0.1 * g;
      v[j] = 0.999 * v[j] + 0.001 * g * g;
      th[j] += (lr * m[j] / (1 - 0.9 ** t)) / (Math.sqrt(v[j] / (1 - 0.999 ** t)) + 1e-8);
    }
    const cur = f(th);
    if (cur > best) { best = cur; bestTh = th.slice(); }
  }
  return { value: best, theta: bestTh };
}

const scalarFit = (lam, zc) => {
  const f = (th) => lmlScalar(lam, zc, Math.exp(th[0]), Math.exp(th[1]));
  const varZ = zc.reduce((a, b) => a + b * b, 0) / zc.length;
  const r = adam(f, [Math.log(varZ / (lam.reduce((a, b) => a + b, 0) / lam.length) + 1e-6), Math.log(varZ / 2 + 1e-6)], { iters: 300, lr: 0.1 });
  return { lml: r.value, b: Math.exp(r.theta[0]), kappa: Math.exp(r.theta[1]) };
};

// theta = [lower-tri L of B (diag as log), log kappa]
const nL = (d * (d + 1)) / 2;
function unpack(theta) {
  const L = Array.from({ length: d }, () => new Array(d).fill(0));
  let idx = 0;
  for (let a = 0; a < d; a++) for (let b = 0; b <= a; b++) L[a][b] = a === b ? Math.exp(theta[idx++]) : theta[idx++];
  const B = Array.from({ length: d }, (_, a) =>
    Array.from({ length: d }, (_, b) => {
      let acc = 0;
      for (let k = 0; k < d; k++) acc += L[a][k] * L[b][k];
      return acc;
    }));
  const kappa = theta.slice(nL).map(Math.exp);
  return { B, kappa };
}

// ---- Model comparison ------------------------------------------------------
const LS = [230, 330, 470, 680, 1000, 1500, 2200];
const RHO = [0.4, 0.7, 1];
const DIL = [1, 4, 8, 16];

console.log(`${n} sondages, ${d} coordonnees ILR — grille ${LS.length * RHO.length * DIL.length} noyaux temps`);
const t0ms = Date.now();

// Pass 1: per-config eigen + per-coordinate scalar fits.
// This yields M0 (each coordinate takes its own best config) and M0'
// (one shared config, diagonal B), and ranks configs for the ICM pass.
const configs = [];
for (const ls of LS) for (const rho of RHO) for (const dil of DIL) {
  const { lam, Z } = branches(ls, rho, dil);
  const per = [];
  for (let c = 0; c < d; c++) per.push(scalarFit(lam, Z.map((z) => z[c])));
  configs.push({ ls, rho, dil, lam, Z, per, sum: per.reduce((a, r) => a + r.lml, 0) });
}
console.log(`passe 1 (eigen + scalaires) : ${((Date.now() - t0ms) / 1000).toFixed(0)} s`);

// M0: per coordinate, best config independently.
let m0 = 0;
const m0Detail = [];
for (let c = 0; c < d; c++) {
  let bc = null;
  for (const cf of configs) if (!bc || cf.per[c].lml > bc.lml) bc = { ...cf.per[c], ls: cf.ls, rho: cf.rho, dil: cf.dil };
  m0 += bc.lml;
  m0Detail.push(bc);
}
console.log("\nM0  (independants, noyaux propres)      lml =", m0.toFixed(1));
m0Detail.forEach((b, c) => console.log(`    coord ${c}: ls=${b.ls} rho=${b.rho} k=${b.dil}`));

// M0': best single shared config with diagonal B.
const m0p = configs.reduce((a, b) => (b.sum > a.sum ? b : a));
console.log(`M0' (noyau partage ls=${m0p.ls} rho=${m0p.rho} k=${m0p.dil}, B diagonale) lml = ${m0p.sum.toFixed(1)}`);

// Pass 2: full-B ICM on the top configs by M0' score.
const top = [...configs].sort((a, b) => b.sum - a.sum).slice(0, 6);
let icm = null;
for (const cf of top) {
  const f = (th) => {
    const { B, kappa } = unpack(th);
    return lmlFull(cf.lam, cf.Z, B, kappa);
  };
  // Init at the diagonal solution of this config.
  const th0 = [];
  for (let a = 0; a < d; a++) for (let b = 0; b <= a; b++) th0.push(a === b ? 0.5 * Math.log(cf.per[a].b) : 0);
  for (let c = 0; c < d; c++) th0.push(Math.log(cf.per[c].kappa));
  const r = adam(f, th0, { iters: 700, lr: 0.04 });
  if (!icm || r.value > icm.lml) icm = { lml: r.value, theta: r.theta, cf };
}
console.log(`passe 2 (ICM, ${top.length} noyaux)          : ${((Date.now() - t0ms) / 1000).toFixed(0)} s`);

const { B, kappa } = unpack(icm.theta);
console.log(`\nICM (noyau partage ls=${icm.cf.ls} rho=${icm.cf.rho} k=${icm.cf.dil}, B pleine)  lml = ${icm.lml.toFixed(1)}`);
console.log("\n  Delta lml  ICM - M0  =", (icm.lml - m0).toFixed(1));
console.log("  Delta lml  ICM - M0' =", (icm.lml - m0p.sum).toFixed(1));
console.log("  Delta lml  M0  - M0' =", (m0 - m0p.sum).toFixed(1), "(cout du noyau partage)");

console.log("\nMatrice de correlation implicite de B :");
for (let a = 0; a < d; a++) {
  console.log("  " + Array.from({ length: d }, (_, b) =>
    (B[a][b] / Math.sqrt(B[a][a] * B[b][b])).toFixed(2).padStart(6)).join(" "));
}
console.log("\nParts de variance signal (diag B / (diag B + kappa)) :");
console.log("  " + Array.from({ length: d }, (_, c) => (B[c][c] / (B[c][c] + kappa[c])).toFixed(2)).join("  "));
