/* =========================================================================
 * Planning Eloi — pont entre la PWA et la feuille Google (sans backend/VPS)
 *
 * À COLLER dans : ta feuille Google → menu Extensions → Apps Script.
 * Puis : Déployer → Nouveau déploiement → type « Application Web »
 *        - Exécuter en tant que : Moi
 *        - Qui a accès : Tout le monde
 * Copie l'URL « /exec » obtenue et colle-la dans la PWA (bouton ☁ Synchronisation).
 *
 * Cette URL est le LIEN SECRET : quiconque la possède peut lire et écrire.
 *
 * Modèle de données : une ligne par jour dans chaque onglet mensuel.
 *   A = Date | B = Jour | C = Arrivée | D = Départ | E = Heures | F = Montant
 *   B1 = taux horaire en vigueur (lisible). Le jour J est en ligne (3 + J).
 *
 * Le taux varie dans le temps : l'historique est conservé dans l'onglet « Taux »
 * (A = date de début "AAAA-MM-JJ", B = taux €/h). Chaque jour est payé au taux
 * en vigueur à sa date ; B1 reflète le taux du jour courant.
 *
 * ---------------------------------------------------------------------------
 * SYNCHRONISATION ROBUSTE (v2) — écritures par CHAMP, idempotence, révisions :
 *
 * Deux onglets techniques MASQUÉS sont créés automatiquement :
 *   « _SyncMeta » : une ligne par cellule synchronisée
 *        A = cellKey ("AAAA-MM-JJ-arr" | "…-dep")
 *        B = révision (entier, +1 à chaque changement de valeur)
 *        C = valeur   ("HH:MM" ou vide)
 *        D = dernier id d'opération   E = id d'appareil   F = date serveur ISO
 *   « _SyncOps » : journal d'idempotence des identifiants d'opérations déjà
 *        appliqués (A = opId, B = horodatage). Taille bornée (voir OPS_CAP).
 *
 * L'action « writeField » applique UN seul champ (arr OU dep), recalcule côté
 * serveur Heures/Montant/Date/Jour, et gère :
 *   - l'idempotence  : une op déjà appliquée renvoie un succès sans re-appliquer ;
 *   - le conflit     : si la révision de base du client est périmée ET que la
 *                      valeur voulue diffère de la valeur serveur, on renvoie un
 *                      conflit explicite (aucun écrasement silencieux).
 * ===================================================================== */

var MONTHS = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];
var WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
var FIRST_DATA_ROW = 4;        // le jour 1 est en ligne 4
var COL_DATE = 1, COL_JOUR = 2, COL_ARR = 3, COL_DEP = 4, COL_HEURES = 5, COL_MONTANT = 6;
var RATE_CELL = 'B1';
var RATES_SHEET = 'Taux';      // onglet d'historique des taux
var META_SHEET = '_SyncMeta';  // révisions/valeurs par cellule (masqué)
var OPS_SHEET = '_SyncOps';    // journal d'idempotence (masqué)
var OPS_CAP = 2000;            // nombre max d'identifiants d'op conservés
var LOCK_MS = 10000;           // durée max d'attente/tenue du verrou

/**
 * Clé de comparaison tolérante pour les noms d'onglets mensuels.
 * La feuille historique utilise notamment « Fevrier » et « Aout », alors que
 * les libellés canoniques de l'application sont « Février » et « Août ».
 * Une différence d'accent/casse ne doit jamais couper toute la synchronisation.
 */
function monthNameKey_(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/[àáâäãå]/g, 'a')
    .replace(/[éèêë]/g, 'e')
    .replace(/[îïíì]/g, 'i')
    .replace(/[ôöóòõ]/g, 'o')
    .replace(/[ùûüú]/g, 'u')
    .replace(/ç/g, 'c')
    .replace(/\s+/g, ' ');
}

/**
 * Résout un onglet mensuel en privilégiant le nom canonique, puis en repliant
 * sur une comparaison sans accent et insensible à la casse.
 */
function getMonthSheet_(ss, m) {
  if (!ss || isNaN(m) || m < 0 || m > 11) return null;
  var canonical = MONTHS[m];
  var direct = ss.getSheetByName(canonical);
  if (direct) return direct;

  var wanted = monthNameKey_(canonical);
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (monthNameKey_(sheets[i].getName()) === wanted) return sheets[i];
  }
  return null;
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    if (p.action === 'read') out = readAll();
    else if (p.action === 'writeField') out = writeField(p);
    else if (p.action === 'write') out = writeOne(p);       // compat. ancien client
    else if (p.action === 'setrates') out = setRates(p);
    else if (p.action === 'setrate') out = setRate(p);
    else if (p.action === 'ping') out = { ok: true, pong: true };
    else out = { ok: false, error: 'action inconnue : ' + p.action };
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return reply(out, p.callback);
}

/** Réponse JSON, ou JSONP si un callback VALIDE est fourni (contourne le CORS). */
function reply(obj, callback) {
  var json = JSON.stringify(obj);
  // Validation stricte du nom de callback : identifiant JS simple uniquement.
  if (callback && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================ LECTURE ============================ */

/** Lit le taux, les arrivées/départs saisis, et les révisions par cellule. */
function readAll() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var rate = null;
  var months = {};
  for (var m = 0; m < 12; m++) {
    var sh = getMonthSheet_(ss, m);
    if (!sh) continue;
    if (rate === null) {
      var rv = sh.getRange(RATE_CELL).getValue();
      if (typeof rv === 'number' && rv > 0) rate = rv;
    }
    // getDisplayValues() : on lit le TEXTE affiché ("09:00"), pas un objet Date.
    // Évite toute réinterprétation de fuseau horaire (bug du décalage des heures).
    var values = sh.getRange(FIRST_DATA_ROW, COL_ARR, 31, 2).getDisplayValues(); // C..D
    var days = {};
    for (var i = 0; i < 31; i++) {
      var arr = fmtTime(values[i][0]);
      var dep = fmtTime(values[i][1]);
      if (arr || dep) days[i + 1] = { arr: arr, dep: dep };
    }
    months[m + 1] = days;
  }
  return { ok: true, rate: rate, rates: readRates(ss), months: months, revs: readRevs(ss) };
}

/** Lit l'historique des taux depuis l'onglet « Taux » ([] si vide, null si absent). */
function readRates(ss) {
  var sh = ss.getSheetByName(RATES_SHEET);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, 2).getDisplayValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var f = String(vals[i][0]).trim();
    var v = parseFloat(String(vals[i][1]).replace(',', '.'));
    var iso = f.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!iso) {
      var fr = f.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); // repli si reformaté JJ/MM/AAAA
      if (fr) f = fr[3] + '-' + fr[2] + '-' + fr[1];
      else continue;
    }
    if (!isNaN(v) && v >= 0) out.push({ from: f, value: v });
  }
  return out;
}

/** Carte des révisions connues { cellKey: révision } depuis « _SyncMeta ». */
function readRevs(ss) {
  var sh = ss.getSheetByName(META_SHEET);
  var revs = {};
  if (!sh) return revs;
  var last = sh.getLastRow();
  if (last < 2) return revs;
  var vals = sh.getRange(2, 1, last - 1, 2).getValues(); // A=key, B=rev
  for (var i = 0; i < vals.length; i++) {
    var k = String(vals[i][0]);
    if (k) revs[k] = Number(vals[i][1]) || 0;
  }
  return revs;
}

/* ==================== ÉCRITURE PAR CHAMP (v2) ==================== */

/**
 * Applique une opération unitaire (un champ). Idempotent + détection de conflit.
 * Paramètres : id, deviceId, year, month(1-12), day, field(arr|dep), value,
 *              baseRevision.
 */
function writeField(p) {
  var id = String(p.id || '');
  var field = String(p.field || '');
  if (field !== 'arr' && field !== 'dep') return { ok: false, error: 'champ invalide' };
  var m = parseInt(p.month, 10) - 1;
  var day = parseInt(p.day, 10);
  var year = parseInt(p.year, 10);
  if (isNaN(m) || m < 0 || m > 11 || isNaN(day) || day < 1 || day > 31 || isNaN(year)) {
    return { ok: false, error: 'paramètres invalides' };
  }
  var value = (p.value == null) ? '' : String(p.value);
  if (value && !/^\d{1,2}:\d{2}$/.test(value)) return { ok: false, error: 'valeur invalide' };
  var baseRev = parseInt(p.baseRevision, 10) || 0;
  var deviceId = String(p.deviceId || '');
  var cellK = year + '-' + pad(m + 1) + '-' + pad(day) + '-' + field;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) {
    // Verrou NON acquis : on n'écrit rien et on renvoie une erreur exploitable.
    return { ok: false, error: 'verrou indisponible, réessayer', busy: true };
  }
  try {
    var opsSh = getOpsSheet_(ss);
    // Idempotence : opération déjà appliquée -> succès sans re-appliquer.
    if (id && opProcessed_(opsSh, id)) {
      var cur0 = metaFor_(ss, cellK);
      return { ok: true, applied: false, idempotent: true, revision: cur0.rev, value: cur0.value };
    }

    var meta = getMetaSheet_(ss);
    var cur = metaRow_(meta, cellK);              // { row, rev, value } (row=0 si absent)
    var curRev = cur.rev;
    // Valeur serveur de référence : celle de _SyncMeta, sinon lecture de la feuille.
    var curVal = cur.row ? cur.value : readCellValue_(ss, m, day, field);

    // La valeur voulue est déjà en place : on confirme sans rien changer.
    if (curVal === value) {
      if (id) recordOp_(opsSh, id);
      return { ok: true, applied: false, idempotent: true, revision: curRev, value: curVal };
    }

    // Base périmée ET valeur différente : conflit explicite, aucun écrasement.
    if (baseRev !== curRev) {
      return {
        ok: false, conflict: true,
        serverValue: curVal, serverRevision: curRev,
        serverDevice: cur.row ? cur.device : '', serverAt: cur.row ? cur.at : '',
      };
    }

    // Base à jour : on applique et on incrémente la révision.
    var newRev = curRev + 1;
    applyCellWrite_(ss, year, m, day, field, value);
    var nowIso = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
    upsertMeta_(meta, cur.row, cellK, newRev, value, id, deviceId, nowIso);
    if (id) recordOp_(opsSh, id);
    return { ok: true, applied: true, revision: newRev, value: value };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Écrit UN champ dans la feuille du mois et recalcule la ligne (Date, Jour,
 * Heures, Montant) en une seule écriture groupée A..F. Préserve l'autre champ.
 */
function applyCellWrite_(ss, year, m, day, field, value) {
  var sh = getMonthSheet_(ss, m);
  if (!sh) throw new Error('onglet introuvable : ' + MONTHS[m]);
  var row = FIRST_DATA_ROW + (day - 1);
  var curCD = sh.getRange(row, COL_ARR, 1, 2).getDisplayValues()[0]; // [arr, dep]
  var arr = fmtTime(curCD[0]);
  var dep = fmtTime(curCD[1]);
  if (field === 'arr') arr = value; else dep = value;

  var hours = computeHours_(arr, dep);
  var rate = rateForDate_(ss, year, m, day);
  var amount = hours ? round2_(hours * rate) : '';
  var dateObj = new Date(year, m, day);
  var jour = WEEKDAYS[dateObj.getDay()];

  // Une seule écriture groupée : Date | Jour | Arrivée | Départ | Heures | Montant
  sh.getRange(row, COL_DATE, 1, 6).setValues([[
    dateObj, jour, arr, dep, hours ? round2_(hours) : '', amount,
  ]]);
}

/** Lit la valeur "HH:MM" d'un champ directement dans la feuille du mois. */
function readCellValue_(ss, m, day, field) {
  var sh = getMonthSheet_(ss, m);
  if (!sh) return '';
  var row = FIRST_DATA_ROW + (day - 1);
  var col = field === 'arr' ? COL_ARR : COL_DEP;
  return fmtTime(sh.getRange(row, col).getDisplayValue());
}

/* ==================== ONGLETS TECHNIQUES ==================== */

function getMetaSheet_(ss) {
  var sh = ss.getSheetByName(META_SHEET);
  if (!sh) {
    sh = ss.insertSheet(META_SHEET);
    sh.getRange(1, 1, 1, 6).setValues([['cellKey', 'revision', 'value', 'opId', 'deviceId', 'updatedAt']]);
    sh.getRange(2, 1, sh.getMaxRows() - 1, 1).setNumberFormat('@'); // clés en texte
    try { sh.hideSheet(); } catch (e) { /* ignore */ }
  }
  return sh;
}

/** Renvoie la ligne meta pour une cellule ({row:0} si absente). */
function metaRow_(sh, cellK) {
  var last = sh.getLastRow();
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 6).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]) === cellK) {
        return {
          row: i + 2,
          rev: Number(vals[i][1]) || 0,
          value: String(vals[i][2] == null ? '' : vals[i][2]),
          device: String(vals[i][4] || ''),
          at: String(vals[i][5] || ''),
        };
      }
    }
  }
  return { row: 0, rev: 0, value: '', device: '', at: '' };
}

/** Variante pratique quand on n'a pas encore la feuille sous la main. */
function metaFor_(ss, cellK) {
  var sh = ss.getSheetByName(META_SHEET);
  if (!sh) return { rev: 0, value: '' };
  return metaRow_(sh, cellK);
}

function upsertMeta_(sh, row, cellK, rev, value, opId, deviceId, nowIso) {
  var data = [[cellK, rev, value, opId, deviceId, nowIso]];
  if (row) {
    sh.getRange(row, 1, 1, 6).setValues(data);
  } else {
    var r = sh.getLastRow() + 1;
    sh.getRange(r, 1).setNumberFormat('@'); // clé en texte
    sh.getRange(r, 1, 1, 6).setValues(data);
  }
}

function getOpsSheet_(ss) {
  var sh = ss.getSheetByName(OPS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(OPS_SHEET);
    sh.getRange(1, 1, 1, 2).setValues([['opId', 'at']]);
    try { sh.hideSheet(); } catch (e) { /* ignore */ }
  }
  return sh;
}

function opProcessed_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return false;
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === id) return true;
  }
  return false;
}

function recordOp_(sh, id) {
  var nowIso = Utilities.formatDate(new Date(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
  sh.appendRow([id, nowIso]);
  // Bornage FIFO : on ne conserve que les OPS_CAP derniers identifiants.
  var last = sh.getLastRow();
  var count = last - 1;
  if (count > OPS_CAP) {
    var remove = count - OPS_CAP;
    sh.deleteRows(2, remove); // supprime les plus anciens
  }
}

/* ==================== TAUX ==================== */

/** Enregistre l'historique complet des taux + recalcule tous les montants. */
function setRates(p) {
  var list;
  try { list = JSON.parse(p.rates); } catch (e) { return { ok: false, error: 'rates invalide' }; }
  if (!Array.isArray(list)) return { ok: false, error: 'rates invalide' };

  var clean = [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i] || {};
    var v = parseFloat(r.value);
    var f = r.from;
    if (!isNaN(v) && v >= 0 && typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f)) {
      clean.push({ from: f, value: v });
    }
  }
  clean.sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : 0; });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return { ok: false, error: 'verrou indisponible', busy: true };
  try {
    var sh = ss.getSheetByName(RATES_SHEET);
    if (!sh) sh = ss.insertSheet(RATES_SHEET);
    sh.clear();
    sh.getRange(1, 1, 1, 2).setValues([['Date début', 'Taux (€/h)']]);
    if (clean.length) {
      sh.getRange(2, 1, clean.length, 1).setNumberFormat('@'); // dates en TEXTE
      var rows = clean.map(function (r) { return [r.from, r.value]; });
      sh.getRange(2, 1, clean.length, 2).setValues(rows);
    }
    // B1 lisible = taux en vigueur aujourd'hui.
    var today = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
    var current = clean.length ? clean[0].value : 0;
    for (var k = 0; k < clean.length; k++) { if (clean[k].from <= today) current = clean[k].value; }
    for (var mm = 0; mm < 12; mm++) {
      var ms = getMonthSheet_(ss, mm);
      if (ms) ms.getRange(RATE_CELL).setValue(current);
    }
    // Recalcule TOUS les montants avec la nouvelle grille de taux (Heures inchangées).
    recomputeAllAmounts_(ss);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

/** Recalcule Heures + Montant de chaque ligne saisie, par écriture groupée. */
function recomputeAllAmounts_(ss) {
  for (var m = 0; m < 12; m++) {
    var sh = getMonthSheet_(ss, m);
    if (!sh) continue;
    var year = yearOfSheet_(sh, m);
    var cd = sh.getRange(FIRST_DATA_ROW, COL_ARR, 31, 2).getDisplayValues(); // C..D
    var ef = [];
    for (var i = 0; i < 31; i++) {
      var arr = fmtTime(cd[i][0]);
      var dep = fmtTime(cd[i][1]);
      var hours = computeHours_(arr, dep);
      if (hours) {
        var rate = rateForDate_(ss, year, m, i + 1);
        ef.push([round2_(hours), round2_(hours * rate)]);
      } else {
        ef.push(['', '']);
      }
    }
    sh.getRange(FIRST_DATA_ROW, COL_HEURES, 31, 2).setValues(ef); // E..F groupé
  }
}

/** Année représentée par un onglet : lue depuis la 1re date, sinon année courante. */
function yearOfSheet_(sh, m) {
  var d = sh.getRange(FIRST_DATA_ROW, COL_DATE).getValue();
  if (Object.prototype.toString.call(d) === '[object Date]') return d.getFullYear();
  return new Date().getFullYear();
}

/** Écrit le taux horaire en B1 de tous les onglets mensuels (compat.). */
function setRate(p) {
  var r = parseFloat(p.rate);
  if (isNaN(r) || r < 0) return { ok: false, error: 'taux invalide' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  for (var m = 0; m < 12; m++) {
    var sh = getMonthSheet_(ss, m);
    if (sh) sh.getRange(RATE_CELL).setValue(r);
  }
  return { ok: true };
}

/** Taux applicable à une date donnée (grille « Taux », repli sur B1). */
function rateForDate_(ss, year, m, day) {
  var rates = readRates(ss);
  var dateStr = year + '-' + pad(m + 1) + '-' + pad(day);
  if (rates && rates.length) {
    var sorted = rates.slice().sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : 0; });
    var v = sorted[0].value;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].from <= dateStr) v = sorted[i].value;
      else break;
    }
    return v;
  }
  var sh = getMonthSheet_(ss, m);
  var rv = sh ? sh.getRange(RATE_CELL).getValue() : 0;
  return (typeof rv === 'number' && rv > 0) ? rv : 0;
}

/* ============== COMPAT. ANCIEN CLIENT (écriture jour entier) ============== */

/** Écrit une journée entière (ancien format). Conservé pour la transition. */
function writeOne(p) {
  var m = parseInt(p.month, 10) - 1;
  var day = parseInt(p.day, 10);
  var year = parseInt(p.year, 10);
  if (isNaN(m) || m < 0 || m > 11 || isNaN(day) || day < 1 || day > 31) {
    return { ok: false, error: 'paramètres invalides' };
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = getMonthSheet_(ss, m);
  if (!sh) return { ok: false, error: 'onglet introuvable : ' + MONTHS[m] };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return { ok: false, error: 'verrou indisponible', busy: true };
  try {
    var row = FIRST_DATA_ROW + (day - 1);
    var arr = p.arr || '';
    var dep = p.dep || '';
    var hours = (p.hours !== undefined && p.hours !== '') ? parseFloat(p.hours) : '';
    var amount = (p.amount !== undefined && p.amount !== '') ? parseFloat(p.amount) : '';
    var dateObj = !isNaN(year) ? new Date(year, m, day) : sh.getRange(row, COL_DATE).getValue();
    var jour = p.jour || WEEKDAYS[new Date(year, m, day).getDay()];
    sh.getRange(row, COL_DATE, 1, 6).setValues([[dateObj, jour, arr, dep, hours, amount]]);
    if (p.rate) sh.getRange(RATE_CELL).setValue(parseFloat(p.rate));
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

/* ==================== UTILITAIRES ==================== */

/** "HH:MM" -> heures décimales, ou null si invalide. */
function timeToHours_(v) {
  if (!v) return null;
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(v).trim());
  if (!m) return null;
  var h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h + mi / 60;
}

/**
 * Heures travaillées (arrondi à la demi-heure : arrivée au plancher, départ au
 * plafond ; gère le passage de minuit). Copie EXACTE de la logique client
 * (sync-core.js). Garder les deux en phase.
 */
function computeHours_(arr, dep) {
  var a = timeToHours_(arr), d = timeToHours_(dep);
  if (a === null || d === null) return 0;
  var ra = Math.floor(a * 2) / 2;
  var rd = Math.ceil(d * 2) / 2;
  var diff = rd - ra;
  if (diff < 0) diff += 24;
  return diff;
}

function round2_(x) { return Math.round(x * 100) / 100; }

/** Normalise une valeur de cellule (Date ou texte) en "HH:MM", sinon "". */
function fmtTime(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return pad(v.getHours()) + ':' + pad(v.getMinutes());
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? pad(parseInt(m[1], 10)) + ':' + m[2] : '';
}

function pad(n) { return (n < 10 ? '0' : '') + n; }
