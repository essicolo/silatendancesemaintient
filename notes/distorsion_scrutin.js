// ---
// title: Distorsion scrutin
// id: distorsion-scrutin
// ---

// %% [markdown]
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
// 14 % de la population (un gouvernement procède du vote d'une petite
// fraction des Québécois).

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
// ## 2. L'entonnoir et la distorsion
//
// La cascade population → inscrits → votants → votes valides, le vote valide
// éclaté par parti, et, alignée sur chaque parti, la flèche de la distorsion :
// de sa part des votes exprimés (point) vers sa part des sièges. La CAQ :
// 13,3 % des votes, aucun des 127 sièges.

// %% [javascript]
const sankeyMod = await import("https://cdn.jsdelivr.net/npm/d3-sankey@0.12/+esm");

// --- palette et typographie du graphique (hors couleurs de partis) ---
const ENCRE = "#2A2E24";        // encre teintée feuille, pas de noir pur
const GRIS = "#8B887A";         // texte secondaire, chaud
const HAIRLINE = "#DAD7CE";
const VERT_NOEUD = "#9FBA85";   // entonnoir
const VERT_FLUX = "#E3EDD3";
const SORTIE_FLUX = "#ECE8E1";  // gris-papier des sorties
const SORTIE_NOEUD = "#C8C2B8";
const F_DISPLAY = "'Fraunces', Georgia, serif";
const F_TEXTE = "'Inter Tight', 'Segoe UI', sans-serif";

const couleurParti = Object.fromEntries(partis.map((p) => [p.parti, p.couleur]));
const autresN = VOTES_VALIDES - partis.reduce((s, p) => s + p.votesN, 0);
const partisSankey = [...partis, { parti: "Autres", votesN: autresN, sieges: 0, couleur: GRIS }];

const noeudsSankey = [
  "Pop. du Québec", "Électeurs inscrits", "Votes exercés", "Votes valides",
  "Mineurs, non-citoyens", "Abstention", "Bulletins rejetés",
  ...partisSankey.map((p) => p.parti),
].map((name) => ({ name }));
const idxSankey = Object.fromEntries(noeudsSankey.map((n, i) => [n.name, i]));
const liensSankey = [
  ["Pop. du Québec", "Électeurs inscrits", INSCRITS],
  ["Pop. du Québec", "Mineurs, non-citoyens", POPULATION - INSCRITS],
  ["Électeurs inscrits", "Votes exercés", VOTES_EXERCES],
  ["Électeurs inscrits", "Abstention", INSCRITS - VOTES_EXERCES],
  ["Votes exercés", "Votes valides", VOTES_VALIDES],
  ["Votes exercés", "Bulletins rejetés", VOTES_EXERCES - VOTES_VALIDES],
  ...partisSankey.map((p) => ["Votes valides", p.parti, p.votesN]),
].map(([s, t, v]) => ({ source: idxSankey[s], target: idxSankey[t], value: v }));

const sankeyGen = sankeyMod.sankey().nodeWidth(8).nodePadding(16)
  .nodeSort(null) // garde l'ordre déclaré : partis du plus fort au plus faible
  .extent([[0, 10], [640, 470]]);
const sankeyLayout = sankeyGen({ nodes: noeudsSankey.map((d) => ({ ...d })), links: liensSankey });
const gris = new Set(["Mineurs, non-citoyens", "Abstention", "Bulletins rejetés"]);
const couleurNoeud = (name) =>
  gris.has(name) ? SORTIE_NOEUD : couleurParti[name] ?? (name === "Autres" ? SORTIE_NOEUD : VERT_NOEUD);
const valeurM = (v) => (v / 1e6).toFixed(2).replace(".", ",") + " M";

// Réglages du panneau des flèches : SEULS ces deux nombres sont à ajuster.
// FLECHE_GAUCHE rapproche/éloigne le panneau du Sankey; FLECHE_LARGEUR le
// resserre ou l'étire.
const FLECHE_GAUCHE = 780;
const FLECHE_LARGEUR = 300;

const svgSankey = d3.create("svg").attr("viewBox", [0, 0, FLECHE_GAUCHE + FLECHE_LARGEUR + 90, 540])
  .attr("font-family", F_TEXTE).attr("font-size", 12);
svgSankey.append("style").text(
  "@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,560&family=Inter+Tight:wght@400;600&display=swap');"
);

// flux
svgSankey.append("g").selectAll("path").data(sankeyLayout.links).join("path")
  .attr("d", sankeyMod.sankeyLinkHorizontal())
  .attr("fill", "none")
  .attr("stroke", (d) => gris.has(d.target.name) ? SORTIE_FLUX
    : couleurParti[d.target.name] ?? VERT_FLUX)
  .attr("stroke-opacity", (d) => couleurParti[d.target.name] ? 0.5 : 1)
  .attr("stroke-width", (d) => Math.max(1, d.width));
// nœuds
svgSankey.append("g").selectAll("rect").data(sankeyLayout.nodes).join("rect")
  .attr("x", (d) => d.x0).attr("y", (d) => d.y0)
  .attr("width", (d) => d.x1 - d.x0).attr("height", (d) => Math.max(1, d.y1 - d.y0))
  .attr("fill", (d) => couleurNoeud(d.name));
// libellés des étapes et des sorties
svgSankey.append("g").selectAll("text")
  .data(sankeyLayout.nodes.filter((d) => !couleurParti[d.name] && d.name !== "Autres" && d.name !== "Votes valides"))
  .join("text")
  .attr("x", (d) => d.x1 + 8).attr("y", (d) => (d.y0 + d.y1) / 2).attr("dy", "0.35em")
  .attr("fill", (d) => gris.has(d.name) ? GRIS : ENCRE)
  .text((d) => `${d.name} : ${valeurM(d.value)}`);
// libellés des partis : nom en couleur, valeur en gris léger
const lblParti = svgSankey.append("g").selectAll("text")
  .data(sankeyLayout.nodes.filter((d) => couleurParti[d.name] || d.name === "Autres"))
  .join("text")
  .attr("x", (d) => d.x1 + 8).attr("y", (d) => (d.y0 + d.y1) / 2).attr("dy", "0.35em");
lblParti.append("tspan")
  .attr("font-weight", 600)
  .attr("fill", (d) => d.name === "Autres" ? GRIS : couleurParti[d.name])
  .text((d) => d.name);
lblParti.append("tspan").attr("fill", GRIS).text((d) => `  ${valeurM(d.value)}`);

// --- flèches de distorsion, alignées sur les nœuds de partis ---
const xFleche = d3.scaleLinear([0, 50], [FLECHE_GAUCHE, FLECHE_GAUCHE + FLECHE_LARGEUR]);
const partisFleche = partis.map((p) => {
  const n = sankeyLayout.nodes.find((nd) => nd.name === p.parti);
  return {
    ...p,
    y: (n.y0 + n.y1) / 2,
    votesPct: p.votesN / VOTES_VALIDES * 100,
    siegesPct: p.sieges / TOTAL_SIEGES * 100,
  };
});
const yHautF = Math.min(...partisFleche.map((d) => d.y)) - 26;
const yBasF = Math.max(...partisFleche.map((d) => d.y)) + 26;

// un seul repère : le zéro, là où s'écrase la flèche de la CAQ
svgSankey.append("line")
  .attr("x1", xFleche(0)).attr("x2", xFleche(0))
  .attr("y1", yHautF).attr("y2", yBasF)
  .attr("stroke", HAIRLINE);
svgSankey.append("text")
  .attr("x", xFleche(0)).attr("y", yBasF + 16)
  .attr("text-anchor", "middle").attr("fill", GRIS).attr("font-size", 11)
  .text("0");
// la légende remplace l'axe
svgSankey.append("text")
  .attr("x", xFleche(0) + 12).attr("y", yBasF + 16)
  .attr("fill", GRIS).attr("font-size", 11)
  .text("chaque flèche va de la part des votes à la part des sièges, à l'échelle");

// pointes de flèche aux couleurs des partis
const defsF = svgSankey.append("defs");
for (const p of partisFleche) {
  defsF.append("marker")
    .attr("id", "fleche-" + p.parti)
    .attr("viewBox", "0 0 8 8").attr("refX", 6).attr("refY", 4)
    .attr("markerWidth", 6.5).attr("markerHeight", 6.5).attr("orient", "auto")
    .append("path").attr("d", "M0,0L8,4L0,8z").attr("fill", p.couleur);
}
const grpF = svgSankey.append("g").attr("font-size", 11);
for (const p of partisFleche) {
  const x1 = xFleche(p.votesPct), x2 = xFleche(p.siegesPct);
  const versDroite = x2 >= x1;
  grpF.append("line")
    .attr("x1", x1).attr("x2", x2).attr("y1", p.y).attr("y2", p.y)
    .attr("stroke", p.couleur).attr("stroke-width", 2)
    .attr("marker-end", `url(#fleche-${p.parti})`);
  grpF.append("circle").attr("cx", x1).attr("cy", p.y).attr("r", 4).attr("fill", p.couleur);
  // part des votes du côté du point, hors de la flèche
  grpF.append("text")
    .attr("x", x1 + (versDroite ? -9 : 9)).attr("y", p.y)
    .attr("dy", "0.35em").attr("text-anchor", versDroite ? "end" : "start")
    .attr("fill", GRIS)
    .text(Math.round(p.votesPct) + " %");
  // sièges au-delà de la pointe
  grpF.append("text")
    .attr("x", x2 + (versDroite ? 10 : -10)).attr("y", p.y)
    .attr("dy", "0.35em").attr("text-anchor", versDroite ? "start" : "end")
    .attr("fill", ENCRE).attr("font-weight", 600)
    .text(`${p.sieges} siège${p.sieges > 1 ? "s" : ""}`);
}

// --- l'annotation qui habite le vide : la thèse du graphique ---
const pctPop = Math.round(1199925 / POPULATION * 100);
const xAnnot = FLECHE_GAUCHE + 110;
svgSankey.append("text")
  .attr("x", xAnnot).attr("y", 96)
  .attr("font-family", F_DISPLAY).attr("font-size", 78).attr("font-weight", 560)
  .attr("fill", ENCRE)
  .text(pctPop + " %");
const annot = svgSankey.append("text")
  .attr("x", xAnnot + 3).attr("y", 122)
  .attr("fill", GRIS).attr("font-size", 13);
annot.append("tspan").text("de la population a donné son vote");
annot.append("tspan").attr("x", xAnnot + 3).attr("dy", 18).text("au parti qui forme le gouvernement.");

svgSankey.node();

// %% [markdown]
// ## 3. Le Québec dans le monde : l'indice de Gallagher
//
// L'indice de Gallagher, √(½ Σ (vᵢ − sᵢ)²), mesure l'écart entre parts de
// votes et parts de sièges. Élections récentes (Wikipédia, « Gallagher
// index ») et les trois dernières générales québécoises, calculées des
// résultats par circonscription (partis principaux distincts, petites
// candidatures regroupées - le regroupement choisi influence la valeur).

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