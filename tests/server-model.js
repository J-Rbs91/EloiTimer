/* =========================================================================
 * server-model.js — Modèle EN MÉMOIRE du serveur Apps Script.
 *
 * Reproduit fidèlement la logique de décision de `writeField` et de `readAll`
 * (apps-script/Code.gs) SANS dépendre de SpreadsheetApp, afin de pouvoir tester
 * sous Node l'idempotence, la détection de conflit et la fusion multi-appareils.
 *
 * ⚠️ Toute modification de la logique de conflit/idempotence dans Code.gs doit
 *    être répercutée ici (et inversement).
 * ===================================================================== */
'use strict';

var p2 = function (n) { return String(n).padStart(2, '0'); };

function createServer() {
  var meta = {};        // cellKey -> { rev, value, device, at }
  var ops = new Set();  // identifiants d'opérations déjà traités (ledger)

  function cell(k) { return meta[k] || { rev: 0, value: '', device: '', at: '' }; }

  function writeField(op) {
    var k = op.year + '-' + p2(op.month) + '-' + p2(op.day) + '-' + op.field;
    var value = op.value == null ? '' : String(op.value);

    // 1) Idempotence par identifiant d'opération.
    if (op.id && ops.has(op.id)) {
      var c0 = cell(k);
      return { ok: true, applied: false, idempotent: true, revision: c0.rev, value: c0.value };
    }
    var c = cell(k);

    // 2) Valeur déjà en place (couvre aussi le cas « ledger purgé ») : confirme.
    if (c.value === value) {
      if (op.id) ops.add(op.id);
      return { ok: true, applied: false, idempotent: true, revision: c.rev, value: c.value };
    }

    // 3) Base périmée + valeur différente : conflit explicite.
    if ((op.baseRevision | 0) !== c.rev) {
      return {
        ok: false, conflict: true,
        serverValue: c.value, serverRevision: c.rev,
        serverDevice: c.device, serverAt: c.at,
      };
    }

    // 4) Base à jour : applique, incrémente la révision.
    var newRev = c.rev + 1;
    meta[k] = { rev: newRev, value: value, device: op.deviceId || '', at: op.createdAt || '' };
    if (op.id) ops.add(op.id);
    return { ok: true, applied: true, revision: newRev, value: value };
  }

  function read() {
    var months = {}, revs = {};
    Object.keys(meta).forEach(function (k) {
      var mm = /^(\d{4})-(\d{2})-(\d{2})-(arr|dep)$/.exec(k);
      if (!mm) return;
      revs[k] = meta[k].rev;
      var val = meta[k].value;
      if (!val) return;
      var mo = String(parseInt(mm[2], 10));
      var d = String(parseInt(mm[3], 10));
      months[mo] = months[mo] || {};
      months[mo][d] = months[mo][d] || {};
      months[mo][d][mm[4]] = val;
    });
    return { ok: true, months: months, revs: revs };
  }

  // Purge du ledger d'idempotence (simule le bornage FIFO / OPS_CAP).
  function trimLedger() { ops.clear(); }

  return { writeField: writeField, read: read, trimLedger: trimLedger, _meta: meta, _ops: ops };
}

module.exports = { createServer: createServer };
