/**
 * dataLoader.js — Charge les JSON via fetch(), gère les erreurs et met en cache.
 *
 * 4 fichiers obligatoires (historique, stats, co-occurrences, parcours) + 2 optionnels
 * (courses_a_venir.json, combinaisons_candidates.json). Une fois chargées, les données restent en mémoire :
 * le site fonctionne ensuite hors ligne.
 */
import { trierCourses } from './backtest.js';

export const FICHIERS = Object.freeze({
  histo: 'arrivees_historique.json',
  stats: 'stats_numeros.json',
  coocc: 'cooccurrences.json',
  parcours: 'parcours.json',
});
export const FICHIERS_OPTIONNELS = Object.freeze({
  aVenir: 'courses_a_venir.json',
  candidats: 'combinaisons_candidates.json',
});

const cache = new Map();

export class ErreurChargement extends Error {
  constructor(fichier, cause) {
    super(`Impossible de charger « ${fichier} » : ${cause}`);
    this.name = 'ErreurChargement';
    this.fichier = fichier;
  }
}

/** Charge un JSON (avec cache mémoire). */
export async function chargerJSON(fichier, base = 'data/') {
  const url = base + fichier;
  if (cache.has(url)) return cache.get(url);
  const promesse = (async () => {
    let rep;
    try {
      rep = await fetch(url, { cache: 'no-cache' });
    } catch (e) {
      throw new ErreurChargement(fichier, e.message || 'réseau indisponible');
    }
    if (!rep.ok) throw new ErreurChargement(fichier, `HTTP ${rep.status}`);
    try {
      return await rep.json();
    } catch (e) {
      throw new ErreurChargement(fichier, 'JSON invalide');
    }
  })();
  cache.set(url, promesse);
  try {
    return await promesse;
  } catch (e) {
    cache.delete(url); // on ne garde pas les échecs
    throw e;
  }
}

/**
 * Charge toutes les données. Renvoie { histo, courses, stats, coocc, parcours, aVenir, candidats, erreurs }.
 * Lance ErreurChargement si un fichier obligatoire manque.
 */
export async function chargerDonnees({ base = 'data/', onProgress = () => {} } = {}) {
  const resultat = { erreurs: [] };
  let fait = 0;
  const total = Object.keys(FICHIERS).length + Object.keys(FICHIERS_OPTIONNELS).length;
  const avancer = (nom) => onProgress(++fait, total, nom);

  await Promise.all(
    Object.entries(FICHIERS).map(async ([cle, fichier]) => {
      resultat[cle] = await chargerJSON(fichier, base);
      avancer(fichier);
    }),
  );
  await Promise.all(
    Object.entries(FICHIERS_OPTIONNELS).map(async ([cle, fichier]) => {
      try {
        resultat[cle] = await chargerJSON(fichier, base);
      } catch (e) {
        resultat[cle] = null;
        resultat.erreurs.push(e.message);
      }
      avancer(fichier);
    }),
  );
  resultat.courses = trierCourses(resultat.histo.courses ?? []);
  resultat.exemple = Boolean(resultat.histo.meta?.exemple);
  return resultat;
}

/** Valide une course importée à la main (JSON) et la normalise. Lance Error avec un message clair. */
export function validerCourseImportee(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Le fichier doit contenir un objet JSON.');
  const c = obj.courses?.[0] ?? obj; // accepte aussi { courses: [ … ] }
  const partants = c.partants;
  if (!Array.isArray(partants) || partants.length < 6) throw new Error('« partants » doit être une liste d\'au moins 6 partants.');
  for (const p of partants) {
    if (!Number.isInteger(p.numero) || typeof p.nom !== 'string') throw new Error('Chaque partant doit avoir un « numero » entier et un « nom ».');
  }
  return {
    id: c.id ?? 'import', date: c.date ?? null, hippodrome: c.hippodrome ?? 'Inconnu', discipline: c.discipline ?? 'inconnue',
    distance: c.distance ?? null, nb_partants: partants.length,
    partants: partants.map((p) => ({
      numero: p.numero, nom: p.nom.toUpperCase(), jockey: p.jockey ?? '', entraineur: p.entraineur ?? '',
      poids: p.poids ?? null, cote: p.cote ?? null, musique: p.musique ?? '',
    })).sort((a, b) => a.numero - b.numero),
  };
}
