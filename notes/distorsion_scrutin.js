// %% [markdown]
// # La distorsion du mode de scrutin — Québec 2026
//
// Élection générale du 5 octobre 2026 (dépouillement final, Élections Québec).
// Sources : flux ouvert donnees.electionsquebec.qc.ca; Atlas des élections et
// DGEQ pour l'historique; ISQ pour la population; Wikipédia (« Gallagher
// index ») pour les références internationales.

// %% [javascript]
const Plot = await import("https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6/+esm");
const d3 = await import("https://cdn.jsdelivr.net/npm/d3@7/+esm");

const TOTAL_SIEGES = 127;
const INSCRITS = 6495984;
const VOTES_EXERCES = 4345857;
const VOTES_VALIDES = 4282551;
const POPULATION = 9110000; // ISQ, estimation 2026

const partis = [
  { parti: "PQ",  votesN: 1199925, sieges: 59, couleur: "#2B50C8" },
  { parti: "PLQ", votesN: 1037051, sieges: 40, couleur: "#E01020" },
  { parti: "PCQ", votesN: 885164,  sieges: 19, couleur: "#10275A" },
  { parti: "CAQ", votesN: 571520,  sieges: 0,  couleur: "#6EC9F5" },
  { parti: "QS",  votesN: 532176,  sieges: 9,  couleur: "#F28C28" },
];
partis;

// %% [markdown]
// ## 1. Quatre lectures de la force d'un parti
//
// De gauche à droite, la même force politique rapportée à quatre dénominateurs
// de plus en plus étroits : la population, les électeurs inscrits, les votes
// exprimés, les sièges de l'Assemblée. Les pentes racontent tout : le PQ grossit
// à chaque étage du filtre (13 % de la population, 46 % de l'Assemblée); la
// CAQ disparaît au dernier étage; tous les partis confondus se tassent sous
// 14 % de la population — un gouvernement procède du vote d'une petite
// fraction des Québécois.

// %% [javascript]
const etapes = ["% Assemblée", "% vote exprimé", "% des inscrits", "% population"];
const pente = partis.flatMap((p) => [
  { parti: p.parti, couleur: p.couleur, etape: etapes[0], pct: p.sieges / TOTAL_SIEGES * 100 },
  { parti: p.parti, couleur: p.couleur, etape: etapes[1], pct: p.votesN / VOTES_VALIDES * 100 },
  { parti: p.parti, couleur: p.couleur, etape: etapes[2], pct: p.votesN / INSCRITS * 100 },
  { parti: p.parti, couleur: p.couleur, etape: etapes[3], pct: p.votesN / POPULATION * 100 },
]);

Plot.plot({
  height: 420,
  width: 760,
  marginLeft: 40,
  marginRight: 110,
  marginBottom: 45,
  style: { fontSize: "13px", fontFamily: "system-ui" },
  x: { domain: [...etapes].reverse(), label: null, tickSize: 0, padding: 0.35 },
  y: { label: null, axis: null, domain: [0, 50] },
  marks: [
    Plot.ruleX(etapes, { x: (d) => d, y1: 0, y2: 50, stroke: "black", strokeWidth: 2.5 }),
    Plot.line(pente, {
      x: "etape", y: "pct", z: "parti",
      stroke: "couleur", strokeWidth: 2.5, curve: "linear",
    }),
    Plot.dot(pente, { x: "etape", y: "pct", fill: "couleur", r: 7 }),
    // noms des partis a droite de la colonne Assemblee, valeur au-dessus du point
    Plot.text(pente.filter((d) => d.etape === etapes[0]), {
      x: "etape", y: "pct", text: "parti", fill: "couleur",
      textAnchor: "start", dx: 14, fontWeight: "bold", fontSize: 13,
    }),
    Plot.text(pente.filter((d) => d.etape === etapes[0]), {
      x: "etape", y: "pct", text: (d) => d.pct.toFixed(0) + " %",
      dx: -10, dy: -10, textAnchor: "end", fill: "#444", fontSize: 11,
    }),
  ],
});

// %% [markdown]
// ## 2. Votes et sièges : la flèche de la distorsion
//
// Chaque flèche part de la part des votes exprimés (point) et pointe vers la
// part des sièges. La CAQ : 13,3 % des votes, aucun des 127 sièges.

// %% [javascript]
const fleches = partis.map((p) => ({
  ...p,
  votesPct: p.votesN / VOTES_VALIDES * 100,
  siegesPct: p.sieges / TOTAL_SIEGES * 100,
}));

Plot.plot({
  height: 300,
  width: 760,
  marginLeft: 60,
  marginRight: 40,
  marginBottom: 55,
  style: { fontSize: "13px", fontFamily: "system-ui" },
  x: { label: "part (%)", domain: [0, 50], grid: true, labelAnchor: "center", labelOffset: 45 },
  y: { domain: partis.map((d) => d.parti), label: null, axis: null },
  marks: [
    Plot.text(fleches, {
      y: "parti", x: 0, text: "parti", fill: "couleur",
      textAnchor: "end", dx: -10, fontSize: 13,
    }),
    Plot.arrow(fleches, {
      y: "parti", x1: "votesPct", x2: "siegesPct",
      stroke: "couleur", strokeWidth: 2.5, headLength: 5,
    }),
    Plot.dot(fleches, { y: "parti", x: "votesPct", r: 4.5, fill: "couleur" }),
    Plot.text(fleches, {
      y: "parti", x: "votesPct", dy: -13, textAnchor: "middle",
      text: (d) => d.votesPct.toFixed(1).replace(".", ",") + " %",
      fill: "#555", fontSize: 11,
    }),
    Plot.text(fleches, {
      y: "parti", x: "siegesPct", dy: -13, textAnchor: "middle",
      text: (d) => `${d.sieges} siège${d.sieges > 1 ? "s" : ""}`,
      fill: "#333", fontSize: 11,
    }),
  ],
});

// %% [markdown]
// ## 3. L'entonnoir, en flux
//
// La cascade population → inscrits → votants → votes valides, puis le vote
// valide éclaté par parti (couleurs des partis, sièges en étiquette); les
// sorties de l'entonnoir en gris.

// %% [javascript]
const sankeyMod = await import("https://cdn.jsdelivr.net/npm/d3-sankey@0.12/+esm");

const couleurParti = Object.fromEntries(partis.map((p) => [p.parti, p.couleur]));
const autresN = VOTES_VALIDES - partis.reduce((s, p) => s + p.votesN, 0);
const partisSankey = [...partis, { parti: "Autres", votesN: autresN, sieges: 0, couleur: "#9a9a9a" }];

const noeudsSankey = [
  "Population du Québec", "Électeurs inscrits", "Votes exercés", "Votes valides",
  "Mineurs, non-citoyens", "Abstention", "Bulletins rejetés",
  ...partisSankey.map((p) => p.parti),
].map((name) => ({ name }));
const idxSankey = Object.fromEntries(noeudsSankey.map((n, i) => [n.name, i]));
const liensSankey = [
  ["Population du Québec", "Électeurs inscrits", INSCRITS],
  ["Population du Québec", "Mineurs, non-citoyens", POPULATION - INSCRITS],
  ["Électeurs inscrits", "Votes exercés", VOTES_EXERCES],
  ["Électeurs inscrits", "Abstention", INSCRITS - VOTES_EXERCES],
  ["Votes exercés", "Votes valides", VOTES_VALIDES],
  ["Votes exercés", "Bulletins rejetés", VOTES_EXERCES - VOTES_VALIDES],
  ...partisSankey.map((p) => ["Votes valides", p.parti, p.votesN]),
].map(([s, t, v]) => ({ source: idxSankey[s], target: idxSankey[t], value: v }));

const sankeyGen = sankeyMod.sankey().nodeWidth(14).nodePadding(16)
  .nodeSort(null) // garde l'ordre déclaré : partis du plus fort au plus faible
  .extent([[0, 10], [640, 470]]);
const sankeyLayout = sankeyGen({ nodes: noeudsSankey.map((d) => ({ ...d })), links: liensSankey });
const gris = new Set(["Mineurs, non-citoyens", "Abstention", "Bulletins rejetés"]);
const couleurNoeud = (name) =>
  gris.has(name) ? "#9a9a9a" : couleurParti[name] ?? (name === "Autres" ? "#9a9a9a" : "#2B50C8");
const siegesDe = Object.fromEntries(partisSankey.map((p) => [p.parti, p.sieges]));
const libelle = (d) => {
  const base = `${d.name} — ${(d.value / 1e6).toFixed(2).replace(".", ",")} M`;
  if (siegesDe[d.name] === undefined) return base;
  const s = siegesDe[d.name];
  return `${base} (${s} siège${s > 1 ? "s" : ""})`;
};

const svgSankey = d3.create("svg").attr("viewBox", [0, 0, 920, 480])
  .attr("font-family", "system-ui").attr("font-size", 12);
svgSankey.append("g").selectAll("path").data(sankeyLayout.links).join("path")
  .attr("d", sankeyMod.sankeyLinkHorizontal())
  .attr("fill", "none")
  .attr("stroke", (d) => gris.has(d.target.name) ? "#c4c4c4"
    : couleurParti[d.target.name] ?? "#2B50C8")
  .attr("stroke-opacity", (d) => couleurParti[d.target.name] ? 0.55 : 0.35)
  .attr("stroke-width", (d) => Math.max(1, d.width));
svgSankey.append("g").selectAll("rect").data(sankeyLayout.nodes).join("rect")
  .attr("x", (d) => d.x0).attr("y", (d) => d.y0)
  .attr("width", (d) => d.x1 - d.x0).attr("height", (d) => Math.max(1, d.y1 - d.y0))
  .attr("fill", (d) => couleurNoeud(d.name));
svgSankey.append("g").selectAll("text").data(sankeyLayout.nodes).join("text")
  .attr("x", (d) => d.x1 + 6).attr("y", (d) => (d.y0 + d.y1) / 2).attr("dy", "0.35em")
  .attr("font-weight", (d) => couleurParti[d.name] ? "bold" : "normal")
  .text(libelle);
svgSankey.node();

// %% [markdown]
// ## 4. Le Québec dans le monde : l'indice de Gallagher
//
// L'indice de Gallagher, √(½ Σ (vᵢ − sᵢ)²), mesure l'écart entre parts de
// votes et parts de sièges. Élections récentes (Wikipédia, « Gallagher
// index ») et les trois dernières générales québécoises, calculées des
// résultats par circonscription (partis principaux distincts, petites
// candidatures regroupées — le regroupement choisi influence la valeur).

// %% [javascript]
const gallagherMonde = [
  { label: "Québec 2026",       g: 17.80, type: "qc" },
  { label: "Québec 2022",       g: 25.19, type: "qc" },
  { label: "Québec 2018",       g: 16.82, type: "qc" },
  { label: "Sainte-Lucie 2025", g: 30.22, type: "monde" },
  { label: "Royaume-Uni 2024",  g: 23.73, type: "monde" },
  { label: "Australie 2025",    g: 23.11, type: "monde" },
  { label: "France 2024",       g: 7.79,  type: "monde" },
  { label: "Allemagne 2025",    g: 6.49,  type: "monde" },
  { label: "Canada 2025",       g: 5.01,  type: "monde" },
  { label: "N.-Zélande 2023",   g: 2.63,  type: "monde" },
  { label: "États-Unis 2024",   g: 1.01,  type: "monde" },
  { label: "Suède 2022",        g: 0.64,  type: "monde" },
  { label: "Danemark 2026",     g: 0.42,  type: "monde" },
];

Plot.plot({
  height: 420,
  width: 760,
  marginLeft: 150,
  marginBottom: 55,
  style: { fontSize: "13px", fontFamily: "system-ui" },
  x: { label: "indice de Gallagher", grid: true, domain: [0, 32], labelAnchor: "center", labelOffset: 45 },
  y: {
    label: null,
    domain: gallagherMonde.slice().sort((a, b) => b.g - a.g).map((d) => d.label),
  },
  marks: [
    Plot.barX(gallagherMonde, {
      y: "label", x: "g",
      fill: (d) => d.label === "Québec 2026" ? "#2B50C8" : d.type === "qc" ? "#8FA6E0" : "#c9c9c9",
    }),
    Plot.text(gallagherMonde, {
      y: "label", x: "g", dx: 6, textAnchor: "start",
      text: (d) => d.g.toFixed(1).replace(".", ","), fill: "#444", fontSize: 11,
    }),
  ],
  caption: "Le Québec vit dans la zone des scrutins majoritaires les plus distordants; les systèmes proportionnels sont sous 3.",
});
