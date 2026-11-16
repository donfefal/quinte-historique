/**
 * combinaisonGenerator.js — Quatre types de combinaisons à partir des scores (miroir du moteur Python).
 *
 *  base     : les 5 numéros au meilleur score composite
 *  elargie  : les 7 meilleurs
 *  valeur   : 3 « favoris historiques » (cote ≤ 10) + 2 outsiders à potentiel (cote > 10), par score composite
 *  poker    : 5 numéros à score élevé parmi les cotes ≥ 15 (complété par les cotes les plus hautes)
 *
 * Exclusions : historique insuffisant (< 3 sorties) et tocards (cote > 69) sauf options. Si moins de 5 numéros
 * sont éligibles, le lot est complété avec les meilleurs « historique insuffisant » (jamais les tocards) et signalé.
 * La cote ne sert qu'à CLASSER les numéros en favoris/outsiders — jamais à calculer le score.
 */
import { CONFIG, moyenne, hasardTop5 } from './scoreEngine.js';

const tri = (lst) => [...lst].sort((a, b) => b.composite - a.composite || a.numero - b.numero);
const pct = (x) => `${Math.round(x * 100)} %`;
const f1 = (x) => x.toFixed(1).replace('.', ',');

export const TYPES = ['base', 'elargie', 'valeur', 'poker'];

/** Phrase courte : meilleur appui statistique d'un numéro, comparé au hasard. */
export function pointFort(s) {
  const d = s.detail;
  const cand = [];
  if (d.frequence.suffisant) {
    cand.push([d.frequence.taux_hippodrome / d.frequence.hasard - 1,
      `taux de top 5 sur l'hippodrome ${pct(d.frequence.taux_hippodrome)} (au hasard : ${pct(d.frequence.hasard)})`]);
  }
  if (d.cooccurrence.suffisant) {
    cand.push([d.cooccurrence.lift_moyen - 1, `co-occurrence ×${d.cooccurrence.lift_moyen.toFixed(2).replace('.', ',')} vs hasard avec les autres partants`]);
  }
  if (d.parcours.suffisant) {
    cand.push([d.parcours.regularite / CONFIG.PRIOR_TOP3 - 1, `régularité top 3 ${pct(d.parcours.regularite)} (au hasard : ~20 %)`]);
  }
  if (!cand.length) return 'historique insuffisant (score neutre)';
  return cand.reduce((m, x) => (x[0] > m[0] ? x : m))[1];
}

function fabriquer(type, label, choisis, nbPartants, complete) {
  const numeros = choisis.map((s) => s.numero).sort((a, b) => a - b);
  const detail = {
    frequence: moyenne(choisis.map((s) => s.frequence)),
    cooccurrence: moyenne(choisis.map((s) => s.cooccurrence)),
    parcours: moyenne(choisis.map((s) => s.parcours)),
  };
  const score = moyenne(choisis.map((s) => s.composite));
  const k = choisis.length;
  const meilleur = choisis.reduce((m, s) => (s.composite > m.composite ? s : m));
  let justification = `${label} : ${k} numéros, score moyen ${f1(score)}/100. Au hasard, un lot de ${k} numéros place en moyenne `
    + `${f1((k * 5) / nbPartants)} numéros dans le top 5. Meilleur appui : n°${meilleur.numero} ${meilleur.nom} — ${pointFort(meilleur)}.`;
  if (complete) justification += ' Lot complété avec des numéros à historique insuffisant (moins de 5 numéros éligibles).';
  return {
    type, label, numeros, score, detail, justification, complete,
    partants: [...choisis].sort((a, b) => a.numero - b.numero).map((s) => ({
      numero: s.numero, nom: s.nom, composite: s.composite, cote: s.cote,
      frequence: s.frequence, cooccurrence: s.cooccurrence, parcours: s.parcours, suffisant: s.suffisant,
    })),
  };
}

/**
 * genererCombinaisons(partants, scores, type) → tableau de combinaisons.
 * type : 'base' | 'elargie' | 'valeur' | 'poker' | 'toutes' (défaut) — résultat trié par score décroissant.
 */
export function genererCombinaisons(partants, scores, type = 'toutes') {
  const nbPartants = partants.length;
  const pool = tri(scores.filter((s) => !s.exclu));
  const reserve = tri(scores.filter((s) => s.exclu === 'historique insuffisant'));

  const completer = (lst, k) => {
    const out = lst.slice(0, k);
    let complete = false;
    for (const s of reserve) {
      if (out.length >= k) break;
      if (!out.includes(s)) { out.push(s); complete = true; }
    }
    return [out, complete];
  };

  const res = {};
  let [c, cpl] = completer(pool, 5);
  res.base = fabriquer('base', 'Base solide', c, nbPartants, cpl);
  [c, cpl] = completer(pool, 7);
  res.elargie = fabriquer('elargie', 'Élargie', c, nbPartants, cpl);

  const favoris = pool.filter((s) => s.cote === null || s.cote <= CONFIG.SEUIL_FAVORI).slice(0, 3);
  const outsiders = pool.filter((s) => s.cote !== null && s.cote > CONFIG.SEUIL_FAVORI && !favoris.includes(s)).slice(0, 2);
  let lot = [...favoris, ...outsiders];
  for (const s of pool) { if (lot.length >= 5) break; if (!lot.includes(s)) lot.push(s); }
  [lot, cpl] = completer(lot, 5);
  res.valeur = fabriquer('valeur', 'Valeur (3 favoris + 2 outsiders)', lot, nbPartants, cpl);

  let hauts = pool.filter((s) => s.cote !== null && s.cote >= CONFIG.SEUIL_POKER).slice(0, 5);
  const parCote = [...pool].sort((a, b) => (b.cote ?? 0) - (a.cote ?? 0) || a.numero - b.numero);
  for (const s of parCote) { if (hauts.length >= 5) break; if (!hauts.includes(s)) hauts.push(s); }
  [hauts, cpl] = completer(hauts, 5);
  res.poker = fabriquer('poker', 'Coup de poker (cotes élevées)', hauts, nbPartants, cpl);

  if (type !== 'toutes') return [res[type]].filter(Boolean);
  return Object.values(res).sort((a, b) => b.score - a.score);
}

export { hasardTop5 };
