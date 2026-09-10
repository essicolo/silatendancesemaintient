/**
 * Tile-cartogram layout for the 127 ridings -- v4.
 *
 * Three earlier attempts taught the constraints:
 *  - v1 (pure rank, 91%-full grid): every relation preserved, no SHAPE --
 *    a featureless checkerboard.
 *  - v3 (Dorling force relaxation): organic, but collisions expand dense
 *    clusters into whatever space is empty, ORDER breaks -- east-Montreal
 *    ridings ended up beside Chicoutimi.
 *  - The keeper (v2): BLENDED targets, x' = a*geo + (1-a)*rank per axis.
 *    The geo part keeps Quebec's silhouette (empty north, Gaspe tail); the
 *    rank part decompresses the island of Montreal. The blend is MONOTONE
 *    per axis, so no east/west or north/south relation can ever flip --
 *    the property the force pass lost.
 *
 * Pipeline: blended targets -> one-cell-per-riding assignment on a sparse
 * grid (greedy hardest-first, then improvement by swaps and moves; overlap-
 * free by construction) -> void squeeze (fully empty rows/columns collapse
 * to a fixed breathing gap; whole half-planes shift together, so order and
 * overlap-freedom survive).
 *
 * Runs ONCE and exports tile centres (unit = one tile side) to
 * js/data/qc_tile_layout.json {riding_code: {x, y, name, abbr}}; the page
 * just draws squares. Regenerate after a redistricting:
 *   node js/tools/make_tiles.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";

const dataDir = new URL("../data/", import.meta.url);
const geo = JSON.parse(readFileSync(new URL("qc_ridings_2026.geojson", dataDir), "utf-8"));

const COLS = 18, ROWS = 12; // 216 cells for 127 tiles: voids draw the shape
const ALPHA = 0.7; // weight of raw geography vs rank in the blend
const PITCH = 1.12; // centre-to-centre distance, in tile sides
const MAXGAP = 2.0; // widest allowed fully-empty span, in tile sides

const tiles = geo.features.map((f) => {
  const rings = f.geometry.type === "Polygon" ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((p) => p[0]);
  let sx = 0, sy = 0, n = 0;
  for (const ring of rings) for (const [x, y] of ring) { sx += x; sy += y; n++; }
  return { code: String(f.properties.riding_code), name: f.properties.riding_name, lon: sx / n, lat: sy / n };
});

const minLon = Math.min(...tiles.map((c) => c.lon)), maxLon = Math.max(...tiles.map((c) => c.lon));
const minLat = Math.min(...tiles.map((c) => c.lat)), maxLat = Math.max(...tiles.map((c) => c.lat));
const byLon = [...tiles].sort((a, b) => a.lon - b.lon);
const byLat = [...tiles].sort((a, b) => b.lat - a.lat); // north at top
byLon.forEach((c, i) => { c.rankX = i / (byLon.length - 1); });
byLat.forEach((c, i) => { c.rankY = i / (byLat.length - 1); });
// Which SHORE of the St. Lawrence a centroid sits on, for ridings east of
// Montreal where the river actually separates the map (upstream it runs
// through the metropolis). Approximate river polyline, cross-product side.
const RIVER = [[-73.5, 45.62], [-72.55, 46.35], [-71.2, 46.82], [-68.5, 48.45], [-66.0, 49.2]];
function shoreOf(lon, lat) {
  if (lon < -73.3) return 0; // metro area and upstream: no split
  let seg = RIVER.length - 2;
  for (let i = 0; i < RIVER.length - 1; i++) if (lon < RIVER[i + 1][0]) { seg = i; break; }
  const [x1, y1] = RIVER[seg], [x2, y2] = RIVER[seg + 1];
  const cross = (x2 - x1) * (lat - y1) - (y2 - y1) * (lon - x1);
  return cross > 0 ? -1 : 1; // -1 north shore (up), +1 south shore (down)
}

for (const c of tiles) {
  const geoX = (c.lon - minLon) / (maxLon - minLon);
  const geoY = (maxLat - c.lat) / (maxLat - minLat);
  c.tx = (ALPHA * geoX + (1 - ALPHA) * c.rankX) * (COLS - 1);
  c.ty = (ALPHA * geoY + (1 - ALPHA) * c.rankY) * (ROWS - 1);
  // Pry the two shores apart: the diagonal void this creates IS the river,
  // the single strongest geographic landmark a Quebec map can carry.
  c.ty += shoreOf(c.lon, c.lat) * 0.95;
}

// BRICK lattice, not a square grid: odd rows sit half a tile over, which
// breaks the rigid column alignment that made earlier versions read as a
// checkerboard, while changing no ordering property of the assignment.
const cells = [];
for (let r = 0; r < ROWS + 2; r++) {
  for (let c = 0; c < COLS; c++) cells.push({ col: c + (r % 2) * 0.5, row: r });
}
const d2 = (t, cell) => (t.tx - cell.col) ** 2 + (t.ty - cell.row) ** 2;

// Greedy hardest-first, then improvement (swaps + moves to empty cells).
const free = new Set(cells);
const todo = new Set(tiles);
while (todo.size) {
  let pick = null, pickCell = null, pickBest = -1;
  for (const t of todo) {
    let best = null, bestD = Infinity;
    for (const cell of free) {
      const d = d2(t, cell);
      if (d < bestD) { bestD = d; best = cell; }
    }
    if (bestD > pickBest) { pickBest = bestD; pick = t; pickCell = best; }
  }
  pick.cell = pickCell;
  free.delete(pickCell);
  todo.delete(pick);
}
let improved = true;
while (improved) {
  improved = false;
  for (const a of tiles) {
    for (const cell of free) {
      if (d2(a, cell) < d2(a, a.cell)) { free.add(a.cell); free.delete(cell); a.cell = cell; improved = true; }
    }
    for (const b of tiles) {
      if (a === b) continue;
      if (d2(a, b.cell) + d2(b, a.cell) < d2(a, a.cell) + d2(b, b.cell) - 1e-9) {
        const t = a.cell; a.cell = b.cell; b.cell = t; improved = true;
      }
    }
  }
}
for (const t of tiles) { t.x = t.cell.col * PITCH; t.y = t.cell.row * PITCH; }

// Void squeeze: collapse fully empty rows/columns beyond MAXGAP. Whole
// half-planes shift together: order intact, no overlap can appear.
for (const axis of ["x", "y"]) {
  const vals = [...new Set(tiles.map((t) => +t[axis].toFixed(4)))].sort((a, b) => a - b);
  let shift = 0;
  const shiftAt = new Map();
  for (let i = 0; i < vals.length; i++) {
    if (i > 0) {
      const gap = vals[i] - vals[i - 1];
      if (gap > MAXGAP) shift += gap - MAXGAP;
    }
    shiftAt.set(vals[i], shift);
  }
  for (const t of tiles) t[axis] -= shiftAt.get(+t[axis].toFixed(4));
}

const abbr = (name) =>
  name
    .replace(/Saint-/g, "St-").replace(/Sainte-/g, "Ste-")
    .split(/[\s–—-]+/)
    .map((w) => (/^(de|du|des|la|le|les|d'|l')$/i.test(w) ? "" : w.slice(0, 3)))
    .filter(Boolean)
    .slice(0, 2)
    .join("·");

const minX = Math.min(...tiles.map((t) => t.x)), minY = Math.min(...tiles.map((t) => t.y));
const layout = Object.fromEntries(
  tiles.map((t) => [t.code, {
    x: +(t.x - minX).toFixed(2),
    y: +(t.y - minY).toFixed(2),
    name: t.name,
    abbr: abbr(t.name),
  }]),
);
// Region labels anchored on NAMED member ridings -- lat/lon boxes misfire
// here because polygon centroids of the huge northern ridings (Roberval,
// Lac-Saint-Jean) sit far north of their population. Labels are placed
// above their cluster and lifted until they overlap no tile; decorative
// bearings, not boundaries.
const norm = (x) => x.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
const REGION_GROUPS = [
  ["Nord-du-Québec", "above", ["Ungava"]],
  ["Côte-Nord", "above", ["Duplessis", "René-Lévesque"]],
  ["Saguenay–Lac-St-Jean", "above", ["Chicoutimi", "Jonquière", "Dubuc", "Roberval", "Lac-Saint-Jean"]],
  ["Abitibi", "above", ["Abitibi-Est", "Abitibi-Ouest", "Rouyn-Noranda"]],
  ["Outaouais", "below", ["Hull", "Gatineau", "Pontiac", "Papineau", "Chapleau"]],
  ["Gaspésie–Bas-St-Laurent", "above", ["Gaspé", "Matane", "Rimouski", "Bonaventure"]],
  ["Montréal", "below", ["Westmount", "Mercier", "Hochelaga", "Acadie", "Saint-Laurent"]],
  ["Estrie", "below", ["Orford", "Sherbrooke", "Mégantic", "Saint-François"]],
];
const width = Math.max(...tiles.map((t) => t.x)) - minX;
const regions = [];
for (const [label, side, keys] of REGION_GROUPS) {
  const hit = tiles.filter((t) => keys.some((k) => norm(t.name).includes(norm(k))));
  if (!hit.length) { console.warn(`  ! région sans membres: ${label}`); continue; }
  const dir = side === "above" ? -1 : 1;
  let lx = hit.reduce((s2, t) => s2 + t.x - minX, 0) / hit.length;
  let ly = (side === "above"
    ? Math.min(...hit.map((t) => t.y - minY)) - 1.0
    : Math.max(...hit.map((t) => t.y - minY)) + 1.1);
  const halfW = label.length * 0.085;
  lx = Math.min(Math.max(lx, halfW + 0.2), width - halfW - 0.2);
  // Lift AWAY from the map (up for northern clusters, down for southern
  // ones): lifting bottom labels upward walked them through the dense
  // St. Lawrence valley and parked ESTRIE on top of Taschereau.
  const collidesTile = () =>
    tiles.some((t) => Math.abs(t.x - minX - lx) < halfW + 0.6 && Math.abs(t.y - minY - ly) < 0.72);
  const collidesLabel = () =>
    regions.some((r) => Math.abs(r.x - lx) < halfW + r.label.length * 0.085 + 0.3 && Math.abs(r.y - ly) < 0.8);
  for (let lift = 0; lift < 12 && (collidesTile() || collidesLabel()); lift++) ly += dir * 0.45;
  regions.push({ label, x: +lx.toFixed(2), y: +ly.toFixed(2) });
}

writeFileSync(
  new URL("qc_tile_layout.json", dataDir),
  JSON.stringify({ tiles: layout, regions }, null, 1),
  "utf-8",
);

// ASCII preview so layout changes are reviewable in a terminal or a diff.
const grid = Array.from({ length: ROWS + 2 }, () => Array(COLS + 1).fill("     "));
for (const t of tiles) if (grid[t.cell.row]) grid[t.cell.row][Math.round(t.cell.col)] = (abbr(t.name) + "     ").slice(0, 5);
console.log(grid.map((r) => r.join("")).join("\n"));
const w = Math.max(...tiles.map((t) => t.x)) - minX, h = Math.max(...tiles.map((t) => t.y)) - minY;
console.log(`qc_tile_layout.json : ${tiles.length} tuiles, emprise ${w.toFixed(1)}x${h.toFixed(1)}`);
