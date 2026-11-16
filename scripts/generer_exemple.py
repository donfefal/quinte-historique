#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generer_exemple.py — Génère des données FICTIVES mais vraisemblables dans data/.

Les courses, chevaux, cotes et rapports sont inventés (aucune course réelle). Le but est que le site
soit fonctionnel dès le premier clic, avant la collecte réelle. Les JSON sont produits par le même
code que la collecte réelle (collecte_quinte.exporter_tout), ce qui teste aussi le pipeline.

    python scripts/generer_exemple.py            # écrit dans data/
    python scripts/generer_exemple.py --output /tmp/data
"""
from __future__ import annotations

import argparse
import math
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collecte_quinte as cq  # noqa: E402

DEBUTS = ["Quartz", "Idole", "Tango", "Orage", "Fleur", "Jade", "Nuage", "Éclair", "Soleil", "Rubis", "Saphir",
          "Prince", "Reine", "Baron", "Étoile", "Mistral", "Opale", "Cyclone", "Harmonie", "Galop", "Vagabond",
          "Lumière", "Tempête", "Océane", "Ténor", "Brindille", "Caprice", "Dahlia", "Faucon", "Gazelle"]
FINS = ["Brume", "Vaux", "Lys", "Sablé", "Mauve", "Vigny", "Riva", "Cléry", "Tilly", "Naval", "Mont", "Roche",
        "Plaine", "Ormes", "Fontaine", "Aubrac", "Cassis", "Beaumont", "Landes", "Cerisy"]
JOCKEYS = ["J. Dupont", "M. Lefèvre", "A. Garnier", "C. Moreau", "P. Roux", "S. Bernard", "L. Fabre", "T. Morel",
           "N. Girard", "B. Faure", "E. Blanc", "R. Perrin", "D. Colin", "F. Mercier", "H. Renard", "V. Lemaire"]
FAMILLES = {
    "trot": {"disc": "trot_attele", "hipp": ["Vincennes", "Enghien", "Cabourg"], "dist": [2100, 2700, 2850, 3000], "n": 24, "champ": (16, 18)},
    "plat": {"disc": "plat", "hipp": ["Longchamp", "Deauville", "Saint-Cloud"], "dist": [1600, 2000, 2400], "n": 20, "champ": (14, 18)},
    "obstacle": {"disc": "haies", "hipp": ["Auteuil", "Pau", "Compiègne"], "dist": [3500, 4100, 4400], "n": 18, "champ": (14, 16)},
}
# 10 courses passées (la dernière date est la veille de "aujourd'hui" dans l'exemple)
CALENDRIER = [("2026-10-17", "trot"), ("2026-10-20", "plat"), ("2026-10-24", "trot"), ("2026-10-27", "obstacle"),
              ("2026-10-31", "trot"), ("2026-11-03", "plat"), ("2026-11-07", "trot"), ("2026-11-10", "plat"),
              ("2026-11-13", "obstacle"), ("2026-11-15", "trot")]
JOUR_A_VENIR = "2026-11-17"


def noms_uniques(rng, n):
    vus = set()
    while len(vus) < n:
        vus.add(f"{rng.choice(DEBUTS)} de {rng.choice(FINS)}".upper())
    return sorted(vus)


def cotes_depuis_niveaux(rng, niveaux):
    """Cotes 'marché' : le marché connaît à peu près le niveau (bruit), marge ~18 %."""
    est = [a + rng.gauss(0, 0.45) for a in niveaux]
    w = [math.exp(1.15 * e) for e in est]
    tot = sum(w)
    return [min(99.0, max(1.6, round(0.82 * tot / x - 1, 1))) for x in w]


def rapports_fictifs(rng, top5, cote_de):
    """Rapports fictifs calibrés : ~65 % des mises redistribuées en moyenne (ordre de grandeur réel du pari mutuel).
    Une arrivée de favoris paie moins qu'une arrivée de tocards."""
    n = len(cote_de)
    logs = [math.log(1 + c) for c in cote_de.values()]
    s = sum(math.log(1 + cote_de[x]) for x in top5)
    m = math.exp(0.45 * (s - 5 * sum(logs) / n)) * rng.uniform(0.7, 1.4)
    p5 = 1 / math.comb(n, 5)
    p45 = 5 * (n - 5) * p5
    des = round(max(150.0, 2 * 0.65 / p5 * m), 2)
    b45 = round(max(6.0, 2 * 0.12 / p45 * math.sqrt(m)), 2)
    return {
        "quinte_ordre": round(des * rng.uniform(8, 30), 2),
        "quinte_desordre": des,
        "bonus4": round(des * rng.uniform(0.01, 0.03) + 60, 2),
        "bonus4sur5": b45,
        "bonus3": round(6 + des * rng.uniform(0.0002, 0.0005), 2),
        "tierce_ordre": round(rng.uniform(300, 4000), 2),
        "tierce_desordre": round(rng.uniform(40, 400), 2),
        "couple_gagnant": round(rng.uniform(25, 400), 2),
        "couple_place": [round(rng.uniform(5, 40), 1) for _ in range(3)],
    }


def construire(output: Path, graine: int = 2026):
    rng = random.Random(graine)
    db = cq.ouvrir_db(":memory:")
    # --- chevaux : famille, niveau, affinité avec un hippodrome
    chevaux = {}
    for fam, cfg in FAMILLES.items():
        for nom in noms_uniques(rng, cfg["n"]):
            while nom in chevaux:
                nom = f"{rng.choice(DEBUTS)} de {rng.choice(FINS)}".upper()
            chevaux[nom] = {"fam": fam, "niveau": rng.gauss(0, 1), "hipp_fav": rng.choice(cfg["hipp"]),
                            "jockey": rng.choice(JOCKEYS), "entraineur": rng.choice(JOCKEYS)}
    par_fam = {f: [n for n, c in chevaux.items() if c["fam"] == f] for f in FAMILLES}

    def perf(nom, hip):
        c = chevaux[nom]
        return c["niveau"] + (0.35 if hip == c["hipp_fav"] else 0) + rng.gauss(0, 1.05)

    # --- sorties antérieures (courses ordinaires, un seul partant renseigné par course : sert au parcours)
    k = 0
    for nom, c in chevaux.items():
        cfg = FAMILLES[c["fam"]]
        for _ in range(rng.randint(5, 10)):
            k += 1
            jour = f"2026-{rng.randint(4, 10):02d}-{rng.randint(1, 28):02d}"
            hip = rng.choice(cfg["hipp"] + [c["hipp_fav"]])
            nb = rng.randint(8, 16)
            mienne = perf(nom, hip)
            place = 1 + sum(1 for _ in range(nb - 1) if rng.gauss(0, 1.2) > mienne)
            course = {"reunion": 9, "num": k, "hippodrome": hip, "discipline": cfg["disc"], "distance": rng.choice(cfg["dist"]),
                      "nb_partants": nb, "niveau": None, "libelle": "", "type_pari": None, "est_quinte": False, "arrivee": []}
            part = {"numero": 1, "nom": nom, "jockey": c["jockey"], "entraineur": c["entraineur"], "poids": None,
                    "cote": None, "musique": "", "place": None if rng.random() < 0.07 else place}
            cq.enregistrer_course(db, jour, course, [part], {})
            db.execute("UPDATE courses SET statut='arrivee' WHERE id=?", (f"{jour}_R9C{k}",))

    def composer_course(jour, fam, numero_course, avec_resultat):
        cfg = FAMILLES[fam]
        hip = cfg["hipp"][numero_course % len(cfg["hipp"])]
        n = rng.randint(*cfg["champ"])
        noms = rng.sample(par_fam[fam], min(n, len(par_fam[fam])))
        n = len(noms)
        numeros = list(range(1, n + 1))
        rng.shuffle(numeros)
        cotes = cotes_depuis_niveaux(rng, [chevaux[x]["niveau"] for x in noms])
        parts = []
        for nom, num, cote in zip(noms, numeros, cotes):
            c = chevaux[nom]
            parts.append({"numero": num, "nom": nom, "jockey": c["jockey"], "entraineur": c["entraineur"],
                          "poids": round(rng.uniform(52, 62), 1) if fam != "trot" else None, "cote": cote,
                          "musique": "".join(rng.choice("1234567ADp0") + rng.choice("apm") for _ in range(5)),
                          "place": None, "_perf": perf(nom, hip)})
        classement = sorted(parts, key=lambda p: -p["_perf"])
        if avec_resultat:
            for rang, p in enumerate(classement, start=1):
                p["place"] = rang
        arrivee = [p["numero"] for p in classement[:8]]
        info = {"reunion": 1, "num": numero_course + 3, "hippodrome": hip, "discipline": cfg["disc"],
                "distance": rng.choice(cfg["dist"]), "nb_partants": n,
                "niveau": rng.choice(["Handicap", "Course à conditions", "Groupe III", "Réclamer"]),
                "libelle": f"PRIX FICTIF N°{numero_course + 1}", "type_pari": "QUINTE_PLUS", "est_quinte": True,
                "arrivee": arrivee if avec_resultat else []}
        for p in parts:
            p.pop("_perf")
        return info, parts, {p["numero"]: p["cote"] for p in parts}

    for i, (jour, fam) in enumerate(CALENDRIER):
        info, parts, cote_de = composer_course(jour, fam, i, True)
        rap = rapports_fictifs(rng, info["arrivee"][:5], cote_de)
        cq.enregistrer_course(db, jour, info, parts, rap)
    db.commit()

    # --- course à venir (pas de résultat)
    info, parts, _ = composer_course(JOUR_A_VENIR, "trot", 1, False)
    a_venir = [{"id": f"{JOUR_A_VENIR}_R1C{info['num']}", "date": JOUR_A_VENIR,
                **{k2: info[k2] for k2 in ("hippodrome", "discipline", "distance", "niveau", "libelle", "type_pari")},
                "nb_partants": len(parts), "partants": sorted(parts, key=lambda p: p["numero"])}]

    r = cq.exporter_tout(db, output, a_venir, nb_retro=6, indent=1, exemple=True)
    return r


def main():
    ap = argparse.ArgumentParser(description="Génère les JSON d'exemple (données fictives).")
    ap.add_argument("--output", default=str(Path(__file__).resolve().parent.parent / "data"))
    a = ap.parse_args()
    r = construire(Path(a.output))
    print(f"Exemples écrits dans {a.output} : {r['courses']} courses, {r['chevaux']} chevaux, "
          f"{r['paires']} paires, {r['combinaisons']} combinaisons (DONNÉES FICTIVES).")


if __name__ == "__main__":
    main()
