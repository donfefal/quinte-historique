/**
 * utils.js — Configuration et petits utilitaires partagés (échappement HTML, formats).
 */

/** Réglages modifiables. devise: 'EUR' (défaut) ou 'XOF' (FCFA, parité fixe 655,957). */
export const CONFIG = {
  devise: 'EUR',
  tauxXOF: 655.957,
  miseDefaut: 2,
};

/** Échappe une valeur avant insertion dans du HTML (les JSON importés sont non fiables). */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const fmtPct = (x, d = 1) => (x == null || Number.isNaN(x) ? '–' : (x * 100).toFixed(d).replace('.', ',') + ' %');
export const fmtNum = (x, d = 1) => (x == null || Number.isNaN(x) ? '–' : Number(x).toFixed(d).replace('.', ','));

/** Montant fourni en euros, affiché dans la devise configurée. */
export function fmtMontant(eur, d = 2) {
  if (eur == null || Number.isNaN(eur)) return '–';
  if (CONFIG.devise === 'XOF') return Math.round(eur * CONFIG.tauxXOF).toLocaleString('fr-FR') + ' FCFA';
  return Number(eur).toFixed(d).replace('.', ',') + ' €';
}

export const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '–');

/** Coefficient binomial C(n, k). */
export function binom(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Toutes les combinaisons de k éléments d'un tableau. */
export function sousEnsembles(arr, k) {
  const out = [];
  const rec = (start, cur) => {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  return out;
}

/** Générateur pseudo-aléatoire déterministe (mulberry32) : backtest reproductible. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const moyenne = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
