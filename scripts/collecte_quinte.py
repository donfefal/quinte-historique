#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
collecte_quinte.py — Collecte, statistiques et moteur de combinaisons (historique Quinté+)
=========================================================================================

Ce script autonome :
  1. interroge l'API publique utilisée par le PMU (online.turfinfo.api.pmu.fr)
     pour récupérer programmes, partants, arrivées et rapports des courses passées ;
  2. range tout dans une base SQLite locale (courses, partants, arrivees, rapports) ;
  3. calcule les statistiques historiques et exporte les JSON consommés par le site :
       arrivees_historique.json, stats_numeros.json, cooccurrences.json,
       parcours.json, combinaisons_candidates.json (+ courses_a_venir.json) ;
  4. contient le MOTEUR de génération de combinaisons (formules documentées plus bas),
     strictement identique à js/scoreEngine.js et js/combinaisonGenerator.js.

Exemple :
    python scripts/collecte_quinte.py --debut 2024-11-01 --fin 2026-10-31 --output data/

AVERTISSEMENT — statistique descriptive, pas une prédiction. Résultats passés, sans garantie
pour l'avenir. LES JEUX D'ARGENT ET DE HASARD PEUVENT ÊTRE DANGEREUX : PERTES D'ARGENT,
CONFLITS FAMILIAUX, ADDICTION… NOS CONSEILS SUR JOUEURS-INFO-SERVICE.FR (09-74-75-13-13 -
APPEL NON SURTAXÉ).

NOTE SUR L'API : elle n'est pas documentée officiellement. Les parseurs ci-dessous sont
tolérants (plusieurs noms de champs essayés) mais, si le PMU change sa structure, il suffit
d'ajuster les fonctions `extraire_*` / `parser_*`. Respectez les conditions d'utilisation du
service et gardez un rythme de requêtes raisonnable (option --pause).
"""
from __future__ import annotations

import argparse
import datetime as dt
import itertools
import json
import logging
import math
import random
import sqlite3
import sys
import time
import unicodedata
from collections import defaultdict
from pathlib import Path

log = logging.getLogger("quinte")

# ---------------------------------------------------------------------------
# 1. CONSTANTES ET FORMULES (à garder synchronisées avec js/scoreEngine.js)
# ---------------------------------------------------------------------------
API_BASE = "https://online.turfinfo.api.pmu.fr/rest/client/1"
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
]

NEUTRE = 0.15          # score neutre quand les données manquent ("historique insuffisant")
MIN_SORTIES = 3        # historique minimal (numéro ET cheval) pour être scoré
COTE_MAX = 69.0        # au-delà : "tocard", exclu sauf option
SEUIL_FAVORI = 10.0    # cote <= 10 : favori historique (combinaison "valeur")
SEUIL_POKER = 15.0     # cote >= 15 : candidat "coup de poker"
M_LISSAGE = 10         # pseudo-courses du lissage vers le hasard (taux de top 5 / co-occurrences)
M_TOP3 = 4             # pseudo-sorties du lissage de la régularité top 3
PRIOR_TOP3 = 0.2       # taux de top 3 "au hasard" retenu pour le lissage (≈ 3/15)
FENETRE_PARCOURS = 20  # nb de dernières sorties prises en compte pour un cheval
FENETRE_REGULARITE = 10

# score_frequence    = 0.3*taux_top5_global + 0.4*taux_top5_hippodrome + 0.3*taux_top5_discipline
POIDS_FREQ = {"global": 0.3, "hippodrome": 0.4, "discipline": 0.3}
# score_parcours     = 0.5*regularite_top3 + 0.3*progression_normalisee + 0.2*performance_hippodrome
POIDS_PARCOURS = {"regularite": 0.5, "progression": 0.3, "hippodrome": 0.2}
# score_composite    = 0.4*frequence + 0.3*cooccurrence + 0.3*parcours   (puis x100)
POIDS_COMPOSITE = {"frequence": 0.4, "cooccurrence": 0.3, "parcours": 0.3}

DISCIPLINES = {
    "attele": "trot_attele", "trot_attele": "trot_attele",
    "monte": "trot_monte", "trot_monte": "trot_monte",
    "plat": "plat", "haie": "haies", "haies": "haies",
    "steeple": "steeple", "steeplechase": "steeple",
    "cross": "cross", "cross_country": "cross",
}


# ---------------------------------------------------------------------------
# 2. OUTILS
# ---------------------------------------------------------------------------
def sans_accents(txt: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", txt or "") if unicodedata.category(c) != "Mn")


def normaliser_discipline(d: str | None) -> str:
    cle = sans_accents(d or "").lower().replace(" ", "_")
    return DISCIPLINES.get(cle, cle or "inconnue")


def moyenne(xs):
    xs = list(xs)
    return sum(xs) / len(xs) if xs else 0.0


def clip(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def hasard_top5(n: int) -> float:
    """Probabilité qu'un partant au hasard finisse dans les 5 premiers d'un lot de n."""
    return min(1.0, 5.0 / n) if n else 0.0


def hasard_paire(n: int) -> float:
    """Probabilité que deux partants donnés soient TOUS DEUX dans le top 5."""
    return (5.0 / n) * (4.0 / (n - 1)) if n and n > 5 else 1.0


def cle_paire(a: int, b: int) -> str:
    return f"{min(a, b)}-{max(a, b)}"


def ecrire_json(chemin: Path, obj, indent: int = 0) -> None:
    chemin.parent.mkdir(parents=True, exist_ok=True)
    with open(chemin, "w", encoding="utf-8") as f:
        if indent:
            json.dump(obj, f, ensure_ascii=False, indent=indent)
        else:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def date_pmu(iso: str) -> str:
    """AAAA-MM-JJ -> JJMMAAAA (format de l'API)."""
    return dt.date.fromisoformat(iso).strftime("%d%m%Y")


# ---------------------------------------------------------------------------
# 3. CLIENT API (rythme, retry avec backoff, User-Agent réaliste)
# ---------------------------------------------------------------------------
class ApiIndisponible(Exception):
    """Levée quand l'API reste injoignable après tous les essais."""


class PmuClient:
    def __init__(self, pause: float = 0.7, essais: int = 5, timeout: float = 20.0):
        import requests  # import tardif : le reste du script fonctionne sans
        self.requests = requests
        self.pause, self.essais, self.timeout = pause, essais, timeout
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": random.choice(USER_AGENTS),
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.6",
            "Referer": "https://www.pmu.fr/",
        })

    def get(self, chemin: str):
        """GET JSON. Renvoie None si la ressource n'existe pas (404/204)."""
        url = f"{API_BASE}/{chemin}"
        for essai in range(self.essais):
            time.sleep(self.pause + random.uniform(0, self.pause / 2))  # rythme + gigue
            try:
                r = self.s.get(url, timeout=self.timeout)
                if r.status_code == 200:
                    return r.json()
                if r.status_code in (204, 404):
                    return None
                log.warning("HTTP %s sur %s (essai %d/%d)", r.status_code, chemin, essai + 1, self.essais)
            except (self.requests.RequestException, ValueError) as e:
                log.warning("Erreur réseau sur %s : %s (essai %d/%d)", chemin, e, essai + 1, self.essais)
            time.sleep(min(90, 2 ** (essai + 1)))  # backoff exponentiel
        raise ApiIndisponible(url)

    def programme(self, iso: str):
        return self.get(f"programme/{date_pmu(iso)}")

    def participants(self, iso: str, reunion: int, course: int):
        return self.get(f"programme/{date_pmu(iso)}/R{reunion}/C{course}/participants")

    def rapports(self, iso: str, reunion: int, course: int):
        return self.get(f"programme/{date_pmu(iso)}/R{reunion}/C{course}/rapports-definitifs")


# ---------------------------------------------------------------------------
# 4. PARSEURS (tolérants) DES RÉPONSES DE L'API
# ---------------------------------------------------------------------------
def aplatir_arrivee(ordre) -> list[int]:
    """ordreArrivee = [[4],[7],[2,9],...] (ex æquo possibles) -> [4,7,2,9,...]."""
    out: list[int] = []
    for x in ordre or []:
        if isinstance(x, (list, tuple)):
            out.extend(int(v) for v in x)
        elif x is not None:
            out.append(int(x))
    return out


def extraire_courses_programme(prog: dict | None, types_pari: list[str], toutes: bool) -> list[dict]:
    """Liste de courses (dicts bruts normalisés) d'une réponse /programme/JJMMAAAA."""
    sortie = []
    reunions = ((prog or {}).get("programme") or {}).get("reunions") or []
    for r in reunions:
        hip = r.get("hippodrome") or {}
        nom_hip = hip.get("libelleCourt") or hip.get("libelleLong") or hip.get("code") or "Inconnu"
        for c in r.get("courses") or []:
            codes = {str(p.get("codePari") or p.get("typePari") or "").upper() for p in (c.get("paris") or [])}
            type_pari = next((code for code in sorted(codes) if any(t in code for t in types_pari)), None)
            est_quinte = type_pari is not None
            if not est_quinte and not toutes:
                continue
            arrivee = aplatir_arrivee(c.get("ordreArrivee"))
            sortie.append({
                "reunion": int(r.get("numOfficiel") or r.get("numReunion") or 0),
                "num": int(c.get("numOrdre") or c.get("numExterne") or 0),
                "hippodrome": nom_hip.strip().title(),
                "discipline": normaliser_discipline(c.get("discipline") or r.get("discipline")),
                "distance": int(c.get("distance") or 0),
                "nb_partants": int(c.get("nombreDeclaresPartants") or 0),
                "niveau": (c.get("categorieParticularite") or c.get("conditionSexe") or c.get("typeCourse") or "").strip().title() or None,
                "libelle": (c.get("libelle") or "").strip(),
                "type_pari": type_pari,
                "est_quinte": est_quinte,
                "arrivee": arrivee,
                "statut": c.get("statut") or "",
            })
    return sortie


def extraire_partants(data: dict | None) -> list[dict]:
    """Partants effectifs (hors non-partants) d'une réponse /participants."""
    out = []
    for p in (data or {}).get("participants") or []:
        if str(p.get("statut") or "PARTANT").upper().startswith("NON"):
            continue
        cote = None
        for cle in ("dernierRapportDirect", "dernierRapportReference"):
            rap = p.get(cle) or {}
            if isinstance(rap, dict) and rap.get("rapport"):
                cote = float(rap["rapport"])
                break
        poids = p.get("handicapPoids") or p.get("poidsConditionMonte")
        place = (p.get("ordreArrivee") or 0) or None
        try:
            numero = int(p.get("numPmu"))
        except (TypeError, ValueError):
            continue
        out.append({
            "numero": numero,
            "nom": (p.get("nom") or "").strip().upper(),
            "jockey": (p.get("driver") or p.get("jockey") or "").strip(),
            "entraineur": (p.get("entraineur") or "").strip(),
            "poids": float(poids) if poids else None,
            "cote": cote,
            "musique": p.get("musique") or "",
            "place": int(place) if place else None,
        })
    return sorted(out, key=lambda x: x["numero"])


def extraire_rapports(data) -> dict:
    """Rapports officiels en euros pour la mise de base (2 €). L'API donne des centimes."""
    out: dict = {}
    for bloc in data or []:
        tp = str(bloc.get("typePari") or "").upper()
        for r in bloc.get("rapports") or []:
            lib = sans_accents(r.get("libelle") or "").lower()
            div = r.get("dividende")
            if div is None:
                continue
            euros = round(float(div) / 100.0, 2)
            if "QUINTE" in tp:
                if "4/5" in lib or "4 sur 5" in lib:
                    out["bonus4sur5"] = euros
                elif "bonus 4" in lib:
                    out["bonus4"] = euros
                elif "bonus 3" in lib:
                    out["bonus3"] = euros
                elif "desordre" in lib:
                    out["quinte_desordre"] = euros
                elif "ordre" in lib:
                    out["quinte_ordre"] = euros
            elif tp.endswith("TIERCE"):
                out["tierce_desordre" if "desordre" in lib else "tierce_ordre"] = euros
            elif tp.endswith("COUPLE_GAGNANT"):
                out["couple_gagnant"] = euros
            elif tp.endswith("COUPLE_PLACE"):
                out.setdefault("couple_place", []).append(euros)
    return out


# ---------------------------------------------------------------------------
# 5. BASE SQLITE
# ---------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS jours   (date TEXT PRIMARY KEY, statut TEXT, maj TEXT);
CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY, date TEXT, reunion INT, num INT, hippodrome TEXT, discipline TEXT,
    distance INT, nb_partants INT, niveau TEXT, type_pari TEXT, est_quinte INT,
    libelle TEXT, statut TEXT);          -- statut : 'arrivee' | 'attente'
CREATE TABLE IF NOT EXISTS partants (
    course_id TEXT, numero INT, nom TEXT, jockey TEXT, entraineur TEXT, poids REAL,
    cote REAL, musique TEXT, place INT, PRIMARY KEY (course_id, numero));
CREATE TABLE IF NOT EXISTS arrivees (course_id TEXT, rang INT, numero INT, PRIMARY KEY (course_id, rang));
CREATE TABLE IF NOT EXISTS rapports (course_id TEXT, type TEXT, valeur REAL, detail TEXT, PRIMARY KEY (course_id, type));
CREATE INDEX IF NOT EXISTS idx_partants_nom ON partants(nom);
CREATE INDEX IF NOT EXISTS idx_courses_date ON courses(date);
"""


def ouvrir_db(chemin: str | Path) -> sqlite3.Connection:
    if str(chemin) != ":memory:":
        Path(chemin).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(chemin))
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    return db


def enregistrer_course(db, iso, c: dict, partants: list[dict], rapports: dict) -> str:
    cid = f"{iso}_R{c['reunion']}C{c['num']}"
    arrivee = c["arrivee"] or [p["numero"] for p in sorted((p for p in partants if p["place"]), key=lambda p: p["place"])]
    statut = "arrivee" if len(arrivee) >= 5 else "attente"
    nb = c["nb_partants"] or len(partants)
    db.execute("INSERT OR REPLACE INTO courses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
               (cid, iso, c["reunion"], c["num"], c["hippodrome"], c["discipline"], c["distance"], nb,
                c["niveau"], c["type_pari"], int(c["est_quinte"]), c["libelle"], statut))
    db.execute("DELETE FROM partants WHERE course_id=?", (cid,))
    db.execute("DELETE FROM arrivees WHERE course_id=?", (cid,))
    db.execute("DELETE FROM rapports WHERE course_id=?", (cid,))
    for p in partants:
        db.execute("INSERT INTO partants VALUES (?,?,?,?,?,?,?,?,?)",
                   (cid, p["numero"], p["nom"], p["jockey"], p["entraineur"], p["poids"], p["cote"], p["musique"], p["place"]))
    for rang, num in enumerate(arrivee[:8], start=1):
        db.execute("INSERT OR REPLACE INTO arrivees VALUES (?,?,?)", (cid, rang, num))
    for k, v in (rapports or {}).items():
        if isinstance(v, list):
            db.execute("INSERT INTO rapports VALUES (?,?,?,?)", (cid, k, None, json.dumps(v)))
        else:
            db.execute("INSERT INTO rapports VALUES (?,?,?,?)", (cid, k, v, None))
    return cid


# ---------------------------------------------------------------------------
# 6. COLLECTE
# ---------------------------------------------------------------------------
def jours_entre(debut: str, fin: str):
    d, f = dt.date.fromisoformat(debut), dt.date.fromisoformat(fin)
    while d <= f:
        yield d.isoformat()
        d += dt.timedelta(days=1)


def collecter(client, db, debut: str, fin: str, types_pari: list[str], toutes: bool, forcer: bool = False) -> int:
    """Collecte [debut, fin]. Reprise possible : les jours déjà traités sont sautés (sauf --forcer)."""
    aujourdhui = dt.date.today().isoformat()
    n_courses = 0
    for iso in jours_entre(debut, fin):
        deja = db.execute("SELECT statut FROM jours WHERE date=?", (iso,)).fetchone()
        if deja and deja["statut"] == "ok" and not forcer and iso < aujourdhui:
            continue
        try:
            prog = client.programme(iso)
            for c in extraire_courses_programme(prog, types_pari, toutes):
                cid = f"{iso}_R{c['reunion']}C{c['num']}"
                if not forcer and db.execute("SELECT 1 FROM courses WHERE id=? AND statut='arrivee'", (cid,)).fetchone():
                    continue
                parts = extraire_partants(client.participants(iso, c["reunion"], c["num"]))
                rap = extraire_rapports(client.rapports(iso, c["reunion"], c["num"])) if c["est_quinte"] else {}
                if not parts:
                    continue
                enregistrer_course(db, iso, c, parts, rap)
                n_courses += 1
            db.execute("INSERT OR REPLACE INTO jours VALUES (?,?,?)", (iso, "ok", dt.datetime.now().isoformat(timespec="seconds")))
            db.commit()
        except ApiIndisponible as e:
            log.error("Jour %s abandonné (API indisponible : %s) — relancez pour reprendre.", iso, e)
    return n_courses


def collecter_a_venir(client, iso: str, types_pari: list[str]) -> list[dict]:
    """Courses Quinté+ d'un jour à venir (partants connus, pas d'arrivée)."""
    out = []
    for c in extraire_courses_programme(client.programme(iso), types_pari, toutes=False):
        parts = extraire_partants(client.participants(iso, c["reunion"], c["num"]))
        if len(parts) < 6:
            continue
        for p in parts:
            p["place"] = None
        out.append({"id": f"{iso}_R{c['reunion']}C{c['num']}", "date": iso, **{k: c[k] for k in
                    ("hippodrome", "discipline", "distance", "niveau", "libelle", "type_pari")},
                    "nb_partants": len(parts), "partants": parts})
    return out


# ---------------------------------------------------------------------------
# 7. LECTURE DE LA BASE -> structures Python
# ---------------------------------------------------------------------------
def charger_courses_quinte(db) -> list[dict]:
    """Courses Quinté+ terminées, ordre chronologique, avec partants, arrivée et rapports."""
    courses = []
    for r in db.execute("SELECT * FROM courses WHERE est_quinte=1 AND statut='arrivee' ORDER BY date, reunion, num"):
        arr = [x["numero"] for x in db.execute("SELECT numero FROM arrivees WHERE course_id=? ORDER BY rang", (r["id"],))]
        parts = [dict(p) for p in db.execute(
            "SELECT numero, nom, jockey, entraineur, poids, cote, musique, place FROM partants WHERE course_id=? ORDER BY numero",
            (r["id"],))]
        rap: dict = {}
        for x in db.execute("SELECT type, valeur, detail FROM rapports WHERE course_id=?", (r["id"],)):
            rap[x["type"]] = json.loads(x["detail"]) if x["detail"] else x["valeur"]
        if len(arr) < 5 or len(parts) < 6:
            continue
        courses.append({
            "id": r["id"], "date": r["date"], "hippodrome": r["hippodrome"], "discipline": r["discipline"],
            "distance": r["distance"], "nb_partants": len(parts), "niveau": r["niveau"], "type_pari": r["type_pari"],
            "libelle": r["libelle"], "arrivee": arr[:5], "suite": arr[5:8], "rapports": rap, "partants": parts,
        })
    return courses


def charger_sorties_chevaux(db) -> dict[str, list[dict]]:
    """Toutes les sorties connues (courses Quinté+ ou non) par nom de cheval, ordre chronologique."""
    out: dict[str, list[dict]] = defaultdict(list)
    q = """SELECT p.nom, c.date, c.hippodrome, c.discipline, c.distance, c.nb_partants, p.place, p.cote
           FROM partants p JOIN courses c ON c.id = p.course_id
           WHERE c.statut='arrivee' AND p.nom <> '' ORDER BY c.date, c.reunion, c.num"""
    for r in db.execute(q):
        out[r["nom"]].append({"date": r["date"], "hippodrome": r["hippodrome"], "discipline": r["discipline"],
                              "distance": r["distance"], "place": r["place"], "cote": r["cote"],
                              "nb_partants": r["nb_partants"]})
    return out


# ---------------------------------------------------------------------------
# 8. STATISTIQUES PAR NUMÉRO ET CO-OCCURRENCES
# ---------------------------------------------------------------------------
def _entree():
    return {"sorties": 0, "top5": 0, "hasard_sum": 0.0, "positions": [0] * 5, "rangs": [], "derniere": None}


def _cellule():
    return {"n": 0, "opportunites": 0, "attendu_sum": 0.0}


def calculer_stats_numeros(courses: list[dict]) -> dict:
    """
    Pour chaque numéro (global / hippodrome / discipline) :
      sorties        = nb de courses où ce numéro était au départ
      top5           = nb de fois où il a fini dans les 5 premiers
      taux_top5      = top5 / sorties          hasard = moyenne de 5/nb_partants sur ces courses
      ecart_moyen    = nb moyen de courses (où il courait) entre deux top 5 consécutifs
      ecart_actuel   = nb de courses depuis son dernier top 5
      derniere_sortie= date de son dernier top 5
      positions      = [nb de 1er, 2e, 3e, 4e, 5e]
    """
    glob = defaultdict(_entree)
    hip = defaultdict(lambda: defaultdict(_entree))
    disc = defaultdict(lambda: defaultdict(_entree))
    for c in courses:
        n = len(c["partants"])
        pos = {num: i for i, num in enumerate(c["arrivee"][:5])}
        for p in c["partants"]:
            for e in (glob[p["numero"]], hip[c["hippodrome"]][p["numero"]], disc[c["discipline"]][p["numero"]]):
                e["sorties"] += 1
                e["hasard_sum"] += hasard_top5(n)
                if p["numero"] in pos:
                    e["top5"] += 1
                    e["positions"][pos[p["numero"]]] += 1
                    e["rangs"].append(e["sorties"])
                    e["derniere"] = c["date"]

    def fin(e):
        r = e["rangs"]
        ecarts = [b - a for a, b in zip(r, r[1:])]
        return {
            "sorties": e["sorties"], "top5": e["top5"],
            "taux_top5": round(e["top5"] / e["sorties"], 4) if e["sorties"] else 0,
            "hasard": round(e["hasard_sum"] / e["sorties"], 4) if e["sorties"] else 0,
            "ecart_moyen": round(moyenne(ecarts), 2) if ecarts else None,
            "ecart_actuel": e["sorties"] - r[-1] if r else None,
            "derniere_sortie": e["derniere"],
            "positions": e["positions"],
        }

    def bloc(d):
        return {str(k): fin(v) for k, v in sorted(d.items())}

    return {
        "global": bloc(glob),
        "par_hippodrome": {h: bloc(d) for h, d in sorted(hip.items())},
        "par_discipline": {k: bloc(d) for k, d in sorted(disc.items())},
    }


def calculer_cooccurrences(courses: list[dict], avec_scopes: bool = True) -> dict:
    """
    Paires de numéros présentes ENSEMBLE dans le top 5.
      n             = nb de fois où les deux sont dans le top 5
      opportunites  = nb de courses où les deux étaient au départ
      taux          = n / opportunites
      attendu       = taux attendu au hasard (moyenne de (5/N)*(4/(N-1)))
      lift          = taux / attendu  (>1 : ensemble plus souvent que le hasard)
    Hippodromes/disciplines : seules les paires vues au moins une fois sont écrites.
    """
    glob = defaultdict(_cellule)
    hip = defaultdict(lambda: defaultdict(_cellule))
    disc = defaultdict(lambda: defaultdict(_cellule))
    for c in courses:
        n = len(c["partants"])
        nums = sorted(p["numero"] for p in c["partants"])
        top = set(c["arrivee"][:5])
        att = hasard_paire(n)
        for a, b in itertools.combinations(nums, 2):
            cle = f"{a}-{b}"
            cibles = [glob[cle]]
            if avec_scopes:
                cibles += [hip[c["hippodrome"]][cle], disc[c["discipline"]][cle]]
            for cell in cibles:
                cell["opportunites"] += 1
                cell["attendu_sum"] += att
                if a in top and b in top:
                    cell["n"] += 1

    def fin(cell):
        opp = cell["opportunites"]
        taux = cell["n"] / opp if opp else 0
        att = cell["attendu_sum"] / opp if opp else 0
        return {"n": cell["n"], "opportunites": opp, "taux": round(taux, 4), "attendu": round(att, 4),
                "lift": round(taux / att, 3) if att else None}

    res = {"global": {k: fin(v) for k, v in glob.items()}}
    if avec_scopes:
        res["par_hippodrome"] = {h: {k: fin(v) for k, v in d.items() if v["n"] > 0} for h, d in sorted(hip.items())}
        res["par_discipline"] = {x: {k: fin(v) for k, v in d.items() if v["n"] > 0} for x, d in sorted(disc.items())}
    return res


# ---------------------------------------------------------------------------
# 9. PARCOURS DES CHEVAUX
# ---------------------------------------------------------------------------
def point_place(s: dict) -> float:
    """Place -> 0..1 (1 = vainqueur, 0 = dernier ou non classé)."""
    place, n = s.get("place"), s.get("nb_partants") or 0
    if not place:
        return 0.0
    if n <= 1:
        return 0.5
    return clip(1 - (place - 1) / (n - 1))


def taux_lisse(top: float, sorties: float, prior: float, m: float = M_LISSAGE) -> float:
    """Taux observé tiré vers le hasard (prior) avec m pseudo-observations."""
    return (top + m * prior) / (sorties + m)


def stats_cheval(sorties_asc: list[dict]) -> dict:
    """
    Statistiques d'un cheval sur ses FENETRE_PARCOURS dernières sorties (ordre chronologique).
      regularite_top3 : part de top 3 sur les 10 dernières, lissée (M_TOP3 pseudo-sorties à PRIOR_TOP3)
      progression     : moyenne(point_place des k dernières) - moyenne(k précédentes), k=3 (si >= 6 sorties)
                        k = n//2 pour 4 ou 5 sorties ; < 4 sorties -> pas de tendance (0.5)
      progression_normalisee = (progression + 1) / 2   dans [0, 1]
    """
    fen = sorties_asc[-FENETRE_PARCOURS:]
    res: dict = {"nb_sorties": len(sorties_asc), "sorties_fenetre": len(fen)}
    last = fen[-FENETRE_REGULARITE:]
    top3 = sum(1 for s in last if s["place"] and s["place"] <= 3)
    res["taux_top3_brut"] = top3 / len(last) if last else None
    res["regularite_top3"] = (top3 + M_TOP3 * PRIOR_TOP3) / (len(last) + M_TOP3) if last else None
    ps = [point_place(s) for s in fen]
    if len(ps) >= 4:
        k = 3 if len(ps) >= 6 else len(ps) // 2
        der, prec = moyenne(ps[-k:]), moyenne(ps[-2 * k:-k])
        val = der - prec
        res["progression"] = {"valeur": val, "normalisee": (val + 1) / 2, "k": k, "recentes": der, "precedentes": prec}
    else:
        res["progression"] = {"valeur": None, "normalisee": 0.5, "k": 0, "recentes": None, "precedentes": None}

    def agreger(cle):
        d: dict = defaultdict(lambda: {"sorties": 0, "top3": 0})
        for s in fen:
            e = d[s[cle]]
            e["sorties"] += 1
            e["top3"] += 1 if (s["place"] and s["place"] <= 3) else 0
        return {k: {**v, "taux_top3": v["top3"] / v["sorties"]} for k, v in sorted(d.items())}

    res["par_hippodrome"], res["par_discipline"] = agreger("hippodrome"), agreger("discipline")
    dates = [dt.date.fromisoformat(s["date"]) for s in sorties_asc]
    ecarts = [(b - a).days for a, b in zip(dates, dates[1:])]
    res["ecart_moyen_jours"] = moyenne(ecarts) if ecarts else None
    res["derniere_sortie"] = sorties_asc[-1]["date"] if sorties_asc else None
    return res


def arrondir(obj, nd: int = 4):
    """Arrondit récursivement les flottants (pour l'export JSON uniquement)."""
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, dict):
        return {k: arrondir(v, nd) for k, v in obj.items()}
    if isinstance(obj, list):
        return [arrondir(v, nd) for v in obj]
    return obj


def calculer_parcours(sorties_par_cheval: dict[str, list[dict]], max_export: int = FENETRE_PARCOURS) -> dict:
    chevaux = {}
    for nom, sorties in sorted(sorties_par_cheval.items()):
        if not sorties:
            continue
        st = arrondir(stats_cheval(sorties))
        st["sorties"] = sorties[-max_export:]   # ordre chronologique (la plus récente en dernier)
        chevaux[nom] = st
    return chevaux


# ---------------------------------------------------------------------------
# 10. MOTEUR DE SCORES (miroir de js/scoreEngine.js)
# ---------------------------------------------------------------------------
def detail_frequence(numero, hippodrome, discipline, stats, nb_partants):
    """score_frequence = 0.3*taux_global + 0.4*taux_hippodrome + 0.3*taux_discipline (taux lissés vers le hasard)."""
    prior = hasard_top5(nb_partants)
    g = (stats.get("global") or {}).get(str(numero))
    if not g or g["sorties"] < MIN_SORTIES:
        return {"score": NEUTRE, "suffisant": False, "hasard": prior}
    h = ((stats.get("par_hippodrome") or {}).get(hippodrome) or {}).get(str(numero)) or {"sorties": 0, "top5": 0}
    d = ((stats.get("par_discipline") or {}).get(discipline) or {}).get(str(numero)) or {"sorties": 0, "top5": 0}
    tg = taux_lisse(g["top5"], g["sorties"], prior)
    th = taux_lisse(h["top5"], h["sorties"], prior)
    td = taux_lisse(d["top5"], d["sorties"], prior)
    score = POIDS_FREQ["global"] * tg + POIDS_FREQ["hippodrome"] * th + POIDS_FREQ["discipline"] * td
    return {"score": score, "suffisant": True, "hasard": prior, "taux_global": tg, "taux_hippodrome": th,
            "taux_discipline": td, "sorties_global": g["sorties"], "sorties_hippodrome": h["sorties"],
            "sorties_discipline": d["sorties"]}


def detail_cooccurrence(numero, numeros_du_jour, coocc):
    """
    score_cooccurrence = moyenne, sur les autres partants du jour, du taux de co-occurrence rapporté au hasard
    (lift lissé), ramené sur 0-1 : lift moyen 1 (= hasard) -> 0.5 ; lift >= 2 -> 1.
    """
    glob = (coocc or {}).get("global") or {}
    if not glob:
        return {"score": NEUTRE, "suffisant": False}
    n = len(numeros_du_jour)
    att = hasard_paire(n)
    lifts = []
    for b in numeros_du_jour:
        if b == numero:
            continue
        cell = glob.get(cle_paire(numero, b)) or {"n": 0, "opportunites": 0}
        lifts.append(taux_lisse(cell["n"], cell["opportunites"], att) / att)
    lift = moyenne(lifts) if lifts else 1.0
    return {"score": clip(lift / 2), "suffisant": True, "lift_moyen": lift}


def detail_parcours(nom, hippodrome, sorties_par_cheval, avant):
    """score_parcours = 0.5*regularite_top3 + 0.3*progression_normalisee + 0.2*performance_hippodrome."""
    hist = [s for s in sorties_par_cheval.get(nom, []) if avant is None or s["date"] < avant]
    if len(hist) < MIN_SORTIES:
        return {"score": NEUTRE, "suffisant": False, "nb_sorties": len(hist)}
    st = stats_cheval(hist)
    h = st["par_hippodrome"].get(hippodrome)
    perf = taux_lisse(h["top3"], h["sorties"], PRIOR_TOP3, M_TOP3) if h and h["sorties"] else NEUTRE
    reg, prog = st["regularite_top3"], st["progression"]["normalisee"]
    score = POIDS_PARCOURS["regularite"] * reg + POIDS_PARCOURS["progression"] * prog + POIDS_PARCOURS["hippodrome"] * perf
    return {"score": score, "suffisant": True, "nb_sorties": len(hist), "regularite": reg, "progression": prog,
            "progression_valeur": st["progression"]["valeur"], "perf_hippodrome": perf,
            "sorties_hippodrome": h["sorties"] if h else 0}


def scorer_course(course: dict, ctx: dict, inclure_tocards=False, inclure_insuffisants=False) -> list[dict]:
    """
    Score tous les partants d'une course. ctx = {"stats", "coocc", "sorties"} où sorties = {nom: [sorties asc]}.
    Seules les sorties STRICTEMENT antérieures à la date de la course sont utilisées pour le parcours.
    """
    parts = course["partants"]
    nums = [p["numero"] for p in parts]
    n = len(parts)
    res = []
    for p in parts:
        f = detail_frequence(p["numero"], course["hippodrome"], course["discipline"], ctx["stats"], n)
        c = detail_cooccurrence(p["numero"], nums, ctx["coocc"])
        pa = detail_parcours(p["nom"], course["hippodrome"], ctx["sorties"], course["date"])
        composite = 100 * (POIDS_COMPOSITE["frequence"] * f["score"] + POIDS_COMPOSITE["cooccurrence"] * c["score"]
                           + POIDS_COMPOSITE["parcours"] * pa["score"])
        suffisant = f["suffisant"] and pa["suffisant"]
        cote = p.get("cote")
        exclu = None
        if cote is not None and cote > COTE_MAX and not inclure_tocards:
            exclu = "tocard"
        elif not suffisant and not inclure_insuffisants:
            exclu = "historique insuffisant"
        res.append({"numero": p["numero"], "nom": p["nom"], "cote": cote,
                    "frequence": f["score"], "cooccurrence": c["score"], "parcours": pa["score"],
                    "composite": composite, "suffisant": suffisant, "exclu": exclu,
                    "detail": {"frequence": f, "cooccurrence": c, "parcours": pa}})
    return res


# ---------------------------------------------------------------------------
# 11. GÉNÉRATION DES COMBINAISONS (miroir de js/combinaisonGenerator.js)
# ---------------------------------------------------------------------------
def _tri(lst):
    return sorted(lst, key=lambda s: (-s["composite"], s["numero"]))


def point_fort(s: dict, nb_partants: int) -> str:
    """Phrase courte sur le meilleur appui statistique d'un numéro (comparé au hasard)."""
    d = s["detail"]
    cand = []
    f = d["frequence"]
    if f.get("suffisant"):
        cand.append((f["taux_hippodrome"] / f["hasard"] - 1,
                     f"taux de top 5 sur l'hippodrome {f['taux_hippodrome']*100:.0f} % (au hasard : {f['hasard']*100:.0f} %)"))
    c = d["cooccurrence"]
    if c.get("suffisant"):
        cand.append((c["lift_moyen"] - 1, f"co-occurrence ×{c['lift_moyen']:.2f} vs hasard avec les autres partants"))
    p = d["parcours"]
    if p.get("suffisant"):
        cand.append((p["regularite"] / PRIOR_TOP3 - 1, f"régularité top 3 {p['regularite']*100:.0f} % (au hasard : ~20 %)"))
    return max(cand)[1] if cand else "historique insuffisant (score neutre)"


def _fabriquer(type_, label, choisis, nb_partants, complete=False):
    nums = sorted(s["numero"] for s in choisis)
    detail = {k: round(moyenne(s[k] for s in choisis), 4) for k in ("frequence", "cooccurrence", "parcours")}
    score = round(moyenne(s["composite"] for s in choisis), 2)
    k = len(choisis)
    hasard = k * 5 / nb_partants
    meilleur = max(choisis, key=lambda s: s["composite"])
    just = (f"{label} : {k} numéros, score moyen {score:.1f}/100. Au hasard, un lot de {k} numéros place en moyenne "
            f"{hasard:.1f} numéros dans le top 5. Meilleur appui : n°{meilleur['numero']} {meilleur['nom']} — "
            f"{point_fort(meilleur, nb_partants)}.")
    if complete:
        just += " Lot complété avec des numéros à historique insuffisant (moins de 5 numéros éligibles)."
    return {"type": type_, "label": label, "numeros": nums, "score": score, "detail": detail,
            "justification": just, "complete": complete,
            "partants": [{"numero": s["numero"], "nom": s["nom"], "composite": round(s["composite"], 2),
                          "cote": s["cote"]} for s in sorted(choisis, key=lambda s: s["numero"])]}


def generer_combinaisons(scores: list[dict], nb_partants: int, inclure_tocards=False) -> list[dict]:
    """Quatre combinaisons : base solide (5), élargie (7), valeur (3 favoris + 2 outsiders), coup de poker (5)."""
    pool = _tri([s for s in scores if not s["exclu"]])
    # complément si trop peu d'éligibles : meilleurs scores parmi les "historique insuffisant" (jamais les tocards)
    reserve = _tri([s for s in scores if s["exclu"] == "historique insuffisant"])

    def completer(lst, k):
        out = list(lst[:k])
        complete = False
        for s in reserve:
            if len(out) >= k:
                break
            if s not in out:
                out.append(s)
                complete = True
        return out, complete

    res = []
    choisis, cpl = completer(pool, 5)
    res.append(_fabriquer("base", "Base solide", choisis, nb_partants, cpl))
    choisis, cpl = completer(pool, 7)
    res.append(_fabriquer("elargie", "Élargie", choisis, nb_partants, cpl))

    favoris = [s for s in pool if s["cote"] is None or s["cote"] <= SEUIL_FAVORI][:3]
    outsiders = [s for s in pool if s["cote"] is not None and s["cote"] > SEUIL_FAVORI and s not in favoris][:2]
    lot = favoris + outsiders
    for s in pool:                       # complète si un des deux groupes est trop court
        if len(lot) >= 5:
            break
        if s not in lot:
            lot.append(s)
    lot, cpl = completer(lot, 5)
    res.append(_fabriquer("valeur", "Valeur (3 favoris + 2 outsiders)", lot, nb_partants, cpl))

    hauts = [s for s in pool if s["cote"] is not None and s["cote"] >= SEUIL_POKER][:5]
    for s in sorted(pool, key=lambda s: (-(s["cote"] or 0), s["numero"])):   # complète par les cotes les plus hautes
        if len(hauts) >= 5:
            break
        if s not in hauts:
            hauts.append(s)
    hauts, cpl = completer(hauts, 5)
    res.append(_fabriquer("poker", "Coup de poker (cotes élevées)", hauts, nb_partants, cpl))
    return res


def contexte_a_la_date(courses: list[dict], sorties: dict, index: int) -> dict:
    """Contexte 'honnête' : uniquement les courses AVANT courses[index] (pas de regard vers l'avenir)."""
    avant = courses[:index]
    return {"stats": calculer_stats_numeros(avant), "coocc": calculer_cooccurrences(avant, avec_scopes=False),
            "sorties": sorties}


def candidats_pour_course(course: dict, ctx: dict, mode: str, inclure_tocards=False) -> dict:
    scores = scorer_course(course, ctx, inclure_tocards)
    combos = generer_combinaisons(scores, len(course["partants"]), inclure_tocards)
    combos.sort(key=lambda c: -c["score"])
    for i, c in enumerate(combos, start=1):
        c["rang"] = i
    return {"id": course["id"], "date": course["date"], "hippodrome": course["hippodrome"],
            "discipline": course["discipline"], "distance": course["distance"], "nb_partants": len(course["partants"]),
            "mode": mode, "combinaisons": combos,
            "scores_partants": [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in s.items() if k != "detail"}
                                for s in sorted(scores, key=lambda s: -s["composite"])]}


# ---------------------------------------------------------------------------
# 12. EXPORT DES JSON
# ---------------------------------------------------------------------------
def exporter_tout(db, output: Path, a_venir: list[dict] | None = None, nb_retro: int = 10,
                  inclure_tocards: bool = False, max_export: int = FENETRE_PARCOURS,
                  indent: int = 0, exemple: bool = False) -> dict:
    courses = charger_courses_quinte(db)
    sorties = charger_sorties_chevaux(db)
    if not courses:
        raise SystemExit("Aucune course Quinté+ terminée en base : rien à exporter.")
    meta = {"genere_le": dt.datetime.now().isoformat(timespec="seconds"), "debut": courses[0]["date"],
            "fin": courses[-1]["date"], "nb_courses": len(courses), "exemple": exemple,
            "source": "Données fictives d'exemple" if exemple else "API publique PMU (online.turfinfo.api.pmu.fr)",
            "avertissement": "Résultats passés, sans garantie pour l'avenir."}

    stats = calculer_stats_numeros(courses)
    coocc = calculer_cooccurrences(courses)
    parcours = calculer_parcours(sorties, max_export)
    ctx = {"stats": stats, "coocc": coocc, "sorties": sorties}

    # --- combinaisons : courses à venir (contexte complet) + rétro-pronostics honnêtes sur les dernières courses
    cands = []
    for c in a_venir or []:
        cands.append(candidats_pour_course(c, ctx, "a_venir", inclure_tocards))
    for i in range(max(0, len(courses) - nb_retro), len(courses)):
        cands.append(candidats_pour_course(courses[i], contexte_a_la_date(courses, sorties, i), "retro", inclure_tocards))
    nb_combos = sum(len(c["combinaisons"]) for c in cands)

    ecrire_json(output / "arrivees_historique.json", {"meta": meta, "courses": courses}, indent)
    ecrire_json(output / "stats_numeros.json", {"meta": meta, **stats}, indent)
    ecrire_json(output / "cooccurrences.json", {"meta": meta, **coocc}, indent)
    ecrire_json(output / "parcours.json", {"meta": {**meta, "fenetre": FENETRE_PARCOURS,
                                                    "note": "Sorties en ordre chronologique ; statistiques calculées sur les 20 dernières."},
                                           "chevaux": parcours}, indent)
    ecrire_json(output / "combinaisons_candidates.json", {"meta": {**meta, "formules": {
        "frequence": POIDS_FREQ, "parcours": POIDS_PARCOURS, "composite": POIDS_COMPOSITE}}, "courses": cands}, indent)
    ecrire_json(output / "courses_a_venir.json", {"meta": meta, "courses": a_venir or []}, indent)

    return {"courses": len(courses), "chevaux": len(parcours), "paires": len(coocc["global"]),
            "combinaisons": nb_combos, "debut": meta["debut"], "fin": meta["fin"]}


# ---------------------------------------------------------------------------
# 13. LIGNE DE COMMANDE
# ---------------------------------------------------------------------------
def main(argv=None):
    hier = dt.date.today() - dt.timedelta(days=1)
    ap = argparse.ArgumentParser(description="Collecte Quinté+ (API PMU) et génération des JSON du site.")
    ap.add_argument("--debut", default=(hier - dt.timedelta(days=730)).isoformat(), help="AAAA-MM-JJ (défaut : hier - 24 mois)")
    ap.add_argument("--fin", default=hier.isoformat(), help="AAAA-MM-JJ (défaut : hier)")
    ap.add_argument("--output", default="data/", help="dossier de sortie des JSON")
    ap.add_argument("--db", default="collecte/quinte.sqlite", help="base SQLite locale (cache, reprise possible)")
    ap.add_argument("--types", default="QUINTE", help="sous-chaînes de codePari à retenir, séparées par des virgules "
                    "(ex. QUINTE ou QUINTE,QUARTE)")
    ap.add_argument("--toutes-courses", action="store_true",
                    help="collecte aussi les courses non-Quinté+ (historique des chevaux plus riche, beaucoup plus de requêtes)")
    ap.add_argument("--a-venir", default=dt.date.today().isoformat(),
                    help="jour dont on récupère le Quinté+ à venir ('non' pour ignorer)")
    ap.add_argument("--nb-retro", type=int, default=10, help="nb de dernières courses rejouées sans regard vers l'avenir")
    ap.add_argument("--inclure-tocards", action="store_true", help="n'exclut pas les cotes > 69/1")
    ap.add_argument("--max-sorties-export", type=int, default=FENETRE_PARCOURS)
    ap.add_argument("--pause", type=float, default=0.7, help="pause (s) entre requêtes")
    ap.add_argument("--forcer", action="store_true", help="re-télécharge même les jours déjà traités")
    ap.add_argument("--sans-collecte", action="store_true", help="ne contacte pas l'API : recalcule les JSON depuis la base")
    ap.add_argument("--indent", type=int, default=0, help="indentation JSON (0 = compact)")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    types = [t.strip().upper() for t in a.types.split(",") if t.strip()]
    db = ouvrir_db(a.db)
    a_venir: list[dict] = []
    if not a.sans_collecte:
        client = PmuClient(pause=a.pause)
        log.info("Collecte du %s au %s (types : %s)", a.debut, a.fin, types)
        n = collecter(client, db, a.debut, a.fin, types, a.toutes_courses, a.forcer)
        log.info("%d nouvelles courses enregistrées", n)
        if a.a_venir.lower() not in ("non", "no", "none", ""):
            try:
                a_venir = collecter_a_venir(client, a.a_venir, types)
                log.info("%d course(s) à venir pour le %s", len(a_venir), a.a_venir)
            except ApiIndisponible as e:
                log.warning("Programme à venir indisponible : %s", e)
    r = exporter_tout(db, Path(a.output), a_venir, a.nb_retro, a.inclure_tocards, a.max_sorties_export, a.indent)

    print("\n=== RÉSUMÉ ===")
    print(f"Période analysée        : {r['debut']} → {r['fin']}")
    print(f"Courses collectées      : {r['courses']}")
    print(f"Chevaux (parcours)      : {r['chevaux']}")
    print(f"Paires de numéros       : {r['paires']}")
    print(f"Combinaisons générées   : {r['combinaisons']}")
    print(f"JSON écrits dans        : {Path(a.output).resolve()}")
    print("Résultats passés, sans garantie pour l'avenir.")


if __name__ == "__main__":
    main()
