// Vérifie que le moteur JS donne les mêmes scores/combinaisons que le moteur Python
// (combinaisons_candidates.json) — course à venir ET rétro-pronostics sans regard vers l'avenir.
// Lancer : node tests/test_parite.mjs
import { readFileSync } from 'node:fs';
import { scorerCourse, construireAccumulateur, finaliserStats, finaliserCoocc, CONFIG } from '../js/scoreEngine.js';
import { genererCombinaisons } from '../js/combinaisonGenerator.js';
import { backtest, comb, esperanceHasard, evaluerCombinaison } from '../js/backtest.js';

const lire = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url)));
const histo = lire('arrivees_historique.json').courses;
const stats = lire('stats_numeros.json');
const coocc = lire('cooccurrences.json');
const parcours = lire('parcours.json');
const aVenir = lire('courses_a_venir.json').courses;
const cands = lire('combinaisons_candidates.json').courses;

let erreurs = 0;
const ok = (cond, msg) => { if (!cond) { erreurs++; console.error('ECHEC :', msg); } };
const proche = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

function comparer(course, ctx, ref, etiquette) {
  const scores = scorerCourse(course, ctx);
  const combos = genererCombinaisons(course.partants, scores, 'toutes');
  for (const sref of ref.scores_partants) {
    const s = scores.find((x) => x.numero === sref.numero);
    ok(s && proche(s.composite, sref.composite, 2e-3), `${etiquette} n°${sref.numero} composite JS=${s?.composite} PY=${sref.composite}`);
    ok(s && s.exclu === sref.exclu, `${etiquette} n°${sref.numero} exclusion JS=${s?.exclu} PY=${sref.exclu}`);
  }
  for (const cref of ref.combinaisons) {
    const c = combos.find((x) => x.type === cref.type);
    ok(c && JSON.stringify(c.numeros) === JSON.stringify(cref.numeros), `${etiquette} ${cref.type} numéros JS=${c?.numeros} PY=${cref.numeros}`);
    ok(c && proche(c.score, cref.score, 5e-3), `${etiquette} ${cref.type} score JS=${c?.score} PY=${cref.score}`);
  }
  return ref.combinaisons.length;
}

let n = 0;
// 1) course à venir : contexte complet (fichiers JSON)
for (const c of aVenir) {
  const ref = cands.find((x) => x.id === c.id && x.mode === 'a_venir');
  ok(ref, `référence Python introuvable pour ${c.id}`);
  if (ref) n += comparer(c, { stats, coocc, parcours }, ref, `à venir ${c.id}`);
}
// 2) rétro-pronostics : contexte construit avec les seules courses précédentes
for (const ref of cands.filter((x) => x.mode === 'retro')) {
  const i = histo.findIndex((c) => c.id === ref.id);
  const acc = construireAccumulateur(histo.slice(0, i), { scopesPaires: false });
  n += comparer(histo[i], { stats: acc, coocc: acc.coocc, parcours }, ref, `rétro ${ref.id}`);
}
// 3) le stats finalisé de l'accumulateur = stats_numeros.json (sur tout l'historique)
const accTout = construireAccumulateur(histo);
const sf = finaliserStats(accTout);
for (const [num, e] of Object.entries(stats.global)) {
  ok(sf.global[num].top5 === e.top5 && sf.global[num].sorties === e.sorties, `stats global n°${num}`);
  ok(proche(sf.global[num].ecart_moyen ?? 0, e.ecart_moyen ?? 0, 0.01), `écart moyen n°${num}`);
}
const cf = finaliserCoocc(accTout);
ok(Object.keys(cf.global).length === Object.keys(coocc.global).length, 'nb de paires global');

// 4) combinatoire du backtest
ok(comb(16, 5) === 4368 && comb(7, 5) === 21 && comb(5, 5) === 1, 'comb');
const rap = { quinte_desordre: 1000, bonus4sur5: 20 };
let e = evaluerCombinaison([1, 2, 3, 4, 5], [5, 4, 3, 2, 1], rap, 2);
ok(e.gain === 1000 && e.cout === 2 && e.trouves === 5, 'évaluation 5/5');
e = evaluerCombinaison([1, 2, 3, 4, 9], [5, 4, 3, 2, 1], rap, 2);
ok(e.gain === 20 && e.trouves === 4, 'évaluation 4/5');
e = evaluerCombinaison([1, 2, 3, 4, 5, 6, 7], [5, 4, 3, 2, 1], rap, 2);
// 7 numéros contenant les 5 premiers : 21 combinaisons, 1 désordre + 5×2 = 10 combinaisons « 4/5 »
ok(e.cout === 42 && e.gain === 1000 + 10 * 20, `évaluation élargie gain=${e.gain}`);
// espérance exacte : somme des probabilités = 1 ; probabilité de 5/5 = 1/C(16,5) pour k=5
const esp = esperanceHasard(16, 5, rap, 2);
ok(proche(esp.pDesordre, 1 / 4368, 1e-9), 'P(désordre) hasard');
ok(proche(esp.trouves, 25 / 16, 1e-9), 'trouvés moyens hasard');

// 5) le backtest tourne et n'utilise pas la course jouée (même résultat si on modifie sa propre arrivée n'est pas
//    testable ici ; on vérifie la cohérence des totaux)
for (const type of ['base', 'elargie', 'valeur', 'poker']) {
  const r = backtest(histo, { type, parcours });
  ok(r.nbCourses + r.ignorees.echauffement + r.ignorees.sansRapport === histo.length, `${type} : décompte des courses`);
  ok(r.evolution.length === r.nbCourses, `${type} : évolution`);
  ok(proche(r.evolution.at(-1).solde, r.gainTotal - r.miseTotale, 1e-6), `${type} : solde final`);
  console.log(`backtest ${type.padEnd(8)} courses=${r.nbCourses} gagnants=${r.nbGagnants} ROI=${(r.roi * 100).toFixed(1)}% hasard ROI=${(r.hasard.roi * 100).toFixed(1)}% trouvés=${r.trouvesMoyen.toFixed(2)} (hasard ${r.hasard.trouvesMoyen.toFixed(2)})`);
}

console.log(`\n${n} combinaisons comparées avec le moteur Python.`);
if (erreurs) { console.error(`${erreurs} échec(s).`); process.exit(1); }
console.log('Parité Python/JS : OK');
