/**
 * Test: RANDOM-WALK (Wiener) kernel family in the trend ensemble
 * (five-agent review, 2026-10-06, external critique #3).
 *
 * Every nowcast formulation tested in the post-mortem was a variant of
 * the stationary Matern averager, which reverts to the recent-past level
 * at the series edge -- the mechanical cause of the CAQ lag. The
 * state-space standard (Jackman 2005, Linzer 2013) is a random walk: no
 * mean reversion, and at the edge its posterior is precision-weighted
 * recent polls. In GP terms that is the Wiener kernel
 *
 *   k(a,b) = sigma_w^2 * min(w(a), w(b)) * rho^|regime difference|,
 *
 * with w(t) the dilated campaign clock (inherited mechanism). Candidates
 * join the ensemble by marginal likelihood exactly like rho and the
 * dilation; the production Matern cell stays on the grid, so this is a
 * null-on-grid test at the FAMILY level.
 *
 * Variants compared on the eve-of-election nowcasts 2018/2022/2026:
 *   matern  : production top cell (the 8-times-tested baseline)
 *   wiener  : best Wiener cell by lml
 *   ensemble: lml-weighted mixture of both families.
 *
 * Run: node js/tools/wiener_test.mjs   (from the repo root)
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
const SIGW2 = [1e-4, 3e-4, 1e-3, 3e-3, 1e-2]; // per dilated day, normalized-y units
const RHO_W = [0.7, 1];
const DIL_W = [1, 8, 16];

class WienerKernel extends ml.Kernel {
  constructor({ s2 = 1e-3, rho = 1, dil = 1 } = {}) {
    super();
    this.s2 = s2; this.rho = rho; this.dil = dil;
  }
  compute(a, b) {
    const wa = (a[0] + 1) + (this.dil - 1) * a[2];
    const wb = (b[0] + 1) + (this.dil - 1) * b[2];
    return this.s2 * Math.min(wa, wb) * Math.pow(this.rho, Math.abs(a[1] - b[1]));
  }
  getParams() { return { s2: this.s2, rho: this.rho, dil: this.dil }; }
}

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

const fitK = (idxs, c, kernel) => {
  const gp = new ml.GaussianProcessRegressor({ kernel, normalizeY: true });
  gp.fit(idxs.map((i) => x[i]), idxs.map((i) => ilrMat[i][c]), {
    alpha: idxs.map((i) => shapeC[c][i] * HYPER[c].ns),
  });
  return gp;
};

const close5 = (o) => {
  const main = ["CAQ", "LIB", "QS", "PQ", "PCQ"];
  const t = main.reduce((s, p) => s + o[p], 0);
  return Object.fromEntries(main.map((p) => [p, (o[p] / t) * 100]));
};
const maeVs = (pred, act) => {
  const a = close5(act);
  return Object.keys(a).reduce((s, p) => s + Math.abs(pred[p] - a[p]), 0) / 5;
};
const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v.toFixed(1)}`).join("  ");

for (const e of ELECTIONS) {
  const idxs = polls.map((p, i) => [p, i]).filter(([p]) => p.pollDate <= e.eve).map(([, i]) => i);
  const xe = toX(t0, [e.day]);
  const preds = { matern: [], wiener: [], ensemble: [] };
  const picks = [];
  for (let c = 0; c < nCoord; c++) {
    const mat = fitK(idxs, c, new ChangepointKernel({ lengthScale: HYPER[c].ls, rho: HYPER[c].rho, dilation: HYPER[c].dil }));
    const cands = [{ gp: mat, lml: mat.logMarginalLikelihood_, label: "matern" }];
    for (const s2 of SIGW2) for (const rho of RHO_W) for (const dil of DIL_W) {
      try {
        const gp = fitK(idxs, c, new WienerKernel({ s2, rho, dil }));
        cands.push({ gp, lml: gp.logMarginalLikelihood_, label: `wiener s2=${s2} rho=${rho} dil=${dil}` });
      } catch { /* non-PSD cell */ }
    }
    const bestW = cands.filter((cd) => cd.label !== "matern").reduce((a, b) => (b.lml > a.lml ? b : a));
    const lmax = Math.max(...cands.map((cd) => cd.lml));
    const ws = cands.map((cd) => Math.exp(cd.lml - lmax));
    const wsum = ws.reduce((a, b) => a + b, 0);
    const mix = cands.reduce((s, cd, i) => s + (ws[i] / wsum) * cd.gp.predict(xe)[0], 0);
    preds.matern.push(mat.predict(xe)[0]);
    preds.wiener.push(bestW.gp.predict(xe)[0]);
    preds.ensemble.push(mix);
    const wWiener = cands.reduce((s, cd, i) => s + (cd.label !== "matern" ? ws[i] / wsum : 0), 0);
    picks.push(`c${c}: dlml ${(bestW.lml - mat.logMarginalLikelihood_).toFixed(1)}, poids wiener ${(wWiener * 100).toFixed(0)}%`);
  }
  console.log(`\n=== ${e.year}  (officiel : ${fmt(close5(e.actual))})`);
  for (const [label, ilrMean] of Object.entries(preds)) {
    const share = ilrInv([ilrMean])[0];
    const pred = close5(Object.fromEntries(partyCodes.map((p, i) => [p, share[i]])));
    console.log(`  ${label.padEnd(9)} : ${fmt(pred)}   MAE ${maeVs(pred, e.actual).toFixed(2)} pp`);
  }
  console.log(`  ${picks.join(" | ")}`);
}
