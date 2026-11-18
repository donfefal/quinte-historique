/**
 * main.js — Point d'entrée : charge les JSON, initialise l'interface, affiche les erreurs de chargement.
 */
import { chargerDonnees } from './dataLoader.js';
import { init } from './ui.js';

const zoneErreur = document.getElementById('erreur-chargement');
const chargement = document.getElementById('chargement');

async function demarrer() {
  try {
    const data = await chargerDonnees({
      onProgress: (fait, total, nom) => { chargement.textContent = `Chargement des données… ${fait}/${total} (${nom})`; },
    });
    chargement.hidden = true;
    document.getElementById('app').hidden = false;
    init(data);
    if (data.erreurs.length) console.info('Fichiers optionnels absents :', data.erreurs);
  } catch (e) {
    console.error(e);
    chargement.hidden = true;
    zoneErreur.hidden = false;
    zoneErreur.querySelector('[data-detail]').textContent = e.message;
  }
}

demarrer();

// Installation / mode hors ligne : enregistre le service worker (ignoré si indisponible, ex. ouverture en file://).
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.info('Service worker non enregistré :', e.message));
  });
}
