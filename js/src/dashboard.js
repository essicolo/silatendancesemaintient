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

  renderRidingDetail(code, name, entry, registry.ridingBaseline.sharesFor(code), registry.partyCodes);

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

function renderRidingDetail(code, name, forecastEntry, baselineShares, partyCodes) {
  const host = document.getElementById("riding-detail");
  host.innerHTML = "";

  const title = document.createElement("h3");
  title.textContent = name;
  host.appendChild(title);

  const rows = partyCodes
    .map((p) => ({ party: p, projected: forecastEntry.shares[p], baseline: baselineShares?.[p] ?? null }))
    .sort((a, b) => b.projected - a.projected);

  const table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>Parti</th><th>Projection 2026</th><th>Résultat 2022</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    const proj = (r.projected * 100).toFixed(1) + "%";
    const base = r.baseline !== null ? (r.baseline * 100).toFixed(1) + "%" : "n/d";
    tr.innerHTML = `<td style="border-left:4px solid ${PARTY_COLORS[r.party]}; padding-left:6px">${r.party}</td><td>${proj}</td><td>${base}</td>`;
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
  const CELL = 64, PAD = 3;
  const cols = 1 + Math.max(...Object.values(layout).map((t) => t.col));
  const rows = 1 + Math.max(...Object.values(layout).map((t) => t.row));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${cols * CELL} ${rows * CELL}`);

  for (const [code, t] of Object.entries(layout)) {
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
    rect.setAttribute("x", t.col * CELL + PAD);
    rect.setAttribute("y", t.row * CELL + PAD);
    rect.setAttribute("width", CELL - 2 * PAD);
    rect.setAttribute("height", CELL - 2 * PAD);
    rect.setAttribute("rx", 4);
    rect.setAttribute("fill", PARTY_COLORS[fav] ?? "#ccc");
    // Opacity carries certainty: a 52/48 race must not look like 90/10.
    rect.setAttribute("fill-opacity", (0.25 + 0.7 * pFav).toFixed(2));
    rect.setAttribute("stroke", close ? PARTY_COLORS[runner] ?? "#999" : "#ddd");
    rect.setAttribute("stroke-width", close ? 4 : 1);
    const title = document.createElementNS(svg.namespaceURI, "title");
    title.textContent = probs
      ? `${t.name}\n${ranked.slice(0, 3).filter(([, p]) => p >= 0.005)
        .map(([p, v]) => `${p} : ${(v * 100).toFixed(0)}% de chances`).join("\n")}`
      : t.name;
    rect.appendChild(title);
    rect.addEventListener("click", () => selectRiding(code, { zoom: false }));
    registry.tileByCode.set(code, rect);
    g.appendChild(rect);

    const label = document.createElementNS(svg.namespaceURI, "text");
    label.setAttribute("x", t.col * CELL + CELL / 2);
    label.setAttribute("y", t.row * CELL + CELL / 2 + 3);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("font-size", "10");
    label.setAttribute("fill", pFav > 0.6 ? "#fff" : "#222");
    label.textContent = t.abbr;
    g.appendChild(label);
    svg.appendChild(g);
  }

  // Selection frame: one reusable rect moved onto the selected tile.
  const sel = document.createElementNS(svg.namespaceURI, "rect");
  sel.setAttribute("fill", "none");
  sel.setAttribute("stroke", "#000");
  sel.setAttribute("stroke-width", 3.5);
  sel.setAttribute("rx", 4);
  sel.setAttribute("pointer-events", "none");
  sel.setAttribute("hidden", "");
  svg.appendChild(sel);
  registry.tileSelFrame = sel;

  host.appendChild(svg);

  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    "Chaque tuile est une circonscription, à taille égale (Montréal cesse de disparaître). " +
    "Couleur : parti favori; intensité : sa probabilité de victoire sur 5 000 simulations. " +
    `Contour coloré : course serrée (favori sous ${Math.round(CLOSE_RACE_P * 100)}%), aux couleurs du poursuivant. ` +
    "La somme des probabilités de victoire d'un parti est son espérance de sièges — la seule décomposition par circonscription qui somme à 127.";
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
    tr.innerHTML = `<td>${r.name}</td><td style="color:${PARTY_COLORS[r.winner]}">${r.winner}</td><td>${r.runnerUp}</td><td>${(r.margin * 100).toFixed(1)} pt</td>`;
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
    `Trait pointillé : seuil de majorité (${threshold} sièges). À droite : le scénario simulé le plus ` +
    `typique (le tirage le plus proche de tous les autres — cohérent entre partis, somme à ${totalSeats}) ` +
    `et l'intervalle à 90% de chaque parti. La carte montre le scénario central (toutes les sources ` +
    `d'incertitude à leur moyenne), qui peut s'en écarter dans les courses serrées.`;
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
    "Scénarios mutuellement exclusifs : chaque simulation compte une seule fois, les probabilités totalisent 100% " +
    "(les scénarios sous 1% ne sont pas affichés). La balance du pouvoir désigne le plus petit parti dont les sièges " +
    "suffiraient à donner la majorité au parti arrivé en tête. C'est de l'arithmétique, pas une prédiction d'entente.";
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
  const [projection, pollRows, geojson, leaders, tileLayout] = await Promise.all([
    loadJSON("data/qc_projection.json"),
    loadJSON("data/qc_national_polls.json"),
    loadJSON("data/qc_ridings_2026.geojson"),
    loadJSON("data/qc_leaders.json"),
    loadJSON("data/qc_tile_layout.json"),
  ]);

  const { meta, partyCodes, trendSeries, totalSeats } = projection;
  registry.partyCodes = partyCodes;
  registry.nameByCode = new Map(
    geojson.features.map((f) => [normalizeRidingCode(f.properties.riding_code), f.properties.riding_name])
  );
  const ridingForecast = new Map(Object.entries(projection.ridingForecast));
  registry.ridingForecast = ridingForecast;
  registry.ridingBaseline = {
    sharesFor: (code) => projection.ridingBaseline2022[String(code)] ?? null,
  };

  const effectsNote = meta.effectsR2 != null
    ? ` · effets locaux R²=${meta.effectsR2.toFixed(2)} sur ${meta.effectsCount} circonscriptions`
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
  section("riding-map", () => renderMap(geojson, ridingForecast));

  // Tiles by default; the geographic map stays one click away. Leaflet is
  // initialised while hidden, so give it a size recompute when revealed.
  const btnTiles = document.getElementById("btn-tiles");
  const btnGeo = document.getElementById("btn-geo");
  const setMode = (tiles) => {
    document.getElementById("tile-map").hidden = !tiles;
    document.getElementById("riding-map").hidden = tiles;
    btnTiles.classList.toggle("active", tiles);
    btnGeo.classList.toggle("active", !tiles);
    if (!tiles && registry.leafletMap) setTimeout(() => registry.leafletMap.invalidateSize(), 0);
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

  // Default selection so the detail panel isn't empty on first load, and so
  // it's obvious from the start that clicking updates it.
  const firstWatchlistCode = [...registry.watchlistRowsByCode.keys()][0];
  if (firstWatchlistCode) selectRiding(firstWatchlistCode, { zoom: false });
}

main().catch((err) => {
  console.error(err);
  document.getElementById("status").textContent = `Erreur : ${err.message}`;
});
