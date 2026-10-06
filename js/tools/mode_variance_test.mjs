/**
 * Test: observation variance by COLLECTION MODE (five-agent review,
 * 2026-10-06, data critique #1).
 *
 * The production noise model gives every poll the multinomial ILR
 * variance x one shared overdispersion scale: an IVR n=2011 weighs twice
 * a web panel n=1000, the opposite of the measured quality ordering
 * (final 2026: Leger web 0.90 MAE, Mainstreet IVR 2.80). Per-FIRM
 * variances were uninformative (18 firms); per-MODE is 2 free parameters
 * (web = reference, multipliers on the SD for ivr and tel), null = 1.
 *
 * Selection by summed marginal likelihood on the full series, validation
 * on the eve-of-election nowcasts 2018/2022/2026 (the established
 * criterion), with the small-effect caveat from power_check.mjs stated:
 * at these sizes the eve test is weakly powered, so the lml verdict and
 * the SIGN consistency across the three elections carry the decision.
 *
 * Run: node js/tools/mode_variance_test.mjs   (from the repo root)
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
const M_GRID = [0.7, 1, 1.4, 2]; // SD multipliers for ivr and tel (web = 1)

const ELECTIONS = [
  { year: 2018, eve: "2018-09-30", day: "2018-10-01", actual: { CAQ: 37.42, LIB: 24.82, QS: 16.10, PQ: 17.06, PCQ: 1.46 } },
  { year: 2022, eve: "2022-10-02", day: "2022-10-03", actual: { CAQ: 40.98, LIB: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91 } },
  { year: 2026, eve: "2026-10-04", day: "2026-10-05", actual: { CAQ: 13.3453, LIB: 24.2157, QS: 12.4266, PQ: 28.0189, PCQ: 20.6691 } },
];

const modes = JSON.parse(readFileSync(new URL("../data/qc_firm_modes.json", import.meta.url), "utf-8")).modes;
const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows);
const comp = toClosedComposition(polls, partyCodes);
const ilrMat = ilr(comp);
const nCoord = ilrMat[0].length;
const t0 = polls.reduce((m, p) => (p.pollDate < m ? p.pollDate : m), polls[0].pollDate);
const x = toX(t0, polls.map((p) => p.pollDate));
const varC = ilrSamplingVariance(comp, polls.map((p) => p.sampleSize));
const shapeC = varC.map((col) => { const m = Math.min(...col); return col.map((v) => v / m); });
const modeOf = polls.map((p) => modes[p.firm] ?? "web");
const counts = modeOf.reduce((a, m) => ((a[m] = (a[m] ?? 0) + 1), a), {});
console.log("sondages par mode :", JSON.stringify(counts));

const fitAll = (idxs, c, mIvr, mTel) => {
  const mult = (i) => {
    const m = modeOf[i] === "ivr" ? mIvr : modeOf[i] === "tel" ? mTel : 1;
    return m * m;
  };
  const gp = new ml.GaussianProcessRegressor({
    kernel: new ChangepointKernel({ lengthScale: HYPER[c].ls, rho: HYPER[c].rho, dilation: HYPER[c].dil }),
    normalizeY: true,
  });
  gp.fit(idxs.map((i) => x[i]), idxs.map((i) => ilrMat[i][c]), {
    alpha: idxs.map((i) => shapeC[c][i] * HYPER[c].ns * mult(i)),
  });
  return gp;
};

// --- selection by summed lml on the full series --------------------------
const allIdx = polls.map((_, i) => i);
let best = null;
console.log("\nlml sommee (5 coordonnees), delta vs (1,1) :");
const base = Array.from({ length: nCoord }, (_, c) => fitAll(allIdx, c, 1, 1).logMarginalLikelihood_).reduce((a, b) => a + b, 0);
for (const mIvr of M_GRID) {
  const line = [];
  for (const mTel of M_GRID) {
    const lml = Array.from({ length: nCoord }, (_, c) => fitAll(allIdx, c, mIvr, mTel).logMarginalLikelihood_).reduce((a, b) => a + b, 0);
    line.push(`tel=${mTel}: ${(lml - base) >= 0 ? "+" : ""}${(lml - base).toFixed(1)}`);
    if (!best || lml > best.lml) best = { lml, mIvr, mTel };
  }
  console.log(`  ivr=${mIvr} : ${line.join("  ")}`);
}
console.log(`retenu par lml : ivr=${best.mIvr}, tel=${best.mTel}`);

// --- validation: eve nowcasts ---------------------------------------------
const close5 = (o) => {
  const main = ["CAQ", "LIB", "QS", "PQ", "PCQ"];
  const t = main.reduce((s, p) => s + o[p], 0);
  return Object.fromEntries(main.map((p) => [p, (o[p] / t) * 100]));
};
const maeVs = (pred, act) => {
  const a = close5(act);
  return Object.keys(a).reduce((s, p) => s + Math.abs(pred[p] - a[p]), 0) / 5;
};

console.log("\nnowcasts de veille (MAE pp) :");
for (const e of ELECTIONS) {
  const idxs = polls.map((p, i) => [p, i]).filter(([p]) => p.pollDate <= e.eve).map(([, i]) => i);
  const xe = toX(t0, [e.day]);
  const nc = (mIvr, mTel) => {
    const v = Array.from({ length: nCoord }, (_, c) => fitAll(idxs, c, mIvr, mTel).predict(xe)[0]);
    const share = ilrInv([v])[0];
    return close5(Object.fromEntries(partyCodes.map((p, i) => [p, share[i]])));
  };
  const m0 = maeVs(nc(1, 1), e.actual);
  const m1 = maeVs(nc(best.mIvr, best.mTel), e.actual);
  console.log(`  ${e.year} : nul ${m0.toFixed(2)}  mode(${best.mIvr},${best.mTel}) ${m1.toFixed(2)}  delta ${(m1 - m0) >= 0 ? "+" : ""}${(m1 - m0).toFixed(3)}`);
}
