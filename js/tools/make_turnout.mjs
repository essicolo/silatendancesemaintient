/**
 * Differential-turnout parameters -> js/data/qc_turnout.json.
 *
 * Mechanism validated on 2022 (tools/turnout_test.ts): pollsters weight to
 * the adult population, the electorate skews older; reweighting the age
 * mix by official turnout improved the final-poll error (MAE 2.015 -> 1.877
 * across the 7 final 2022 polls, robust in sensitivity).
 *
 * Components, every one measured:
 *  - tau: turnout by age band, 2022 general election (DGE-6281 table 1,
 *    sex-averaged, sub-bands aggregated with census weights). Used as the
 *    prior for 2026 turnout; the 2018 profile is nearly identical.
 *  - wPop: census 18+ age structure (2016 five-year pyramid aggregated;
 *    the sensitivity grid in the backtest showed the result is insensitive
 *    to plausible ageing shifts).
 *  - gradient: 2026 pooled age gradient, log(share in band / topline), from
 *    the two 2026 crosstabs published with matching bands (Léger reports of
 *    2026-08-31 p.7 and 2026-09-07 p.7, decided voters; data/raw/lus/).
 *    Pallas 2026-08-29 is excluded: its bands (35-49, 50-64, 65+) do not
 *    map onto the turnout bands. The 2022 gradient is NOT reused: party
 *    age profiles moved too much between cycles (the PQ aged markedly).
 *    AUTRES carries no crosstab and gets a zero gradient (no correction).
 *
 * Regenerate when a new same-band crosstab is transcribed:
 *   node js/tools/make_turnout.mjs
 */

import { writeFileSync } from "node:fs";

const BANDS = ["18-34", "35-54", "55+"];
const PARTIES = ["PQ", "CAQ", "LIB", "PCQ", "QS"];

// tau: DGE-6281 table 1 (2022), sex-averaged then aggregated to poll bands.
const TAU = [0.544, 0.633, 0.732];
// wPop: census 18+ structure aggregated to the same bands.
const W_POP = [0.256, 0.334, 0.410];

// 2026 crosstabs, decided voters: [topline, 18-34, 35-54, 55+].
const CROSSTABS = [
  { source: "Léger 2026-08-31 (Rapport-intentions-de-vote-31-aout-2026-VF.pdf, p.7)",
    PQ: [29, 19, 37, 28], CAQ: [24, 14, 13, 37], LIB: [22, 27, 14, 25], PCQ: [15, 18, 26, 7], QS: [10, 21, 10, 3] },
  { source: "Léger 2026-09-07 (Rapport-intentions-de-vote-7-septembre-2026-VF.pdf, p.7)",
    PQ: [29, 24, 38, 24], CAQ: [23, 8, 14, 37], LIB: [22, 29, 19, 21], PCQ: [15, 17, 17, 12], QS: [10, 19, 12, 5] },
];

const gradient = {};
for (const p of PARTIES) {
  gradient[p] = BANDS.map((_, a) => {
    const vals = CROSSTABS.map((t) => Math.log(t[p][a + 1] / t[p][0]));
    return +(vals.reduce((x, y) => x + y, 0) / vals.length).toFixed(4);
  });
}
gradient.AUTRES = [0, 0, 0];

const out = {
  bands: BANDS,
  wPop: W_POP,
  tau: TAU,
  gradient,
  sources: {
    tau: "Élections Québec, DGE-6281, tableau 1 (élection générale 2022)",
    wPop: "Recensement, structure d'âge 18+",
    gradient: CROSSTABS.map((t) => t.source),
    validation: "js/tools/turnout_test.ts (backtest 2022 : MAE finaux 2,015 -> 1,877 pp)",
  },
};
writeFileSync(new URL("../data/qc_turnout.json", import.meta.url), JSON.stringify(out, null, 1), "utf-8");
console.log("qc_turnout.json ecrit. Gradient 2026 :");
for (const p of PARTIES) console.log(`  ${p.padEnd(4)} ${gradient[p].map((v) => (v >= 0 ? "+" : "") + v.toFixed(2)).join("  ")}`);
