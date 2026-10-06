/**
 * Spatial correlation of riding residuals between NEIGHBOURS (five-agent
 * review, 2026-10-06): the simulation resamples riding residuals i.i.d.
 * after removing regional means, which thins the seat tails if adjacent
 * ridings actually move together (the 2026 failures were contiguous
 * blocks: the Mauricie belt, the QS urban core).
 *
 * Estimate: adjacency graph of the 127 ridings from shared polygon
 * vertices (DGEQ-derived geojson shares exact boundary coordinates);
 * residual = 2022->2026 departure change, de-meaned by region (MTL/QC/REG,
 * same decomposition as the simulation); report the correlation of
 * residual pairs for adjacent ridings vs a permutation baseline, per ILR
 * coordinate and pooled. A clearly positive neighbour correlation is the
 * prerequisite for replacing the i.i.d. resampling by a CAR/Matern field
 * on the adjacency graph; a null result closes the question.
 *
 * Run: node js/tools/neighbor_correlation.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { residualIlr, PARTIES } from "../src/ridingEffects.js";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const geo = load("../data/qc_ridings_2026.geojson");
const regions = load("../data/qc_riding_regions.json");
const baseline26 = load("../data/qc_2022_baseline_2026map.json");
const dgeq = JSON.parse(readFileSync(new URL("../../data/raw/lus/2026-10-05-resultats-dgeq.json", import.meta.url), "utf-8"));

// --- residuals (2022->2026 departure change, by riding code) ------------
const MAP = { "PQ": "PQ", "PLQ/QLP": "LIB", "PCOQ": "PCQ", "ÉCF-CAQ": "CAQ", "QS": "QS" };
const rows2026 = [];
for (const c of dgeq.circonscriptions) {
  for (const cand of c.candidats) {
    rows2026.push({
      election_date: "2026-10-05", boundary_year: "2026", riding_code: String(c.numeroCirconscription),
      party_code: MAP[cand.abreviationPartiPolitique] ?? "AUTRES", votes: cand.nbVoteTotal,
    });
  }
}
const rows22 = baseline26.map((r) => ({
  election_date: "2022-10-03", boundary_year: "2026", riding_code: String(r.riding_code),
  party_code: r.party_code, votes: r.votes,
}));
const res = residualIlr([...rows22, ...rows2026], "2022-10-03", "2026", "2026-10-05", "2026", PARTIES);
const Y = new Map(res.ridings.map((r, i) => [String(r), res.Y[i]]));
const nC = res.Y[0].length;

// de-mean by region, mirroring the simulation's decomposition
const regionOf = {};
for (const r of regions) regionOf[String(r.riding_code)] = r.region_code;
const sums = new Map(), counts = new Map();
for (const [code, y] of Y) {
  const reg = regionOf[code] ?? "?";
  if (!sums.has(reg)) { sums.set(reg, new Array(nC).fill(0)); counts.set(reg, 0); }
  y.forEach((v, j) => sums.get(reg)[j] += v);
  counts.set(reg, counts.get(reg) + 1);
}
const Yd = new Map();
for (const [code, y] of Y) {
  const reg = regionOf[code] ?? "?";
  const m = sums.get(reg).map((v) => v / counts.get(reg));
  Yd.set(code, y.map((v, j) => v - m[j]));
}

// --- adjacency from shared vertices --------------------------------------
const vertexOwners = new Map(); // "x|y" -> Set(codes)
for (const f of geo.features) {
  const code = String(f.properties.riding_code);
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) for (const ring of poly) for (const [x, y] of ring) {
    const key = `${x.toFixed(5)}|${y.toFixed(5)}`;
    if (!vertexOwners.has(key)) vertexOwners.set(key, new Set());
    vertexOwners.get(key).add(code);
  }
}
const sharedCount = new Map(); // "a|b" -> n shared vertices
for (const owners of vertexOwners.values()) {
  if (owners.size < 2) continue;
  const list = [...owners].sort();
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const key = `${list[i]}|${list[j]}`;
    sharedCount.set(key, (sharedCount.get(key) ?? 0) + 1);
  }
}
const adjacent = [...sharedCount.entries()].filter(([, n]) => n >= 2).map(([k]) => k.split("|"));
console.log(`${adjacent.length} paires adjacentes (>=2 sommets partages) sur ${geo.features.length} circonscriptions`);

// --- neighbour correlation vs permutation baseline ------------------------
const corrOf = (pairs) => {
  // pooled across coordinates, standardized per coordinate
  const sd = Array.from({ length: nC }, (_, j) => {
    const vals = [...Yd.values()].map((y) => y[j]);
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length) || 1;
  });
  let num = 0, n = 0;
  const perCoord = new Array(nC).fill(0);
  const perCoordN = new Array(nC).fill(0);
  for (const [a, b] of pairs) {
    const ya = Yd.get(a), yb = Yd.get(b);
    if (!ya || !yb) continue;
    for (let j = 0; j < nC; j++) {
      const z = (ya[j] / sd[j]) * (yb[j] / sd[j]);
      num += z; n++;
      perCoord[j] += z; perCoordN[j]++;
    }
  }
  return { pooled: num / n, perCoord: perCoord.map((v, j) => v / perCoordN[j]) };
};

const obs = corrOf(adjacent);
console.log(`correlation voisins (apres de-moyennage regional), pooled : ${obs.pooled.toFixed(3)}`);
console.log(`  par coordonnee ILR : [${obs.perCoord.map((v) => v.toFixed(2)).join(", ")}]`);

// permutation baseline: shuffle codes
let state = 7;
const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff), state / 0x7fffffff);
const codes = [...Yd.keys()];
const perms = [];
for (let rep = 0; rep < 200; rep++) {
  const shuffled = [...codes];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const mapTo = new Map(codes.map((c, i) => [c, shuffled[i]]));
  perms.push(corrOf(adjacent.map(([a, b]) => [mapTo.get(a), mapTo.get(b)])).pooled);
}
perms.sort((a, b) => a - b);
console.log(`permutation (200 rep) : mediane ${perms[100].toFixed(3)}, p95 ${perms[190].toFixed(3)}, p99 ${perms[198].toFixed(3)}`);
console.log(obs.pooled > perms[198] ? "=> correlation de voisinage SIGNIFICATIVE (p<0,01)" :
  obs.pooled > perms[190] ? "=> significative a p<0,05" : "=> non significative");
