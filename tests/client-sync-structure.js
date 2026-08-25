'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
let passed = 0;
function ok(condition, message) {
  if (!condition) { console.error('  ✗ ÉCHEC : ' + message); process.exitCode = 1; return; }
  passed++;
}
function functionBody(name, nextMarker) {
  const start = app.indexOf(`function ${name}(`);
  const end = nextMarker ? app.indexOf(nextMarker, start) : -1;
  ok(start >= 0, `${name} existe`);
  return app.slice(start, end > start ? end : undefined);
}
console.log('\n• Client sync — orchestration sérialisée');
const cycle = functionBody('syncNow', '\n  function applyRemote');
const push = cycle.indexOf('await flushOutbox()');
const pull = cycle.indexOf('await cloudPull()');
ok(push >= 0, 'syncNow attend le push de l’outbox');
ok(pull > push, 'le pull ne démarre qu’après la fin du push');
ok(!/flushOutbox\(\);\s*cloudPull\(\)/.test(app), 'aucun démarrage push/pull parallèle ne subsiste');
console.log('\n• Client sync — erreurs et déclencheurs');
const cloud = functionBody('cloudPull', '\n\n  /**\n   * Cycle unique');
ok(/catch \(e\)[\s\S]*?lastError = true;/.test(cloud), 'un échec de lecture distante marque explicitement une erreur');
ok(app.includes('isFlushing: isFlushing || isSyncing'), 'le statut reste Synchronisation pendant tout le cycle');
ok(app.includes("window.addEventListener('focus'") && app.includes('scheduleSync(0)'), 'le retour au focus déclenche un cycle complet');
ok(app.includes("document.visibilityState !== 'visible'") && app.includes('isEditingTime()'), 'aucun pull ne reconstruit le tableau pendant le sélecteur horaire');
console.log('\n• Client sync — compatibilité et reset');
ok(app.includes("action: 'writeField', field: '__protocol_probe__'"), 'la configuration vérifie réellement le protocole writeField v2');
ok(app.includes("probe.error !== 'champ invalide'"), 'un ancien Apps Script est rejeté');
ok(app.includes("clears.forEach((c) => enqueueOp(currentYear, c.month0, c.day, c.field, ''))"), 'Réinitialiser propage les effacements à la feuille partagée');
console.log('\n• PWA — invalidation du cache');
ok(sw.includes("const CACHE = 'eloitimer-v29';"), 'le cache PWA est incrémenté');
if (!process.exitCode) console.log(`\n✓ STRUCTURE CLIENT SYNC : ${passed} assertions OK.`);
