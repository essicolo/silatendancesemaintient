// %% [markdown]
// # La distorsion du mode de scrutin — Québec 2026
//
// Élection générale du 5 octobre 2026 (dépouillement final, Élections Québec).
// Trois lectures de la même réalité : la distorsion votes→sièges, l'entonnoir
// démographique qui sépare la population du vote gouvernemental, et la place du
// scrutin dans l'histoire québécoise et le monde selon l'indice de Gallagher.
//
// Sources : flux ouvert donnees.electionsquebec.qc.ca (résultats finaux),
// Atlas des élections / DGEQ pour l'historique 1878-2022, ISQ pour la
// population, Wikipédia (« Gallagher index ») pour les références
// internationales.

// %% [javascript]
// Données officielles 2026 et imports (Observable Plot + d3 via CDN).
const Plot = await import("https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6/+esm");
const d3 = await import("https://cdn.jsdelivr.net/npm/d3@7/+esm");

const resultat2026 = [
  { parti: "PQ",     votes: 28.02, sieges: 59 },
  { parti: "PLQ",    votes: 24.22, sieges: 40 },
  { parti: "PCQ",    votes: 20.67, sieges: 19 },
  { parti: "CAQ",    votes: 13.35, sieges: 0 },
  { parti: "QS",     votes: 12.43, sieges: 9 },
  { parti: "Autres", votes: 1.32,  sieges: 0 },
];
const TOTAL_SIEGES = 127;
const couleurs = { PQ: "#004C9D", PLQ: "#D71920", PCQ: "#52307C", CAQ: "#00B0F0", QS: "#FF8040", Autres: "#999999" };
resultat2026.map((d) => ({ ...d, siegesPct: +(d.sieges / TOTAL_SIEGES * 100).toFixed(1) }));

// %% [markdown]
// ## 1. Votes et sièges : la flèche de la distorsion
//
// Chaque flèche part de la part des votes et pointe vers la part des sièges.
// Un parti au-dessus de la diagonale implicite est surreprésenté, un parti
// dont la flèche pointe vers zéro est effacé par le scrutin : la CAQ obtient
// 13,4 % des votes et aucun des 127 sièges.

// %% [javascript]
{
  const data = resultat2026.map((d) => ({ ...d, siegesPct: d.sieges / TOTAL_SIEGES * 100 }));
  const ordre = data.map((d) => d.parti);
  Plot.plot({
    height: 300,
    marginLeft: 70,
    marginRight: 60,
    x: { label: "part (%)", domain: [0, 50], grid: true },
    y: { domain: ordre, label: null },
    marks: [
      Plot.arrow(data, {
        y: "parti", x1: "votes", x2: "siegesPct",
        stroke: (d) => couleurs[d.parti], strokeWidth: 2.5, headLength: 5,
      }),
      Plot.dot(data, { y: "parti", x: "votes", r: 4, fill: (d) => couleurs[d.parti] }),
      Plot.text(data, {
        y: "parti", x: "votes", dy: -12, textAnchor: "middle",
        text: (d) => `${d.votes.toFixed(1)} %`,
        fill: "#555", fontSize: 11,
      }),
      Plot.text(data, {
        y: "parti", x: "siegesPct", dy: -12, textAnchor: "middle",
        text: (d) => `${d.sieges} siège${d.sieges > 1 ? "s" : ""}`,
        fontWeight: "bold", fontSize: 11,
      }),
    ],
  });
}

// %% [markdown]
// ## 2. L'entonnoir : de la population au vote gouvernemental
//
// Le gouvernement issu du scrutin procède d'une fraction de la population :
// population totale, puis électorat inscrit (majeurs, citoyens), puis votes
// exercés, puis votes valides, puis votes pour le parti qui forme le
// gouvernement. Chiffres 2026 : Élections Québec (inscription et
// dépouillement finals); population : ISQ, estimation 2026 (≈ 9,11 M).

// %% [javascript]
const entonnoir = [
  { etape: "Population du Québec",       n: 9110000, note: "ISQ, estimation 2026" },
  { etape: "Électeurs inscrits",         n: 6495984, note: "citoyens de 18 ans et plus inscrits" },
  { etape: "Votes exercés",              n: 4345857, note: "participation de 66,9 %" },
  { etape: "Votes valides",              n: 4282551, note: "1,5 % de bulletins rejetés" },
  { etape: "Votes pour le gouvernement", n: 1199925, note: "PQ, 59 sièges sur 127" },
].map((d, i) => ({ ...d, rang: i, pctPop: d.n / 9110000 * 100 }));

Plot.plot({
  height: 320,
  marginLeft: 50,
  x: {
    domain: entonnoir.map((d) => d.etape), label: null,
    tickRotate: -15,
  },
  y: { label: "personnes (millions)", grid: true, domain: [0, 9.5] },
  marks: [
    Plot.areaY(entonnoir, { x: "etape", y: (d) => d.n / 1e6, fill: "#004C9D", fillOpacity: 0.15, curve: "linear" }),
    Plot.lineY(entonnoir, { x: "etape", y: (d) => d.n / 1e6, stroke: "#004C9D", strokeWidth: 2, marker: "circle" }),
    Plot.text(entonnoir, {
      x: "etape", y: (d) => d.n / 1e6, dy: -12,
      text: (d) => `${(d.n / 1e6).toFixed(2).replace(".", ",")} M (${d.pctPop.toFixed(0)} %)`,
      fontSize: 11,
    }),
  ],
  caption: "Le parti qui forme le gouvernement a reçu le vote de 13 % de la population.",
});

// %% [markdown]
// La même cascade en diagramme de Sankey : chaque étape sépare ce qui continue
// de ce qui sort (mineurs et non-inscrits, abstention, bulletins rejetés,
// votes pour les autres partis).

// %% [javascript]
{
  const sankeyMod = await import("https://cdn.jsdelivr.net/npm/d3-sankey@0.12/+esm");
  const noeuds = [
    "Population du Québec", "Électeurs inscrits", "Votes exercés", "Votes valides",
    "Votes pour le gouvernement (PQ)",
    "Mineurs, non-citoyens, non-inscrits", "Abstention", "Bulletins rejetés", "Votes pour les autres partis",
  ].map((name) => ({ name }));
  const idx = Object.fromEntries(noeuds.map((n, i) => [n.name, i]));
  const liens = [
    { source: "Population du Québec", target: "Électeurs inscrits", value: 6495984 },
    { source: "Population du Québec", target: "Mineurs, non-citoyens, non-inscrits", value: 9110000 - 6495984 },
    { source: "Électeurs inscrits", target: "Votes exercés", value: 4345857 },
    { source: "Électeurs inscrits", target: "Abstention", value: 6495984 - 4345857 },
    { source: "Votes exercés", target: "Votes valides", value: 4282551 },
    { source: "Votes exercés", target: "Bulletins rejetés", value: 4345857 - 4282551 },
    { source: "Votes valides", target: "Votes pour le gouvernement (PQ)", value: 1199925 },
    { source: "Votes valides", target: "Votes pour les autres partis", value: 4282551 - 1199925 },
  ].map((l) => ({ source: idx[l.source], target: idx[l.target], value: l.value }));

  const largeur = 820, hauteur = 420;
  const sankey = sankeyMod.sankey()
    .nodeWidth(14).nodePadding(18)
    .extent([[0, 10], [largeur - 170, hauteur - 10]]);
  const { nodes, links } = sankey({ nodes: noeuds.map((d) => ({ ...d })), links: liens });

  const svg = d3.create("svg").attr("viewBox", [0, 0, largeur, hauteur]).attr("font-family", "system-ui").attr("font-size", 11);
  const sortie = new Set(["Mineurs, non-citoyens, non-inscrits", "Abstention", "Bulletins rejetés", "Votes pour les autres partis"]);
  svg.append("g").selectAll("path").data(links).join("path")
    .attr("d", sankeyMod.sankeyLinkHorizontal())
    .attr("fill", "none")
    .attr("stroke", (d) => sortie.has(d.target.name) ? "#bbbbbb" : "#004C9D")
    .attr("stroke-opacity", 0.45)
    .attr("stroke-width", (d) => Math.max(1, d.width));
  svg.append("g").selectAll("rect").data(nodes).join("rect")
    .attr("x", (d) => d.x0).attr("y", (d) => d.y0)
    .attr("width", (d) => d.x1 - d.x0).attr("height", (d) => Math.max(1, d.y1 - d.y0))
    .attr("fill", (d) => sortie.has(d.name) ? "#999999" : "#004C9D");
  svg.append("g").selectAll("text").data(nodes).join("text")
    .attr("x", (d) => d.x1 + 6).attr("y", (d) => (d.y0 + d.y1) / 2).attr("dy", "0.35em")
    .text((d) => `${d.name} — ${(d.value / 1e6).toFixed(2).replace(".", ",")} M`);
  svg.node();
}

// %% [markdown]
// ## 3. 2026 dans l'histoire et dans le monde : l'indice de Gallagher
//
// L'indice de Gallagher, √(½ Σ (vᵢ − sᵢ)²), mesure l'écart entre parts de
// votes et parts de sièges. Série québécoise calculée des résultats par
// circonscription (Atlas / DGEQ; partis principaux distincts, petites
// candidatures regroupées; sièges recomptés par pluralité; avant 1900 les
// élections par acclamation rendent la mesure fragile). Références
// internationales : article « Gallagher index » de Wikipédia.

// %% [javascript]
const gallagherQc = [
  { year: 1878, g: 1.36 }, { year: 1890, g: 12.57 }, { year: 1892, g: 15.36 },
  { year: 1897, g: 14.93 }, { year: 1908, g: 20.48 }, { year: 1912, g: 23.50 },
  { year: 1923, g: 18.57 }, { year: 1927, g: 23.99 }, { year: 1931, g: 32.14 },
  { year: 1935, g: 4.03 }, { year: 1936, g: 25.91 }, { year: 1939, g: 24.60 },
  { year: 1944, g: 13.32 }, { year: 1948, g: 33.90 }, { year: 1952, g: 22.21 },
  { year: 1956, g: 24.57 }, { year: 1960, g: 2.01 }, { year: 1962, g: 9.72 },
  { year: 1966, g: 9.10 }, { year: 1970, g: 19.27 }, { year: 1973, g: 32.81 },
  { year: 1976, g: 19.00 }, { year: 1981, g: 14.56 }, { year: 1985, g: 22.96 },
  { year: 1989, g: 21.04 }, { year: 1994, g: 13.81 }, { year: 1998, g: 15.37 },
  { year: 2003, g: 15.13 }, { year: 2007, g: 5.58 }, { year: 2008, g: 11.79 },
  { year: 2012, g: 13.76 }, { year: 2014, g: 10.84 }, { year: 2018, g: 16.82 },
  { year: 2022, g: 25.19 }, { year: 2026, g: 17.80 },
];
const referencesMonde = [
  { label: "Danemark 2026", g: 0.42 }, { label: "Suède 2022", g: 0.64 },
  { label: "N.-Zélande 2023", g: 2.63 }, { label: "Canada 2025", g: 5.01 },
  { label: "Allemagne 2025", g: 6.49 }, { label: "France 2024", g: 7.79 },
  { label: "Australie 2025", g: 23.11 }, { label: "Royaume-Uni 2024", g: 23.73 },
];

Plot.plot({
  height: 380,
  marginRight: 140,
  x: { label: "année", tickFormat: "d" },
  y: { label: "indice de Gallagher", grid: true, domain: [0, 35] },
  marks: [
    Plot.ruleY(referencesMonde, { y: "g", stroke: "#cccccc", strokeDasharray: "2,3" }),
    Plot.text(referencesMonde, {
      y: "g", x: 2030, text: "label", textAnchor: "start", fill: "#888", fontSize: 10,
      dy: (d, i) => (d.label === "Royaume-Uni 2024" ? -5 : d.label === "Australie 2025" ? 7 : 0),
    }),
    Plot.lineY(gallagherQc, { x: "year", y: "g", stroke: "#004C9D", strokeWidth: 1.5 }),
    Plot.dot(gallagherQc, { x: "year", y: "g", r: 2.5, fill: "#004C9D" }),
    Plot.dot([gallagherQc.at(-1)], { x: "year", y: "g", r: 5, fill: "#D71920" }),
    Plot.text([gallagherQc.at(-1)], { x: "year", y: "g", dy: -12, text: (d) => `2026 : ${d.g.toFixed(1)}`, fontWeight: "bold" }),
  ],
  caption: "Le Québec évolue depuis un siècle dans la zone des scrutins majoritaires les plus distordants (Royaume-Uni, Australie); les systèmes proportionnels vivent sous 3.",
});

// %% [markdown]
// ## 4. La distance d'Aitchison comme indice de distorsion?
//
// Idée naturelle dans un cadre compositionnel : la distorsion serait
// d_A(votes, sièges), la distance d'Aitchison entre les deux compositions.
// Deux objections, d'importance très inégale.
//
// **Le nombre de parties n'est pas le vrai problème.** La distance croît
// mécaniquement avec le nombre de coordonnées, mais se normalise (par
// √(k−1), moyenne quadratique par coordonnée), et la dominance
// sous-compositionnelle garantit une comparaison cohérente à convention de
// parts fixée — la même exigence que l'indice de Gallagher impose déjà
// (regrouper ou non les petits partis change sa valeur : 17,8 contre 25,2
// pour 2022 selon la convention).
//
// **Les zéros structurels, eux, sont disqualifiants.** La géométrie
// d'Aitchison exclut le bord du simplexe : un parti avec des votes et zéro
// siège n'a pas d'image. Il faut imputer une part de siège δ > 0, et la
// distance est alors dominée par log(δ) — l'indice mesure le choix
// d'imputation, pas la distorsion. Or les zéros sont précisément le
// phénomène à mesurer : 2026 EST l'année où un parti à 13,4 % des votes n'a
// aucun siège. Là où la distorsion culmine, la distance d'Aitchison diverge
// au lieu de produire un nombre. La cellule suivante le montre : d_A passe
// du simple au double (3,27 à 7,45) selon un δ arbitraire entre un demi et
// un centième de siège, pendant que Gallagher ne bouge pas. Verdict : garder l'esprit
// compositionnel pour les parts strictement positives, et Gallagher — borné,
// indifférent aux zéros — pour la distorsion du scrutin.

// %% [javascript]
{
  const ilr = (parts) => {
    // base pivot : contrastes cumulatifs orthonormés
    const logp = parts.map(Math.log);
    const out = [];
    for (let i = 0; i < parts.length - 1; i++) {
      const meanRest = logp.slice(i + 1).reduce((a, b) => a + b, 0) / (parts.length - i - 1);
      out.push(Math.sqrt((parts.length - i - 1) / (parts.length - i)) * (logp[i] - meanRest));
    }
    return out;
  };
  const close = (v) => { const s = v.reduce((a, b) => a + b, 0); return v.map((x) => x / s); };
  const votes = close(resultat2026.map((d) => d.votes));
  const essais = [0.5, 0.1, 0.01].map((delta) => {
    const sieges = close(resultat2026.map((d) => d.sieges > 0 ? d.sieges : delta));
    const a = ilr(votes), b = ilr(sieges);
    const dA = Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));
    return { "δ (sièges imputés aux partis à 0)": delta, "distance d'Aitchison": +dA.toFixed(2), "Gallagher": 17.8 };
  });
  essais;
}
