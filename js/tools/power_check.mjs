/**
 * Power check of the project's validation protocol itself (five-agent
 * review, 2026-10-06, external critique #1).
 *
 * The de facto acceptance rule of the post-mortem was: a mechanism enters
 * production only if it improves the eve-of-election nowcast MAE on the
 * available test elections (mean improvement, ideally every election).
 * With 2-3 test elections, does that rule have any POWER against effects
 * of realistic size?
 *
 * Design: inject a KNOWN, PERSISTENT house bias into one firm's polls
 * (CAQ share +b pp, others re-closed) across the whole series, then run
 * the standard previous-election correction test (bias measured on the
 * firm's final poll at election E-1, subtracted from its cycle-E polls,
 * centered on the industry mean) and apply the acceptance rules:
 *   R1: mean dMAE over {2022, 2026} < 0
 *   R2: dMAE < 0 at BOTH elections.
 * By construction the injected bias is exactly the effect the correction
 * estimates, so acceptance SHOULD approach 100% as b grows. The
 * acceptance rate at realistic b is the protocol's power; at b=0 it is
 * the false-acceptance rate.
 *
 * Run: node js/tools/power_check.mjs   (from the repo root; ~10 min)
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
const MAIN = ["CAQ", "LIB", "QS", "PQ", "PCQ"];
const ACTUALS = {
  2022: { CAQ: 40.98, LIB: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91 },
  2026: { CAQ: 13.3453, LIB: 24.2157, QS: 12.4266, PQ: 28.0189, PCQ: 20.6691 },
};
const CASES = [
  { measure: 2018, window: ["2018-09-17", "2018-10-01"], cycle: ["2018-10-02", "2022-10-02"], evalYear: 2022, eve: "2022-10-02", day: "2022-10-03" },
  { measure: 2022, window: ["2022-09-19", "2022-10-03"], cycle: ["2022-10-04", "2026-10-04"], evalYear: 2026, eve: "2026-10-04", day: "2026-10-05" },
];
const RESULTS = {
  2018: { CAQ: 37.42, LIB: 24.82, QS: 16.10, PQ: 17.06, PCQ: 1.46, AUTRES: 3.14 },
  2022: { CAQ: 40.98, LIB: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91, AUTRES: 1.70 },
};

const rowsRaw = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const B_GRID = [0, 0.5, 1, 2]; // injected CAQ bias, pp
const FIRMS = ["Léger", "Mainstreet Research", "Forum Research", "Research Co."];

const close5 = (o) => {
  const t = MAIN.reduce((s, p) => s + o[p], 0);
  return Object.fromEntries(MAIN.map((p) => [p, (o[p] / t) * 100]));
};
const maeVs = (pred, act) => {
  const a = close5(act);
  return MAIN.reduce((s, p) => s + Math.abs(pred[p] - a[p]), 0) / 5;
};

/** Run the standard correction test on a (possibly injected) poll set.
 * Returns dMAE per eval year (corrected - null). */
function correctionTest(pollRows) {
  const { polls, partyCodes } = pivotPolls(pollRows);
  const comp = toClosedComposition(polls, partyCodes);
  const ilrMat = ilr(comp);
  const nCoord = ilrMat[0].length;
  const t0 = polls.reduce((m, p) => (p.pollDate < m ? p.pollDate : m), polls[0].pollDate);
  const x = toX(t0, polls.map((p) => p.pollDate));
  const varC = ilrSamplingVariance(comp, polls.map((p) => p.sampleSize));
  const shapeC = varC.map((col) => { const m = Math.min(...col); return col.map((v) => v / m); });

  const toIlrRes = (shares) => {
    const rec = [{ shares: Object.fromEntries(partyCodes.map((p) => [p, (shares[p] ?? 0) / 100])) }];
    return ilr(toClosedComposition(rec, partyCodes))[0];
  };

  const out = {};
  for (const cse of CASES) {
    const resIlr = toIlrRes(RESULTS[cse.measure]);
    const finals = new Map();
    polls.forEach((p, i) => {
      if (p.pollDate < cse.window[0] || p.pollDate > cse.window[1]) return;
      const cur = finals.get(p.firm);
      if (cur === undefined || p.pollDate > polls[cur].pollDate) finals.set(p.firm, i);
    });
    const biasRaw = new Map();
    for (const [firm, i] of finals) biasRaw.set(firm, ilrMat[i].map((v, c) => v - resIlr[c]));
    const meanBias = Array.from({ length: nCoord }, (_, c) =>
      [...biasRaw.values()].reduce((s, b) => s + b[c], 0) / biasRaw.size);
    const biases = new Map([...biasRaw].map(([f, b]) => [f, b.map((v, c) => v - meanBias[c])]));

    const idxs = polls.map((p, i) => [p, i]).filter(([p]) => p.pollDate <= cse.eve).map(([, i]) => i);
    const inCycle = (i) => polls[i].pollDate >= cse.cycle[0] && polls[i].pollDate <= cse.cycle[1];
    const nowcast = (lambda) => {
      const ilrMean = [];
      for (let c = 0; c < nCoord; c++) {
        const y = idxs.map((i) => {
          const b = inCycle(i) ? biases.get(polls[i].firm) : null;
          return ilrMat[i][c] - (b ? lambda * b[c] : 0);
        });
        const gp = new ml.GaussianProcessRegressor({
          kernel: new ChangepointKernel({ lengthScale: HYPER[c].ls, rho: HYPER[c].rho, dilation: HYPER[c].dil }),
          normalizeY: true,
        });
        gp.fit(idxs.map((i) => x[i]), y, { alpha: idxs.map((i) => shapeC[c][i] * HYPER[c].ns) });
        ilrMean.push(gp.predict(toX(t0, [cse.day]))[0]);
      }
      const share = ilrInv([ilrMean])[0];
      return close5(Object.fromEntries(partyCodes.map((p, i) => [p, share[i]])));
    };
    out[cse.evalYear] = maeVs(nowcast(1), ACTUALS[cse.evalYear]) - maeVs(nowcast(0), ACTUALS[cse.evalYear]);
  }
  return out;
}

const inject = (rows, firm, b) => {
  if (!b) return rows;
  // group by poll, shift CAQ by +b pp and re-scale the others to keep the
  // published total (injection in reported-share space)
  const byPoll = new Map();
  for (const r of rows) {
    if (!byPoll.has(r.poll_id)) byPoll.set(r.poll_id, []);
    byPoll.get(r.poll_id).push(r);
  }
  const out = [];
  for (const [, group] of byPoll) {
    if (group[0].firm !== firm) { out.push(...group); continue; }
    const tot = group.reduce((s, r) => s + r.pct_reported, 0);
    const caq = group.find((r) => r.party_code === "CAQ");
    if (!caq) { out.push(...group); continue; }
    const restScale = (tot - caq.pct_reported - b) / (tot - caq.pct_reported);
    for (const r of group) {
      out.push({ ...r, pct_reported: r.party_code === "CAQ" ? r.pct_reported + b : r.pct_reported * restScale });
    }
  }
  return out;
};

console.log("b (pp) | firme                 | dMAE 2022 | dMAE 2026 | R1 (moyenne<0) | R2 (les deux<0)");
const accept = {};
for (const b of B_GRID) {
  accept[b] = { r1: 0, r2: 0, n: 0 };
  for (const firm of FIRMS) {
    const d = correctionTest(inject(rowsRaw, firm, b));
    const r1 = (d[2022] + d[2026]) / 2 < 0;
    const r2 = d[2022] < 0 && d[2026] < 0;
    accept[b].r1 += r1; accept[b].r2 += r2; accept[b].n++;
    console.log(`${String(b).padStart(5)}  | ${firm.padEnd(21)} | ${d[2022].toFixed(3).padStart(8)}  | ${d[2026].toFixed(3).padStart(8)}  | ${r1 ? "ACCEPTE" : "rejette"}        | ${r2 ? "ACCEPTE" : "rejette"}`);
  }
}
console.log("\ntaux d'acceptation par taille d'effet injecte :");
for (const b of B_GRID) {
  console.log(`  b=${String(b).padEnd(4)} : R1 ${accept[b].r1}/${accept[b].n}   R2 ${accept[b].r2}/${accept[b].n}` +
    (b === 0 ? "   (= taux de fausse acceptation)" : "   (= puissance a cet effet)"));
}
