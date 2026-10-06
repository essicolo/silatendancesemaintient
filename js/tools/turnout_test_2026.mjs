/**
 * Turnout-correction re-validation on the 2026 result, with a shrinkage
 * weight w on the grid (w = 0: no correction, the null; w = 1: the
 * production correction; the factor is applied as f^w).
 *
 * Same design as tools/turnout_test.ts (2022): the correction built from
 * the production inputs (qc_turnout.json: pooled 2026 Léger age gradient,
 * census weights, DGE-6281 turnout rates) is applied to each firm's FINAL
 * national poll of the campaign's last two weeks and scored against the
 * official result (MAE over the five main parties, closed).
 *
 * Run: node js/tools/turnout_test_2026.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";

const PARTIES = ["CAQ", "LIB", "QS", "PQ", "PCQ"];
const ACTUAL_RAW = { CAQ: 13.3453, LIB: 24.2157, QS: 12.4266, PQ: 28.0189, PCQ: 20.6691 };

const turnout = JSON.parse(readFileSync(new URL("../data/qc_turnout.json", import.meta.url), "utf-8"));
const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));

const close = (v) => { const s = v.reduce((x, y) => x + y, 0); return v.map((x) => x / s); };
const ACTUAL = close(PARTIES.map((p) => ACTUAL_RAW[p]));
const mae = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length * 100;

// gradient in qc_turnout.json is keyed with LIB already; bands match.
const BANDS = turnout.bands;
const wP = close(turnout.wPop);
const wV = close(turnout.wPop.map((w, a) => w * turnout.tau[a]));

function correct(nat, w) {
  return close(PARTIES.map((p) => {
    const s = nat[p] ?? 0;
    let mixP = 0, mixV = 0;
    for (let a = 0; a < BANDS.length; a++) {
      const band = s * Math.exp(turnout.gradient[p][a]);
      mixP += wP[a] * band;
      mixV += wV[a] * band;
    }
    const f = mixP > 0 ? mixV / mixP : 1;
    return s * Math.pow(f, w);
  }));
}

// final national poll per firm, last two campaign weeks
const byPoll = new Map();
for (const r of rows) {
  if (r.poll_date < "2026-09-21" || r.poll_date > "2026-10-04") continue;
  if (!byPoll.has(r.poll_id)) byPoll.set(r.poll_id, { firm: r.firm, date: r.poll_date, nat: {} });
  byPoll.get(r.poll_id).nat[r.party_code] = r.pct_reported;
}
const finals = new Map();
for (const p of byPoll.values()) {
  const cur = finals.get(p.firm);
  if (!cur || p.date > cur.date) finals.set(p.firm, p);
}
console.log(`sondages finaux 2026 (21 sept - 4 oct, dernier par maison) : ${finals.size}`);

const W_GRID = [0, 0.25, 0.5, 0.75, 1, 1.25];
console.log("\nMAE moyenne (pp, 5 partis fermes) selon le poids w de la correction :");
for (const w of W_GRID) {
  let e = 0;
  const detail = [];
  for (const [firm, f] of finals) {
    const c = correct(f.nat, w);
    e += mae(c, ACTUAL);
    if (w === 0 || w === 1) {
      detail.push(`    ${firm.padEnd(22)} ${f.date}  MAE ${mae(c, ACTUAL).toFixed(2)}  CAQ ${(c[0] * 100).toFixed(1)} (reel ${(ACTUAL[0] * 100).toFixed(1)})`);
    }
  }
  console.log(`  w=${String(w).padEnd(4)} : ${(e / finals.size).toFixed(3)} pp`);
  for (const l of detail) console.log(l);
}
