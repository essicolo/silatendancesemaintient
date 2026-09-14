/**
 * Test: differential-turnout correction of poll toplines, backtested on the
 * 2022 general election.
 *
 * Pollsters weight to the ADULT POPULATION; the actual electorate skews
 * older. If support differs by age, reweighting by turnout-adjusted age
 * weights shifts the topline. The null hypothesis (no correction) competes
 * out of sample against the official 2022 result.
 *
 * Design constraint discovered in the data: the published age breakdowns of
 * the 2022 cycle stop on 2022-08-26 -- none exist for the campaign's final
 * weeks, and a single breakdown has n = 200-300 per band (share noise of
 * 3-4 points, larger than the correction itself). The correction is
 * therefore built the only way it could run in production:
 *
 *   1. AGE GRADIENT, pooled: for each of the 16 polls with breakdowns,
 *      delta_{a,p} = log(share of party p in band a / topline share);
 *      the gradient is the across-poll mean (noise averages down),
 *      its stability is reported (sd across polls).
 *   2. CORRECTION of any topline: reconstruct band shares as
 *      s_p exp(delta_{a,p}), mix them under population weights and under
 *      turnout-adjusted weights, and scale the topline by the ratio of the
 *      two mixes, then re-close.
 *   3. EVALUATION: each firm's final national poll (field date >=
 *      2022-09-20), corrected vs raw, mean absolute error against the
 *      official result. Sensitivity grid over the age weights and rates.
 *
 * tau (turnout 2022 by age, DGE-6281 table 1, sex-averaged, aggregated to
 * poll bands with census sub-band weights): 18-34: 54.4 %, 35-54: 63.3 %,
 * 55+: 73.2 %. wPop: census 18+ structure.
 *
 * Run: deno run --allow-net=fr.wikipedia.org --allow-read js/tools/turnout_test.ts
 */

import { parseHTML } from "linkedom";
import { fetchPage } from "../ingest/wiki_polls.ts";

const PAGE_2022 = "Liste de sondages sur les élections générales québécoises de 2022";
const BANDS = ["18-34", "35-54", "55+"] as const;
const BAND_PATTERNS: [string, RegExp][] = [
  ["18-34", /18[–-]34/],
  ["35-54", /35[–-]54/],
  ["55+", /55 ans|plus de 55/i],
];
const PARTIES = ["CAQ", "PLQ", "QS", "PQ", "PCQ"] as const;
const ACTUAL_RAW: Record<string, number> = { CAQ: 40.98, PLQ: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91 };

const MONTHS: Record<string, number> = {
  janvier: 1, "février": 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  "août": 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, "décembre": 12,
};
const parseDate = (text: string): string | null => {
  const m = text.replace(/\[.*?\]/g, "").trim().toLowerCase().match(/(\d{1,2})\s+([a-zéûôà]+)\s+(\d{4})/);
  if (!m || !MONTHS[m[2]]) return null;
  return `${m[3]}-${String(MONTHS[m[2]]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
};
const parseNum = (text: string): number | null => {
  const m = text.replace(/\[.*?\]/g, "").replace(/[\s  ]/g, "").replace(",", ".").match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

const snap = await fetchPage(PAGE_2022);
const { document } = parseHTML(snap.html);

const series: Record<string, Map<string, Record<string, number>>> = { national: new Map() };
for (const b of BANDS) series[b] = new Map();

const chain = new Map<number, string>();
for (const node of document.querySelectorAll("h2,h3,h4,table")) {
  const tag = node.tagName.toLowerCase();
  if (tag !== "table") {
    chain.set(Number(tag[1]), (node.textContent ?? "").replace(/\s+/g, " ").trim());
    for (const k of [...chain.keys()]) if (k > Number(tag[1])) chain.delete(k);
    continue;
  }
  const firstTr = node.querySelector("tr");
  if (!firstTr) continue;
  const headers = [...firstTr.querySelectorAll("th")].map((th) => (th.textContent ?? "").trim());
  if (!headers.includes("Sondeur") || !headers.includes("CAQ")) continue;
  const heading = [...chain.values()].join(" / ");
  let target: string | null = null;
  for (const [band, re] of BAND_PATTERNS) if (re.test(heading)) target = band;
  if (target === null && !/langue|francoph|montréal|montreal|capitale|reste du|région|region|sexe|âge|age/i.test(heading)) {
    target = "national";
  }
  if (target === null) continue;

  const idx = new Map(headers.map((h, i) => [h, i]));
  for (const tr of node.querySelectorAll("tr")) {
    const cells = [...tr.children].filter((c) => c.tagName === "TD");
    if (cells.length < headers.length - 2) continue;
    const date = parseDate(cells[0].textContent ?? "");
    if (!date) continue;
    const firm = (cells[idx.get("Sondeur")!]?.textContent ?? "").replace(/\[.*?\]/g, "").trim().split("/")[0].trim();
    const rec: Record<string, number> = {};
    let ok = 0;
    for (const p of PARTIES) {
      const col = p === "PLQ" ? (idx.has("PLQ") ? "PLQ" : "LIB") : p;
      const i = idx.get(col);
      if (i === undefined || i >= cells.length) continue;
      const v = parseNum(cells[i].textContent ?? "");
      if (v !== null && v > 0) { rec[p] = v; ok++; }
    }
    if (ok >= 4) series[target].set(`${firm}|${date}`, rec);
  }
}

const matched = [...series.national.entries()]
  .filter(([k]) => BANDS.every((b) => series[b].has(k)))
  .map(([k, nat]) => ({ key: k, date: k.split("|")[1], nat, bands: BANDS.map((b) => series[b].get(k)!) }));
console.log(`sondages avec ventilation d'age complete : ${matched.length} (dernier : ${matched.map((m) => m.date).sort().at(-1)})`);

// ---- Pooled age gradient (log-ratio band vs topline) -----------------------
const grad: number[][] = BANDS.map(() => PARTIES.map(() => 0));
const gradSd: number[][] = BANDS.map(() => PARTIES.map(() => 0));
for (let a = 0; a < BANDS.length; a++) {
  for (let p = 0; p < PARTIES.length; p++) {
    const vals = matched
      .filter((m) => m.bands[a][PARTIES[p]] && m.nat[PARTIES[p]])
      .map((m) => Math.log(m.bands[a][PARTIES[p]] / m.nat[PARTIES[p]]));
    const mu = vals.reduce((x, y) => x + y, 0) / vals.length;
    grad[a][p] = mu;
    gradSd[a][p] = Math.sqrt(vals.reduce((x, y) => x + (y - mu) ** 2, 0) / vals.length / vals.length); // se of mean
  }
}
console.log("\ngradient d'age mutualise (log-ratio tranche/topline, ecart type de la moyenne) :");
for (let a = 0; a < BANDS.length; a++) {
  console.log(`  ${BANDS[a].padEnd(6)} ` + PARTIES.map((p, i) =>
    `${p} ${grad[a][i] >= 0 ? "+" : ""}${grad[a][i].toFixed(2)}±${gradSd[a][i].toFixed(2)}`).join("  "));
}

// ---- Correction ------------------------------------------------------------
const close = (v: number[]) => { const s = v.reduce((x, y) => x + y, 0); return v.map((x) => x / s); };
const ACTUAL = close(PARTIES.map((p) => ACTUAL_RAW[p]));
const mae = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length * 100;

function correct(nat: Record<string, number>, wPop: number[], tau: number[]): number[] {
  const wV = close(wPop.map((w, a) => w * tau[a]));
  const wP = close(wPop);
  return close(PARTIES.map((p, pi) => {
    const s = nat[p] ?? 0;
    let mixP = 0, mixV = 0;
    for (let a = 0; a < BANDS.length; a++) {
      const band = s * Math.exp(grad[a][pi]);
      mixP += wP[a] * band;
      mixV += wV[a] * band;
    }
    return s * (mixP > 0 ? mixV / mixP : 1);
  }));
}

// ---- Evaluation: final national poll per firm ------------------------------
const finals = new Map<string, { date: string; nat: Record<string, number> }>();
for (const [k, nat] of series.national) {
  const [firm, date] = k.split("|");
  if (date < "2022-09-20" || date > "2022-10-03") continue;
  const cur = finals.get(firm);
  if (!cur || date > cur.date) finals.set(firm, { date, nat });
}
console.log(`\nsondages finaux (20 sept - 3 oct, dernier par maison) : ${finals.size}`);

const CASES: [string, number[], number[]][] = [
  ["central (recens., DGE-6281)", [25.6, 33.4, 41.0], [54.4, 63.3, 73.2]],
  ["structure vieillie (~2022)", [24.5, 31.5, 44.0], [54.4, 63.3, 73.2]],
  ["participation aplatie", [25.6, 33.4, 41.0], [59.4, 65.3, 71.2]],
  ["participation accentuee", [25.6, 33.4, 41.0], [49.4, 61.3, 75.2]],
];

for (const [label, wPop, tau] of CASES) {
  let e0 = 0, e1 = 0;
  const detail: string[] = [];
  for (const [firm, f] of finals) {
    const u = close(PARTIES.map((p) => f.nat[p] ?? 0));
    const c = correct(f.nat, wPop, tau);
    e0 += mae(u, ACTUAL); e1 += mae(c, ACTUAL);
    if (label.startsWith("central")) {
      detail.push(`    ${firm.padEnd(14)} ${f.date}  MAE brut ${mae(u, ACTUAL).toFixed(2)}  corrige ${mae(c, ACTUAL).toFixed(2)}` +
        `  CAQ ${(u[0] * 100).toFixed(1)} -> ${(c[0] * 100).toFixed(1)} (reel ${(ACTUAL[0] * 100).toFixed(1)})`);
    }
  }
  console.log(`\n${label}: MAE brut ${(e0 / finals.size).toFixed(3)} pp, corrige ${(e1 / finals.size).toFixed(3)} pp` +
    ` (delta ${(e1 - e0) / finals.size >= 0 ? "+" : ""}${((e1 - e0) / finals.size).toFixed(3)})`);
  for (const l of detail) console.log(l);
}

// Magnitude of the correction itself (central case), for scale.
const [, wPop0, tau0] = CASES[0];
const sample = [...finals.values()][0];
if (sample) {
  const u = close(PARTIES.map((p) => sample.nat[p] ?? 0));
  const c = correct(sample.nat, wPop0, tau0);
  console.log("\nampleur de la correction (exemple, points de %) : " +
    PARTIES.map((p, i) => `${p} ${((c[i] - u[i]) * 100 >= 0 ? "+" : "")}${((c[i] - u[i]) * 100).toFixed(2)}`).join("  "));
}
