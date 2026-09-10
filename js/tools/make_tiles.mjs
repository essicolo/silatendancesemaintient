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
for (const c of tiles) {
  const geoX = (c.lon - minLon) / (maxLon - minLon);
  const geoY = (maxLat - c.lat) / (maxLat - minLat);
  c.tx = (ALPHA * geoX + (1 - ALPHA) * c.rankX) * (COLS - 1);
  c.ty = (ALPHA * geoY + (1 - ALPHA) * c.rankY) * (ROWS - 1);
}

const cells = [];
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) cells.push({ col: c, row: r });
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
writeFileSync(new URL("qc_tile_layout.json", dataDir), JSON.stringify(layout, null, 1), "utf-8");

// ASCII preview so layout changes are reviewable in a terminal or a diff.
const grid = Array.from({ length: ROWS }, () => Array(COLS).fill("     "));
for (const t of tiles) grid[t.cell.row][t.cell.col] = (abbr(t.name) + "     ").slice(0, 5);
console.log(grid.map((r) => r.join("")).join("\n"));
const w = Math.max(...tiles.map((t) => t.x)) - minX, h = Math.max(...tiles.map((t) => t.y)) - minY;
console.log(`qc_tile_layout.json : ${tiles.length} tuiles, emprise ${w.toFixed(1)}x${h.toFixed(1)}`);
