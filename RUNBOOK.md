# RUNBOOK — réveil et exploitation

Procédure pour reprendre le projet après des mois d'inactivité (gouvernement
minoritaire : prochaines générales possibles dès 2028).

## 1. Vérifier l'environnement

Versions attestées au 2026-10-08 : Deno 2.x, Node 26.x, @duckdb/node-api et
@tangent.to/ds 0.13.x figés par `js/package-lock.json` (`nodeModulesDir:
"manual"` dans `js/deno.json` : le lockfile npm fait foi pour les DEUX
runtimes; `npm install` dans `js/` avant toute commande Deno).

```
cd js && npm install && npm test
```

Le test golden exécute `computeProjection` sur des intrants figés
(`js/test/fixtures/`) avec graines et date fixes. S'il passe, l'environnement
est sain; s'il échoue sans changement de code volontaire, c'est la librairie
ou le runtime qui a bougé — diagnostiquer avant toute autre chose. Après un
changement de modèle VOULU : `node js/test/make_golden.mjs` régénère les
fixtures et l'attendu; le diff de `golden_expected.json` documente l'effet.

## 2. Frontière des runtimes

- `js/ingest/**/*.ts` : Deno (permissions explicites, un seul processus
  veille→export→compute). `js/src/` et `js/tools/*.mjs` : Node.
- `tools/compute.mjs` est lancé par les deux (`deno task compute` /
  `npm run compute`), par conception.
- Quelques outils d'analyse en `.ts` sous `js/tools/` (accès DuckDB) se
  lancent avec `deno run --allow-read --allow-write --allow-ffi --allow-env`
  DEPUIS `js/` (l'import map de `deno.json` est requis).

## 3. Séquence d'exploitation (campagne)

```
cd js
deno task watch          # veille Wikipédia -> DuckDB -> exports -> projection
npm run build:dashboard  # bundle du tableau de bord
# vérification visuelle Playwright avant push (règle CLAUDE.md)
```

Tâche planifiée Windows (la commande vit aussi en commentaire de watch.ts) :

```
schtasks /create /tn "veille-sondages" /sc hourly ^
  /tr "cmd /c cd /d C:\Users\parse01\documents-locaux\polls\js && deno task watch >> ..\data\watch.log 2>&1"
```

La veille porte des GARDES (retraits massifs, sommes de parts aberrantes) :
un run refusé n'écrit rien et le journal dit pourquoi; `--override-guards`
après inspection humaine seulement.

## 4. Nouveau cycle électoral — ce qu'il faut mettre à jour

Tant que `qc_cycles.json` (déclaratif, prévu au TODO) n'existe pas, les
constantes de cycle vivent dans SIX endroits à synchroniser à la main :

1. `js/src/computeProjection.js` : ELECTION_DATE, LEADERS_*.
2. `js/src/gpTrend.js` : CHANGEPOINTS (événements datés), CAMPAIGNS
   (fenêtres décret→scrutin).
3. `js/ingest/watch.ts` : CYCLE_BOUNDARIES (sinon tout sondage post-élection
   est classé dans le cycle précédent, silencieusement).
4. `js/ingest/export_json.ts` : bornes des partielles dans le SQL.
5. Chefs/candidats/sortants : `deno task candidates`, vérifier qc_leaders.
6. La baseline passe aux résultats de la dernière générale (réagrégation par
   sections de vote si la carte change — chaîne au tag `python-archive`,
   primitives TS équivalentes dans `tools/make_federal.mjs`).

## 5. État figé post-2026

- `js/data/qc_projection.json` AFFICHÉ = la projection de veille de scrutin
  (archivée aussi sous `qc_projection_veille_2026-10-05.json`). Un
  `deno task watch` qui recalcule l'écrase : restaurer depuis l'archive si
  le tableau de bord doit continuer de montrer l'état de veille.
- Résultats officiels : `data/raw/lus/2026-10-05-resultats-dgeq.json`
  (versionné) + `election_results` carte 2026 en base.
- `data/raw/MANIFEST.md` : empreintes des intrants que git ne porte pas.
- Le journal scientifique est `TODO.md`; la méthodologie publique est
  `js/index.html` (registre strict, voir CLAUDE.md).
