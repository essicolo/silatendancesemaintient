/**
 * Federal 2025 (GE45) vote composition per PROVINCIAL riding, both maps.
 *
 * Inputs (data/raw/federal_ge45/):
 *  - pollresults_resultatsbureau24001..24078.csv (Elections Canada, long
 *    form: one row per candidate x polling division, final counts);
 *  - pd_2025/SHP/PD_CA_2025_EN.shp (polling division boundaries, Lambert
 *    conformal conic; 17,762 QC divisions).
 *
 * Method: each ordinary polling division's centroid (computed in Lambert,
 * inverse-projected to lon/lat) is assigned to the provincial riding
 * containing it (2026 map, 127; 2017 map, 125) by point-in-polygon with a
 * bbox prefilter. Advance/SVR/mobile rows that match no mapped division
 * are allocated pro rata to each riding according to the party's own
 * geographic distribution of matched votes within that federal district.
 * Output: js/data/qc_federal_2025.json -- per map, per riding_code, vote
 * SHARES over {BQ, PLC, PCC, NPD, AUTRES} (Greens and small parties in
 * AUTRES).
 *
 * Run: node js/tools/make_federal.mjs   (from the repo root; ~1 min)
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import shapefile from "shapefile";
import proj4 from "proj4";

const LAMBERT = "+proj=lcc +lat_1=49 +lat_2=77 +lat_0=63.390675 +lon_0=-91.86666666666666 +x_0=6200000 +y_0=3000000 +datum=NAD83 +units=m +no_defs";
const toLonLat = (xy) => proj4(LAMBERT, "WGS84", xy);

const PARTY_MAP = new Map([
  ["Bloc Québécois", "BQ"],
  ["Liberal", "PLC"],
  ["Conservative", "PCC"],
  ["NDP-New Democratic Party", "NPD"],
]);
const PARTIES = ["BQ", "PLC", "PCC", "NPD", "AUTRES"];

// --- provincial riding polygons, both maps -----------------------------
const loadMap = (path) => {
  const g = JSON.parse(readFileSync(path, "utf8"));
  return g.features.map((f) => {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of polys) for (const [x, y] of poly[0]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { code: String(f.properties.riding_code), polys, bbox: [x0, y0, x1, y1] };
  });
};
const inRing = ([x, y], ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const ridingOf = (pt, map) => {
  for (const r of map) {
    if (pt[0] < r.bbox[0] || pt[0] > r.bbox[2] || pt[1] < r.bbox[1] || pt[1] > r.bbox[3]) continue;
    for (const poly of r.polys) {
      if (inRing(pt, poly[0])) {
        let hole = false;
        for (let h = 1; h < poly.length; h++) if (inRing(pt, poly[h])) { hole = true; break; }
        if (!hole) return r.code;
      }
    }
  }
  return null;
};
const map2026 = loadMap(new URL("../data/qc_ridings_2026.geojson", import.meta.url));
const map2017 = loadMap(new URL("../../data/raw/lus/qc_ridings_2017.geojson", import.meta.url));

// --- PD centroids -> provincial riding ---------------------------------
console.log("lecture du shapefile des sections de vote...");
const pdRiding = new Map(); // "fed|pdnum" -> {r26, r17}
const src = await shapefile.open(new URL("../../data/raw/federal_ge45/pd_2025/SHP/PD_CA_2025_EN.shp", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
let rec = await src.read(), nQc = 0, unassigned = 0;
while (!rec.done) {
  const p = rec.value.properties;
  if (String(p.FED_NUM).startsWith("24")) {
    nQc++;
    const polys = rec.value.geometry.type === "Polygon" ? [rec.value.geometry.coordinates] : rec.value.geometry.coordinates;
    // area-weighted centroid over outer rings (Lambert, planar)
    let A = 0, cx = 0, cy = 0;
    for (const poly of polys) {
      const ring = poly[0];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
        A += cross;
        cx += (ring[j][0] + ring[i][0]) * cross;
        cy += (ring[j][1] + ring[i][1]) * cross;
      }
    }
    const pt = toLonLat(A !== 0 ? [cx / (3 * A), cy / (3 * A)] : [polys[0][0][0][0], polys[0][0][0][1]]);
    const r26 = ridingOf(pt, map2026);
    const r17 = ridingOf(pt, map2017);
    if (!r26 && !r17) unassigned++;
    else pdRiding.set(`${p.FED_NUM}|${p.PD_NUM}`, { r26, r17 });
  }
  rec = await src.read();
}
console.log(`${nQc} sections QC, ${pdRiding.size} assignees, ${unassigned} hors cartes`);

// --- results CSVs -------------------------------------------------------
const dir = new URL("../../data/raw/federal_ge45/", import.meta.url);
const parseCsvLine = (line) => {
  const out = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};

const acc = { map2026: new Map(), map2017: new Map() }; // riding -> party -> votes
const add = (accMap, riding, party, v) => {
  if (!riding || !v) return;
  if (!accMap.has(riding)) accMap.set(riding, Object.fromEntries(PARTIES.map((p) => [p, 0])));
  accMap.get(riding)[party] += v;
};

let matchedVotes = 0, floatingVotes = 0;
for (const f of readdirSync(dir).filter((f) => /^pollresults_.*\.csv$/.test(f))) {
  const lines = readFileSync(new URL(f, dir), "utf8").split(/\r?\n/).slice(1).filter(Boolean);
  const fed = f.match(/(\d{5})/)[1];
  // per-ED tallies: matched by (riding, party), floating by party
  const edMatched = { map2026: new Map(), map2017: new Map() };
  const floating = Object.fromEntries(PARTIES.map((p) => [p, 0]));
  for (const line of lines) {
    const c = parseCsvLine(line);
    const pdRaw = c[3].trim();
    const partyEn = c[13];
    const votes = Number(c[17]);
    if (!votes) continue;
    const party = PARTY_MAP.get(partyEn) ?? "AUTRES";
    const pdNum = parseInt(pdRaw, 10); // "45A" -> 45 (mobile shares the division)
    const hit = Number.isFinite(pdNum) ? pdRiding.get(`${Number(fed)}|${pdNum}`) : null;
    if (hit) {
      matchedVotes += votes;
      add(edMatched.map2026, hit.r26, party, votes);
      add(edMatched.map2017, hit.r17, party, votes);
    } else {
      floatingVotes += votes;
      floating[party] += votes;
    }
  }
  // allocate floating votes (advance, SVR) pro rata of the party's own
  // matched geography within this federal district
  for (const mapKey of ["map2026", "map2017"]) {
    for (const party of PARTIES) {
      const tot = [...edMatched[mapKey].values()].reduce((s, v) => s + v[party], 0);
      for (const [riding, v] of edMatched[mapKey]) {
        add(acc[mapKey], riding, party, v[party] + (tot > 0 ? (floating[party] * v[party]) / tot : 0));
      }
    }
  }
}
console.log(`votes geolocalises : ${matchedVotes}, flottants (anticipation/REV) repartis : ${floatingVotes} (${(floatingVotes / (matchedVotes + floatingVotes) * 100).toFixed(1)} %)`);

// --- shares + output -----------------------------------------------------
const out = {};
for (const mapKey of ["map2026", "map2017"]) {
  out[mapKey] = {};
  for (const [riding, v] of acc[mapKey]) {
    const tot = PARTIES.reduce((s, p) => s + v[p], 0);
    out[mapKey][riding] = Object.fromEntries(PARTIES.map((p) => [p, +(v[p] / tot).toFixed(5)]));
  }
}
console.log(`circonscriptions couvertes : 2026 ${Object.keys(out.map2026).length}/127, 2017 ${Object.keys(out.map2017).length}/125`);
writeFileSync(new URL("../data/qc_federal_2025.json", import.meta.url), JSON.stringify({
  source: "Élections Canada, 45e élection générale (2025-04-28), résultats par section de vote (ovrGE45) + limites des sections (PD_CA_2025)",
  method: "centroïde de section -> circonscription provinciale; votes anticipés/REV répartis au prorata de la géographie du parti dans la circonscription fédérale",
  parties: PARTIES,
  ...out,
}, null, 1));
console.log("qc_federal_2025.json ecrit");

// provincial sanity: QC-wide shares
const prov = Object.fromEntries(PARTIES.map((p) => [p, 0]));
for (const v of acc.map2026.values()) for (const p of PARTIES) prov[p] += v[p];
const pt = PARTIES.reduce((s, p) => s + prov[p], 0);
console.log("part provinciale (controle vs resultat officiel QC du 28 avril 2025) :",
  PARTIES.map((p) => `${p} ${(prov[p] / pt * 100).toFixed(1)}`).join("  "));
