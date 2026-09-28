# Règles du projet

## Méthodologie et textes affichés : registre scientifique strict

La méthodologie de `js/index.html` et tous les textes visibles du tableau de
bord (notes, légendes, infobulles) sont des textes scientifiques destinés à
des lecteurs humains. Règles non négociables :

- Décrire le modèle **tel qu'il tourne**, jamais l'histoire de son
  développement. Aucun récit de débogage, aucune justification narrative
  (« le maximum était fragile », « au point de laisser… », « ce qui
  ignorait… »), aucune comparaison avec un état antérieur du code.
- Registre impersonnel et sobre : énoncer la méthode, la formule, la source,
  le chiffre de validation. Si une phrase explique *pourquoi on a changé*
  plutôt que *ce qui est calculé*, elle n'a pas sa place.
- Jamais de cadratin (—) ni de gras dans les textes affichés.
- Les chiffres cités (couverture, R², effectifs) doivent être à jour avec le
  modèle en production.
- Le journal de bord — diagnostics, essais rejetés, leçons, anecdotes — vit
  dans `TODO.md` et les messages de commit, nulle part ailleurs.

Toute modification du modèle exige la mise à jour de la méthodologie **dans
ce registre**, pas l'ajout d'un paragraphe qui raconte la modification.

## Autres conventions établies

- Aucun paramètre posé à la main : tout effet est estimé des données, avec
  l'hypothèse nulle sur la grille (le modèle sans l'effet doit rester un cas
  particulier que l'évidence peut choisir).
- Validation obligatoire avant adoption : hors échantillon (CV, backtest),
  jamais la seule vraisemblance in-sample.
- Modifications d'interface : vérifier le rendu réel (Playwright) avant de
  pousser.
