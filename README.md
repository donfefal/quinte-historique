# Quinté+ Historique

Site **100 % statique** (HTML/CSS/JavaScript vanilla, sans framework) qui analyse l'historique des courses Quinté+/Quarté+ et le parcours des chevaux, génère des **combinaisons candidates** et affiche un **backtest avec ROI réel**, toujours comparé au hasard.

> ⚠️ **Résultats passés, sans garantie pour l'avenir.** Ce n'est pas un outil de prédiction : en jeu d'argent, le ROI attendu est négatif.
> **LES JEUX D'ARGENT ET DE HASARD PEUVENT ÊTRE DANGEREUX : PERTES D'ARGENT, CONFLITS FAMILIAUX, ADDICTION… NOS CONSEILS SUR JOUEURS-INFO-SERVICE.FR (09-74-75-13-13 - APPEL NON SURTAXÉ)**

## Structure

```
index.html              SPA (routes #/accueil, #/analyse, #/stats, #/backtest, #/methode, #/legal)
css/style.css           charte claire, .card .table .badge .disclaimer .reglementaire .btn .slider
js/
  main.js               point d'entrée
  dataLoader.js         fetch des JSON + cache + import d'une course
  scoreEngine.js        formules de score + état incrémental (sans fuite d'information)
  combinaisonGenerator.js  base / élargie / valeur / poker
  backtest.js           walk-forward + comparaison à 200 tirages au hasard
  charts.js             heatmap, distribution, barres, évolution (SVG natif)
  ui.js                 pages, filtres, tri, sliders
  utils.js              CONFIG (devise EUR/XOF), échappement, formats
data/                   JSON pré-calculés (exemples FICTIFS fournis)
scripts/
  collecte_quinte.py    collecte API PMU + SQLite + moteur + JSON
  generer_exemple.py    régénère les données fictives
  requirements.txt
```

## 1. Collecte réelle (Python ≥ 3.10)

```bash
pip install -r scripts/requirements.txt
python scripts/collecte_quinte.py --debut 2024-11-01 --fin 2026-11-15 --output data/ --a-venir
```

Options utiles : `--toutes-courses` (collecte toutes les courses pour enrichir les parcours, ~10× plus long), `--paris QUINTE,QUARTE`, `--inclure-tocards`, `--pause 1.0`, `--sans-collecte` (régénère les JSON depuis `quinte.sqlite`), `--dump-brut` (enregistre une réponse brute dans `data/raw/`).
La collecte est reprenable (les jours déjà traités sont ignorés). Un résumé final affiche courses, chevaux, paires et combinaisons.

**À vérifier au premier lancement** : le script n'a pas pu être testé contre l'API réelle (accès réseau indisponible au moment du développement). Les noms de champs PMU sont lus de façon défensive ; lancez d'abord une petite période avec `--dump-brut` et contrôlez courses, partants, cotes et rapports (`rapports-definitifs`, dividende pour 1 €). Le jeu « 4+1 » dépend de l'opérateur : ajustez `--paris` si besoin.

## 2. Lancer le site en local

```bash
python -m http.server 8000     # puis http://localhost:8000
```
(Le site doit être servi en HTTP ; `file://` bloque `fetch()`.)

## 3. Déployer sur GitHub Pages

1. Créez un dépôt, poussez tout le contenu du dossier (y compris `data/`).
2. *Settings → Pages → Deploy from a branch → `main` / `(root)`*.
3. Le site est disponible sur `https://<utilisateur>.github.io/<depot>/`. Mettez à jour en relançant la collecte puis `git commit` des JSON.

## Course à venir

`--a-venir` ajoute les courses d'aujourd'hui/demain à `combinaisons_candidates.json`. Vous pouvez aussi importer un JSON depuis la page d'accueil (format affiché dans la page).

## Méthode

Voir la page **Méthode** du site (formules, limites, comparaison au hasard). Les formules sont identiques en Python et JavaScript (44 comparaisons vérifiées, 0 écart).

## Avant publication

- Les 6 JSON fournis sont **fictifs** (bandeau rouge automatique tant que `meta.fictif` est vrai).
- Complétez les mentions légales (éditeur, contact) et vérifiez les obligations de votre pays.
- Devise : `CONFIG.devise = 'XOF'` dans `js/utils.js` affiche les montants en FCFA.
