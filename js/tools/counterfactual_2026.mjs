/**
 * Counterfactual: the published riding layer fed with the TRUE national
 * vote. uniformClrSwing applies one province-level ILR delta to every
 * riding, and the effects are ILR-additive perturbations, so replacing the
 * national point in the published forecast is exact: add
 * ilr(actual) - ilr(forecastPoint) to each riding's ILR shares.
 *
 * Purpose: decompose the seat error of the pre-election projection into
 * (a) the national-vote layer (nowcast + turnout correction) and (b) the
 * riding layer (regional granularity, effects, swing form), by comparing
 *   medoid error -> counterfactual error -> 0.
 *
 * Run: node js/tools/counterfactual_2026.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";

const { ilr, ilrInv } = mva.composition;
const proj = JSON.parse(readFileSync(new URL("../data/qc_projection.json", import.meta.url), "utf-8"));
const raw = JSON.parse(readFileSync(new URL("../../data/raw/lus/2026-10-05-resultats-dgeq.json", import.meta.url), "utf-8"));
const MAP = { "PQ": "PQ", "PLQ/QLP": "LIB", "PCOQ": "PCQ", "ÉCF-CAQ": "CAQ", "QS": "QS" };
const parties = proj.partyCodes;
const ACTUAL_SEATS = { PQ: 59, LIB: 40, PCQ: 19, CAQ: 0, QS: 9 };

// forecastPoint of the published run: turnout-corrected nowcast, closed
const last = proj.trendSeries[proj.trendSeries.length - 1];
const tf = proj.meta.turnoutFactor;
let F = parties.map((p) => last[p].mean * (tf[p] ?? 1));
const fs = F.reduce((a, b) => a + b, 0);
F = F.map((v) => v / fs);

// actual national composition over the same parts
const natVotes = Object.fromEntries(parties.map((p) => [p, 0]));
for (const pp of raw.statistiques.partisPolitiques) {
  natVotes[MAP[pp.abreviationPartiPolitique] ?? "AUTRES"] += pp.nbVoteTotal;
}
const nt = Object.values(natVotes).reduce((a, b) => a + b, 0);
const A = parties.map((p) => natVotes[p] / nt);

const [fI, aI] = ilr([F, A]);
const delta = aI.map((v, i) => v - fI[i]);

const actualWinner = {};
const nameOf = {};
for (const c of raw.circonscriptions) {
  const sh = {};
  for (const cand of c.candidats) {
    const p = MAP[cand.abreviationPartiPolitique] ?? "AUTRES";
    sh[p] = (sh[p] ?? 0) + cand.nbVoteTotal;
  }
  const code = String(c.numeroCirconscription);
  actualWinner[code] = Object.entries(sh).filter(([p]) => p !== "AUTRES").sort((a, b) => b[1] - a[1])[0][0];
  nameOf[code] = c.nomCirconscription;
}

const seats = {};
let correct = 0, n = 0;
const misses = [];
for (const [code, fc] of Object.entries(proj.ridingForecast)) {
  const shIlr = ilr([parties.map((p) => fc.shares[p])])[0];
  const cf = ilrInv([shIlr.map((v, i) => v + delta[i])])[0];
  const winner = parties.map((p, i) => [p, cf[i]]).filter(([p]) => p !== "AUTRES").sort((a, b) => b[1] - a[1])[0][0];
  seats[winner] = (seats[winner] ?? 0) + 1;
  n++;
  if (winner === actualWinner[code]) correct++;
  else misses.push(`${nameOf[code]}: contrefactuel ${winner} / reel ${actualWinner[code]}`);
}

const absErr = (s) => Object.keys(ACTUAL_SEATS).reduce((e, p) => e + Math.abs((s[p] ?? 0) - ACTUAL_SEATS[p]), 0);
console.log("contrefactuel (vote national = reel, couche circonscriptions inchangee) :");
console.log(`  sieges : ${JSON.stringify(seats)}  (reel ${JSON.stringify(ACTUAL_SEATS)})`);
console.log(`  gagnants corrects : ${correct}/${n} (${(correct / n * 100).toFixed(1)} %)`);
console.log(`  erreur absolue sieges : contrefactuel ${absErr(seats)}, medoide publie ${absErr(proj.medoidCounts)}`);
console.log("  manques :");
for (const m of misses) console.log(`    ${m}`);
