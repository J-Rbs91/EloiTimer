/* =========================================================================
 * tests/run.js — Tests des fonctions PURES (offline-first / outbox / sync).
 *
 * Exécution :  node tests/run.js       (ou : npm test)
 *
 * Couvre : calcul des heures (arrondi + nuit), taux daté, fusion NON
 * destructive, migration de l'ancienne file, statut de synchro, et les
 * scénarios serveur (idempotence, conflit, multi-appareils) via le modèle
 * en mémoire miroir de Code.gs.
 * ===================================================================== */
'use strict';

var SC = require('../sync-core.js');
var createServer = require('./server-model.js').createServer;

var passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ ÉCHEC : ' + msg); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + '  (obtenu ' + JSON.stringify(a) + ', attendu ' + JSON.stringify(b) + ')'); }
function section(name) { console.log('\n• ' + name); }

var ctx = 0;
function nextCtx(dev) { ctx++; return { id: 'op' + ctx, deviceId: dev || 'devA', createdAt: '2026-07-16T06:0' + (ctx % 10) + ':00.000Z' }; }

/* --------------------------- Calcul des heures --------------------------- */
section('computeHours — arrondi (arrivée plancher, départ plafond) + nuit');
eq(SC.computeHours('09:01', '18:29'), 9.5, 'arr 9h01->9h00, dep 18h29->18h30 = 9,5 h');
eq(SC.computeHours('09:00', '17:00'), 8, 'journée pleine 8 h');
eq(SC.computeHours('22:00', '06:00'), 8, 'service de nuit = 8 h');
eq(SC.computeHours('09:00', ''), 0, 'saisie incomplète = 0');
eq(SC.timeToHours('25:00'), null, 'heure invalide -> null');

/* --------------------------- Taux daté --------------------------- */
section('rateForDate — taux applicable à une date');
var rates = [{ from: '2000-01-01', value: 2.66 }, { from: '2026-01-01', value: 2.90 }];
eq(SC.rateForDate(rates, '2025-12-31'), 2.66, 'avant 2026 -> 2,66');
eq(SC.rateForDate(rates, '2026-07-16'), 2.90, 'en 2026 -> 2,90');

/* ----------------- Fusion NON destructive (pull protégé) ----------------- */
section('mergeRemote — protège une opération locale en attente');
(function () {
  var local = { '2026-07-16': { arr: '08:00' } };          // saisie locale non poussée
  var remote = { '7': { '16': { dep: '17:00' } } };         // l'autre tél. a mis le départ
  var outbox = [SC.makeOp(2026, 7, 16, 'arr', '08:00', 0, nextCtx())];
  var merged = SC.mergeRemote(local, remote, outbox, 2026);
  eq(merged['2026-07-16'], { dep: '17:00', arr: '08:00' }, 'arr local conservé + dep distant fusionné');
})();

section('mergeRemote — le distant ne remplace pas la valeur protégée par une op');
(function () {
  var local = { '2026-07-16': { arr: '08:00' } };
  var remote = { '7': { '16': { arr: '09:30' } } };         // valeur distante concurrente
  var outbox = [SC.makeOp(2026, 7, 16, 'arr', '08:00', 0, nextCtx())]; // op locale en attente
  var merged = SC.mergeRemote(local, remote, outbox, 2026);
  eq(merged['2026-07-16'].arr, '08:00', 'la saisie locale en attente reste visible');
})();

section('mergeRemote — autres années intactes, effacement local pris en compte');
(function () {
  var local = { '2025-03-02': { arr: '07:00' }, '2026-07-16': { arr: '08:00' } };
  var remote = {};                                          // année 2026 vide côté serveur
  var outbox = [SC.makeOp(2026, 7, 16, 'arr', '', 0, nextCtx())]; // op = effacement en attente
  var merged = SC.mergeRemote(local, remote, outbox, 2026);
  ok(!('2026-07-16' in merged), 'effacement local en attente respecté (cellule absente)');
  eq(merged['2025-03-02'], { arr: '07:00' }, 'autre année laissée intacte');
})();

/* --------------------------- Migration --------------------------- */
section('migratePending — reconstruit des ops depuis l\'ancienne file');
(function () {
  var pendingKeys = ['2026-07-16', '2026-07-17'];
  var entries = { '2026-07-16': { arr: '08:00', dep: '17:00' }, '2026-07-17': { arr: '08:30' } };
  var c = 0;
  var ops = SC.migratePending(pendingKeys, entries, 2026, [], function () { return { id: 'm' + (++c), deviceId: 'devA', createdAt: '2026-07-16T00:00:0' + c + '.000Z' }; });
  eq(ops.length, 3, '3 champs -> 3 opérations (16:arr,16:dep,17:arr)');
  var fields = ops.map(function (o) { return o.day + o.field; }).sort();
  eq(fields, ['16arr', '16dep', '17arr'], 'champs migrés corrects');
})();

section('migratePending — idempotente (ne recrée pas une op déjà présente)');
(function () {
  var pendingKeys = ['2026-07-16'];
  var entries = { '2026-07-16': { arr: '08:00' } };
  var existing = [SC.makeOp(2026, 7, 16, 'arr', '08:00', 0, nextCtx())];
  var ops = SC.migratePending(pendingKeys, entries, 2026, existing, function () { return nextCtx(); });
  eq(ops.length, 0, 'op déjà dans l\'outbox -> aucune nouvelle op');
})();

/* --------------------------- Statut de synchro --------------------------- */
section('computeSyncStatus — jamais « Synchronisé » si outbox non vide / conflit');
(function () {
  eq(SC.computeSyncStatus({ outbox: [], isFlushing: false, online: true }).text, 'Synchronisé', 'vide+en ligne -> Synchronisé');
  var one = [SC.makeOp(2026, 7, 16, 'arr', '08:00', 0, nextCtx())];
  ok(SC.computeSyncStatus({ outbox: one, isFlushing: false, online: true }).text.indexOf('en attente') >= 0, '1 op -> « en attente »');
  ok(SC.computeSyncStatus({ outbox: one, isFlushing: false, online: false }).kind === 'off', 'hors ligne -> off');
  ok(SC.computeSyncStatus({ outbox: one, isFlushing: true, online: true }).text === 'Synchronisation…', 'flush -> Synchronisation…');
  var conf = [Object.assign(SC.makeOp(2026, 7, 16, 'arr', '08:00', 0, nextCtx()), { conflict: { serverValue: '09:00' } })];
  ok(SC.computeSyncStatus({ outbox: conf, isFlushing: false, online: true }).kind === 'conflict', 'conflit -> conflict');
  // Rejet DUR du serveur (ex. Apps Script pas à jour) : ne pas masquer par « en attente ».
  var stuck = SC.computeSyncStatus({ outbox: one, isFlushing: false, online: true, serverError: 'action inconnue : writeField' });
  ok(stuck.kind === 'off' && stuck.text.indexOf('en attente') < 0, 'rejet serveur -> statut d\'erreur, pas « en attente »');
})();

/* ===================== Scénarios SERVEUR (miroir Code.gs) ===================== */
section('Serveur — idempotence : rejouer la même op ne l\'applique pas deux fois');
(function () {
  var s = createServer();
  var op = { id: 'x1', deviceId: 'A', year: 2026, month: 7, day: 16, field: 'arr', value: '08:00', baseRevision: 0 };
  var r1 = s.writeField(op);
  eq([r1.ok, r1.applied, r1.revision], [true, true, 1], '1re application -> rev 1');
  var r2 = s.writeField(op); // réponse perdue -> rejoue
  eq([r2.ok, r2.applied, r2.idempotent, r2.revision], [true, false, true, 1], 'rejeu -> succès idempotent, rev inchangée');
})();

section('Serveur — réponse perdue + ledger purgé : rejeu reconnu par égalité de valeur');
(function () {
  var s = createServer();
  var op = { id: 'x2', deviceId: 'A', year: 2026, month: 7, day: 16, field: 'arr', value: '08:00', baseRevision: 0 };
  s.writeField(op);
  s.trimLedger();          // simulate OPS_CAP FIFO : l'id n'est plus dans le ledger
  var r = s.writeField(op);
  eq([r.ok, r.applied, r.revision], [true, false, 1], 'valeur déjà en place -> succès sans ré-application');
})();

section('Serveur — multi-appareils SANS conflit : arr (A) et dep (B) fusionnent');
(function () {
  var s = createServer();
  s.writeField({ id: 'a1', deviceId: 'A', year: 2026, month: 7, day: 16, field: 'arr', value: '08:00', baseRevision: 0 });
  s.writeField({ id: 'b1', deviceId: 'B', year: 2026, month: 7, day: 16, field: 'dep', value: '17:00', baseRevision: 0 });
  var data = s.read();
  eq(data.months['7']['16'], { arr: '08:00', dep: '17:00' }, 'arrivée et départ conservés tous les deux');
})();

section('Serveur — multi-appareils AVEC conflit sur le même champ');
(function () {
  var s = createServer();
  // A et B ont chargé la révision 0 de la cellule arr.
  var rA = s.writeField({ id: 'a2', deviceId: 'A', year: 2026, month: 7, day: 16, field: 'arr', value: '08:00', baseRevision: 0 });
  eq([rA.ok, rA.revision], [true, 1], 'A applique -> rev 1');
  var rB = s.writeField({ id: 'b2', deviceId: 'B', year: 2026, month: 7, day: 16, field: 'arr', value: '09:00', baseRevision: 0 });
  eq([rB.ok, rB.conflict, rB.serverValue, rB.serverRevision], [false, true, '08:00', 1], 'B en retard -> conflit (valeur+révision serveur exposées)');

  // Résolution « conserver ma valeur » côté B : nouvelle op basée sur rev serveur.
  var rB2 = s.writeField({ id: 'b3', deviceId: 'B', year: 2026, month: 7, day: 16, field: 'arr', value: '09:00', baseRevision: 1 });
  eq([rB2.ok, rB2.applied, rB2.revision], [true, true, 2], 'résolution -> nouvelle op appliquée en rev 2');
})();

section('Serveur+client — pull après échec de push ne remplace pas l\'op locale');
(function () {
  var s = createServer();
  // Le push a échoué (réseau) : rien côté serveur. L'op reste dans l'outbox.
  var outbox = [SC.makeOp(2026, 7, 16, 'arr', '08:00', 0, nextCtx())];
  var local = { '2026-07-16': { arr: '08:00' } };
  var data = s.read(); // distant vide
  var merged = SC.mergeRemote(local, data.months, outbox, 2026);
  eq(merged['2026-07-16'].arr, '08:00', 'valeur locale préservée malgré le pull');
  ok(outbox.length === 1, 'op toujours dans l\'outbox');
})();

/* --------------------------- Bilan --------------------------- */
console.log('\n──────────────────────────────');
console.log((failed === 0 ? '✓ TOUS LES TESTS PASSENT' : '✗ ÉCHECS') + ' : ' + passed + ' assertions OK, ' + failed + ' en échec.');
process.exit(failed === 0 ? 0 : 1);
