/**
 * Evaluation of the pre-election projection against the official 2026-10-05
 * results (Elections Quebec final counts). Reads the LAST pre-election
 * qc_projection.json (do not recompute before running this) and the raw
 * results saved by ingest/loaders/resultats_2026.ts.
 *
 * Sections:
 *  1. national vote: actual vs GP nowcast, vs turnout-corrected point, vs
 *     the final-week poll average (error decomposition);
 *  2. riding level: winner accuracy, Brier score and calibration of the
 *     win probabilities, list of missed ridings;
 *  3. seats: actual vs medoid and the quantile of the actual seat count in
 *     each party's simulated distribution;
 *  4. riding-share errors per party (systematic vs distributional).
 *
 * Run: node js/tools/evaluation_2026.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";

const proj = JSON.parse(readFileSync(new URL("../data/qc_projection.json", import.meta.url), "utf-8"));
const raw = JSON.parse(readFileSync(new URL("../../data/raw/lus/2026-10-05-resultats-dgeq.json", import.meta.url), "utf-8"));
const pollRows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));

const MAIN = ["PQ", "LIB", "PCQ", "CAQ", "QS"];
const PARTY_MAP = { "PQ": "PQ", "PLQ/QLP": "LIB", "PCOQ": "PCQ", "ÉCF-CAQ": "CAQ", "QS": "QS" };

// --- actual results ----------------------------------------------------
const actualNat = {};
for (const p of raw.statistiques.partisPolitiques) {
  const code = PARTY_MAP[p.abreviationPartiPolitique] ?? "AUTRES";
  actualNat[code] = (actualNat[code] ?? 0) + p.nbVoteTotal;
}
const natTotal = Object.values(actualNat).reduce((a, b) => a + b, 0);
for (const k of Object.keys(actualNat)) actualNat[k] = (actualNat[k] / natTotal) * 100;

const actualRidings = {}; // code -> {name, shares, winner}
for (const c of raw.circonscriptions) {
  const shares = {};
  for (const cand of c.candidats) {
    const code = PARTY_MAP[cand.abreviationPartiPolitique] ?? "AUTRES";
    shares[code] = (shares[code] ?? 0) + cand.nbVoteTotal;
  }
  const tot = Object.values(shares).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(shares)) shares[k] = (shares[k] / tot) * 100;
  const winner = Object.entries(shares).filter(([p]) => p !== "AUTRES").sort((a, b) => b[1] - a[1])[0][0];
  actualRidings[String(c.numeroCirconscription)] = { name: c.nomCirconscription, shares, winner };
}

const fmtShares = (o) => MAIN.map((p) => `${p} ${(o[p] ?? 0).toFixed(1)}`).join("  ");
const mae = (pred) => MAIN.reduce((s, p) => s + Math.abs((pred[p] ?? 0) - actualNat[p]), 0) / MAIN.length;

// --- 1. national -------------------------------------------------------
console.log("1. VOTE NATIONAL (resultat officiel vs modeles)\n");
console.log(`  officiel              : ${fmtShares(actualNat)}  AUTRES ${actualNat.AUTRES.toFixed(1)}`);

const nowcast = {};
const last = proj.trendSeries[proj.trendSeries.length - 1];
for (const p of proj.partyCodes) nowcast[p] = last[p].mean * 100;
console.log(`  nowcast GP (${last.date}) : ${fmtShares(nowcast)}   MAE ${mae(nowcast).toFixed(2)} pp`);

const tf = proj.meta.turnoutFactor;
const pointRaw = Object.fromEntries(proj.partyCodes.map((p) => [p, nowcast[p] * (tf[p] ?? 1)]));
const ptTot = Object.values(pointRaw).reduce((a, b) => a + b, 0);
const point = Object.fromEntries(Object.entries(pointRaw).map(([k, v]) => [k, (v / ptTot) * 100]));
console.log(`  + correction particip.: ${fmtShares(point)}   MAE ${mae(point).toFixed(2)} pp`);

// final-week national polls (fieldEnd >= 09-28), renormalized average
const byPoll = new Map();
for (const r of pollRows) {
  if (r.poll_date < "2026-09-28") continue;
  if (!byPoll.has(r.poll_id)) byPoll.set(r.poll_id, { firm: r.firm, date: r.poll_date, shares: {} });
  byPoll.get(r.poll_id).shares[r.party_code] = r.pct_reported;
}
const finals = [...byPoll.values()];
const pollAvg = {};
for (const p of MAIN) pollAvg[p] = finals.reduce((s, f) => s + (f.shares[p] ?? 0), 0) / finals.length;
console.log(`  moyenne sondages fin. : ${fmtShares(pollAvg)}   MAE ${mae(pollAvg).toFixed(2)} pp   (${finals.length} sondages depuis le 28 sept)`);
for (const f of finals.sort((a, b) => a.date < b.date ? -1 : 1)) {
  const m = MAIN.reduce((s, p) => s + Math.abs((f.shares[p] ?? 0) - actualNat[p]), 0) / MAIN.length;
  console.log(`    ${f.date} ${f.firm.padEnd(22)} ${fmtShares(f.shares)}   MAE ${m.toFixed(2)}`);
}

console.log("\n  erreur par parti (modele - officiel) :");
for (const p of MAIN) {
  console.log(`    ${p.padEnd(4)} nowcast ${(nowcast[p] - actualNat[p]).toFixed(1).padStart(5)}  +particip. ${(point[p] - actualNat[p]).toFixed(1).padStart(5)}  sondages ${(pollAvg[p] - actualNat[p]).toFixed(1).padStart(5)}`);
}

// --- 2. ridings ---------------------------------------------------------
console.log("\n2. CIRCONSCRIPTIONS\n");
let correctPoint = 0, correctProb = 0, brier = 0, nR = 0;
const missed = [];
const bins = Array.from({ length: 5 }, () => ({ n: 0, won: 0, pSum: 0 })); // [0.5-0.6) ... [0.9-1]
for (const [code, act] of Object.entries(actualRidings)) {
  const fc = proj.ridingForecast[code];
  const wp = proj.ridingWinProbs[code];
  if (!fc || !wp) continue;
  nR++;
  if (fc.winner === act.winner) correctPoint++;
  const fav = Object.entries(wp).sort((a, b) => b[1] - a[1])[0];
  if (fav[0] === act.winner) correctProb++;
  else missed.push({ code, name: act.name, fav: fav[0], pFav: fav[1], actual: act.winner, pActual: wp[act.winner] ?? 0 });
  for (const [p, pr] of Object.entries(wp)) brier += (pr - (p === act.winner ? 1 : 0)) ** 2;
  const b = Math.min(Math.floor((fav[1] - 0.5) / 0.1), 4);
  if (fav[1] >= 0.5) { bins[b].n++; bins[b].pSum += fav[1]; if (fav[0] === act.winner) bins[b].won++; }
}
console.log(`  gagnant correct (projection ponctuelle) : ${correctPoint}/${nR} (${(correctPoint / nR * 100).toFixed(1)} %)`);
console.log(`  gagnant correct (favori par p victoire) : ${correctProb}/${nR} (${(correctProb / nR * 100).toFixed(1)} %)`);
console.log(`  score de Brier (multi-parti, moyen)     : ${(brier / nR).toFixed(3)}`);
console.log("\n  calibration du favori (p predite vs frequence gagnee) :");
for (let i = 0; i < 5; i++) {
  if (!bins[i].n) continue;
  console.log(`    p=[${(0.5 + i * 0.1).toFixed(1)}-${(0.6 + i * 0.1).toFixed(1)}) : predit ${(bins[i].pSum / bins[i].n).toFixed(2)}, observe ${(bins[i].won / bins[i].n).toFixed(2)}  (${bins[i].won}/${bins[i].n})`);
}
console.log(`\n  circonscriptions manquees (${missed.length}) :`);
for (const m of missed.sort((a, b) => b.pFav - a.pFav)) {
  console.log(`    ${m.name.padEnd(28)} predit ${m.fav} (p=${m.pFav.toFixed(2)}), elu ${m.actual} (p=${m.pActual.toFixed(2)})`);
}

// --- 3. seats ------------------------------------------------------------
console.log("\n3. SIEGES\n");
const actualSeats = {};
for (const a of Object.values(actualRidings)) actualSeats[a.winner] = (actualSeats[a.winner] ?? 0) + 1;
console.log(`  officiel : ${MAIN.map((p) => `${p} ${actualSeats[p] ?? 0}`).join("  ")}`);
console.log(`  medoide  : ${MAIN.map((p) => `${p} ${proj.medoidCounts[p] ?? 0}`).join("  ")}`);
for (const p of MAIN) {
  const h = proj.seatDistributions[p].histogram;
  const act = actualSeats[p] ?? 0;
  let below = 0, at = 0;
  for (const bin of h) { if (bin.seats < act) below += bin.prob; if (bin.seats === act) at += bin.prob; }
  console.log(`    ${p.padEnd(4)} officiel ${String(act).padStart(3)}  quantile dans la simulation : ${(100 * (below + at / 2)).toFixed(1)} %  [p05-p95 simules ${proj.seatDistributions[p].p05}-${proj.seatDistributions[p].p95}]`);
}

// --- 4. riding-share errors ----------------------------------------------
console.log("\n4. ERREUR DES PARTS PAR CIRCONSCRIPTION (modele - officiel, pp)\n");
for (const p of MAIN) {
  const errs = [];
  for (const [code, act] of Object.entries(actualRidings)) {
    const fc = proj.ridingForecast[code];
    if (!fc) continue;
    errs.push(fc.shares[p] * 100 - (act.shares[p] ?? 0));
  }
  errs.sort((a, b) => a - b);
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  const sd = Math.sqrt(errs.reduce((s, e) => s + (e - mean) ** 2, 0) / errs.length);
  const med = errs[Math.floor(errs.length / 2)];
  const maeR = errs.reduce((s, e) => s + Math.abs(e), 0) / errs.length;
  console.log(`  ${p.padEnd(4)} biais moyen ${mean.toFixed(2).padStart(6)}  mediane ${med.toFixed(2).padStart(6)}  ecart-type ${sd.toFixed(2)}  MAE ${maeR.toFixed(2)}`);
}
