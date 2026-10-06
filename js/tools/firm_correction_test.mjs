/**
 * Test: firm-bias correction measured at the PREVIOUS election, applied
 * to the next cycle's polls. Clean temporal validation with the two
 * ground truths available:
 *   - biases measured on the 2018 finals -> applied to the 2022 cycle,
 *     scored on the 2022 eve-of-election nowcast;
 *   - biases measured on the 2022 finals -> applied to the 2026 cycle,
 *     scored on the 2026 eve nowcast.
 *
 * Bias of a firm = ILR(final poll) - ILR(result), 6 parts. Two variants:
 *   raw      : the full error (carries the industry-wide miss, whose sign
 *              flipped between 2022 and 2026 -- see final_poll_errors);
 *   centered : deviation from that election's industry mean error (the
 *              "house effect" proper).
 * Firms absent from the previous election get zero correction. The
 * correction enters as ILR offset -lambda * bias on every poll of that
 * firm in the following cycle, lambda on the grid with 0 = production.
 *
 * Run: node js/tools/firm_correction_test.mjs   (from the repo root)
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
const LAMBDA = [0, 0.25, 0.5, 0.75, 1];

const RESULTS = {
  2018: { CAQ: 37.42, LIB: 24.82, QS: 16.10, PQ: 17.06, PCQ: 1.46, AUTRES: 3.14 },
  2022: { CAQ: 40.98, LIB: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91, AUTRES: 1.70 },
  2026: { CAQ: 13.3453, LIB: 24.2157, QS: 12.4266, PQ: 28.0189, PCQ: 20.6691, AUTRES: 1.3244 },
};
const CASES = [
  { measure: 2018, window: ["2018-09-17", "2018-10-01"], cycle: ["2018-10-02", "2022-10-02"], evalYear: 2022, eve: "2022-10-02", day: "2022-10-03" },
  { measure: 2022, window: ["2022-09-19", "2022-10-03"], cycle: ["2022-10-04", "2026-10-04"], evalYear: 2026, eve: "2026-10-04", day: "2026-10-05" },
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

// ILR of a {party: pct} record, zero-replaced and closed like the polls.
const toIlr = (shares) => {
  const rec = [{ shares: Object.fromEntries(partyCodes.map((p) => [p, (shares[p] ?? 0) / 100])) }];
  return ilr(toClosedComposition(rec, partyCodes))[0];
};

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

const byPoll = new Map();
polls.forEach((p, i) => {
  if (!byPoll.has(p.pollId)) byPoll.set(p.pollId, i);
});

for (const cse of CASES) {
  // 1. measure firm biases at the previous election
  const resIlr = toIlr(RESULTS[cse.measure]);
  const finals = new Map(); // firm -> poll index
  polls.forEach((p, i) => {
    if (p.pollDate < cse.window[0] || p.pollDate > cse.window[1]) return;
    const cur = finals.get(p.firm);
    if (cur === undefined || p.pollDate > polls[cur].pollDate) finals.set(p.firm, i);
  });
  const biasRaw = new Map();
  for (const [firm, i] of finals) biasRaw.set(firm, ilrMat[i].map((v, c) => v - resIlr[c]));
  const meanBias = Array.from({ length: nCoord }, (_, c) =>
    [...biasRaw.values()].reduce((s, b) => s + b[c], 0) / biasRaw.size);
  const biasCentered = new Map([...biasRaw].map(([f, b]) => [f, b.map((v, c) => v - meanBias[c])]));

  // 2. evaluate on the following cycle's eve nowcast
  const idxs = polls.map((p, i) => [p, i]).filter(([p]) => p.pollDate <= cse.eve).map(([, i]) => i);
  const inCycle = (i) => polls[i].pollDate >= cse.cycle[0] && polls[i].pollDate <= cse.cycle[1];

  console.log(`\n=== biais mesures en ${cse.measure} (${biasRaw.size} maisons) -> nowcast ${cse.evalYear}`);
  console.log(`  officiel : ${fmt(close5(RESULTS[cse.evalYear]))}`);
  for (const [variant, biases] of [["brut", biasRaw], ["centre", biasCentered]]) {
    for (const lambda of LAMBDA) {
      if (lambda === 0 && variant === "centre") continue; // identical to brut lambda=0
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
      const pred = close5(Object.fromEntries(partyCodes.map((p, i) => [p, share[i]])));
      const label = lambda === 0 ? "production (lambda=0)" : `${variant} lambda=${lambda}`;
      console.log(`  ${label.padEnd(22)} : ${fmt(pred)}   MAE ${maeVs(pred, RESULTS[cse.evalYear]).toFixed(2)} pp`);
    }
  }
}
