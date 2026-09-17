/**
 * Browser entry point: fetches the exported data, runs the compositional/GP/
 * swing/simulation pipeline client-side, and renders the dashboard. See
 * index.html for the section layout.
 *
 * Every section is wrapped independently (section()) so one failing section
 * leaves the rest of the dashboard intact instead of blanking the whole page.
 */

import * as Plot from "@observablehq/plot";
import { mva } from "@tangent.to/ds";
import L from "leaflet";
// leaflet.css is linked directly from index.html (copied to dist/leaflet/)
// rather than imported here, so esbuild doesn't need CSS-bundling config.
import { pivotPolls } from "./compositional.js";
import { normalizeRidingCode } from "./swing.js";

const PARTY_COLORS = {
  CAQ: "#12BBFF",
  LIB: "#d90000",
  QS: "#ff5402",
  PQ: "#0101CC",
  PCQ: "#172853",
  AUTRES: "#999999",
};


// A range is either rolling (`days` back from today) or anchored (`since` a
// fixed date). "Depuis 2022" anchors at the last general election -- the
// natural "this whole cycle" view, which no rolling window can express.
const RANGES = [
  { label: "3 mois", days: 90 },
  { label: "6 mois", days: 182 },
  { label: "1 an", days: 365 },
  { label: "Depuis l'élection 2022", since: "2022-10-03" },
  { label: "Tout", days: null },
];

function section(id, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[dashboard] section "${id}" failed:`, err);
    const el = document.getElementById(id);
    if (el) el.textContent = `Erreur (${id}) : ${err.message}`;
  }
}

function colorScale(partyCodes) {
  return { domain: partyCodes, range: partyCodes.map((p) => PARTY_COLORS[p] ?? "#ccc") };
}

// ---- Shared selection state --------------------------------------------
// A single selectRiding() call drives the map highlight, the popup, the
// detail panel, and the watchlist row highlight together, so a click in any
// one of those three places produces the same visible, connected result in
// all three -- instead of one view silently updating far from where the
// user clicked.

const registry = {
  partyCodes: null,
  nameByCode: new Map(),
  ridingForecast: null,
  ridingBaseline: null,
  mapLayersByCode: new Map(),
  watchlistRowsByCode: new Map(),
  leafletMap: null,
  defaultStyleByCode: new Map(),
  tileByCode: new Map(),
  tileSelFrame: null,
};

function selectRiding(code, { zoom = true } = {}) {
  const name = registry.nameByCode.get(code) ?? code;
  const entry = registry.ridingForecast.get(code);
  if (!entry) return;
  registry.selectedCode = code;

  renderRidingDetail(code, name, entry, registry.ridingBaseline.sharesFor(code), registry.partyCodes,
    registry.winProbs?.[code] ?? null, registry.candidates?.[code] ?? null);

  // Map: reset every layer to its default style, then highlight the
  // selected one with a heavy black outline that stays until the next
  // selection (not just on hover) -- a persistent "you clicked this" mark.
  for (const [c, layer] of registry.mapLayersByCode) {
    layer.setStyle(registry.defaultStyleByCode.get(c));
  }
  const selectedLayer = registry.mapLayersByCode.get(code);
  if (selectedLayer) {
    selectedLayer.setStyle({ weight: 3.5, color: "#000" });
    selectedLayer.bringToFront();
    selectedLayer
      .bindPopup(`<strong>${name}</strong><br>${entry.winner} ${(entry.shares[entry.winner] * 100).toFixed(0)}%`)
      .openPopup();
    const geoVisible = !document.getElementById("riding-map")?.hidden;
    if (zoom && geoVisible && registry.leafletMap) {
      registry.leafletMap.fitBounds(selectedLayer.getBounds(), { maxZoom: 9 });
    }
  }

  // Tile cartogram: move the selection frame onto the chosen tile.
  const tile = registry.tileByCode.get(code);
  if (tile && registry.tileSelFrame) {
    const f = registry.tileSelFrame;
    f.setAttribute("x", tile.getAttribute("x"));
    f.setAttribute("y", tile.getAttribute("y"));
    f.setAttribute("width", tile.getAttribute("width"));
    f.setAttribute("height", tile.getAttribute("height"));
    f.removeAttribute("hidden");
  }

  // Watchlist: highlight the matching row (if it's in the top-N list) and
  // scroll it into view.
  for (const row of registry.watchlistRowsByCode.values()) row.classList.remove("selected-row");
  const watchRow = registry.watchlistRowsByCode.get(code);
  if (watchRow) {
    watchRow.classList.add("selected-row");
    watchRow.scrollIntoView({ block: "nearest" });
  }

  // Detail panel: a brief flash draws the eye to it, since it can be a
  // fair distance from wherever the click happened.
  const detailSection = document.getElementById("riding-detail").closest("section");
  detailSection.classList.remove("flash");
  void detailSection.offsetWidth; // restart the CSS animation
  detailSection.classList.add("flash");
}

function renderRidingDetail(code, name, forecastEntry, baselineShares, partyCodes, winProbs, candidates) {
  const host = document.getElementById("riding-detail");
  host.innerHTML = "";

  const title = document.createElement("h3");
  title.textContent = name;
  host.appendChild(title);

  const rows = partyCodes
    .map((p) => ({
      party: p,
      projected: forecastEntry.shares[p],
      baseline: baselineShares?.[p] ?? null,
      pWin: winProbs?.[p] ?? null,
    }))
    .sort((a, b) => (b.pWin ?? b.projected) - (a.pWin ?? a.projected) || b.projected - a.projected);

  // Ranked by CHANCE OF WINNING, the number that colours the map, so the
  // first row always matches the tile -- ranking by projected share instead
  // made the panel contradict the map in close multi-way races (Jean-Lesage:
  // QS ahead by 0.8 in the central scenario, PCQ the likelier winner).
  // Plain-language headers on purpose.
  const table = document.createElement("table");
  const candCol = candidates ? "<th>Candidat.e</th>" : "";
  table.innerHTML =
    `<thead><tr><th>Parti</th>${candCol}<th>Chances de gagner</th><th>Appui projeté</th><th>Résultat 2022</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    const proj = (r.projected * 100).toFixed(1) + "%";
    const base = r.baseline !== null ? (r.baseline * 100).toFixed(1) + "%" : "n/d";
    const pw = r.pWin !== null ? Math.round(r.pWin * 100) + " %" : "n/d";
    const cand = candidates ? `<td>${candidates[r.party] ?? '<span class="muted-cell">n/d</span>'}</td>` : "";
    tr.innerHTML =
      `<td style="border-left:4px solid ${PARTY_COLORS[r.party]}; padding-left:6px">${r.party}</td>` +
      `${cand}<td>${pw}</td><td>${proj}</td><td>${base}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

// ---- Trend chart with a date-range selector -------------------------------

function renderTrendChart(fullSeries, polls, partyCodes) {
  const container = document.getElementById("trend-chart");
  const controls = document.createElement("div");
  controls.className = "range-controls";
  container.appendChild(controls);
  const chartHost = document.createElement("div");
  container.appendChild(chartHost);

  // Only plot parties a poll actually measured. Drawing an unmeasured party
  // at zero put a row of dots along the axis for every pre-2021 poll, each
  // reading as a pollster having found the PCQ at 0% -- a measurement none of
  // them made.
  const pollPoints = [];
  for (const p of polls) {
    for (const party of partyCodes) {
      if (p.shares[party] == null) continue;
      pollPoints.push({ date: new Date(p.pollDate), party, share: p.shares[party], firm: p.firm });
    }
  }

  function draw(range) {
    chartHost.innerHTML = "";
    const cutoff = range.since
      ? new Date(range.since)
      : range.days
        ? new Date(Date.now() - range.days * 86_400_000)
        : null;
    const series = cutoff ? fullSeries.filter((row) => new Date(row.date) >= cutoff) : fullSeries;
    const dots = cutoff ? pollPoints.filter((d) => d.date >= cutoff) : pollPoints;

    const points = [];
    for (const row of series) {
      for (const party of partyCodes) points.push({ date: new Date(row.date), party, ...row[party] });
    }

    // End-of-line labels: party name + last predicted share, right of the
    // last point. Labels whose values are close would overprint (LIB and CAQ
    // are 1pt apart), so the y positions are relaxed apart with a minimum
    // gap while the leader line still ends at the true value.
    const last = series.at(-1);
    const endLabels = partyCodes
      .filter((p) => last?.[p])
      .map((p) => ({ party: p, value: last[p].mean, label: `${p} ${(last[p].mean * 100).toFixed(1)}%` }))
      .sort((a, b) => b.value - a.value);
    const MIN_GAP = 0.022; // in share units, ~9px at this height
    endLabels.forEach((d, i) => { d.y = d.value; });
    for (let i = 1; i < endLabels.length; i++) {
      if (endLabels[i - 1].y - endLabels[i].y < MIN_GAP) endLabels[i].y = endLabels[i - 1].y - MIN_GAP;
    }

    const plot = Plot.plot({
      width: container.clientWidth || 900,
      height: 420,
      marginLeft: 55,
      marginRight: 78,
      x: { label: "Date" },
      y: { label: "Intention de vote", percent: true, grid: true },
      color: colorScale(partyCodes),
      marks: [
        Plot.areaY(points, { x: "date", y1: "p05", y2: "p95", fill: "party", fillOpacity: 0.12 }),
        Plot.dot(dots, { x: "date", y: "share", fill: "party", r: 2.5, fillOpacity: 0.55, title: (d) => `${d.firm}\n${d.party}: ${(d.share * 100).toFixed(1)}%` }),
        Plot.lineY(points, { x: "date", y: "mean", stroke: "party", strokeWidth: 2.5, z: "party" }),
        Plot.text(endLabels, {
          x: () => new Date(last.date), y: "y", text: "label", fill: "party",
          dx: 8, textAnchor: "start", fontWeight: 600, fontSize: 12,
        }),
        // Hover: nearest trend point, all parties' values at that date.
        Plot.ruleX(points, Plot.pointerX({ x: "date", stroke: "#bbb" })),
        Plot.tip(points, Plot.pointerX({
          x: "date", y: "mean",
          title: (d) => {
            const row = series.find((r) => +new Date(r.date) === +d.date);
            const at = d.date.toISOString().slice(0, 10);
            const lines = partyCodes
              .filter((p) => row?.[p])
              .sort((a, b) => row[b].mean - row[a].mean)
              .map((p) => `${p} : ${(row[p].mean * 100).toFixed(1)}%`);
            return [at, ...lines].join("\n");
          },
        })),
        Plot.ruleY([0]),
      ],
    });
    chartHost.appendChild(plot);
  }

  const buttons = [];
  for (const range of RANGES) {
    const btn = document.createElement("button");
    btn.textContent = range.label;
    btn.onclick = () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      draw(range);
    };
    buttons.push(btn);
    controls.appendChild(btn);
  }
  // Default: since the 2022 election -- shown as ALREADY PRESSED, since a
  // control whose state is invisible reads as "nothing selected".
  const defaultRange = RANGES.find((r) => r.since === "2022-10-03");
  buttons[RANGES.indexOf(defaultRange)].classList.add("active");
  draw(defaultRange);
}

// ---- Tile cartogram ---------------------------------------------------------
// US-state-grid style: one equal-size tile per riding (layout precomputed in
// qc_tile_layout.json from rank-normalised centroids). Equal tiles fix the
// choropleth's central lie -- 27 island-of-Montreal ridings vanishing into
// 0.1% of the pixels -- and make CLOSE RACES representable: the fill is the
// favourite (opacity = its win probability across the simulation draws), and
// when the race is close the tile's BORDER takes the runner-up's colour, a
// mark only legible because every tile is big and uniform.

const CLOSE_RACE_P = 0.75; // favourite below this = show the runner-up border

function renderTileMap(layout, winProbs, ridingForecast) {
  const host = document.getElementById("tile-map");
  host.innerHTML = "";
  // Layout coordinates are TILE CENTRES in tile-side units (precomputed by
  // tools/make_tiles.mjs); U converts to pixels.
  const tilesById = layout.tiles ?? layout;
  const U = 56, SIDE = U * 0.94;
  const xs = Object.values(tilesById).map((t) => t.x);
  const ys = Object.values(tilesById).map((t) => t.y);
  const x0 = Math.min(...xs) - 0.65, x1 = Math.max(...xs) + 0.65;
  const y0 = Math.min(...ys) - 1.3, y1 = Math.max(...ys) + 2.1; // room for the below-cluster region labels
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `${x0 * U} ${y0 * U} ${(x1 - x0) * U} ${(y1 - y0) * U}`);

  for (const [code, t] of Object.entries(tilesById)) {
    const probs = winProbs?.[code];
    const ranked = probs
      ? Object.entries(probs).sort((a, b) => b[1] - a[1])
      : [[ridingForecast.get(code)?.winner ?? "AUTRES", 1]];
    const [fav, pFav] = ranked[0];
    const runner = ranked[1]?.[0];
    const close = probs && pFav < CLOSE_RACE_P && runner;

    const g = document.createElementNS(svg.namespaceURI, "g");
    const rect = document.createElementNS(svg.namespaceURI, "rect");
    rect.setAttribute("class", "tile");
    rect.setAttribute("x", t.x * U - SIDE / 2);
    rect.setAttribute("y", t.y * U - SIDE / 2);
    rect.setAttribute("width", SIDE);
    rect.setAttribute("height", SIDE);
    rect.setAttribute("rx", 4);
    rect.setAttribute("fill", PARTY_COLORS[fav] ?? "#ccc");
    // Opacity carries certainty: a 52/48 race must not look like 90/10.
    rect.setAttribute("fill-opacity", (0.25 + 0.7 * pFav).toFixed(2));
    rect.setAttribute("stroke", close ? PARTY_COLORS[runner] ?? "#999" : "#ddd");
    rect.setAttribute("stroke-width", close ? 4 : 1);
    const title = document.createElementNS(svg.namespaceURI, "title");
    title.textContent = probs
      ? `${t.name}\nProbabilité de victoire :\n${ranked.slice(0, 3).filter(([, p]) => p >= 0.005)
        .map(([p, v]) => `${p} ${(v * 100).toFixed(0)} %`).join("\n")}`
      : t.name;
    rect.appendChild(title);
    rect.addEventListener("click", () => selectRiding(code, { zoom: false }));
    registry.tileByCode.set(code, rect);
    g.appendChild(rect);

    const label = document.createElementNS(svg.namespaceURI, "text");
    label.setAttribute("x", t.x * U);
    label.setAttribute("y", t.y * U + 5);
    label.setAttribute("text-anchor", "middle");
    // Adaptive size: short codes get big type; only long two-part names drop
    // smaller. The map column renders a tile at ~35 screen px, so anything
    // below ~12px SVG units was unreadable.
    label.setAttribute("font-size", t.abbr.length <= 4 ? "16" : t.abbr.length <= 6 ? "13" : "11");
    label.setAttribute("font-weight", "600");
    label.setAttribute("fill", pFav > 0.6 ? "#fff" : "#222");
    label.textContent = t.abbr;
    g.appendChild(label);
    svg.appendChild(g);
  }

  // Region labels on top (they sit in space the layout kept free): bearings,
  // not boundaries.
  for (const r of layout.regions ?? []) {
    const lbl = document.createElementNS(svg.namespaceURI, "text");
    lbl.setAttribute("x", r.x * U);
    lbl.setAttribute("y", r.y * U);
    lbl.setAttribute("text-anchor", "middle");
    lbl.setAttribute("font-size", "13");
    lbl.setAttribute("letter-spacing", "0.08em");
    lbl.setAttribute("fill", "#8a8a8a");
    lbl.textContent = r.label.toUpperCase();
    svg.appendChild(lbl);
  }

  // Selection: a double HALO (white over black) drawn OUTSIDE the tile.
  // A plain black border was indistinguishable from the PCQ navy fill and
  // sat exactly where the runner-up border carries the close-race signal;
  // the halo reads on any colour and covers nothing.
  const halo = document.createElementNS(svg.namespaceURI, "g");
  const mk = (stroke, width, grow) => {
    const r = document.createElementNS(svg.namespaceURI, "rect");
    r.setAttribute("fill", "none");
    r.setAttribute("stroke", stroke);
    r.setAttribute("stroke-width", width);
    r.setAttribute("rx", 6);
    r.setAttribute("pointer-events", "none");
    r.dataset.grow = grow;
    halo.appendChild(r);
    return r;
  };
  const haloOuter = mk("#000", 2.5, 7);
  const haloInner = mk("#fff", 2.5, 4.5);
  halo.setAttribute("hidden", "");
  svg.appendChild(halo);
  registry.tileSelFrame = {
    setAttribute(name, value) {
      if (name === "hidden") { halo.setAttribute("hidden", value); return; }
      for (const r of [haloOuter, haloInner]) {
        const grow = +r.dataset.grow;
        if (name === "x" || name === "y") r.setAttribute(name, +value - grow);
        else r.setAttribute(name, +value + 2 * grow);
      }
    },
    removeAttribute(name) { if (name === "hidden") halo.removeAttribute("hidden"); },
  };

  host.appendChild(svg);

  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    "Couleur : parti favori · intensité : probabilité de victoire · " +
    `contour : parti poursuivant lorsque le favori est sous ${Math.round(CLOSE_RACE_P * 100)}%.`;
  host.appendChild(note);
}

// ---- Riding map (Leaflet: pan/zoom, click-to-select) ------------------------

function renderMap(geojson, ridingForecast) {
  const container = document.getElementById("riding-map");

  const map = L.map(container, { zoomControl: true, attributionControl: false });
  registry.leafletMap = map;
  // No base tile layer on purpose: this is a choropleth of riding results,
  // not a street map, and it keeps the look black-and-white/minimalist
  // instead of importing an OSM basemap's own styling.

  const layer = L.geoJSON(geojson, {
    style: (feature) => {
      const code = normalizeRidingCode(feature.properties.riding_code);
      const winner = ridingForecast.get(code)?.winner;
      const style = { color: "#111", weight: 0.6, fillColor: PARTY_COLORS[winner] ?? "#ccc", fillOpacity: 0.85 };
      registry.defaultStyleByCode.set(code, style);
      return style;
    },
    onEachFeature: (feature, lyr) => {
      const code = normalizeRidingCode(feature.properties.riding_code);
      registry.mapLayersByCode.set(code, lyr);
      lyr.on("click", () => selectRiding(code));
      lyr.on("mouseover", () => {
        if (registry.mapLayersByCode.get(code) !== lyr) return;
        const current = lyr.options.weight;
        if (current < 2) lyr.setStyle({ weight: 1.6 });
      });
      lyr.on("mouseout", () => {
        const isSelected = lyr.options.weight >= 3;
        if (!isSelected) lyr.setStyle(registry.defaultStyleByCode.get(code));
      });
    },
  }).addTo(map);

  // The container gets its height from a flex row, which the browser
  // resolves after this runs -- Leaflet would otherwise compute its bounds
  // against a provisional height and leave the province floating in dead
  // space. Recompute once layout has settled, and again on resize.
  const fit = () => { map.invalidateSize(); map.fitBounds(layer.getBounds(), { padding: [12, 12] }); };
  requestAnimationFrame(fit);
  new ResizeObserver(fit).observe(container);
}

// ---- Closest-ridings watchlist ----------------------------------------------

function renderWatchlist(ridingForecast, partyCodes, n = 20) {
  const rows = [...ridingForecast.entries()].map(([code, entry]) => {
    const sorted = partyCodes.map((p) => [p, entry.shares[p]]).sort((a, b) => b[1] - a[1]);
    const margin = sorted[0][1] - sorted[1][1];
    return { code, name: registry.nameByCode.get(code) ?? code, winner: entry.winner, runnerUp: sorted[1][0], margin };
  });
  rows.sort((a, b) => a.margin - b.margin);

  const table = document.createElement("table");
  table.innerHTML =
    "<thead><tr><th>Circonscription</th><th>Favori</th><th>Poursuivant</th><th>Écart</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const r of rows.slice(0, n)) {
    const tr = document.createElement("tr");
    tr.className = "clickable-row";
    const cands = registry.candidates?.[r.code];
    const withName = (party) => {
      const n = cands?.[party];
      return n ? `${party}<br><span class="muted-cell" style="font-size:0.85em">${n}</span>` : party;
    };
    tr.innerHTML = `<td>${r.name}</td><td style="color:${PARTY_COLORS[r.winner]}">${withName(r.winner)}</td>` +
      `<td>${withName(r.runnerUp)}</td><td>${(r.margin * 100).toFixed(1)} pt</td>`;
    tr.onclick = () => selectRiding(r.code);
    registry.watchlistRowsByCode.set(r.code, tr);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  document.getElementById("watchlist").appendChild(table);
}

// ---- Leaders' ridings -------------------------------------------------------
// The riding shown is the one the leader CONTESTS in 2026, not the seat they
// hold now. Those differ for a leader with no seat and for one switching
// ridings, and both are perfectly projectable -- this table previously showed
// the current seat and wrote "ne siège pas" for the two leaders without one,
// withholding a projection that the model could produce perfectly well.
//
// `riding_source` distinguishes a confirmed candidacy from the assumption
// that a sitting leader runs again where they sit, and the distinction is
// shown rather than flattened. Only when there is neither is the riding
// genuinely unknown -- and "non annoncée" says that, where "ne siège pas"
// said something true but irrelevant.

function renderLeaderRidings(leaders, partyCodes) {
  const host = document.getElementById("leader-ridings");
  host.innerHTML = "";

  const codeByName = new Map([...registry.nameByCode].map(([code, name]) => [name, code]));

  const table = document.createElement("table");
  table.innerHTML =
    "<thead><tr><th>Parti</th><th>Chef</th><th>Circonscription</th><th>Projection</th></tr></thead>";
  const tbody = document.createElement("tbody");

  for (const leader of leaders) {
    const tr = document.createElement("tr");
    const partyCell = `<td style="color:${PARTY_COLORS[leader.party_code] ?? "#666"}">${leader.party_code}</td>`;

    if (!leader.riding_name) {
      tr.innerHTML =
        `${partyCell}<td>${leader.leader_name}</td>` +
        `<td colspan="2" class="muted-cell">candidature non annoncée</td>`;
      tbody.appendChild(tr);
      continue;
    }

    // A riding held on assumption rather than announcement is marked, so the
    // reader isn't told a switch has been ruled out when it simply hasn't
    // been announced.
    const ridingLabel =
      leader.riding_source === "siege actuel"
        ? `${leader.riding_name} <span class="muted-cell">(siège actuel)</span>`
        : leader.riding_name;

    const code = codeByName.get(leader.riding_name);
    const entry = code ? registry.ridingForecast.get(code) : null;
    if (!entry) {
      tr.innerHTML = `${partyCell}<td>${leader.leader_name}</td><td>${ridingLabel}</td><td class="muted-cell">n/d</td>`;
      tbody.appendChild(tr);
      continue;
    }

    const sorted = partyCodes.map((p) => [p, entry.shares[p]]).sort((a, b) => b[1] - a[1]);
    const margin = sorted[0][1] - sorted[1][1];

    // "conserve" vs "gagne" is about the SEAT changing hands, so it compares
    // the projected winner with whoever won the riding last time -- not with
    // the leader's own party. Comparing against the leader's party labelled
    // Duhaime's PCQ as "conserve" in Bellechasse, a seat the CAQ won in 2022.
    const baseline = registry.ridingBaseline.sharesFor(code);
    const previousWinner = baseline
      ? partyCodes.reduce((best, p) => ((baseline[p] ?? 0) > (baseline[best] ?? 0) ? p : best), partyCodes[0])
      : null;
    const holds = previousWinner !== null && entry.winner === previousWinner;
    tr.className = "clickable-row";
    tr.innerHTML =
      `${partyCell}<td>${leader.leader_name}</td><td>${ridingLabel}</td>` +
      `<td style="color:${PARTY_COLORS[entry.winner]}">${entry.winner} ${holds ? "conserve" : "gagne"} (+${(margin * 100).toFixed(1)} pt)</td>`;
    tr.onclick = () => selectRiding(code);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  host.appendChild(table);
}

// ---- Seat posterior distributions ------------------------------------------
// The simulation produces a full posterior over each party's seat count, so
// show that distribution rather than collapsing it to one number. A single
// point estimate hides exactly what matters here: how wide the plausible
// range is and how much of it sits above the majority line.

function renderSeatDistributions(distributions, totalSeats, partyCodes, medoidCounts) {
  const host = document.getElementById("seat-bar");
  host.innerHTML = "";
  const threshold = Math.floor(totalSeats / 2) + 1;

  const ordered = [...partyCodes].sort((a, b) => distributions[b].mean - distributions[a].mean);
  const data = [];
  for (const party of ordered) {
    for (const bin of distributions[party].histogram) data.push({ party, ...bin });
  }

  const plot = Plot.plot({
    width: 640,
    height: 90 * ordered.length,
    marginLeft: 62,
    marginRight: 20,
    x: { label: "Sièges", domain: [0, totalSeats], grid: true },
    y: { label: null, axis: null, domain: [0, 1] },
    fy: { domain: ordered, label: null },
    color: colorScale(partyCodes),
    marks: [
      Plot.ruleX([threshold], { stroke: "#000", strokeDasharray: "3,3" }),
      Plot.areaY(data, { x: "seats", y: "height", fy: "party", fill: "party", fillOpacity: 0.5, curve: "step" }),
      Plot.lineY(data, { x: "seats", y: "height", fy: "party", stroke: "party", strokeWidth: 1.5, curve: "step" }),
      // The headline is the MEDOID: the simulated draw closest (mean L1) to
      // all others -- the most typical JOINT scenario. Per-party medians are
      // not jointly attainable (they don't sum to the house size), and the
      // central point projection floors any party sitting narrowly second in
      // many ridings (CAQ showed 3 while its simulated median was 11). The
      // medoid is an actual draw: coherent across parties, sums to 127.
      Plot.text(ordered.map((p) => ({ party: p, label: `${medoidCounts[p] ?? 0} [${distributions[p].p05}–${distributions[p].p95}]` })),
        { fy: "party", x: totalSeats, y: 0.5, text: "label", textAnchor: "end", fontSize: 11, fill: "#333" }),
    ],
  });
  host.appendChild(plot);

  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    `Distribution du nombre de sièges par parti sur 5 000 simulations. ` +
    `Trait pointillé : seuil de majorité (${threshold} sièges). ` +
    `Valeurs à droite : sièges dans le scénario médian de la distribution jointe (médoïde), ` +
    `suivis de l'intervalle à 90 %.`;
  host.appendChild(note);
}

// ---- Vote-vs-seat disproportion ----------------------------------------------
// Each simulation draw carries both a national vote composition and a seat
// allocation, so the electoral system's distortion is a joint distribution:
// dumbbells show expected vote share vs expected seat share per party, the
// note carries the Gallagher index summarised over the draws.

function renderDisproportion(d, partyCodes) {
  const host = document.getElementById("disproportion");
  if (!d) { host.textContent = "n/d"; return; }
  host.innerHTML = "";

  const ordered = [...partyCodes]
    .filter((p) => d.voteShare[p] > 0.5 || d.seatShare[p] > 0.5)
    .sort((a, b) => d.voteShare[b] - d.voteShare[a]);
  const rows = ordered.map((p) => ({
    party: p,
    votes: d.voteShare[p],
    sieges: d.seatShare[p],
    gap: d.gaps[p].p50,
  }));

  const plot = Plot.plot({
    width: 640,
    height: 46 * rows.length + 50,
    marginLeft: 62,
    marginRight: 175,
    x: { label: "du % des votes vers le % des sièges", grid: true },
    y: { domain: ordered, label: null },
    color: colorScale(partyCodes),
    marks: [
      Plot.arrow(rows, {
        x1: "votes", x2: "sieges", y1: "party", y2: "party",
        stroke: "party", strokeWidth: 2, headLength: 5,
      }),
      Plot.dot(rows, { x: "votes", y: "party", fill: "party", r: 4 }),
      // Labels sit at their own mark: "% des votes" beside the dot on the
      // side AWAY from the arrow, "% des sièges" beyond the arrowhead. When
      // the arrow is too short for side-by-side text, the two stack.
      ...(() => {
        const vLbl = (r) => `${r.votes.toFixed(0)} % des votes`;
        const sLbl = (r) => `${r.sieges.toFixed(0)} % des sièges`;
        const wide = rows.filter((r) => Math.abs(r.sieges - r.votes) >= 3);
        const tight = rows.filter((r) => Math.abs(r.sieges - r.votes) < 3);
        const right = wide.filter((r) => r.sieges > r.votes);
        const left = wide.filter((r) => r.sieges < r.votes);
        // A left-pointing head near the axis has no room for an end-anchored
        // label (QS at 3 % overprinted the axis): it goes above the head.
        const leftFar = left.filter((r) => r.sieges >= 8);
        const leftEdge = left.filter((r) => r.sieges < 8);
        const T = { fontSize: 11, fill: "#333", y: "party" };
        return [
          Plot.text(right, { ...T, x: "votes", text: vLbl, dx: -9, textAnchor: "end" }),
          Plot.text(right, { ...T, x: "sieges", text: sLbl, dx: 11, textAnchor: "start" }),
          Plot.text(left, { ...T, x: "votes", text: vLbl, dx: 9, textAnchor: "start" }),
          Plot.text(leftFar, { ...T, x: "sieges", text: sLbl, dx: -11, textAnchor: "end" }),
          Plot.text(leftEdge, { ...T, x: "sieges", text: sLbl, dx: -4, dy: -12, textAnchor: "start" }),
          Plot.text(tight, { ...T, x: (r) => Math.max(r.votes, r.sieges), text: sLbl, dx: 10, dy: -7, textAnchor: "start" }),
          Plot.text(tight, { ...T, x: (r) => Math.max(r.votes, r.sieges), text: vLbl, dx: 10, dy: 7, textAnchor: "start" }),
        ];
      })(),
    ],
  });
  host.appendChild(plot);

  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    `Espérances sur les 5 000 simulations : la flèche va de la part des votes (électorat probable) ` +
    `à la part des 127 sièges. Le scrutin uninominal amplifie le parti en tête et pénalise les appuis dispersés. ` +
    `Indice de disproportion de Gallagher : ${d.gallagher.p50.toFixed(1)} ` +
    `[intervalle à 90 % : ${d.gallagher.p05.toFixed(1)}–${d.gallagher.p95.toFixed(1)}] ; ` +
    `repères : 4 à 6 sous un scrutin proportionnel, 17,8 au Québec en 2022.`;
  host.appendChild(note);
}

// ---- Government scenarios ---------------------------------------------------
// Mutually exclusive by construction: every simulation lands in exactly one
// row, so the probabilities partition to 100%. The "balance of power" column
// names the smallest party that could lift the plurality winner to a
// majority -- arithmetic only. Whether such support would actually be given
// is a political question this model cannot see.

function renderGovernmentScenarios(scenarios, totalSeats, partyCodes) {
  const host = document.getElementById("government-outcomes");
  host.innerHTML = "";

  const majority = scenarios.filter((s) => s.type === "majority").reduce((a, s) => a + s.probability, 0);
  // Round once and subtract, rather than rounding both: two complementary
  // probabilities rounded independently display as 9% and 92%.
  const majPct = Math.round(majority * 100);
  const lead = document.createElement("p");
  lead.innerHTML = `<strong>${majPct}%</strong> de probabilité d'un gouvernement majoritaire, ` +
    `<strong>${100 - majPct}%</strong> d'un gouvernement minoritaire.`;
  host.appendChild(lead);

  const table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>Probabilité</th><th>Gouvernement</th><th>Opposition</th><th>Balance du pouvoir</th></tr></thead>";
  const tbody = document.createElement("tbody");

  for (const s of scenarios.filter((x) => x.probability >= 0.01)) {
    const tr = document.createElement("tr");
    const kind = s.type === "majority" ? "majoritaire" : "minoritaire";
    let balance;
    if (s.type === "majority") balance = '<span class="muted-cell">sans objet</span>';
    else if (s.balanceOfPower) balance = `<span style="color:${PARTY_COLORS[s.balanceOfPower]}">${s.balanceOfPower}</span>`;
    else if (s.needsOpposition) balance = `<span class="muted-cell">appui de l'opposition requis</span>`;
    else balance = '<span class="muted-cell">aucun parti seul ne suffit</span>';
    tr.innerHTML =
      `<td>${(s.probability * 100).toFixed(0)}%</td>` +
      `<td style="color:${PARTY_COLORS[s.leader]}">${s.leader} <span class="muted-cell">${kind}</span></td>` +
      `<td style="color:${PARTY_COLORS[s.opposition] ?? "#666"}">${s.opposition ?? "-"}</td>` +
      `<td>${balance}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);

  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    "Chaque simulation est classée dans un scénario unique; les probabilités somment à 100 % " +
    "(scénarios sous 1 % omis). La balance du pouvoir désigne le plus petit parti dont les sièges, " +
    "ajoutés à ceux du parti arrivé en tête, atteindraient la majorité; elle décrit une possibilité " +
    "arithmétique et non une entente anticipée.";
  host.appendChild(note);
}

// ---- Main -------------------------------------------------------------------

async function loadJSON(path) {
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
  return resp.json();
}

async function main() {
  const status = document.getElementById("status");
  status.textContent = "Chargement des données...";

  // The page DISPLAYS a precomputed projection (js/tools/compute.mjs writes
  // qc_projection.json when the poll watch finds new data). The modelling
  // code is identical -- computeProjection.js, same library -- it just runs
  // in Node at build time instead of in every visitor's browser. Page load
  // went from ~20s of GP fitting to rendering a JSON.
  const [projection, pollRows, geojson, leaders, tileLayout, candidates] = await Promise.all([
    loadJSON("data/qc_projection.json"),
    loadJSON("data/qc_national_polls.json"),
    loadJSON("data/qc_ridings_2026.geojson"),
    loadJSON("data/qc_leaders.json"),
    loadJSON("data/qc_tile_layout.json"),
    loadJSON("data/qc_candidates.json").catch(() => null), // optional
  ]);
  registry.candidates = candidates;

  const { meta, partyCodes, trendSeries, totalSeats } = projection;
  registry.partyCodes = partyCodes;
  registry.nameByCode = new Map(
    geojson.features.map((f) => [normalizeRidingCode(f.properties.riding_code), f.properties.riding_name])
  );
  const ridingForecast = new Map(Object.entries(projection.ridingForecast));
  registry.ridingForecast = ridingForecast;
  registry.winProbs = projection.ridingWinProbs ?? null;
  registry.ridingBaseline = {
    sharesFor: (code) => projection.ridingBaseline2022[String(code)] ?? null,
  };

  const effectsNote = meta.effectsR2 != null
    ? ` · effets locaux : GP démographique R²=${meta.effectsR2.toFixed(2)} sur ${meta.effectsCount} circonscriptions` +
      (meta.nByelections ? `, ${meta.nByelections} partielles` : "")
    : " · effets locaux indisponibles";
  // generatedAt is ISO UTC; the audience is Quebec, so show Eastern time
  // (America/Toronto follows the same DST rules as Montreal).
  const computedAt = new Intl.DateTimeFormat("fr-CA", {
    timeZone: "America/Toronto", dateStyle: "short", timeStyle: "short",
  }).format(new Date(meta.generatedAt));
  status.textContent =
    `${meta.nPolls} sondages · intentions au ${meta.asOf} · simulation pour le scrutin du ${meta.electionDate} · ` +
    `${meta.nRidings} circonscriptions${effectsNote} · calculé le ${computedAt} (HE)`;

  section("trend-chart", () => {
    // Dots come from the raw poll rows (a cheap pivot, no fitting); the
    // smoothed series and bands come precomputed.
    const { polls } = pivotPolls(pollRows);
    renderTrendChart(trendSeries, polls, partyCodes);
  });

  section("tile-map", () => renderTileMap(tileLayout, projection.ridingWinProbs, ridingForecast));

  // Tiles by default; the geographic map stays one click away. Leaflet
  // CANNOT be initialised inside a hidden container (it computes its pixel
  // size at init and gets zero -- the map then renders blank), so it is
  // created lazily on the first switch, once the container is visible.
  const btnTiles = document.getElementById("btn-tiles");
  const btnGeo = document.getElementById("btn-geo");
  const setMode = (tiles) => {
    document.getElementById("tile-map").hidden = !tiles;
    document.getElementById("riding-map").hidden = tiles;
    btnTiles.classList.toggle("active", tiles);
    btnGeo.classList.toggle("active", !tiles);
    if (!tiles && !registry.leafletMap) {
      section("riding-map", () => renderMap(geojson, ridingForecast));
      // Late init: re-apply the current selection so the map opens in sync.
      if (registry.selectedCode) selectRiding(registry.selectedCode, { zoom: false });
    }
  };
  btnTiles.onclick = () => setMode(true);
  btnGeo.onclick = () => setMode(false);
  setMode(true);
  section("watchlist", () => renderWatchlist(ridingForecast, partyCodes));
  section("leader-ridings", () => renderLeaderRidings(leaders, partyCodes));
  section("seat-bar", () =>
    renderSeatDistributions(projection.seatDistributions, totalSeats, partyCodes,
      projection.medoidCounts ?? projection.pointCounts));
  section("government-outcomes", () =>
    renderGovernmentScenarios(projection.scenarios, totalSeats, partyCodes));
  section("disproportion", () =>
    renderDisproportion(projection.disproportion, partyCodes));

  // Default selection so the detail panel isn't empty on first load, and so
  // it's obvious from the start that clicking updates it.
  const firstWatchlistCode = [...registry.watchlistRowsByCode.keys()][0];
  if (firstWatchlistCode) selectRiding(firstWatchlistCode, { zoom: false });
}

main().catch((err) => {
  console.error(err);
  document.getElementById("status").textContent = `Erreur : ${err.message}`;
});
