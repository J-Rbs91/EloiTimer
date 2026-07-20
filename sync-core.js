/* =========================================================================
 * sync-core.js — Fonctions PURES partagées (aucune dépendance au DOM).
 *
 * Chargé à la fois :
 *   - dans le navigateur  -> expose `window.EloiSync`
 *   - sous Node (tests)   -> `module.exports`
 *
 * On y regroupe tout ce qui est testable sans navigateur :
 *   - conversion / arrondi des horaires et calcul des heures ;
 *   - sélection du taux horaire daté ;
 *   - fusion NON destructive des données distantes avec l'état local ;
 *   - migration de l'ancienne file `eloitimer.pending` vers l'outbox ;
 *   - calcul du statut de synchronisation ;
 *   - petites fabriques d'opérations d'outbox.
 *
 * Le serveur (apps-script/Code.gs) reproduit volontairement `computeHours`,
 * `roundedTimes` et `rateForDate` en Apps Script : garder les deux en phase.
 * ===================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // Node / tests
  root.EloiSync = api;                                                    // navigateur
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_RATE = 2.66;
  var EPOCH = '2000-01-01';

  var pad2 = function (n) { return String(n).padStart(2, '0'); };

  // ---- Horaires & heures -------------------------------------------------
  /** "HH:MM" -> heures décimales, ou null si invalide. */
  function timeToHours(value) {
    if (!value) return null;
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
    if (!m) return null;
    var h = Number(m[1]);
    var min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h + min / 60;
  }

  /**
   * Arrondi à la demi-heure, en faveur d'Eloi :
   *  - arrivée au PLANCHER  (9h01 / 9h29  -> 9h00)
   *  - départ  au PLAFOND   (18h01 / 18h29 -> 18h30)
   * Renvoie { arr, dep } en heures décimales, ou null si saisie incomplète.
   */
  function roundedTimes(arr, dep) {
    var a = timeToHours(arr);
    var d = timeToHours(dep);
    if (a === null || d === null) return null;
    return { arr: Math.floor(a * 2) / 2, dep: Math.ceil(d * 2) / 2 };
  }

  /** Heures travaillées (après arrondi), gère le passage de minuit. */
  function computeHours(arr, dep) {
    var r = roundedTimes(arr, dep);
    if (!r) return 0;
    var diff = r.dep - r.arr;
    if (diff < 0) diff += 24; // service de nuit
    return diff;
  }

  /** Heures décimales -> "HH:MM" (info-bulle). */
  function hoursToTime(h) {
    var hh = Math.floor(h) % 24;
    var mm = Math.round((h - Math.floor(h)) * 60);
    return pad2(hh) + ':' + pad2(mm);
  }

  // ---- Taux horaire daté -------------------------------------------------
  function sortRates(list) {
    return list.slice().sort(function (a, b) {
      return a.from < b.from ? -1 : a.from > b.from ? 1 : 0;
    });
  }

  /** Construit une liste de taux valide (gère l'ancien format `rate` unique). */
  function normalizeRates(rates, legacyRate) {
    var list = Array.isArray(rates)
      ? rates.filter(function (r) {
          return r && typeof r.value === 'number' && r.value >= 0 && typeof r.from === 'string';
        }).map(function (r) { return { from: r.from, value: r.value }; })
      : [];
    if (!list.length) {
      var value = typeof legacyRate === 'number' && legacyRate >= 0 ? legacyRate : DEFAULT_RATE;
      list = [{ from: EPOCH, value: value }];
    }
    return sortRates(list);
  }

  /** Taux applicable à une date "YYYY-MM-DD". */
  function rateForDate(rates, dateStr) {
    var sorted = sortRates(rates || []);
    if (!sorted.length) return 0;
    var value = sorted[0].value;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].from <= dateStr) value = sorted[i].value;
      else break;
    }
    return value;
  }

  // ---- Clés --------------------------------------------------------------
  var dayKey = function (year, month, day) {
    // month : 0-11
    return year + '-' + pad2(month + 1) + '-' + pad2(day);
  };
  /** Clé de cellule "YYYY-MM-DD-field" (month : 1-12). */
  var cellKey = function (year, month1, day, field) {
    return year + '-' + pad2(month1) + '-' + pad2(day) + '-' + field;
  };

  // ---- Outbox : opérations unitaires par champ ---------------------------
  /**
   * Fabrique une opération d'outbox.
   * @param {number} year, month1 (1-12), day
   * @param {'arr'|'dep'} field
   * @param {string} value  valeur exacte ("" = effacement)
   * @param {number} baseRevision  révision connue de la cellule (0 si inconnue)
   * @param {{id:string, deviceId:string, createdAt:string}} ctx
   */
  function makeOp(year, month1, day, field, value, baseRevision, ctx) {
    return {
      id: ctx.id,
      deviceId: ctx.deviceId,
      year: year,
      month: month1,
      day: day,
      field: field,
      value: value == null ? '' : String(value),
      baseRevision: baseRevision | 0,
      createdAt: ctx.createdAt,
    };
  }

  /** Ordre déterministe de traitement de l'outbox (createdAt puis id). */
  function sortOutbox(ops) {
    return ops.slice().sort(function (a, b) {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /** Opérations concernant une année donnée. */
  function opsForYear(ops, year) {
    return ops.filter(function (o) { return o.year === year; });
  }

  // ---- Fusion NON destructive des données distantes ----------------------
  /**
   * Fusionne les données distantes avec le snapshot local en PROTÉGEANT toute
   * cellule couverte par une opération en attente (outbox) pour cette année.
   *
   * Entrées :
   *   localEntries : { "YYYY-MM-DD": {arr?,dep?} }  (toutes années confondues)
   *   remoteMonths : { "M": { "D": {arr?,dep?} } }  (M = 1-12) pour `year`
   *   outbox       : [op...]  (toutes années confondues)
   *   year         : année représentée par la feuille
   *
   * Sortie : nouvel objet `entries` complet (les autres années intactes).
   */
  function mergeRemote(localEntries, remoteMonths, outbox, year) {
    var out = {};
    var prefix = year + '-';
    // 1) Conserver les autres années telles quelles.
    Object.keys(localEntries || {}).forEach(function (k) {
      if (k.indexOf(prefix) !== 0) out[k] = cloneEntry(localEntries[k]);
    });

    // 2) Repartir des données distantes pour l'année synchronisée.
    var months = remoteMonths || {};
    Object.keys(months).forEach(function (mStr) {
      var month0 = parseInt(mStr, 10) - 1;
      var days = months[mStr] || {};
      Object.keys(days).forEach(function (dStr) {
        var day = parseInt(dStr, 10);
        var cell = days[dStr] || {};
        var entry = {};
        if (cell.arr) entry.arr = cell.arr;
        if (cell.dep) entry.dep = cell.dep;
        if (entry.arr || entry.dep) out[dayKey(year, month0, day)] = entry;
      });
    });

    // 3) Réappliquer par-dessus les opérations locales en attente : la saisie
    //    locale non confirmée reste visible et n'est jamais écrasée par le pull.
    opsForYear(outbox || [], year).forEach(function (op) {
      var k = dayKey(year, op.month - 1, op.day);
      var entry = out[k] ? cloneEntry(out[k]) : {};
      if (op.value) entry[op.field] = op.value;
      else delete entry[op.field];
      if (entry.arr || entry.dep) out[k] = entry;
      else delete out[k];
    });

    return out;
  }

  function cloneEntry(e) {
    var o = {};
    if (e && e.arr) o.arr = e.arr;
    if (e && e.dep) o.dep = e.dep;
    return o;
  }

  // ---- Migration de l'ancienne file `eloitimer.pending` ------------------
  /**
   * Reconstruit des opérations d'outbox à partir de l'ancienne file de clés de
   * jour et de l'état local. Idempotente : ne recrée pas une op déjà présente
   * (même année/mois/jour/champ) dans l'outbox existante.
   *
   * @param {string[]} pendingKeys  ex. ["2026-07-16", ...]
   * @param {Object} entries        état local { "YYYY-MM-DD": {arr,dep} }
   * @param {number} syncedYear     année concernée par la synchro
   * @param {Object[]} existingOutbox
   * @param {function(number):{id,deviceId,createdAt}} ctxFor  fabrique de contexte (index -> ctx)
   * @returns {Object[]} nouvelles opérations à ajouter
   */
  function migratePending(pendingKeys, entries, syncedYear, existingOutbox, ctxFor) {
    var newOps = [];
    var seen = {};
    (existingOutbox || []).forEach(function (o) {
      seen[o.year + '-' + o.month + '-' + o.day + '-' + o.field] = true;
    });
    var counter = 0;
    (pendingKeys || []).forEach(function (key) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
      if (!m) return;
      var year = parseInt(m[1], 10);
      var month1 = parseInt(m[2], 10);
      var day = parseInt(m[3], 10);
      if (syncedYear && year !== syncedYear) return; // hors année synchro : ignoré
      var entry = entries[key] || {};
      ['arr', 'dep'].forEach(function (field) {
        var value = entry[field];
        if (!value) return; // rien à envoyer pour ce champ
        var dedupe = year + '-' + month1 + '-' + day + '-' + field;
        if (seen[dedupe]) return;
        seen[dedupe] = true;
        newOps.push(makeOp(year, month1, day, field, value, 0, ctxFor(counter++)));
      });
    });
    return newOps;
  }

  // ---- Statut de synchronisation -----------------------------------------
  /**
   * Calcule un statut fiable et lisible.
   * Ne renvoie JAMAIS "Synchronisé" tant que l'outbox n'est pas vide ou qu'un
   * conflit subsiste.
   */
  function computeSyncStatus(opts) {
    var outbox = opts.outbox || [];
    var pendingCount = outbox.filter(function (o) { return !o.conflict; }).length;
    var conflicts = outbox.filter(function (o) { return o.conflict; }).length;

    if (conflicts > 0) {
      return { kind: 'conflict', text: conflicts === 1 ? 'Conflit à vérifier' : conflicts + ' conflits à vérifier' };
    }
    if (opts.isFlushing) return { kind: 'sync', text: 'Synchronisation…' };
    if (pendingCount > 0) {
      if (opts.online === false) {
        return { kind: 'off', text: 'Hors ligne · ' + modLabel(pendingCount) + ' en attente' };
      }
      if (opts.justSaved) return { kind: 'sync', text: 'Enregistré sur ce téléphone' };
      // Le serveur REJETTE l'écriture (ex. script Apps Script pas à jour) : la
      // file ne se videra jamais toute seule. On le dit clairement au lieu de
      // laisser un « en attente » trompeur tourner en boucle.
      if (opts.serverError) {
        return { kind: 'off', text: 'Synchro bloquée · script à mettre à jour ?' };
      }
      return { kind: 'sync', text: modLabel(pendingCount) + ' en attente' };
    }
    if (opts.online === false) return { kind: 'off', text: 'Hors ligne' };
    if (opts.error) return { kind: 'off', text: 'Erreur de synchronisation' };
    return { kind: 'ok', text: 'Synchronisé' };
  }

  function modLabel(n) {
    return n <= 1 ? '1 modification' : n + ' modifications';
  }

  return {
    DEFAULT_RATE: DEFAULT_RATE,
    EPOCH: EPOCH,
    pad2: pad2,
    timeToHours: timeToHours,
    roundedTimes: roundedTimes,
    computeHours: computeHours,
    hoursToTime: hoursToTime,
    sortRates: sortRates,
    normalizeRates: normalizeRates,
    rateForDate: rateForDate,
    dayKey: dayKey,
    cellKey: cellKey,
    makeOp: makeOp,
    sortOutbox: sortOutbox,
    opsForYear: opsForYear,
    mergeRemote: mergeRemote,
    migratePending: migratePending,
    computeSyncStatus: computeSyncStatus,
  };
});
