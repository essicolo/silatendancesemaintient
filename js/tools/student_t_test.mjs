/**
 * Test: Student-t observation likelihood for the trend GP.
 *
 * The Gaussian likelihood gives an observation unbounded influence: the
 * final Mainstreet 2026 poll (CAQ 20, n=2011) anchored the nowcast at
 * CAQ 18 against the 14-15 of the other final polls. A Student-t
 * likelihood is the scale-mixture extension: latent per-observation
 * precision lambda_i ~ Gamma(nu/2, nu/2), estimated by EM on top of the
 * Gaussian GP machinery -- each iteration refits with observation
 * variance alpha0_i / w_i where w_i = (nu+1)/(nu + z_i^2) and z_i is the
 * standardized residual. nu = Inf recovers the production Gaussian
 * exactly (all w_i = 1, zero iterations needed); nu = 1 is Cauchy.
 *
 * Non-likelihood hyperparameters are fixed at the production top choice
 * per coordinate, isolating the likelihood change. Validation, per
 * doctrine: eve-of-election nowcast vs official result on the three
 * campaign endings in the data (2018, 2022, 2026), MAE over the five
 * main parties closed. The weights given to the final-week polls are
 * printed for the selected nu.
 *
 * Run: node js/tools/student_t_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { ml, mva } from "@tangent.to/ds";
import { pivotPolls, toClosedComposition, ilrSamplingVariance } from "../src/compositional.js";
import { ChangepointKernel, toX } from "../src/gpTrend.js";

const { ilr, ilrInv } = mva.composition;

const HYPER = [
  { ls: 680, ns: 0.1, rho: 0.7, dil: 16 },
  { ls: 330, ns: 0.02, rho: 0.7, dil: 8 },
  { ls: 1000, ns: 0.01, rho: 1, dil: 8 },
  { ls: 680, ns: 0.02, rho: 1, dil: 16 },
  { ls: 330, ns: 0.1, rho: 1, dil: 8 },
];
const NU_GRID = [1, 2, 4, 8, 16, Infinity];
const EM_ITER = 5;

const ELECTIONS = [
  { year: 2018, eve: "2018-09-30", day: "2018-10-01", actual: { CAQ: 37.42, LIB: 24.82, QS: 16.10, PQ: 17.06, PCQ: 1.46 } },
  { year: 2022, eve: "2022-10-02", day: "2022-10-03", actual: { CAQ: 40.98, LIB: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91 } },
  { year: 2026, eve: "2026-10-04", day: "2026-10-05", actual: { CAQ: 13.3453, LIB: 24.2157, QS: 12.4266, PQ: 28.0189, PCQ: 20.6691 } },
];

const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows);
const comp = toClosedComposition(polls, partyCodes);
const ilrMat = ilr(comp);
const nCoord = ilrMat[0].length;
const t0 = polls.reduce((m, p) => (p.pollDate < m ? p.pollDate : m), polls[0].pollDate);
const x = toX(t0, polls.map((p) => p.pollDate));

const varC = ilrSamplingVariance(comp, polls.map((p) => p.sampleSize));
const shapeC = varC.map((col) => { const m = Math.min(...col); return col.map((v) => v / m); });

const fitGaussian = (idxs, c, alpha) => {
  const gp = new ml.GaussianProcessRegressor({
    kernel: new ChangepointKernel({ lengthScale: HYPER[c].ls, rho: HYPER[c].rho, dilation: HYPER[c].dil }),
    normalizeY: true,
  });
  gp.fit(idxs.map((i) => x[i]), idxs.map((i) => ilrMat[i][c]), { alpha });
  return gp;
};

/** EM fit with Student-t observation noise; returns {gp, w} (final weights). */
function fitT(idxs, c, nu) {
  const alpha0 = idxs.map((i) => shapeC[c][i] * HYPER[c].ns);
  let w = idxs.map(() => 1);
  let gp = fitGaussian(idxs, c, alpha0);
  if (!Number.isFinite(nu)) return { gp, w };
  for (let it = 0; it < EM_ITER; it++) {
    const pred = gp.predict(idxs.map((i) => x[i]));
    const yStd = gp._yStd ?? 1, yMean = gp._yMean ?? 0;
    w = idxs.map((i, k) => {
      const rNorm = (ilrMat[i][c] - pred[k]) / yStd;
      const z2 = (rNorm * rNorm) / alpha0[k];
      return (nu + 1) / (nu + z2);
    });
    gp = fitGaussian(idxs, c, alpha0.map((a, k) => a / w[k]));
  }
  return { gp, w };
}

const close5 = (o) => {
  const main = ["CAQ", "LIB", "QS", "PQ", "PCQ"];
  const t = main.reduce((s, p) => s + o[p], 0);
  return Object.fromEntries(main.map((p) => [p, (o[p] / t) * 100]));
};
const maeVs = (pred, actual) => {
  const a = close5(actual);
  return Object.keys(a).reduce((s, p) => s + Math.abs(pred[p] - a[p]), 0) / 5;
};
const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v.toFixed(1)}`).join("  ");

const results = {}; // nu -> {year: {mae, pred}}
const weightsFinal = {}; // nu -> per-poll mean weight (2026 train, final week)
for (const nu of NU_GRID) {
  results[nu] = {};
  for (const e of ELECTIONS) {
    const idxs = polls.map((p, i) => [p, i]).filter(([p]) => p.pollDate <= e.eve).map(([, i]) => i);
    const ilrMean = [];
    const wByCoord = [];
    for (let c = 0; c < nCoord; c++) {
      const { gp, w } = fitT(idxs, c, nu);
      ilrMean.push(gp.predict(toX(t0, [e.day]))[0]);
      wByCoord.push(w);
    }
    const share = ilrInv([ilrMean])[0];
    const pred = close5(Object.fromEntries(partyCodes.map((p, i) => [p, share[i]])));
    results[nu][e.year] = { mae: maeVs(pred, e.actual), pred };
    if (e.year === 2026) {
      weightsFinal[nu] = idxs
        .map((i, k) => ({ i, wMean: wByCoord.reduce((s, w) => s + w[k], 0) / nCoord }))
        .filter(({ i }) => polls[i].pollDate >= "2026-09-26")
        .map(({ i, wMean }) => `${polls[i].pollDate} ${polls[i].firm}: ${wMean.toFixed(2)}`);
    }
  }
}

console.log("MAE du nowcast de veille de scrutin (pp, 5 partis fermes) :\n");
console.log("  nu      2018    2022    2026    moyenne");
for (const nu of NU_GRID) {
  const m = ELECTIONS.map((e) => results[nu][e.year].mae);
  const label = Number.isFinite(nu) ? String(nu) : "inf (prod)";
  console.log(`  ${label.padEnd(10)}${m.map((v) => v.toFixed(2).padStart(6)).join("  ")}  ${(m.reduce((a, b) => a + b, 0) / 3).toFixed(2).padStart(7)}`);
}

console.log("\nnowcast 2026 par nu :");
for (const nu of NU_GRID) {
  const label = Number.isFinite(nu) ? `nu=${nu}` : "gaussien";
  console.log(`  ${label.padEnd(10)}: ${fmt(results[nu][2026].pred)}`);
}
console.log(`  officiel  : ${fmt(close5(ELECTIONS[2].actual))}`);

console.log("\npoids EM moyens (sur les 5 coordonnees) des sondages depuis le 26 sept, par nu :");
for (const nu of NU_GRID.filter(Number.isFinite)) {
  console.log(`  nu=${nu} :`);
  for (const l of weightsFinal[nu]) console.log(`    ${l}`);
}
