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
    if (zoom && registry.leafletMap) registry.leafletMap.fitBounds(selectedLayer.getBounds(), { maxZoom: 9 });
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

    const plot = Plot.plot({
      width: container.clientWidth || 900,
      height: 420,
      marginLeft: 55,
      x: { label: "Date" },
      y: { label: "Intention de vote", percent: true, grid: true },
      color: colorScale(partyCodes),
      marks: [
        Plot.areaY(points, { x: "date", y1: "p05", y2: "p95", fill: "party", fillOpacity: 0.12 }),
        Plot.dot(dots, { x: "date", y: "share", fill: "party", r: 2.5, fillOpacity: 0.55, title: (d) => `${d.firm}\n${d.party}: ${(d.share * 100).toFixed(1)}%` }),
        Plot.lineY(points, { x: "date", y: "mean", stroke: "party", strokeWidth: 2.5, z: "party" }),
        Plot.ruleY([0]),
      ],
    });
    chartHost.appendChild(plot);
  }

  for (const range of RANGES) {
    const btn = document.createElement("button");
    btn.textContent = range.label;
    btn.onclick = () => draw(range);
    controls.appendChild(btn);
  }
  draw(RANGES.find((r) => r.days === 365)); // default: last year
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

function renderSeatDistributions(distributions, totalSeats, partyCodes, pointCounts) {
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
      // Two numbers, both needed. The POINT count matches the map and sums
      // to the house size -- but for a party sitting narrowly second in many
      // ridings it is systematically the floor (every 50.1/49.9 falls against
      // them: CAQ showed 3 while its simulated MEDIAN was 11). The median
      // shows where the distribution actually sits; medians alone don't sum
      // to 127, which is why the point count leads.
      Plot.text(ordered.map((p) => ({ party: p, label: `${pointCounts[p] ?? 0} · méd ${Math.round(distributions[p].p50)} [${distributions[p].p05}–${distributions[p].p95}]` })),
        { fy: "party", x: totalSeats, y: 0.5, text: "label", textAnchor: "end", fontSize: 11, fill: "#333" }),
    ],
  });
  host.appendChild(plot);

  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    `Trait pointillé : seuil de majorité (${threshold} sièges). À droite : projection centrale ` +
    `(identique à la carte, somme à ${totalSeats}), médiane simulée et intervalle 90%. Quand un parti ` +
    `est deuxième de peu dans beaucoup de courses, la projection centrale est son plancher — la médiane dit ` +
    `où la distribution se tient vraiment.`;
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
  const [projection, pollRows, geojson, leaders] = await Promise.all([
    loadJSON("data/qc_projection.json"),
    loadJSON("data/qc_national_polls.json"),
    loadJSON("data/qc_ridings_2026.geojson"),
    loadJSON("data/qc_leaders.json"),
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
  status.textContent =
    `${meta.nPolls} sondages · intentions au ${meta.asOf} · simulation pour le scrutin du ${meta.electionDate} · ` +
    `${meta.nRidings} circonscriptions${effectsNote} · calculé le ${meta.generatedAt.slice(0, 16).replace("T", " ")}`;

  section("trend-chart", () => {
    // Dots come from the raw poll rows (a cheap pivot, no fitting); the
    // smoothed series and bands come precomputed.
    const { polls } = pivotPolls(pollRows);
    renderTrendChart(trendSeries, polls, partyCodes);
  });

  section("riding-map", () => renderMap(geojson, ridingForecast));
  section("watchlist", () => renderWatchlist(ridingForecast, partyCodes));
  section("leader-ridings", () => renderLeaderRidings(leaders, partyCodes));
  section("seat-bar", () =>
    renderSeatDistributions(projection.seatDistributions, totalSeats, partyCodes, projection.pointCounts));
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
