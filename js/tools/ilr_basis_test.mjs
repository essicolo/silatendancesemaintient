/**
 * Test: the ILR pivot basis as a discrete hyperparameter (five-agent
 * review, 2026-10-06, statistical critique #3).
 *
 * With one INDEPENDENT GP per coordinate, the model class depends on the
 * basis: tangent's cumulative pivot basis with the alphabetical order
 * puts AUTRES first, mixing it into all five coordinates (the Segma
 * incident), and no coordinate aligns with the axis that moves in a
 * realignment. The journal's planned "AUTRES last" reordering is treated
 * here as a TEST, not housekeeping: both bases get the same full
 * hyperparameter selection (lml over ls x ns x rho x dil per coordinate,
 * on the training window only) and are compared on the established
 * criterion -- eve-of-election nowcasts 2018/2022/2026.
 *
 * Bases: A = production (alphabetical: AUTRES first), B = AUTRES last
 * (CAQ, LIB, PCQ, PQ, QS, AUTRES).
 *
 * Run: node js/tools/ilr_basis_test.mjs   (from the repo root; ~5-10 min)
 */

import { readFileSync } from "node:fs";
import { ml, mva } from "@tangent.to/ds";
import { pivotPolls, toClosedComposition, ilrSamplingVariance } from "../src/compositional.js";
import { ChangepointKernel, toX } from "../src/gpTrend.js";

const { ilr, ilrInv } = mva.composition;

const LS = [30, 110, 330, 680, 1000, 1500, 2200];
const NS = [0.01, 0.02, 0.05, 0.1, 0.25, 1];
const RHO = [0.7, 1];
const DIL = [1, 8, 16];

const ELECTIONS = [
  { year: 2018, eve: "2018-09-30", day: "2018-10-01", actual: { CAQ: 37.42, LIB: 24.82, QS: 16.10, PQ: 17.06, PCQ: 1.46 } },
  { year: 2022, eve: "2022-10-02", day: "2022-10-03", actual: { CAQ: 40.98, LIB: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91 } },
  { year: 2026, eve: "2026-10-04", day: "2026-10-05", actual: { CAQ: 13.3453, LIB: 24.2157, QS: 12.4266, PQ: 28.0189, PCQ: 20.6691 } },
];

const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows); // alphabetical
const comp = toClosedComposition(polls, partyCodes);
const t0 = polls.reduce((m, p) => (p.pollDate < m ? p.pollDate : m), polls[0].pollDate);
const x = toX(t0, polls.map((p) => p.pollDate));

const BASES = {
  "A alphabetique (prod)": partyCodes,
  "B AUTRES dernier": [...partyCodes.filter((p) => p !== "AUTRES"), "AUTRES"],
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

for (const [label, order] of Object.entries(BASES)) {
  const perm = order.map((p) => partyCodes.indexOf(p));
  const compB = comp.map((row) => perm.map((i) => row[i]));
  const ilrMat = ilr(compB);
  const nCoord = ilrMat[0].length;
  const varC = ilrSamplingVariance(compB, polls.map((p) => p.sampleSize));
  const shapeC = varC.map((col) => { const m = Math.min(...col); return col.map((v) => v / m); });

  console.log(`\n### base ${label}`);
  let totalMae = 0;
  for (const e of ELECTIONS) {
    const idxs = polls.map((p, i) => [p, i]).filter(([p]) => p.pollDate <= e.eve).map(([, i]) => i);
    const xe = toX(t0, [e.day]);
    const ilrMean = [];
    for (let c = 0; c < nCoord; c++) {
      let best = null;
      for (const ls of LS) for (const ns of NS) for (const rho of RHO) for (const dil of DIL) {
        let gp;
        try {
          gp = new ml.GaussianProcessRegressor({
            kernel: new ChangepointKernel({ lengthScale: ls, rho, dilation: dil }),
            normalizeY: true,
          });
          gp.fit(idxs.map((i) => x[i]), idxs.map((i) => ilrMat[i][c]), {
            alpha: idxs.map((i) => shapeC[c][i] * ns),
          });
        } catch { continue; }
        if (!best || gp.logMarginalLikelihood_ > best.lml) best = { gp, lml: gp.logMarginalLikelihood_ };
      }
      ilrMean.push(best.gp.predict(xe)[0]);
    }
    const shareB = ilrInv([ilrMean])[0];
    const shares = Object.fromEntries(order.map((p, i) => [p, shareB[i]]));
    const pred = close5(shares);
    const mae = maeVs(pred, e.actual);
    totalMae += mae;
    console.log(`  ${e.year} : ${fmt(pred)}   MAE ${mae.toFixed(2)} pp`);
  }
  console.log(`  moyenne : ${(totalMae / ELECTIONS.length).toFixed(2)} pp`);
}
