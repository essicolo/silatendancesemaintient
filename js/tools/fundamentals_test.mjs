/**
 * Backtest: the mandate-age ("usure du pouvoir") prior as a long-horizon
 * forecast ingredient -- no leakage anywhere.
 *
 * For each test election E in {2018, 2022, 2026} and each horizon H in
 * {36, 24, 12, 6, 2} months:
 *  - POLLS (GP): production trend GP fitted ONLY on polls dated <= E - H,
 *    predicting election day (hyperparameters fixed at the production
 *    choice -- shared by every variant, so the comparison is fair even
 *    if absolute levels are mildly optimistic);
 *  - FONDAMENTAUX: previous election's shares, incumbent shifted by the
 *    mean historical swing of governments at the SAME mandate rank,
 *    estimated exclusively on elections BEFORE E (qc_mandate_cases.json;
 *    rank 3+ pooled), other parties re-closed proportionally;
 *  - MELANGE: 50/50 in share space.
 * Score: MAE (pp) over the five main parties closed, against the
 * official result.
 *
 * Expectation stated before running: polls price in the usure long
 * before election day, so the prior should only compete at horizons
 * before opinion has moved. The test says where that frontier is.
 *
 * Run: node js/tools/fundamentals_test.mjs   (from the repo root)
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
const PARTY_ALIAS = { LIB: "LIB", Parti_liberal: "LIB", PQ: "PQ", Parti_quebecois: "PQ", CAQ: "CAQ", UN: "UN" };

const ACTUALS = {
  "2018-10-01": { CAQ: 37.42, LIB: 24.82, QS: 16.10, PQ: 17.06, PCQ: 1.46 },
  "2022-10-03": { CAQ: 40.98, LIB: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91 },
  "2026-10-05": { CAQ: 13.3453, LIB: 24.2157, QS: 12.4266, PQ: 28.0189, PCQ: 20.6691 },
};

const mc = JSON.parse(readFileSync(new URL("../data/qc_mandate_cases.json", import.meta.url), "utf-8"));
const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows);
const comp = toClosedComposition(polls, partyCodes);
const ilrMat = ilr(comp);
const nCoord = ilrMat[0].length;
const t0 = polls.reduce((m, p) => (p.pollDate < m ? p.pollDate : m), polls[0].pollDate);
const x = toX(t0, polls.map((p) => p.pollDate));
const varC = ilrSamplingVariance(comp, polls.map((p) => p.sampleSize));
const shapeC = varC.map((col) => { const m = Math.min(...col); return col.map((v) => v / m); });

const close5 = (o) => {
  const t = MAIN.reduce((s, p) => s + (o[p] ?? 0), 0);
  return Object.fromEntries(MAIN.map((p) => [p, ((o[p] ?? 0) / t) * 100]));
};
const maeVs = (pred, act) => MAIN.reduce((s, p) => s + Math.abs(pred[p] - act[p]), 0) / 5;
const fmt = (o) => MAIN.map((p) => `${p} ${o[p].toFixed(1)}`).join("  ");
const minusMonths = (date, m) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() - m);
  return d.toISOString().slice(0, 10);
};

const gpForecast = (cutoff, day) => {
  const idxs = polls.map((p, i) => [p, i]).filter(([p]) => p.pollDate <= cutoff).map(([, i]) => i);
  const pred = [];
  for (let c = 0; c < nCoord; c++) {
    const gp = new ml.GaussianProcessRegressor({
      kernel: new ChangepointKernel({ lengthScale: HYPER[c].ls, rho: HYPER[c].rho, dilation: HYPER[c].dil }),
      normalizeY: true,
    });
    gp.fit(idxs.map((i) => x[i]), idxs.map((i) => ilrMat[i][c]), { alpha: idxs.map((i) => shapeC[c][i] * HYPER[c].ns) });
    pred.push(gp.predict(toX(t0, [day]))[0]);
  }
  const share = ilrInv([pred])[0];
  return close5(Object.fromEntries(partyCodes.map((p, i) => [p, share[i]])));
};

/** Mandate prior: mean historical incumbent swing at the same rank,
 * cases strictly before the test election (rank >= 3 pooled). */
const fundamentals = (electionDate) => {
  const i = mc.elections.findIndex((e) => e.date === electionDate);
  const prev = mc.elections[i - 1];
  const kase = mc.cases.find((c) => c.date === electionDate);
  const rank = Math.min(kase.mandates, 3);
  const hist = mc.cases.filter((c) => c.date < electionDate && c.date >= "1960" && Math.min(c.mandates, 3) === rank);
  const prior = hist.reduce((s, c) => s + c.swing, 0) / hist.length;
  const prevShares = {};
  for (const [p, v] of Object.entries(prev.shares)) {
    const code = PARTY_ALIAS[p] ?? p;
    if (MAIN.includes(code)) prevShares[code] = (prevShares[code] ?? 0) + v;
  }
  const inc = kase.incumbent;
  const out = { ...prevShares };
  out[inc] = Math.max(out[inc] + prior, 1);
  return { pred: close5(out), inc, rank: kase.mandates, prior, n: hist.length };
};

for (const [day, actualRaw] of Object.entries(ACTUALS)) {
  const act = close5(actualRaw);
  const f = fundamentals(day);
  console.log(`\n=== ${day.slice(0, 4)}  (officiel : ${fmt(act)})`);
  console.log(`  fondamentaux (sortant ${f.inc}, ${f.rank}e mandat en jeu +1, prior ${f.prior.toFixed(1)} pp sur ${f.n} cas pre-${day.slice(0, 4)}) :`);
  console.log(`      ${fmt(f.pred)}   MAE ${maeVs(f.pred, act).toFixed(2)} pp`);
  for (const h of [36, 24, 12, 6, 2]) {
    const cutoff = minusMonths(day, h);
    const g = gpForecast(cutoff, day);
    const blend = Object.fromEntries(MAIN.map((p) => [p, (g[p] + f.pred[p]) / 2]));
    console.log(`  H=${String(h).padStart(2)} mois  GP ${maeVs(g, act).toFixed(2).padStart(6)}  melange ${maeVs(close5(blend), act).toFixed(2).padStart(6)}   (GP: ${fmt(g)})`);
  }
}
