#!/usr/bin/env python3
"""Copie les JSON fraîchement générés vers data/ seulement s'ils ont réellement changé.

Usage : python scripts/publier_si_change.py data_new data

Sécurités : un fichier vide, invalide, marqué « exemple » ou sans course n'écrase JAMAIS les données publiées.
Le champ meta.genere_le (horodatage) est ignoré dans la comparaison, pour ne pas créer un commit à chaque exécution.
Code retour : 0 = au moins un fichier mis à jour ou rien à faire ; 1 = données invalides (rien n'est copié).
"""
import json
import shutil
import sys
from pathlib import Path

FICHIERS = ["arrivees_historique", "stats_numeros", "cooccurrences", "parcours",
            "combinaisons_candidates", "courses_a_venir"]
OBLIGATOIRES = {"arrivees_historique": "courses", "parcours": "chevaux"}


def charger(p: Path):
    with p.open(encoding="utf-8") as f:
        return json.load(f)


def sans_horodatage(d):
    if isinstance(d, dict) and isinstance(d.get("meta"), dict):
        d = {**d, "meta": {k: v for k, v in d["meta"].items() if k != "genere_le"}}
    return d


def main(src: Path, dst: Path) -> int:
    nouveaux = {}
    for nom in FICHIERS:
        p = src / f"{nom}.json"
        if not p.exists():
            print(f"ERREUR : {p} absent")
            return 1
        try:
            d = charger(p)
        except Exception as e:  # noqa: BLE001
            print(f"ERREUR : {p} illisible ({e})")
            return 1
        if isinstance(d, dict) and d.get("meta", {}).get("exemple"):
            print(f"ERREUR : {p} est marqué « exemple » — publication refusée")
            return 1
        cle = OBLIGATOIRES.get(nom)
        if cle and not d.get(cle):
            print(f"ERREUR : {p} sans « {cle} » — publication refusée")
            return 1
        nouveaux[nom] = d

    modifies = []
    for nom, d in nouveaux.items():
        cible = dst / f"{nom}.json"
        try:
            ancien = charger(cible) if cible.exists() else None
        except Exception:  # noqa: BLE001
            ancien = None
        if sans_horodatage(ancien) != sans_horodatage(d):
            shutil.copyfile(src / f"{nom}.json", cible)
            modifies.append(nom)
    print("Fichiers mis à jour :", ", ".join(modifies) if modifies else "aucun (données identiques)")
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]), Path(sys.argv[2])))
