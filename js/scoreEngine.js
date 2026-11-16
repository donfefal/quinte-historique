/**
 * scoreEngine.js — Formules de score (miroir exact de scripts/collecte_quinte.py, sections 8-10).
 *
 * Tout est calculé à partir de l'HISTORIQUE (aucune « forme du jour »). Les taux sont lissés vers le
 * hasard (pseudo-observations M_LISSAGE) pour qu'un numéro vu 3 fois ne pèse pas comme un numéro vu 300 fois.
 *
 *   score_frequence    = 0.3·taux_top5_global + 0.4·taux_top5_hippodrome + 0.3·taux_top5_discipline
 *   score_cooccurrence = moyenne, sur les autres partants du jour, du taux de co-occurrence rapporté au
 *                        hasard (lift lissé), ramené sur 0-1 : lift 1 (= hasard) → 0,5 ; lift ≥ 2 → 1
 *   score_parcours     = 0.5·régularité_top3 + 0.3·progression_normalisée + 0.2·performance_hippodrome
 *   score_composite    = 100 · (0.4·fréquence + 0.3·co-occurrence + 0.3·parcours)
 *
 * Données manquantes (< 3 sorties, pas de co-occurrences…) : score neutre 0,15 + « historique insuffisant ».
 */

export const CONFIG = Object.freeze({
  NEUTRE: 0.15,
  MIN_SORTIES: 3,
  COTE_MAX: 69,
  SEUIL_FAVORI: 10,
  SEUIL_POKER: 15,
  M_LISSAGE: 10,
  M_TOP3: 4,
  PRIOR_TOP3: 0.2,
  FENETRE_PARCOURS: 20,
  FENETRE_REGULARITE: 10,
  POIDS_FREQ: Object.freeze({ global: 0.3, hippodrome: 0.4, discipline: 0.3 }),
  POIDS_PARCOURS: Object.freeze({ regularite: 0.5, progression: 0.3, hippodrome: 0.2 }),
  POIDS_COMPOSITE: Object.freeze({ frequence: 0.4, cooccurrence: 0.3, parcours: 0.3 }),
});

/* ------------------------------------------------------------------ outils */
export const clip = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const moyenne = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
/** Probabilité qu'un partant au hasard finisse dans le top 5 d'un lot de n. */
export const hasardTop5 = (n) => (n ? Math.min(1, 5 / n) : 0);
/** Probabilité que deux partants donnés soient tous deux dans le top 5. */
export const hasardPaire = (n) => (n > 5 ? (5 / n) * (4 / (n - 1)) : 1);
export const clePaire = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;
/** Taux observé tiré vers le hasard (prior) avec m pseudo-observations. */
export const tauxLisse = (top, sorties, prior, m = CONFIG.M_LISSAGE) => (top + m * prior) / (sorties + m);

/* ------------------------------------------------------------ 1. fréquence */
export function detailFrequence(numero, hippodrome, discipline, stats, nbPartants) {
  const prior = hasardTop5(nbPartants);
  const g = stats?.global?.[String(numero)];
  if (!g || g.sorties < CONFIG.MIN_SORTIES) return { score: CONFIG.NEUTRE, suffisant: false, hasard: prior };
  const vide = { sorties: 0, top5: 0 };
  const h = stats.par_hippodrome?.[hippodrome]?.[String(numero)] ?? vide;
  const d = stats.par_discipline?.[discipline]?.[String(numero)] ?? vide;
  const tg = tauxLisse(g.top5, g.sorties, prior);
  const th = tauxLisse(h.top5, h.sorties, prior);
  const td = tauxLisse(d.top5, d.sorties, prior);
  const P = CONFIG.POIDS_FREQ;
  return {
    score: P.global * tg + P.hippodrome * th + P.discipline * td,
    suffisant: true, hasard: prior,
    taux_global: tg, taux_hippodrome: th, taux_discipline: td,
    sorties_global: g.sorties, sorties_hippodrome: h.sorties, sorties_discipline: d.sorties,
  };
}
/** scoreFrequence(numero, hippodrome, discipline, stats) → 0-1 */
export const scoreFrequence = (numero, hippodrome, discipline, stats, nbPartants = 16) =>
  detailFrequence(numero, hippodrome, discipline, stats, nbPartants).score;

/* -------------------------------------------------------- 2. co-occurrence */
/** Lift lissé d'une paire (1 = autant que le hasard). */
export function liftPaire(coocc, a, b, nbPartants) {
  const att = hasardPaire(nbPartants);
  const cell = coocc?.global?.[clePaire(a, b)] ?? { n: 0, opportunites: 0 };
  return tauxLisse(cell.n, cell.opportunites, att) / att;
}
export function detailCooccurrence(numero, numerosDuJour, coocc) {
  if (!coocc?.global || Object.keys(coocc.global).length === 0) return { score: CONFIG.NEUTRE, suffisant: false };
  const n = numerosDuJour.length;
  const lifts = numerosDuJour.filter((b) => b !== numero).map((b) => liftPaire(coocc, numero, b, n));
  const lift = lifts.length ? moyenne(lifts) : 1;
  return { score: clip(lift / 2), suffisant: true, lift_moyen: lift };
}
/** scoreCooccurrence(numero, partantsDuJour, coocc) → 0-1  (partantsDuJour : numéros ou objets {numero}) */
export const scoreCooccurrence = (numero, partantsDuJour, coocc) =>
  detailCooccurrence(numero, partantsDuJour.map((p) => (typeof p === 'object' ? p.numero : p)), coocc).score;

/* --------------------------------------------------------------- 3. parcours */
/** Place → 0..1 (1 = vainqueur, 0 = dernier ou non classé). */
export function pointPlace(s) {
  const { place, nb_partants: n } = s;
  if (!place) return 0;
  if (!n || n <= 1) return 0.5;
  return clip(1 - (place - 1) / (n - 1));
}

/**
 * Statistiques d'un cheval sur ses FENETRE_PARCOURS dernières sorties (ordre chronologique).
 * Progression : moyenne des k dernières places normalisées − moyenne des k précédentes (k = 3 si ≥ 6 sorties,
 * n/2 pour 4-5 sorties, sinon pas de tendance = 0,5).
 */
export function statsCheval(sortiesAsc) {
  const fen = sortiesAsc.slice(-CONFIG.FENETRE_PARCOURS);
  const dernieres = fen.slice(-CONFIG.FENETRE_REGULARITE);
  const top3 = dernieres.filter((s) => s.place && s.place <= 3).length;
  const res = {
    nb_sorties: sortiesAsc.length,
    sorties_fenetre: fen.length,
    taux_top3_brut: dernieres.length ? top3 / dernieres.length : null,
    regularite_top3: dernieres.length ? (top3 + CONFIG.M_TOP3 * CONFIG.PRIOR_TOP3) / (dernieres.length + CONFIG.M_TOP3) : null,
  };
  const ps = fen.map(pointPlace);
  if (ps.length >= 4) {
    const k = ps.length >= 6 ? 3 : Math.floor(ps.length / 2);
    const der = moyenne(ps.slice(-k));
    const prec = moyenne(ps.slice(-2 * k, -k));
    res.progression = { valeur: der - prec, normalisee: (der - prec + 1) / 2, k, recentes: der, precedentes: prec };
  } else {
    res.progression = { valeur: null, normalisee: 0.5, k: 0, recentes: null, precedentes: null };
  }
  const agreger = (cle) => {
    const d = {};
    for (const s of fen) {
      const e = (d[s[cle]] ??= { sorties: 0, top3: 0 });
      e.sorties += 1;
      if (s.place && s.place <= 3) e.top3 += 1;
    }
    for (const e of Object.values(d)) e.taux_top3 = e.top3 / e.sorties;
    return d;
  };
  res.par_hippodrome = agreger('hippodrome');
  res.par_discipline = agreger('discipline');
  res.derniere_sortie = sortiesAsc.length ? sortiesAsc[sortiesAsc.length - 1].date : null;
  return res;
}

/** Sorties d'un cheval strictement antérieures à `avant` (AAAA-MM-JJ) — évite tout regard vers l'avenir. */
export function sortiesAvant(parcours, nom, avant) {
  const s = parcours?.chevaux?.[nom]?.sorties ?? [];
  return avant ? s.filter((x) => x.date < avant) : s;
}

export function detailParcours(nom, hippodrome, parcours, avant) {
  const hist = sortiesAvant(parcours, nom, avant);
  if (hist.length < CONFIG.MIN_SORTIES) return { score: CONFIG.NEUTRE, suffisant: false, nb_sorties: hist.length };
  const st = statsCheval(hist);
  const h = st.par_hippodrome[hippodrome];
  const perf = h && h.sorties ? tauxLisse(h.top3, h.sorties, CONFIG.PRIOR_TOP3, CONFIG.M_TOP3) : CONFIG.NEUTRE;
  const P = CONFIG.POIDS_PARCOURS;
  return {
    score: P.regularite * st.regularite_top3 + P.progression * st.progression.normalisee + P.hippodrome * perf,
    suffisant: true, nb_sorties: hist.length,
    regularite: st.regularite_top3, progression: st.progression.normalisee, progression_valeur: st.progression.valeur,
    perf_hippodrome: perf, sorties_hippodrome: h ? h.sorties : 0,
  };
}
/** scoreParcours(cheval, parcours) → 0-1   (opts : {hippodrome, avant}) */
export const scoreParcours = (cheval, parcours, { hippodrome = null, avant = null } = {}) =>
  detailParcours(cheval, hippodrome, parcours, avant).score;

/* ------------------------------------------------------------- 4. composite */
export const composite = (f, c, p) => {
  const P = CONFIG.POIDS_COMPOSITE;
  return 100 * (P.frequence * f + P.cooccurrence * c + P.parcours * p);
};

/**
 * scoreComposite(numero, …) → 0-100 pour un partant donné de la course.
 * ctx = { stats, coocc, parcours } ; course = { hippodrome, discipline, date, partants[] }
 */
export function scoreComposite(numero, course, ctx) {
  const s = scorerCourse(course, ctx).find((x) => x.numero === numero);
  return s ? s.composite : CONFIG.NEUTRE * 100;
}

/**
 * Score tous les partants d'une course.
 * opts : { inclureTocards, inclureInsuffisants, coteMax }
 * Renvoie, par partant : frequence/cooccurrence/parcours (0-1), composite (0-100), suffisant, exclu, detail.
 */
export function scorerCourse(course, ctx, opts = {}) {
  const { inclureTocards = false, inclureInsuffisants = false, coteMax = CONFIG.COTE_MAX } = opts;
  const parts = course.partants;
  const nums = parts.map((p) => p.numero);
  const n = parts.length;
  return parts.map((p) => {
    const f = detailFrequence(p.numero, course.hippodrome, course.discipline, ctx.stats, n);
    const c = detailCooccurrence(p.numero, nums, ctx.coocc);
    const pa = detailParcours(p.nom, course.hippodrome, ctx.parcours, course.date ?? null);
    const suffisant = f.suffisant && pa.suffisant;
    const cote = p.cote ?? null;
    let exclu = null;
    if (cote !== null && cote > coteMax && !inclureTocards) exclu = 'tocard';
    else if (!suffisant && !inclureInsuffisants) exclu = 'historique insuffisant';
    return {
      numero: p.numero, nom: p.nom, cote,
      frequence: f.score, cooccurrence: c.score, parcours: pa.score,
      composite: composite(f.score, c.score, pa.score),
      suffisant, exclu, detail: { frequence: f, cooccurrence: c, parcours: pa },
    };
  });
}

/* ============================================================================
 * ACCUMULATEURS — statistiques construites course après course.
 * Servent (a) au backtest, qui ne doit jamais voir les courses futures,
 *            (b) au rejeu d'une course passée, (c) à la fenêtre temporelle de la page Statistiques.
 * La structure est celle de stats_numeros.json / cooccurrences.json (compteurs bruts en plus).
 * ========================================================================== */
export function creerAccumulateur() {
  return {
    nbCourses: 0, debut: null, fin: null,
    global: {}, par_hippodrome: {}, par_discipline: {},
    coocc: { global: {}, par_hippodrome: {}, par_discipline: {} },
  };
}
const nouvelleEntree = () => ({ sorties: 0, top5: 0, hasardSum: 0, positions: [0, 0, 0, 0, 0], rangs: [], derniere: null });
const nouvelleCellule = () => ({ n: 0, opportunites: 0, attenduSum: 0 });

export function ajouterCourse(acc, c, { scopesPaires = true } = {}) {
  const n = c.partants.length;
  const pos = new Map(c.arrivee.slice(0, 5).map((num, i) => [num, i]));
  const hip = (acc.par_hippodrome[c.hippodrome] ??= {});
  const dis = (acc.par_discipline[c.discipline] ??= {});
  for (const p of c.partants) {
    for (const map of [acc.global, hip, dis]) {
      const e = (map[p.numero] ??= nouvelleEntree());
      e.sorties += 1;
      e.hasardSum += hasardTop5(n);
      if (pos.has(p.numero)) {
        e.top5 += 1;
        e.positions[pos.get(p.numero)] += 1;
        e.rangs.push(e.sorties);
        e.derniere = c.date;
      }
    }
  }
  const nums = c.partants.map((p) => p.numero).sort((a, b) => a - b);
  const top = new Set(c.arrivee.slice(0, 5));
  const att = hasardPaire(n);
  const cH = scopesPaires ? (acc.coocc.par_hippodrome[c.hippodrome] ??= {}) : null;
  const cD = scopesPaires ? (acc.coocc.par_discipline[c.discipline] ??= {}) : null;
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      const cle = `${nums[i]}-${nums[j]}`;
      const both = top.has(nums[i]) && top.has(nums[j]);
      const cibles = scopesPaires ? [acc.coocc.global, cH, cD] : [acc.coocc.global];
      for (const map of cibles) {
        const cell = (map[cle] ??= nouvelleCellule());
        cell.opportunites += 1;
        cell.attenduSum += att;
        if (both) cell.n += 1;
      }
    }
  }
  acc.nbCourses += 1;
  acc.debut ??= c.date;
  acc.fin = c.date;
  return acc;
}

export function construireAccumulateur(courses, opts) {
  const acc = creerAccumulateur();
  for (const c of courses) ajouterCourse(acc, c, opts);
  return acc;
}

const arr = (x, nd) => (x === null || x === undefined ? null : Math.round(x * 10 ** nd) / 10 ** nd);
function finaliserEntree(e) {
  const ecarts = e.rangs.slice(1).map((r, i) => r - e.rangs[i]);
  return {
    sorties: e.sorties, top5: e.top5,
    taux_top5: e.sorties ? e.top5 / e.sorties : 0,
    hasard: e.sorties ? e.hasardSum / e.sorties : 0,
    ecart_moyen: ecarts.length ? moyenne(ecarts) : null,
    ecart_actuel: e.rangs.length ? e.sorties - e.rangs[e.rangs.length - 1] : null,
    derniere_sortie: e.derniere,
    positions: e.positions.slice(),
  };
}
/** Accumulateur → même forme que stats_numeros.json. */
export function finaliserStats(acc) {
  const bloc = (m) => Object.fromEntries(Object.entries(m).map(([k, e]) => [k, finaliserEntree(e)]));
  return {
    global: bloc(acc.global),
    par_hippodrome: Object.fromEntries(Object.entries(acc.par_hippodrome).map(([h, m]) => [h, bloc(m)])),
    par_discipline: Object.fromEntries(Object.entries(acc.par_discipline).map(([d, m]) => [d, bloc(m)])),
  };
}
/** Accumulateur → même forme que cooccurrences.json (global seulement : suffisant pour le scoring). */
export function finaliserCoocc(acc) {
  const g = {};
  for (const [k, c] of Object.entries(acc.coocc.global)) {
    const taux = c.opportunites ? c.n / c.opportunites : 0;
    const attendu = c.opportunites ? c.attenduSum / c.opportunites : 0;
    g[k] = { n: c.n, opportunites: c.opportunites, taux, attendu, lift: attendu ? taux / attendu : null };
  }
  return { global: g };
}

/** Courses des `mois` derniers mois (par rapport à la dernière course connue). */
export function fenetreMois(courses, mois) {
  if (!courses.length || !mois) return courses;
  const fin = new Date(courses[courses.length - 1].date + 'T00:00:00Z');
  fin.setUTCMonth(fin.getUTCMonth() - mois);
  const seuil = fin.toISOString().slice(0, 10);
  return courses.filter((c) => c.date >= seuil);
}

export { arr as arrondi };
