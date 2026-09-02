# Si la tendance se maintient
Projection électorale pour les élections générales québécoises de 2026: agrégation de sondages, modèle de circonscriptions et simulation de sièges, le tout compositionnel (coordonnées log-ratio isométriques) et gaussien (processus gaussiens partout où c'est possible). Neutre et reproductible : chaque paramètre est estimé des données, avec son incertitude, jamais posé à la main.

## Méthodologie
### Données
Sondages d'intentions de vote compilés à partir des tableaux de Wikipédia (CC BY-SA), chaque sondage renvoyant à la publication d'origine de la maison de sondage: Léger, Pallas Data, Mainstreet, Synopsis, Angus Reid, Abacus et autres. Recensement 2021 par circonscription (Statistique Canada, agrégé par aire de diffusion). Résultats de 2014, 2018 et 2022 (Élections Québec), exprimés sur la carte électorale 2026 (127 circonscriptions) par réagrégation géographique des sections de vote. Députés sortants, retraits et chefs depuis les pages de l'Assemblée nationale sur Wikipédia.

### Agrégation des sondages
Les intentions de vote sont traitées comme une composition (les parts somment à 1) et manipulées en coordonnées log-ratio isométriques (ILR), où les opérations linéaires sont valides (une différence de points de pourcentage n'a pas le même sens à 4% qu'à 40%). La tendance est un processus gaussien par coordonnée ILR, avec un bruit d'observation par sondage proportionnel à l'inverse de la taille d'échantillon; l'échelle du bruit et la portée temporelle sont choisies par vraisemblance marginale, et le noyau admet des points de rupture aux changements de chefs (14 janvier et 12 avril 2026) : la corrélation entre régimes est elle-même ajustée par vraisemblance, la valeur 1 redonnant le modèle stationnaire, et l'évidence a retenu une rupture partielle (ρ=0,4) sur la coordonnée lente, celle qui tirait la remontée caquiste vers le creux pré-Fréchette. La calibration des intervalles est vérifiée par validation croisée : 91% des sondages tombent dans l'intervalle à 90%. Les sondages régionaux (ventilations Montréal / Québec / reste) entrent dans le même modèle comme observations d'un processus gaussien conjoint : trois trajectoires régionales latentes dont un sondage national observe la somme pondérée par les poids électoraux, et un sondage régional une seule. Validé sur 2022 : erreur régionale moyenne 3,1 points contre 3,6 pour le swing uniforme, le gain concentré dans la région de Québec où la concentration conservatrice décide des sièges.

### Projection par circonscription
Le mouvement provincial est appliqué au résultat de 2022 de chaque circonscription. Un siège dont le député ne se représente pas, ou siège désormais pour un autre parti (57 des 125 sièges, relevés automatiquement) perd la prime personnelle au sortant, appliquée comme perturbation compositionnelle (facteur 1,125 sur la part du parti tenant, estimé des données par candidat 2018 à 2022). Un chef de parti sur le bulletin local vaut davantage. L'effet est estimé sur 35 cas historiques (1970-2022), chaque candidature de chef classée arrivée / continuation / départ et mesurée contre le contrefactuel de swing uniforme; comme l'effet n'est pas stable dans le temps (quasi nul avant 1998, fort à l'ère moderne), un processus gaussien sur l'année en donne l'extrapolation 2026 : arrivée ×1,82, continuation ×1,31, départ ×0,90. Ces ajustements modifient le point de départ de la projection, jamais le résultat 2022 affiché. S'ajoute une déviation locale prédite par un processus gaussien multivarié (noyau Matérn, un GP par coordonnée ILR, hyperparamètres par vraisemblance marginale ré-évaluée dans chaque pli de validation).

### Variables du modèle de déviation locale
- Langue: part de foyers de langue française, le reste en complément.
- Scolarité: diplôme universitaire, aucun diplôme, le reste en complément.
- Immigration: part immigrante, le reste en complément.
- Secteurs d'emploi: agriculture, fabrication, commerce de détail, services professionnels, santé et services sociaux, le reste en complément.
- Âge, revenu, densité: âge médian, revenu médian des ménages, densité de population (les trois seules grandeurs non compositionnelles).
- Déviation de la circonscription à l'élection précédente, en coordonnées ILR.

Les groupes compositionnels sont fermés avec une part résiduelle explicite puis transformés en ILR avant d'entrer au modèle. Aucune sélection de variables : tout entre, et le GP atténue de lui-même ce qui ne porte pas de signal. R² multivarié hors échantillon (50% ×15) : 0,44, contre 0,38 pour la régression ridge qu'il remplace.

### Incertitude
La simulation Monte Carlo (5 000 tirages) propage quatre sources d'incertitude : (1) la distribution a posteriori de la tendance nationale; (2) un choc systémique commun à toutes les circonscriptions, soit le biais collectif des sondeurs plus la dérive d'ici au scrutin du 5 octobre, calibré sur l'écart historique entre les derniers sondages et le résultat réel (2018 et 2022); (3) un facteur régional (Montréal / Québec / reste), car les déviations locales sont corrélées dans l'espace; (4) la déviation propre de chaque circonscription, rééchantillonnée des erreurs de prédiction hors échantillon du modèle (élargie pour les circonscriptions où le modèle ne prédit rien). Les intentions affichées sont l'état de l'opinion aujourd'hui; la simulation de sièges porte sur le jour du scrutin.
### Limites

Deux validations, chacune sur une seule élection. Sur 2022 (swing seul) : 89% des circonscriptions correctement classées, 78% des courses serrées. Sur 2018 (pipeline complet, test temporel inversé faute d'une troisième élection) : 89% des circonscriptions, 97% des serrées, contre 52% pour une projection sans changement. Le choc systémique est calibré sur deux élections seulement. La réputation d'un candidat en particulier n'est pas modélisée, ni la participation différentielle. Les covariances entre partis dans la tendance ne sont pas modélisées.

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

## Commandes
Depuis `js/` :

```sh
deno task watch # veille : détecte, ingère, réexporte, recalcule (~1,5 s si rien)
deno task compute # recalcule la projection seule
deno task export # réexporte les JSON depuis DuckDB
npm run dev # serveur de développement (esbuild, port 8000)
npm run build:dashboard
```

## Déploiement
GitHub Pages via `.github/workflows/pages.yml` : chaque poussée sur `main` rebâtit le bundle et republie la page. La veille tourne localement (planificateur de tâches) ; commiter la nouvelle projection suffit à mettre le site à jour.
