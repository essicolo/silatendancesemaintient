# Si la tendance se maintient

Projection électorale pour les élections générales québécoises de 2026 —
agrégation de sondages, modèle de circonscriptions et simulation de sièges,
le tout compositionnel (coordonnées log-ratio isométriques) et gaussien
(processus gaussiens partout où c'est possible). Neutre et reproductible :
chaque paramètre est estimé des données, avec son incertitude, jamais posé
à la main.

**Page :** le tableau de bord n'affiche qu'une projection **précalculée**
(`js/data/qc_projection.json`) — aucun calcul dans le navigateur.

## Architecture

- `js/src/` — tout le modèle, en JavaScript avec
  [`@tangent.to/ds`](https://tangent.to) : tendance nationale par GP en ILR
  (noyau Matérn 3/2, points de rupture aux changements de chefs), GP conjoint
  national/régional à observations agrégées, effets de circonscription par GP
  Matérn multivarié, effets chef estimés sur 1970-2022, simulation Monte
  Carlo à quatre sources d'incertitude. Le détail est dans la méthodologie de
  la page elle-même (`js/index.html`).
- `js/ingest/` — la boucle vivante, en TypeScript exécuté par Deno :
  parseur des tableaux de sondages de Wikipédia (CC BY-SA, chaque ligne
  pointant vers la publication d'origine), base DuckDB, exports JSON, veille.
- Le Python d'origine (prototypes de validation, scripts d'estimation,
  reconstruction complète de la base : recensement, résultats historiques,
  redécoupage) est purgé du tronc mais intact sous le tag git
  `python-archive` — ses sorties, statiques entre élections, vivent dans
  `js/data/` et `data/riding_names_*.json`.
- `TODO.md` — journal de bord : décisions, validations, limites assumées.

## Commandes

Depuis `js/` :

```sh
deno task watch      # veille : détecte, ingère, réexporte, recalcule (~1,5 s si rien)
deno task compute    # recalcule la projection seule
deno task export     # réexporte les JSON depuis DuckDB
npm run dev          # serveur de développement (esbuild, port 8000)
npm run build:dashboard
```

## Déploiement

GitHub Pages via `.github/workflows/pages.yml` : chaque poussée sur `main`
rebâtit le bundle et republie la page. La veille tourne localement
(planificateur de tâches) ; commiter la nouvelle projection suffit à mettre
le site à jour.
