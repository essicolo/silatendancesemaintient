/**
 * Final-poll errors vs official results, three elections (2018, 2022,
 * 2026). One computation, two questions:
 *
 *  3. INDUSTRY DRIFT: is the mean error of the final polls (the "polling
 *     miss") predictable? The simulation's systemic shock is zero-mean
 *     isotropic ILR; a stable nonzero mean (or one aligned with a
 *     observable like incumbency or poll momentum) would justify a drift
 *     term, null on the grid.
 *  5. FIRM BIAS, ground truth: per-firm deviation from the industry mean
 *     at each election; a REAL house bias should have a stable sign across
 *     elections for firms present twice or more.
 *
 * Final poll = each firm's last national poll in the campaign's final two
 * weeks. Errors in percentage points on the 5 main parties closed, plus
 * the ILR norm of the drift for the systemic-shock comparison (production
 * sigma = 0.144 ILR, 4-party subcomposition).
 *
 * Run: node js/tools/final_poll_errors.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";

const { ilr } = mva.composition;
const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));

const MAIN = ["CAQ", "LIB", "QS", "PQ", "PCQ"];
const ELECTIONS = {
  2018: { window: ["2018-09-17", "2018-10-01"], actual: { CAQ: 37.42, LIB: 24.82, QS: 16.10, PQ: 17.06, PCQ: 1.46 } },
  2022: { window: ["2022-09-19", "2022-10-03"], actual: { CAQ: 40.98, LIB: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91 } },
  2026: { window: ["2026-09-21", "2026-10-05"], actual: { CAQ: 13.3453, LIB: 24.2157, QS: 12.4266, PQ: 28.0189, PCQ: 20.6691 } },
};

const close5 = (o) => {
  const t = MAIN.reduce((s, p) => s + (o[p] ?? 0), 0);
  return MAIN.map((p) => ((o[p] ?? 0) / t) * 100);
};

const byPoll = new Map();
for (const r of rows) {
  if (!byPoll.has(r.poll_id)) byPoll.set(r.poll_id, { firm: r.firm, date: r.poll_date, s: {} });
  byPoll.get(r.poll_id).s[r.party_code] = r.pct_reported;
}

const perFirm = {}; // firm -> {year: errVec}
for (const [year, cfg] of Object.entries(ELECTIONS)) {
  const [a, b] = cfg.window;
  const finals = new Map();
  for (const p of byPoll.values()) {
    if (p.date < a || p.date > b) continue;
    const cur = finals.get(p.firm);
    if (!cur || p.date > cur.date) finals.set(p.firm, p);
  }
  const actual = close5(cfg.actual);
  const errs = [];
  console.log(`\n=== ${year} (${finals.size} maisons) — erreur sondage final - resultat, pp (5 partis fermes)`);
  for (const [firm, f] of [...finals.entries()].sort()) {
    const pred = close5(f.s);
    const e = pred.map((v, i) => v - actual[i]);
    errs.push(e);
    perFirm[firm] = perFirm[firm] ?? {};
    perFirm[firm][year] = e;
    console.log(`  ${firm.padEnd(22)} ${f.date}  ` + MAIN.map((p, i) => `${p} ${e[i] >= 0 ? "+" : ""}${e[i].toFixed(1)}`).join("  "));
  }
  const mean = MAIN.map((_, i) => errs.reduce((s, e) => s + e[i], 0) / errs.length);
  const se = MAIN.map((_, i) => {
    const m = mean[i];
    return Math.sqrt(errs.reduce((s, e) => s + (e[i] - m) ** 2, 0) / errs.length / Math.max(errs.length - 1, 1));
  });
  console.log(`  ${"MOYENNE INDUSTRIE".padEnd(22)} ${" ".repeat(10)}  ` +
    MAIN.map((p, i) => `${p} ${mean[i] >= 0 ? "+" : ""}${mean[i].toFixed(1)}±${se[i].toFixed(1)}`).join("  "));

  // ILR norm of the industry drift (4 major parties of that era, matching
  // the systemic-shock subcomposition convention)
  const big4 = year === "2018" ? ["CAQ", "LIB", "QS", "PQ"] : ["CAQ", "LIB", "PQ", "PCQ"];
  const sub = (o) => { const t = big4.reduce((s, p) => s + o[p], 0); return big4.map((p) => o[p] / t); };
  const avg = {}; MAIN.forEach((p, i) => avg[p] = actual[i] + mean[i]);
  const d = ilr([sub(avg)])[0].map((v, i) => v - ilr([sub(Object.fromEntries(MAIN.map((p, j) => [p, actual[j]])))])[0][i]);
  console.log(`  norme ILR de la derive industrie (sous-composition 4 partis) : ${Math.sqrt(d.reduce((s, v) => s + v * v, 0)).toFixed(3)}  (choc systemique production : sigma 0.144)`);
}

console.log("\n=== 5. STABILITE PAR MAISON (ecart a la moyenne d'industrie de l'annee, pp)");
for (const [firm, byYear] of Object.entries(perFirm).sort()) {
  const years = Object.keys(byYear);
  if (years.length < 2) continue;
  for (const y of years) {
    // deviation from that year's industry mean
    const yearErrs = Object.values(perFirm).map((f) => f[y]).filter(Boolean);
    const mean = MAIN.map((_, i) => yearErrs.reduce((s, e) => s + e[i], 0) / yearErrs.length);
    const dev = byYear[y].map((v, i) => v - mean[i]);
    console.log(`  ${firm.padEnd(22)} ${y}  ` + MAIN.map((p, i) => `${p} ${dev[i] >= 0 ? "+" : ""}${dev[i].toFixed(1)}`).join("  "));
  }
}
