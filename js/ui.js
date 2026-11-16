/**
 * ui.js — Interactions : routeur (hash), sélection de course, filtres, tri, clic sur un cheval, sliders,
 * rendu des 4 pages dynamiques (Accueil, Analyse, Statistiques, Backtest). Pages Méthode/Mentions : HTML statique.
 */
import {
  CONFIG, scorerCourse, statsCheval, construireAccumulateur, finaliserStats, fenetreMois, hasardTop5, sortiesAvant,
} from './scoreEngine.js';
import { genererCombinaisons } from './combinaisonGenerator.js';
import { backtest, comb, echauffementDefaut, MISE_BASE_DEFAUT } from './backtest.js';
import { validerCourseImportee } from './dataLoader.js';
import {
  renderHeatmap, legendeHeatmap, renderDistribution, renderBarresNumeros, renderDistributionGlobale,
  legendePositions, renderEvolution, legendeEvolution,
} from './charts.js';

/* ------------------------------------------------------------------ outils */
const $ = (sel, racine = document) => racine.querySelector(sel);
const $$ = (sel, racine = document) => [...racine.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (x, nd = 1) => Number(x).toLocaleString('fr-FR', { minimumFractionDigits: nd, maximumFractionDigits: nd });
const pct = (x, nd = 1) => `${nf(x * 100, nd)} %`;
const eur = (x) => Number(x).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: x % 1 ? 2 : 0 });
const signe = (x, f) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${f(Math.abs(x))}`;
const DISC = { trot_attele: 'Trot attelé', trot_monte: 'Trot monté', plat: 'Plat', haies: 'Haies', steeple: 'Steeple-chase', cross: 'Cross' };
const libDisc = (d) => DISC[d] ?? d ?? '—';
const libCourse = (c) => `${c.hippodrome} · ${libDisc(c.discipline)}${c.distance ? ` · ${nf(c.distance, 0)} m` : ''} · ${c.partants.length} partants`;
const ROUTES = ['accueil', 'analyse', 'stats', 'backtest', 'methode', 'legal'];
const TITRES = {
  accueil: 'Course du jour', analyse: 'Analyse détaillée', stats: 'Statistiques globales',
  backtest: 'Backtest', methode: 'Méthode', legal: 'Mentions légales et conformité',
};
const MENTION = 'Résultats passés, sans garantie pour l\'avenir.';
const hasardLot = (N, k) => comb(N - 5, k - 5) / comb(N, k); // P(les 5 premiers sont tous dans un lot de k tiré au hasard)

/* -------------------------------------------------------------------- état */
const etat = {
  data: null,
  courses: [], // liste sélectionnable [{cle, groupe, label, course, mode, idx}]
  cle: null,
  options: { inclureTocards: false, inclureInsuffisants: false, coteMax: CONFIG.COTE_MAX },
  ctxHippo: '', ctxDisc: '',
  tri: { col: 'composite', dir: -1 },
  numSelectionne: null,
  calcul: null, // { course, scores, combos, nbCourses, ctx }
  stats: { mois: 0, scope: 'global', valeur: '' },
  importees: [],
  accReplay: new Map(),
};

/* ================================================================ init */
export function init(data) {
  etat.data = data;
  if (data.exemple) $('#bandeau-exemple').hidden = false;
  construireListeCourses();
  peuplerSelecteurs();
  brancherEvenements();
  window.addEventListener('hashchange', router);
  router();
}

function construireListeCourses() {
  const { data } = etat;
  const liste = [];
  (data.aVenir?.courses ?? []).forEach((c, i) => liste.push({ cle: `av-${i}`, groupe: 'À venir', label: `${c.date} — ${libCourse(c)}`, course: c, mode: 'a_venir' }));
  etat.importees.forEach((c, i) => liste.push({ cle: `im-${i}`, groupe: 'Course importée', label: `${c.date ?? 'sans date'} — ${libCourse(c)}`, course: c, mode: 'import' }));
  const n = data.courses.length;
  for (let idx = n - 1; idx >= Math.max(0, n - 30); idx--) {
    const c = data.courses[idx];
    liste.push({ cle: `re-${idx}`, groupe: 'Rejouer une course passée (calcul sans regarder l\'avenir)', label: `${c.date} — ${libCourse(c)}`, course: c, mode: 'replay', idx });
  }
  etat.courses = liste;
  if (!liste.some((x) => x.cle === etat.cle)) etat.cle = liste[0]?.cle ?? null;
}

function peuplerSelecteurs() {
  const sel = $('#sel-course');
  sel.replaceChildren();
  const groupes = new Map();
  for (const it of etat.courses) {
    if (!groupes.has(it.groupe)) { const g = document.createElement('optgroup'); g.label = it.groupe; groupes.set(it.groupe, g); sel.append(g); }
    const o = new Option(it.label, it.cle, false, it.cle === etat.cle);
    groupes.get(it.groupe).append(o);
  }
  const hippos = Object.keys(etat.data.stats.par_hippodrome ?? {}).sort();
  const discs = Object.keys(etat.data.stats.par_discipline ?? {}).sort();
  const remplir = (id, vals, vide) => { const s = $(id); s.replaceChildren(new Option(vide, '')); vals.forEach((v) => s.append(new Option(id === '#ctx-disc' || id === '#st-valeur-disc' ? libDisc(v) : v, v))); };
  remplir('#ctx-hippo', hippos, 'Hippodrome de la course');
  remplir('#ctx-disc', discs, 'Discipline de la course');
}

function brancherEvenements() {
  $('#sel-course').addEventListener('change', (e) => { etat.cle = e.target.value; etat.numSelectionne = null; etat.ctxHippo = etat.ctxDisc = ''; $('#ctx-hippo').value = $('#ctx-disc').value = ''; recalculer(); });
  $('#chk-tocards').addEventListener('change', (e) => { etat.options.inclureTocards = e.target.checked; recalculer(); });
  $('#chk-insuff').addEventListener('change', (e) => { etat.options.inclureInsuffisants = e.target.checked; recalculer(); });
  $('#sl-cote').addEventListener('input', (e) => { etat.options.coteMax = Number(e.target.value); $('#out-cote').textContent = e.target.value; recalculer(); });
  $('#import-json').addEventListener('change', importerCourse);
  $('#ctx-hippo').addEventListener('change', (e) => { etat.ctxHippo = e.target.value; recalculer(); });
  $('#ctx-disc').addEventListener('change', (e) => { etat.ctxDisc = e.target.value; recalculer(); });
  $('#ctx-reset').addEventListener('click', () => { etat.ctxHippo = etat.ctxDisc = ''; $('#ctx-hippo').value = $('#ctx-disc').value = ''; recalculer(); });
  // statistiques
  $('#st-fenetre').addEventListener('change', (e) => { etat.stats.mois = Number(e.target.value); renderStats(); });
  $('#st-scope').addEventListener('change', (e) => { etat.stats.scope = e.target.value; etat.stats.valeur = ''; renderStats(); });
  $('#st-valeur').addEventListener('change', (e) => { etat.stats.valeur = e.target.value; renderStats(); });
  // backtest
  $('#form-backtest').addEventListener('submit', (e) => { e.preventDefault(); lancerBacktest(); });
  $('#bt-echauff').placeholder = String(echauffementDefaut(etat.data.courses.length));
  // tri du tableau des partants (délégation)
  $('#tbl-partants thead').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-col]');
    if (!b) return;
    const col = b.dataset.col;
    etat.tri = { col, dir: etat.tri.col === col ? -etat.tri.dir : (['nom', 'jockey', 'entraineur', 'musique'].includes(col) ? 1 : -1) };
    renderTableau();
    $(`#tbl-partants thead button[data-col="${col}"]`)?.focus();
  });
  $('#tbl-partants tbody').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-num]');
    if (b) selectionnerCheval(Number(b.dataset.num));
  });
}

async function importerCourse(e) {
  const f = e.target.files?.[0];
  const msg = $('#msg-import');
  if (!f) return;
  try {
    const course = validerCourseImportee(JSON.parse(await f.text()));
    etat.importees = [course];
    construireListeCourses();
    etat.cle = 'im-0';
    peuplerSelecteurs();
    msg.textContent = `Course importée : ${libCourse(course)}.`;
    msg.className = 'muted';
    recalculer();
  } catch (err) {
    msg.textContent = `Import impossible : ${err.message}`;
    msg.className = 'erreur';
  }
}

/* ================================================================ routeur */
function router() {
  let page = (location.hash.replace(/^#\/?/, '') || 'accueil').split('?')[0];
  if (!ROUTES.includes(page)) page = 'accueil';
  $$('[data-page]').forEach((s) => { s.hidden = s.dataset.page !== page; });
  $$('nav a[data-route]').forEach((a) => { if (a.dataset.route === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  document.title = `${TITRES[page]} — Quinté+ Historique`;
  if (['accueil', 'analyse'].includes(page)) recalculer(page);
  if (page === 'stats') renderStats();
  if (page === 'backtest') preparerBacktest();
  $(`[data-page="${page}"] h1`)?.focus({ preventScroll: false });
  window.scrollTo(0, 0);
}
const pageActive = () => (location.hash.replace(/^#\/?/, '') || 'accueil').split('?')[0];

/* ================================================== calcul de la course sélectionnée */
function contexteDe(item) {
  const { data } = etat;
  if (item.mode === 'replay') {
    if (!etat.accReplay.has(item.idx)) etat.accReplay.set(item.idx, construireAccumulateur(data.courses.slice(0, item.idx), { scopesPaires: false }));
    const acc = etat.accReplay.get(item.idx);
    return { ctx: { stats: acc, coocc: acc.coocc, parcours: data.parcours }, nbCourses: item.idx };
  }
  return { ctx: { stats: data.stats, coocc: data.coocc, parcours: data.parcours }, nbCourses: data.courses.length };
}

function recalculer(page = pageActive()) {
  const item = etat.courses.find((x) => x.cle === etat.cle);
  if (!item) { renderVide(); return; }
  const base = item.course;
  // « scénario » : le filtre hippodrome / discipline change le contexte statistique utilisé
  const course = { ...base, hippodrome: etat.ctxHippo || base.hippodrome, discipline: etat.ctxDisc || base.discipline };
  const { ctx, nbCourses } = contexteDe(item);
  const scores = scorerCourse(course, ctx, etat.options);
  const combos = genererCombinaisons(course.partants, scores, 'toutes');
  etat.calcul = { item, course, base, scores, combos, nbCourses, ctx };
  if (page === 'accueil') renderAccueil();
  if (page === 'analyse') renderAnalyse();
}

function renderVide() {
  $('#resume-course').innerHTML = '<p>Aucune course disponible. Lancez la collecte Python ou importez une course JSON.</p>';
  $('#combinaisons').replaceChildren();
}

/* ================================================================ PAGE 1 */
function renderAccueil() {
  const { item, base, course, combos, scores, nbCourses } = etat.calcul;
  const N = course.partants.length;
  const dateTxt = base.date ? new Date(base.date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'date non renseignée';
  const mode = { a_venir: 'Course à venir', replay: 'Course passée rejouée avec les seules données antérieures', import: 'Course importée' }[item.mode];
  let reel = '';
  if (item.mode === 'replay') reel = `<p><strong>Arrivée réelle :</strong> ${base.arrivee.slice(0, 5).map((n) => `<span class="num num-sm">${n}</span>`).join(' ')}</p>`;
  $('#resume-course').innerHTML = `<h2>${esc(base.hippodrome)} — ${esc(dateTxt)}</h2>
    <dl class="infos"><div><dt>Discipline</dt><dd>${esc(libDisc(base.discipline))}</dd></div><div><dt>Distance</dt><dd>${base.distance ? `${nf(base.distance, 0)} m` : '—'}</dd></div>
    <div><dt>Partants</dt><dd>${N}</dd></div><div><dt>Mode</dt><dd>${esc(mode)}</dd></div></dl>${reel}
    <p class="muted">Excluts : ${scores.filter((s) => s.exclu === 'tocard').length} tocard(s) (cote &gt; ${etat.options.coteMax}/1) et ${scores.filter((s) => s.exclu === 'historique insuffisant').length} numéro(s) à historique insuffisant (&lt; ${CONFIG.MIN_SORTIES} sorties).</p>`;

  const cible = $('#combinaisons');
  cible.replaceChildren();
  for (const c of combos) cible.append(carteCombinaison(c, course, item));
  $('#disclaimer-accueil').innerHTML = `Basé sur <strong>${nf(nbCourses, 0)}</strong> courses passées — aucune garantie pour la course du jour. ${MENTION}`;
}

function carteCombinaison(c, course, item) {
  const N = course.partants.length, k = c.numeros.length;
  const art = document.createElement('article');
  art.className = 'card combo';
  const id = `combo-${c.type}`;
  art.setAttribute('aria-labelledby', id);
  let reel = '';
  if (item.mode === 'replay') {
    const t = c.numeros.filter((n) => item.course.arrivee.slice(0, 5).includes(n)).length;
    reel = `<p class="resultat">Rejeu : <strong>${t}/5</strong> des premiers trouvés dans ce lot (au hasard : ${nf((5 * k) / N, 1)} en moyenne).</p>`;
  }
  const barre = (lib, v) => `<div class="mini"><span>${lib}</span><div class="bar" role="img" aria-label="${lib} : ${nf(v * 100, 0)} sur 100"><i style="width:${Math.min(100, v * 100)}%"></i></div><span class="val">${nf(v * 100, 1)}</span></div>`;
  art.innerHTML = `<header class="combo-tete"><h3 id="${id}">${esc(c.label)}</h3><span class="badge badge-score" title="Score composite moyen">${nf(c.score, 1)} / 100</span></header>
    ${c.complete ? '<p><span class="badge badge-warn">Lot complété — historique insuffisant</span></p>' : ''}
    <ul class="nums" aria-label="Numéros de la combinaison ${esc(c.label)}">${c.partants.map((p) => `<li><span class="num">${p.numero}</span><span class="num-nom">${esc(p.nom)}${p.cote !== null && p.cote !== undefined ? ` <small>(${nf(p.cote, 1)}/1)</small>` : ''}</span></li>`).join('')}</ul>
    <div class="minis">${barre('Fréquence', c.detail.frequence)}${barre('Co-occurrence', c.detail.cooccurrence)}${barre('Parcours', c.detail.parcours)}</div>
    <p class="justif">${esc(c.justification)}</p>
    <p class="hasard">Au hasard : ${nf(hasardLot(N, k) * 100, 3)} % de chances (1 sur ${nf(1 / hasardLot(N, k), 0)}) que ce lot contienne les 5 premiers.</p>${reel}
    <details><summary>Détail du calcul</summary>
      <p class="muted">score_composite = 0,4 × fréquence + 0,3 × co-occurrence + 0,3 × parcours (puis × 100). Moyenne des ${k} numéros.</p>
      <div class="table-wrap"><table class="table table-compact"><caption class="sr-only">Détail des scores par numéro</caption>
      <thead><tr><th scope="col">N°</th><th scope="col">Cheval</th><th scope="col">Fréq.</th><th scope="col">Cooc.</th><th scope="col">Parc.</th><th scope="col">Composite</th></tr></thead>
      <tbody>${c.partants.map((p) => `<tr><td>${p.numero}</td><td>${esc(p.nom)}</td><td>${nf(p.frequence * 100, 1)}</td><td>${nf(p.cooccurrence * 100, 1)}</td><td>${nf(p.parcours * 100, 1)}</td><td><strong>${nf(p.composite, 1)}</strong>${p.suffisant ? '' : ' <span class="badge badge-warn">insuffisant</span>'}</td></tr>`).join('')}</tbody></table></div>
    </details>`;
  return art;
}

/* ================================================================ PAGE 2 */
const COLONNES = [
  { k: 'numero', lib: 'N°', num: true }, { k: 'nom', lib: 'Cheval' }, { k: 'jockey', lib: 'Jockey / Driver' }, { k: 'entraineur', lib: 'Entraîneur' },
  { k: 'poids', lib: 'Poids', num: true }, { k: 'musique', lib: 'Musique' }, { k: 'cote', lib: 'Cote', num: true },
  { k: 'frequence', lib: 'Fréquence', num: true, score: true }, { k: 'cooccurrence', lib: 'Co-occ.', num: true, score: true },
  { k: 'parcours', lib: 'Parcours', num: true, score: true }, { k: 'composite', lib: 'Composite', num: true, composite: true },
];

function lignesTableau() {
  const { course, scores } = etat.calcul;
  return scores.map((s) => {
    const p = course.partants.find((x) => x.numero === s.numero) ?? {};
    return { ...s, jockey: p.jockey ?? '', entraineur: p.entraineur ?? '', poids: p.poids ?? null, musique: p.musique ?? '' };
  });
}

function renderAnalyse() {
  const { base, nbCourses, item } = etat.calcul;
  $('#analyse-resume').innerHTML = `<strong>${esc(libCourse(base))}</strong>${base.date ? ` — ${esc(base.date)}` : ''}. Scores calculés avec ${nf(nbCourses, 0)} courses passées. ${MENTION}`;
  $('#ctx-note').textContent = etat.ctxHippo || etat.ctxDisc
    ? `Scénario : statistiques de ${etat.ctxHippo || base.hippodrome} / ${libDisc(etat.ctxDisc || base.discipline)} au lieu du contexte réel de la course.`
    : 'Contexte réel de la course (hippodrome et discipline de la course).';
  renderTableau();
  const nums = base.partants.map((p) => p.numero);
  renderHeatmap($('#heatmap-jour'), etat.calcul.ctx.coocc, nums, { nbPartants: nums.length });
  const lg = $('#legende-heat'); lg.replaceChildren(legendeHeatmap());
  const defaut = etat.numSelectionne ?? [...etat.calcul.scores].sort((a, b) => b.composite - a.composite)[0]?.numero;
  selectionnerCheval(defaut, false);
}

function renderTableau() {
  const { col, dir } = etat.tri;
  const rows = lignesTableau().sort((a, b) => {
    const va = a[col], vb = b[col];
    if (va === null || va === '' || va === undefined) return 1;
    if (vb === null || vb === '' || vb === undefined) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb, 'fr') : va - vb) * dir || a.numero - b.numero;
  });
  $('#tbl-partants thead').innerHTML = `<tr>${COLONNES.map((c) => `<th scope="col" aria-sort="${c.k === col ? (dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th-btn" data-col="${c.k}">${c.lib}${c.k === col ? `<span aria-hidden="true"> ${dir > 0 ? '▲' : '▼'}</span>` : ''}</button></th>`).join('')}<th scope="col">Statut</th></tr>`;
  $('#tbl-partants tbody').innerHTML = rows.map((r) => {
    const cellule = (c) => {
      const v = r[c.k];
      if (c.score) return `<td class="num-col${r.detail[c.k]?.suffisant === false ? ' neutre' : ''}" title="${r.detail[c.k]?.suffisant === false ? 'Historique insuffisant : score neutre 0,15' : ''}">${nf(v * 100, 1)}</td>`;
      if (c.composite) return `<td class="num-col"><strong>${nf(v, 1)}</strong></td>`;
      if (c.k === 'nom') return `<td><button type="button" class="lien" data-num="${r.numero}" aria-pressed="${r.numero === etat.numSelectionne}">${esc(v)}</button></td>`;
      if (c.k === 'cote') return `<td class="num-col">${v === null ? '—' : nf(v, 1)}</td>`;
      if (c.k === 'poids') return `<td class="num-col">${v === null ? '—' : nf(v, 1)}</td>`;
      return `<td${c.num ? ' class="num-col"' : ''}>${esc(v ?? '')}</td>`;
    };
    const statut = r.exclu ? `<span class="badge badge-warn">${r.exclu === 'tocard' ? 'tocard' : 'historique insuffisant'}</span>` : '<span class="badge badge-ok">éligible</span>';
    return `<tr class="${r.numero === etat.numSelectionne ? 'selectionne' : ''}${r.exclu ? ' exclu' : ''}">${COLONNES.map(cellule).join('')}<td>${statut}</td></tr>`;
  }).join('');
}

function selectionnerCheval(num, rerender = true) {
  if (num === undefined) return;
  etat.numSelectionne = num;
  if (rerender) renderTableau();
  const { course, ctx, item } = etat.calcul;
  const p = course.partants.find((x) => x.numero === num);
  if (!p) return;
  $('#dist-num').textContent = `${num} — ${p.nom}`;
  // distribution : contexte (global) du numéro
  renderDistribution($('#dist-jour'), ctx.stats.global?.[num] ? finaliserEntreeSimple(ctx.stats.global[num]) : null, num);
  renderParcours(p, course);
}
/** Les accumulateurs ont `hasardSum` ; les fichiers ont `hasard`. On normalise pour le graphique. */
function finaliserEntreeSimple(e) {
  return { sorties: e.sorties, positions: e.positions, hasard: e.hasard ?? (e.sorties ? e.hasardSum / e.sorties : 0) };
}

function renderParcours(p, course) {
  const cible = $('#parcours-contenu');
  const hist = sortiesAvant(etat.data.parcours, p.nom, course.date ?? null);
  if (!hist.length) { cible.innerHTML = `<p><strong>${esc(p.nom)}</strong> — historique insuffisant : aucune sortie connue avant cette course.</p>`; return; }
  const st = statsCheval(hist);
  const dates = hist.map((s) => new Date(s.date + 'T00:00:00Z').getTime());
  const ecarts = dates.slice(1).map((d, i) => (d - dates[i]) / 86400000);
  const ecartMoy = ecarts.length ? ecarts.reduce((a, b) => a + b, 0) / ecarts.length : null;
  const prog = st.progression;
  const fleche = prog.valeur === null ? 'Tendance non calculable (moins de 4 sorties)' : prog.valeur > 0.05 ? `↗ En progression (${signe(prog.valeur, (x) => nf(x, 2))})` : prog.valeur < -0.05 ? `↘ En recul (${signe(prog.valeur, (x) => nf(x, 2))})` : `→ Stable (${signe(prog.valeur, (x) => nf(x, 2))})`;
  const insuff = hist.length < CONFIG.MIN_SORTIES ? '<span class="badge badge-warn">historique insuffisant</span>' : '';
  const dernieres = [...hist].reverse().slice(0, 10);
  const ph = Object.entries(st.par_hippodrome).sort((a, b) => b[1].sorties - a[1].sorties).slice(0, 5).map(([h, v]) => `${esc(h)} : ${v.top3}/${v.sorties} dans les 3`).join(' · ');
  cible.innerHTML = `<h3>${esc(p.nom)} <small>n°${p.numero}</small> ${insuff}</h3>
    <dl class="infos"><div><dt>Sorties connues</dt><dd>${hist.length}</dd></div>
    <div><dt>Régularité top 3</dt><dd>${pct(st.taux_top3_brut)} <small>(lissée : ${pct(st.regularite_top3)} ; au hasard ~20 %)</small></dd></div>
    <div><dt>Progression (${prog.k || 3} dernières vs ${prog.k || 3} précédentes)</dt><dd>${fleche}</dd></div>
    <div><dt>Écart moyen entre sorties</dt><dd>${ecartMoy === null ? '—' : `${nf(ecartMoy, 0)} jours`}</dd></div></dl>
    <p class="muted">Par hippodrome : ${ph || '—'}</p>
    <div class="table-wrap"><table class="table table-compact"><caption>10 dernières sorties connues (les plus récentes en premier)</caption>
    <thead><tr><th scope="col">Date</th><th scope="col">Hippodrome</th><th scope="col">Discipline</th><th scope="col">Distance</th><th scope="col">Place</th><th scope="col">Cote</th></tr></thead>
    <tbody>${dernieres.map((s) => `<tr><td>${esc(s.date)}</td><td>${esc(s.hippodrome)}</td><td>${esc(libDisc(s.discipline))}</td><td class="num-col">${s.distance ? nf(s.distance, 0) : '—'}</td>
      <td class="num-col">${s.place ? `<span class="badge ${s.place <= 3 ? 'badge-ok' : 'badge-neutre'}">${s.place}${s.place === 1 ? 'er' : 'e'}${s.nb_partants ? ` / ${s.nb_partants}` : ''}</span>` : '<span class="badge badge-neutre">non classé</span>'}</td>
      <td class="num-col">${s.cote ? nf(s.cote, 1) : '—'}</td></tr>`).join('')}</tbody></table></div>
    <p class="disclaimer">${MENTION} Les sorties affichées sont celles présentes dans les données collectées.</p>`;
}

/* ================================================================ PAGE 3 */
function statsFenetre() {
  const { data } = etat;
  const mois = etat.stats.mois;
  const courses = mois ? fenetreMois(data.courses, mois) : data.courses;
  if (!mois || courses.length === data.courses.length) return { stats: data.stats, coocc: data.coocc, nb: data.courses.length, courses };
  const acc = construireAccumulateur(courses, { scopesPaires: false });
  return { stats: finaliserStats(acc), coocc: acc.coocc, nb: courses.length, courses };
}

function renderStats() {
  const { data } = etat;
  const { stats, coocc, nb, courses } = statsFenetre();
  const sc = etat.stats;
  // sélecteur de valeur (hippodrome / discipline)
  const sv = $('#st-valeur');
  const valeurs = sc.scope === 'hippodrome' ? Object.keys(stats.par_hippodrome ?? {}).sort() : sc.scope === 'discipline' ? Object.keys(stats.par_discipline ?? {}).sort() : [];
  sv.parentElement.hidden = sc.scope === 'global';
  if (valeurs.length && !valeurs.includes(sc.valeur)) sc.valeur = valeurs[0];
  sv.replaceChildren(...valeurs.map((v) => new Option(sc.scope === 'discipline' ? libDisc(v) : v, v, false, v === sc.valeur)));
  const table = sc.scope === 'global' ? stats.global : sc.scope === 'hippodrome' ? stats.par_hippodrome?.[sc.valeur] : stats.par_discipline?.[sc.valeur];
  const numeros = Object.keys(table ?? {}).map(Number).sort((a, b) => a - b);
  const mois = sc.mois;
  $('#st-resume').innerHTML = `Fenêtre : <strong>${mois ? `${mois} derniers mois` : 'tout l\'historique'}</strong> — ${nf(nb, 0)} courses${courses.length ? ` (du ${esc(courses[0].date)} au ${esc(courses.at(-1).date)})` : ''}. ${MENTION}`;
  if (!numeros.length) {
    $('#tbl-stats tbody').innerHTML = '<tr><td colspan="9">Historique insuffisant sur cette fenêtre.</td></tr>';
    ['#g-taux', '#g-ecart', '#g-dist', '#g-heat'].forEach((s) => $(s).replaceChildren());
    return;
  }
  $('#tbl-stats tbody').innerHTML = numeros.map((n) => {
    const e = table[n];
    const diff = e.taux_top5 - e.hasard;
    return `<tr><th scope="row">${n}</th><td class="num-col">${e.sorties}</td><td class="num-col">${e.top5}</td><td class="num-col"><strong>${pct(e.taux_top5)}</strong></td>
      <td class="num-col">${pct(e.hasard)}</td><td class="num-col ${diff > 0 ? 'positif' : diff < 0 ? 'negatif' : ''}">${signe(diff * 100, (x) => nf(x, 1))} pt</td>
      <td class="num-col">${e.ecart_moyen === null ? '—' : nf(e.ecart_moyen, 1)}</td><td class="num-col">${e.ecart_actuel === null ? '—' : e.ecart_actuel}</td><td>${esc(e.derniere_sortie ?? '—')}</td></tr>`;
  }).join('');
  renderBarresNumeros($('#g-taux'), numeros.map((n) => ({ numero: n, valeur: table[n].taux_top5 * 100, ref: table[n].hasard * 100 })), { titre: 'Taux de top 5 par numéro', formatter: (v) => nf(v, 0), unite: ' %', refLabel: 'hasard' });
  renderBarresNumeros($('#g-ecart'), numeros.map((n) => ({ numero: n, valeur: table[n].ecart_moyen })), { titre: 'Écart moyen entre deux top 5 (en courses)', formatter: (v) => nf(v, 1), unite: ' courses' });
  renderDistributionGlobale($('#g-dist'), table, numeros);
  $('#leg-dist').replaceChildren(legendePositions());
  const N = Math.round(courses.reduce((s, c) => s + c.partants.length, 0) / (courses.length || 1));
  const globaux = Object.keys(stats.global).map(Number).sort((a, b) => a - b).slice(0, 20);
  renderHeatmap($('#g-heat'), coocc, globaux, { nbPartants: N });
  $('#leg-heat').replaceChildren(legendeHeatmap());
  $('#st-note').textContent = mois && courses.length === data.courses.length
    ? `Toutes les courses disponibles (${nb}) tiennent dans cette fenêtre : le résultat est identique à « tout l'historique ».` : '';
}

/* ================================================================ PAGE 4 */
function preparerBacktest() {
  $('#bt-echauff').placeholder = String(echauffementDefaut(etat.data.courses.length));
}

function lancerBacktest() {
  const f = $('#form-backtest');
  const type = $('#bt-type').value;
  const mise = Math.max(0.5, Number($('#bt-mise').value) || MISE_BASE_DEFAUT);
  const eRaw = $('#bt-echauff').value;
  const options = {
    type, mise, parcours: etat.data.parcours, inclureTocards: $('#bt-tocards').checked,
    echauffement: eRaw === '' ? undefined : Math.max(0, Math.floor(Number(eRaw))),
  };
  const t0 = performance.now();
  const r = backtest(etat.data.courses, options);
  const ms = Math.round(performance.now() - t0);
  const zone = $('#bt-resultats');
  if (!r.nbCourses) {
    zone.innerHTML = '<p class="erreur">Aucune course jouable : trop peu de courses après la période d\'échauffement, ou rapports manquants.</p>';
    return;
  }
  const roiClasse = r.roi >= 0 ? 'positif' : 'negatif';
  const libTypes = { base: 'Base solide (5)', elargie: 'Élargie (7)', valeur: 'Valeur (3+2)', poker: 'Coup de poker (5)' };
  zone.innerHTML = `<h2>Résultats — ${esc(libTypes[type])}</h2>
    <p class="disclaimer">${MENTION} Le ROI d'un échantillon aussi réduit est dominé par la variance : un seul gros rapport peut tout changer.</p>
    <div class="tuiles">
      <div class="tuile"><span>Courses jouées</span><strong>${r.nbCourses}</strong><small>${r.ignorees.echauffement} d'échauffement · ${r.ignorees.sansRapport} sans rapport</small></div>
      <div class="tuile"><span>Courses gagnantes</span><strong>${r.nbGagnants}</strong><small>dont ${r.nbQuinte} Quinté+ désordre</small></div>
      <div class="tuile"><span>Taux de réussite</span><strong>${pct(r.tauxReussite)}</strong><small>au hasard : ${pct(r.hasard.tauxReussite)}</small></div>
      <div class="tuile"><span>ROI</span><strong class="${roiClasse}">${signe(r.roi * 100, (x) => nf(x, 1))} %</strong><small>au hasard : ${signe(r.hasard.roi * 100, (x) => nf(x, 1))} %</small></div>
      <div class="tuile"><span>Mise totale</span><strong>${eur(r.miseTotale)}</strong><small>mise de base ${eur(mise)} / combinaison de 5</small></div>
      <div class="tuile"><span>Gain total</span><strong>${eur(r.gainTotal)}</strong><small>solde : <span class="${roiClasse}">${signe(r.gainTotal - r.miseTotale, eur)}</span></small></div>
      <div class="tuile"><span>Numéros trouvés / course</span><strong>${nf(r.trouvesMoyen, 2)}</strong><small>au hasard : ${nf(r.hasard.trouvesMoyen, 2)}</small></div>
      <div class="tuile"><span>ROI hors meilleur rapport</span><strong>${signe(r.roiHorsMeilleur * 100, (x) => nf(x, 1))} %</strong><small>mesure de la dépendance à un seul coup</small></div>
    </div>
    <p class="muted">Comparaison au hasard : calcul exact (loi hypergéométrique), pour un lot de même taille et de même coût, sur les mêmes courses. Gagnants attendus au hasard : ${nf(r.hasard.gagnantsAttendus, 2)} contre ${r.nbGagnants} observés. Calcul en ${ms} ms, sans regarder les courses futures.</p>`;
  zone.focus?.();
  const g = $('#bt-graph');
  g.hidden = false;
  renderEvolution($('#bt-evolution'), r.evolution);
  $('#bt-legende').replaceChildren(legendeEvolution());
  const rows = r.derniers.map((d) => {
    const solde = d.gain - d.cout;
    return `<tr><td>${esc(d.date)}</td><td>${esc(d.hippodrome)}</td><td>${d.numeros.map((n) => `<span class="num num-sm${d.arrivee.includes(n) ? ' num-ok' : ''}">${n}</span>`).join(' ')}</td>
      <td>${d.arrivee.map((n) => `<span class="num num-sm">${n}</span>`).join(' ')}</td><td class="num-col">${d.trouves}/5</td>
      <td><span class="badge ${d.gagnant ? 'badge-ok' : 'badge-perdu'}">${d.desordre ? 'Quinté+ désordre' : d.gagnant ? 'Bonus 4/5' : 'Perdu'}</span></td>
      <td class="num-col">${d.rapport ? eur(d.rapport) : '—'}</td><td class="num-col ${solde >= 0 ? 'positif' : 'negatif'}">${signe(solde, eur)}</td></tr>`;
  }).join('');
  $('#bt-derniers tbody').innerHTML = rows;
  $('#bt-bloc-derniers').hidden = false;
}
