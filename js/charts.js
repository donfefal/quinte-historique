/**
 * charts.js — Graphiques en SVG natif (aucune librairie). Les couleurs viennent du CSS (classes .chart-*)
 * ou de variables CSS ; les cellules colorées calculent leur couleur de texte pour rester lisibles (WCAG AA).
 * Chaque graphique porte role="img", un <title> et un <desc> pour les lecteurs d'écran.
 */
import { liftPaire } from './scoreEngine.js';

const NS = 'http://www.w3.org/2000/svg';

/** Crée un élément SVG. attrs : objet ; enfants : nœuds ou textes. */
export function el(nom, attrs = {}, ...enfants) {
  const n = document.createElementNS(NS, nom);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, v);
  for (const e of enfants.flat()) n.append(e?.nodeType ? e : document.createTextNode(String(e)));
  return n;
}
const texte = (x, y, s, attrs = {}) => el('text', { x, y, ...attrs }, s);
const fr = (x, nd = 1) => Number(x).toLocaleString('fr-FR', { minimumFractionDigits: nd, maximumFractionDigits: nd });

function creerSvg(container, w, h, titre, desc, extraClass = '') {
  container.replaceChildren();
  const svg = el('svg', {
    viewBox: `0 0 ${w} ${h}`, class: `chart ${extraClass}`.trim(), role: 'img', 'aria-label': titre,
    preserveAspectRatio: 'xMidYMid meet',
  }, el('title', {}, titre), el('desc', {}, desc));
  container.append(svg);
  return svg;
}

/* ------------------------------------------------------------ couleurs (heatmap) */
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, t) => {
  const A = hex(a), B = hex(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
};
const lum = (c) => {
  const [r, g, b] = hex(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** Noir ou blanc : celui qui a le meilleur contraste sur ce fond. */
/** Seuil 0,179 : point où noir et blanc ont le même contraste (≈ 4,6:1, conforme WCAG AA). */
export const texteContraste = (fond) => (lum(fond) > 0.179 ? '#000000' : '#ffffff');
export const couleurLift = (v) => {
  if (v === null || v === undefined) return '#eceff3';
  if (v >= 1) return mix('#f2f4f7', '#1f6f43', Math.min(1, (v - 1) / 0.8));
  return mix('#f2f4f7', '#e0903a', Math.min(1, (1 - v) / 0.5));
};

/* ------------------------------------------------------------------ heatmap */
/**
 * renderHeatmap(container, coocc, partants) → SVG
 * partants : tableau de numéros ou d'objets {numero, nom} ; valeur d'une cellule = lift lissé d'une paire
 * (1 = autant que le hasard ; > 1 : sortent plus souvent ensemble dans le top 5).
 */
export function renderHeatmap(container, coocc, partants, { nbPartants = null } = {}) {
  const nums = partants.map((p) => (typeof p === 'object' ? p.numero : p)).sort((a, b) => a - b);
  const n = nums.length;
  const N = nbPartants ?? n;
  const cell = n > 20 ? 24 : 30, marge = 34;
  const W = marge + n * cell + 8, H = marge + n * cell + 8;
  const paires = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) paires.push([nums[i], nums[j], liftPaire(coocc, nums[i], nums[j], N)]);
  const top = [...paires].sort((a, b) => b[2] - a[2]).slice(0, 3).map((p) => `${p[0]}-${p[1]} (×${fr(p[2], 2)})`).join(', ');
  const svg = creerSvg(container, W, H, `Heatmap des co-occurrences entre ${n} numéros`,
    `Chaque case = fréquence d'arrivée ensemble dans le top 5, rapportée au hasard (1 = hasard). Paires les plus fortes : ${top || 'aucune'}.`, 'chart-heatmap');
  nums.forEach((num, i) => {
    svg.append(texte(marge + i * cell + cell / 2, marge - 8, num, { class: 'chart-axis', 'text-anchor': 'middle' }));
    svg.append(texte(marge - 8, marge + i * cell + cell / 2 + 4, num, { class: 'chart-axis', 'text-anchor': 'end' }));
  });
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = marge + j * cell, y = marge + i * cell;
      let v = null;
      if (i !== j) v = liftPaire(coocc, nums[i], nums[j], N);
      const fond = i === j ? '#d5dae1' : couleurLift(v);
      const g = el('g', {}, el('title', {}, i === j ? `n°${nums[i]}` : `n°${nums[i]} et n°${nums[j]} : ×${fr(v, 2)} vs hasard`),
        el('rect', { x, y, width: cell - 1, height: cell - 1, fill: fond, rx: 2 }));
      if (i !== j && cell >= 24) g.append(texte(x + cell / 2 - 0.5, y + cell / 2 + 3, fr(v, 1), { class: 'chart-cell', 'text-anchor': 'middle', fill: texteContraste(fond) }));
      svg.append(g);
    }
  }
  return svg;
}

/** Légende de la heatmap (HTML) — insérée par l'appelant. */
export function legendeHeatmap() {
  const d = document.createElement('div');
  d.className = 'legende';
  d.innerHTML = `<span class="legende-item"><i style="background:${couleurLift(0.5)}"></i>moins souvent que le hasard (×0,5)</span>
    <span class="legende-item"><i style="background:${couleurLift(1)}"></i>comme le hasard (×1)</span>
    <span class="legende-item"><i style="background:${couleurLift(1.8)}"></i>plus souvent que le hasard (×1,8)</span>`;
  return d;
}

/* ------------------------------------------------- distribution des positions */
/**
 * renderDistribution(container, stats, numero) → SVG
 * stats : entrée {positions:[p1..p5], sorties, hasard} d'UN numéro (ex. stats.global[numero]).
 * La ligne pointillée = nombre attendu au hasard pour chaque place.
 */
export function renderDistribution(container, entree, numero) {
  const W = 360, H = 220, m = { g: 36, d: 12, h: 24, b: 34 };
  if (!entree || !entree.sorties) {
    container.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Historique insuffisant pour ce numéro.' }));
    return null;
  }
  const pos = entree.positions;
  const attendu = (entree.hasard * entree.sorties) / 5;
  const max = Math.max(...pos, attendu, 1) * 1.15;
  const bw = (W - m.g - m.d) / 5;
  const y = (v) => H - m.b - (v / max) * (H - m.b - m.h);
  const svg = creerSvg(container, W, H, `Distribution des positions du numéro ${numero}`,
    `Sur ${entree.sorties} départs : 1er ${pos[0]} fois, 2e ${pos[1]}, 3e ${pos[2]}, 4e ${pos[3]}, 5e ${pos[4]}. Attendu au hasard : ${fr(attendu, 1)} par place.`, 'chart-dist');
  for (let t = 0; t <= 4; t++) {
    const v = (max / 4) * t;
    svg.append(el('line', { x1: m.g, x2: W - m.d, y1: y(v), y2: y(v), class: 'chart-grid' }), texte(m.g - 6, y(v) + 4, fr(v, v < 10 ? 1 : 0), { class: 'chart-axis', 'text-anchor': 'end' }));
  }
  pos.forEach((v, i) => {
    const x = m.g + i * bw + bw * 0.15;
    svg.append(el('rect', { x, y: y(v), width: bw * 0.7, height: Math.max(0, H - m.b - y(v)), class: 'chart-bar', rx: 2 }, el('title', {}, `${i + 1}${i ? 'e' : 'er'} : ${v} fois`)),
      texte(x + bw * 0.35, y(v) - 4, v, { class: 'chart-valeur', 'text-anchor': 'middle' }),
      texte(x + bw * 0.35, H - m.b + 16, `${i + 1}${i ? 'e' : 'er'}`, { class: 'chart-axis', 'text-anchor': 'middle' }));
  });
  svg.append(el('line', { x1: m.g, x2: W - m.d, y1: y(attendu), y2: y(attendu), class: 'chart-hasard' }),
    texte(W - m.d, y(attendu) - 4, `hasard : ${fr(attendu, 1)}`, { class: 'chart-note', 'text-anchor': 'end' }));
  return svg;
}

/* ---------------------------------------------------- barres par numéro (page 3) */
/**
 * renderBarresNumeros(container, lignes, opts) → SVG. lignes : [{numero, valeur, ref?}] ; ref = repère « hasard ».
 */
export function renderBarresNumeros(container, lignes, { titre, formatter = (v) => fr(v, 1), unite = '', refLabel = 'hasard' } = {}) {
  const n = lignes.length;
  const W = Math.max(420, 30 + n * 30), H = 240, m = { g: 44, d: 10, h: 18, b: 34 };
  if (!n) { container.replaceChildren(); return null; }
  const max = Math.max(...lignes.map((l) => Math.max(l.valeur ?? 0, l.ref ?? 0)), 0.0001) * 1.15;
  const bw = (W - m.g - m.d) / n;
  const y = (v) => H - m.b - (v / max) * (H - m.b - m.h);
  const svg = creerSvg(container, W, H, titre, `${n} numéros. ${lignes.slice(0, 5).map((l) => `n°${l.numero} : ${formatter(l.valeur ?? 0)}${unite}`).join(' ; ')}…`, 'chart-barres');
  for (let t = 0; t <= 4; t++) {
    const v = (max / 4) * t;
    svg.append(el('line', { x1: m.g, x2: W - m.d, y1: y(v), y2: y(v), class: 'chart-grid' }), texte(m.g - 6, y(v) + 4, formatter(v), { class: 'chart-axis', 'text-anchor': 'end' }));
  }
  lignes.forEach((l, i) => {
    const x = m.g + i * bw + bw * 0.15;
    if (l.valeur !== null && l.valeur !== undefined) {
      svg.append(el('rect', { x, y: y(l.valeur), width: bw * 0.7, height: Math.max(0, H - m.b - y(l.valeur)), class: 'chart-bar', rx: 2 },
        el('title', {}, `n°${l.numero} : ${formatter(l.valeur)}${unite}${l.ref !== undefined ? ` (${refLabel} : ${formatter(l.ref)}${unite})` : ''}`)));
    }
    if (l.ref !== undefined && l.ref !== null) svg.append(el('line', { x1: x - 2, x2: x + bw * 0.7 + 2, y1: y(l.ref), y2: y(l.ref), class: 'chart-repere' }));
    svg.append(texte(x + bw * 0.35, H - m.b + 15, l.numero, { class: 'chart-axis', 'text-anchor': 'middle' }));
  });
  svg.append(texte(m.g, H - 4, `Numéro de partant — trait noir = ${refLabel}`, { class: 'chart-note' }));
  return svg;
}

/** Distribution des positions de tous les numéros (barres empilées 1er…5e). */
export function renderDistributionGlobale(container, statsGlobal, numeros) {
  const n = numeros.length;
  const W = Math.max(420, 30 + n * 30), H = 240, m = { g: 44, d: 10, h: 18, b: 34 };
  const max = Math.max(...numeros.map((k) => statsGlobal[k].positions.reduce((a, b) => a + b, 0)), 1) * 1.1;
  const bw = (W - m.g - m.d) / n;
  const y = (v) => H - m.b - (v / max) * (H - m.b - m.h);
  const svg = creerSvg(container, W, H, 'Distribution des positions par numéro', `Barres empilées : nombre de 1ers, 2es, 3es, 4es et 5es pour chacun des ${n} numéros.`, 'chart-barres');
  for (let t = 0; t <= 4; t++) {
    const v = (max / 4) * t;
    svg.append(el('line', { x1: m.g, x2: W - m.d, y1: y(v), y2: y(v), class: 'chart-grid' }), texte(m.g - 6, y(v) + 4, fr(v, 0), { class: 'chart-axis', 'text-anchor': 'end' }));
  }
  numeros.forEach((k, i) => {
    let cumul = 0;
    const x = m.g + i * bw + bw * 0.15;
    statsGlobal[k].positions.forEach((v, p) => {
      if (v) svg.append(el('rect', { x, y: y(cumul + v), width: bw * 0.7, height: y(cumul) - y(cumul + v), class: `chart-pos chart-pos-${p + 1}` }, el('title', {}, `n°${k} : ${v} fois ${p + 1}${p ? 'e' : 'er'}`)));
      cumul += v;
    });
    svg.append(texte(x + bw * 0.35, H - m.b + 15, k, { class: 'chart-axis', 'text-anchor': 'middle' }));
  });
  return svg;
}
export function legendePositions() {
  const d = document.createElement('div');
  d.className = 'legende';
  d.innerHTML = [1, 2, 3, 4, 5].map((p) => `<span class="legende-item"><i class="chart-pos-${p}"></i>${p}${p === 1 ? 'er' : 'e'}</span>`).join('');
  return d;
}

/* ---------------------------------------------------------------- évolution */
/**
 * renderEvolution(container, evolution) → SVG
 * evolution : [{index, date, solde, soldeHasard}] — solde cumulé (gains − mises) de la stratégie (trait plein)
 * et espérance exacte d'un lot tiré au hasard, même coût (pointillés).
 */
export function renderEvolution(container, evolution) {
  const W = 720, H = 300, m = { g: 62, d: 14, h: 16, b: 38 };
  if (!evolution.length) { container.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Aucune course jouée.' })); return null; }
  const vals = evolution.flatMap((e) => [e.solde, e.soldeHasard]).concat(0);
  let mn = Math.min(...vals), mx = Math.max(...vals);
  if (mx === mn) { mx += 1; mn -= 1; }
  const pad = (mx - mn) * 0.08;
  mn -= pad; mx += pad;
  const n = evolution.length;
  const x = (i) => m.g + (n === 1 ? 0.5 : i / (n - 1)) * (W - m.g - m.d);
  const y = (v) => m.h + (1 - (v - mn) / (mx - mn)) * (H - m.h - m.b);
  const fin = evolution[n - 1];
  const svg = creerSvg(container, W, H, 'Évolution du solde cumulé', `Après ${n} courses : solde ${fr(fin.solde, 0)} €, contre ${fr(fin.soldeHasard, 0)} € d'espérance pour un tirage au hasard au même coût.`, 'chart-evo');
  for (let t = 0; t <= 4; t++) {
    const v = mn + ((mx - mn) / 4) * t;
    svg.append(el('line', { x1: m.g, x2: W - m.d, y1: y(v), y2: y(v), class: 'chart-grid' }), texte(m.g - 8, y(v) + 4, `${fr(v, 0)} €`, { class: 'chart-axis', 'text-anchor': 'end' }));
  }
  svg.append(el('line', { x1: m.g, x2: W - m.d, y1: y(0), y2: y(0), class: 'chart-zero' }));
  const chemin = (cle) => evolution.map((e, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(e[cle]).toFixed(1)}`).join(' ');
  svg.append(el('path', { d: chemin('soldeHasard'), class: 'chart-ligne-hasard', fill: 'none' }));
  svg.append(el('path', { d: chemin('solde'), class: `chart-ligne ${fin.solde >= 0 ? 'positif' : 'negatif'}`, fill: 'none' }));
  evolution.forEach((e, i) => {
    svg.append(el('circle', { cx: x(i), cy: y(e.solde), r: n > 60 ? 0 : 3, class: `chart-point ${e.solde >= 0 ? 'positif' : 'negatif'}` }, el('title', {}, `${e.date} — solde ${fr(e.solde, 2)} € (course ${e.index})`)));
  });
  svg.append(texte(m.g, H - 12, evolution[0].date, { class: 'chart-axis' }), texte(W - m.d, H - 12, fin.date, { class: 'chart-axis', 'text-anchor': 'end' }),
    texte((m.g + W - m.d) / 2, H - 12, `${n} courses jouées`, { class: 'chart-axis', 'text-anchor': 'middle' }));
  return svg;
}
export function legendeEvolution() {
  const d = document.createElement('div');
  d.className = 'legende';
  d.innerHTML = '<span class="legende-item"><i class="trait trait-plein"></i>Stratégie (solde cumulé)</span><span class="legende-item"><i class="trait trait-pointille"></i>Au hasard (espérance exacte, même coût)</span>';
  return d;
}
