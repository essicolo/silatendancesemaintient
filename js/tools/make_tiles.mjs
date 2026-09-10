/**
 * Tile-cartogram layout for the 127 ridings, US-state-grid style: every
 * riding gets ONE equal-size cell, placed with rough geographic sense.
 *
 * Raw coordinates cannot work directly -- 27 island-of-Montreal ridings
 * occupy 0.1% of Quebec's area -- so each centroid is first RANK-normalised
 * (x = rank of longitude, y = rank of latitude): dense clusters decompress,
 * empty north compresses, while every east/west and north/south relation is
 * preserved. Ridings are then greedily assigned to the nearest free cell of
 * the grid, hardest-to-please first (those whose nearest cells are most
 * contested move first).
 *
 * Output: js/data/qc_tile_layout.json  {riding_code: {col, row, name, abbr}}
 * Regenerate after a redistricting: node js/tools/make_tiles.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";

const dataDir = new URL("../data/", import.meta.url);
const geo = JSON.parse(readFileSync(new URL("qc_ridings_2026.geojson", dataDir), "utf-8"));

const COLS = 14, ROWS = 10; // 140 cells for 127 ridings: a little slack

const centroids = geo.features.map((f) => {
  const rings = f.geometry.type === "Polygon" ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((p) => p[0]);
  let sx = 0, sy = 0, n = 0;
  for (const ring of rings) for (const [x, y] of ring) { sx += x; sy += y; n++; }
  return { code: String(f.properties.riding_code), name: f.properties.riding_name, lon: sx / n, lat: sy / n };
});

// Rank-normalise to [0, 1].
const byLon = [...centroids].sort((a, b) => a.lon - b.lon);
const byLat = [...centroids].sort((a, b) => b.lat - a.lat); // north at top
byLon.forEach((c, i) => { c.rx = i / (byLon.length - 1); });
byLat.forEach((c, i) => { c.ry = i / (byLat.length - 1); });

const cells = [];
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) cells.push({ col: c, row: r, taken: false });
const cellDist = (rc, cell) =>
  (rc.rx * (COLS - 1) - cell.col) ** 2 + (rc.ry * (ROWS - 1) - cell.row) ** 2;

// Hardest-first greedy: repeatedly place the riding whose best free cell is
// worst (max of min distances), into its best free cell. O(n^2 m), tiny.
const todo = new Set(centroids);
while (todo.size) {
  let pick = null, pickCell = null, pickBest = -1;
  for (const rc of todo) {
    let best = null, bestD = Infinity;
    for (const cell of cells) {
      if (cell.taken) continue;
      const d = cellDist(rc, cell);
      if (d < bestD) { bestD = d; best = cell; }
    }
    if (bestD > pickBest) { pickBest = bestD; pick = rc; pickCell = best; }
  }
  pickCell.taken = true;
  pick.col = pickCell.col;
  pick.row = pickCell.row;
  todo.delete(pick);
}

// Short labels: initials of the hyphen/space-separated parts (Saint -> St).
const abbr = (name) =>
  name
    .replace(/Saint-/g, "St-").replace(/Sainte-/g, "Ste-")
    .split(/[\s–—-]+/)
    .map((w) => (/^(de|du|des|la|le|les|d'|l')$/i.test(w) ? "" : w.slice(0, 3)))
    .filter(Boolean)
    .slice(0, 2)
    .join("·");

const layout = Object.fromEntries(
  centroids.map((c) => [c.code, { col: c.col, row: c.row, name: c.name, abbr: abbr(c.name) }]),
);
writeFileSync(new URL("qc_tile_layout.json", dataDir), JSON.stringify(layout, null, 1), "utf-8");
console.log(`qc_tile_layout.json : ${centroids.length} tuiles sur ${COLS}x${ROWS}`);
