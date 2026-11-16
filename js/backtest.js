/**
 * backtest.js — Rejoue la stratégie sur l'historique, SANS regard vers l'avenir.
 *
 * Pour chaque course (ordre chronologique) : les statistiques sont construites uniquement avec les courses
 * PRÉCÉDENTES (accumulateur incrémental) et les sorties des chevaux antérieures à la date de la course.
 * On génère la combinaison choisie, on la « joue » et on compare au résultat réel.
 *
 * Modèle de jeu (simplifié, voir page Méthode) — mise de base m (2 € par combinaison de 5 numéros) :
 *   - une combinaison de k numéros coûte C(k,5) × m  (toutes les sous-combinaisons de 5 numéros) ;
 *   - Quinté+ désordre : gagne si les 5 premiers sont dans le lot → rapport « désordre » ;
 *   - Bonus 4 sur 5    : chaque sous-combinaison de 5 numéros contenant exactement 4 des 5 premiers → rapport « bonus 4/5 ».
 * Les rapports officiels sont ceux de la mise de base (2 €) ; le ROI est indépendant de la mise choisie.
 *
 * Comparaison au hasard : CALCUL EXACT (loi hypergéométrique) — un lot de k numéros tiré au hasard parmi N
 * partants contient j des 5 premiers avec la probabilité C(5,j)·C(N−5,k−j)/C(N,k). Pas de simulation.
 */
import { creerAccumulateur, ajouterCourse, scorerCourse, CONFIG } from './scoreEngine.js';
import { genererCombinaisons } from './combinaisonGenerator.js';

export const MISE_BASE_DEFAUT = 2;

/** Coefficient binomial C(n, k) (0 si hors domaine). */
export function comb(n, k) {
  if (k < 0 || k > n || n < 0) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Gain (rapports de la mise de base) pour un lot qui contient `a` des 5 premiers, k numéros au total. */
export function gainPourTrouves(a, k, rap) {
  const des = a === 5 ? rap.quinte_desordre ?? 0 : 0;
  const b45 = comb(a, 4) * (k - a) * (rap.bonus4sur5 ?? 0);
  return { desordre: des, bonus: b45, total: des + b45 };
}

/** Évalue une combinaison jouée sur une course : coût, gain, nb de numéros trouvés. */
export function evaluerCombinaison(numeros, arrivee, rapports, mise = MISE_BASE_DEFAUT) {
  const k = numeros.length;
  const top5 = new Set(arrivee.slice(0, 5));
  const a = numeros.filter((n) => top5.has(n)).length;
  const g = gainPourTrouves(a, k, rapports);
  const base = MISE_BASE_DEFAUT; // les rapports sont exprimés pour 2 €
  const facteur = mise / base;
  return { trouves: a, cout: comb(k, 5) * mise, gain: g.total * facteur, desordre: a === 5, gagnant: g.total > 0 };
}

/** Espérance exacte, pour un lot aléatoire de k numéros parmi N : gain moyen, probabilité de gagner, trouvés moyens. */
export function esperanceHasard(N, k, rapports, mise = MISE_BASE_DEFAUT) {
  const tot = comb(N, k);
  let gain = 0, pGagne = 0;
  const facteur = mise / MISE_BASE_DEFAUT;
  for (let j = 0; j <= 5; j++) {
    const p = (comb(5, j) * comb(N - 5, k - j)) / tot;
    const g = gainPourTrouves(j, k, rapports).total;
    gain += p * g * facteur;
    if (g > 0) pGagne += p;
  }
  return { gain, pGagne, trouves: (5 * k) / N, pDesordre: comb(N - 5, k - 5) / tot };
}

/** Courses triées chronologiquement (date, puis id). */
export const trierCourses = (courses) => [...courses].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

export const echauffementDefaut = (n) => Math.max(3, Math.min(60, Math.floor(n * 0.2)));

/**
 * backtest(histo, options) → { nbCourses, nbGagnants, tauxReussite, roi, miseTotale, gainTotal, evolution, … }
 * options : { type='base', mise=2, echauffement, inclureTocards=false, inclureInsuffisants=false, parcours }
 */
export function backtest(histo, options = {}) {
  const {
    type = 'base', mise = MISE_BASE_DEFAUT, inclureTocards = false, inclureInsuffisants = false, parcours = null,
  } = options;
  const courses = trierCourses(histo);
  const echauffement = options.echauffement ?? echauffementDefaut(courses.length);
  const acc = creerAccumulateur();

  const r = {
    type, mise, echauffement,
    nbCourses: 0, nbGagnants: 0, nbQuinte: 0, tauxReussite: 0, roi: 0, roiHorsMeilleur: 0,
    miseTotale: 0, gainTotal: 0, meilleurGain: 0,
    trouvesMoyen: 0, hasard: { tauxReussite: 0, roi: 0, gainEspere: 0, trouvesMoyen: 0, quinteAttendus: 0 },
    ignorees: { echauffement: 0, sansRapport: 0 },
    evolution: [], derniers: [],
  };
  let solde = 0, soldeHasard = 0, sommeTrouves = 0, sommePGagne = 0, sommeGainHasard = 0, sommePDes = 0, sommeTrouvesHasard = 0;

  courses.forEach((c, i) => {
    const jouable = i >= echauffement && c.rapports && c.rapports.quinte_desordre != null && c.arrivee?.length >= 5;
    if (i < echauffement) r.ignorees.echauffement += 1;
    else if (!jouable) r.ignorees.sansRapport += 1;

    if (jouable) {
      const ctx = { stats: acc, coocc: acc.coocc, parcours };
      const scores = scorerCourse(c, ctx, { inclureTocards, inclureInsuffisants });
      const combo = genererCombinaisons(c.partants, scores, type)[0];
      const ev = evaluerCombinaison(combo.numeros, c.arrivee, c.rapports, mise);
      const esp = esperanceHasard(c.partants.length, combo.numeros.length, c.rapports, mise);

      r.nbCourses += 1;
      r.miseTotale += ev.cout;
      r.gainTotal += ev.gain;
      r.meilleurGain = Math.max(r.meilleurGain, ev.gain);
      if (ev.gagnant) r.nbGagnants += 1;
      if (ev.desordre) r.nbQuinte += 1;
      sommeTrouves += ev.trouves;
      sommePGagne += esp.pGagne;
      sommePDes += esp.pDesordre;
      sommeGainHasard += esp.gain;
      sommeTrouvesHasard += esp.trouves;
      solde += ev.gain - ev.cout;
      soldeHasard += esp.gain - ev.cout;
      r.evolution.push({ index: r.nbCourses, date: c.date, id: c.id, solde, soldeHasard });
      r.derniers.push({
        date: c.date, id: c.id, hippodrome: c.hippodrome, numeros: combo.numeros, arrivee: c.arrivee.slice(0, 5),
        trouves: ev.trouves, cout: ev.cout, gain: ev.gain, gagnant: ev.gagnant, desordre: ev.desordre,
        rapport: ev.desordre ? c.rapports.quinte_desordre : ev.gagnant ? c.rapports.bonus4sur5 ?? null : null,
        nbPartants: c.partants.length,
      });
    }
    ajouterCourse(acc, c, { scopesPaires: false }); // la course entre dans l'historique APRÈS avoir été « jouée »
  });

  const n = r.nbCourses;
  r.tauxReussite = n ? r.nbGagnants / n : 0;
  r.roi = r.miseTotale ? (r.gainTotal - r.miseTotale) / r.miseTotale : 0;
  r.roiHorsMeilleur = r.miseTotale ? (r.gainTotal - r.meilleurGain - r.miseTotale) / r.miseTotale : 0;
  r.trouvesMoyen = n ? sommeTrouves / n : 0;
  r.hasard = {
    tauxReussite: n ? sommePGagne / n : 0,
    roi: r.miseTotale ? (sommeGainHasard - r.miseTotale) / r.miseTotale : 0,
    gainEspere: sommeGainHasard,
    trouvesMoyen: n ? sommeTrouvesHasard / n : 0,
    quinteAttendus: sommePDes,
    gagnantsAttendus: sommePGagne,
  };
  r.derniers = r.derniers.slice(-20).reverse();
  r.config = { M_LISSAGE: CONFIG.M_LISSAGE, MIN_SORTIES: CONFIG.MIN_SORTIES };
  return r;
}
