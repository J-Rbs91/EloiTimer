/* =========================================================================
 * Planning Eloi — pont entre la PWA et la feuille Google (sans backend/VPS)
 *
 * À COLLER dans : ta feuille Google → menu Extensions → Apps Script.
 * Puis : Déployer → Nouveau déploiement → type « Application Web »
 *        - Exécuter en tant que : Moi
 *        - Qui a accès : Tout le monde
 * Copie l'URL « /exec » obtenue et colle-la dans la PWA (bouton ☁ Partage).
 *
 * Cette URL est le LIEN SECRET : quiconque la possède peut lire et écrire.
 *
 * Modèle de données : une ligne par jour dans chaque onglet mensuel.
 *   A = Date | B = Jour | C = Arrivée | D = Départ | E = Heures | F = Montant
 *   B1 = taux horaire. Le jour J est en ligne (3 + J).
 * ===================================================================== */

var MONTHS = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];
var FIRST_DATA_ROW = 4;        // le jour 1 est en ligne 4
var COL_DATE = 1, COL_JOUR = 2, COL_ARR = 3, COL_DEP = 4, COL_HEURES = 5, COL_MONTANT = 6;
var RATE_CELL = 'B1';

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    if (p.action === 'read') out = readAll();
    else if (p.action === 'write') out = writeOne(p);
    else if (p.action === 'setrate') out = setRate(p);
    else if (p.action === 'ping') out = { ok: true, pong: true };
    else out = { ok: false, error: 'action inconnue : ' + p.action };
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return reply(out, p.callback);
}

/** Réponse JSON, ou JSONP si un callback est fourni (contourne le CORS). */
function reply(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

/** Lit le taux et, pour chaque mois, les arrivées/départs saisis. */
function readAll() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var rate = null;
  var months = {};
  for (var m = 0; m < 12; m++) {
    var sh = ss.getSheetByName(MONTHS[m]);
    if (!sh) continue;
    if (rate === null) {
      var rv = sh.getRange(RATE_CELL).getValue();
      if (typeof rv === 'number' && rv > 0) rate = rv;
    }
    // getDisplayValues() : on lit le TEXTE affiché ("09:00"), pas un objet Date.
    // Évite toute réinterprétation de fuseau horaire (bug du décalage des heures).
    var values = sh.getRange(FIRST_DATA_ROW, COL_ARR, 31, 2).getDisplayValues(); // C..D, 31 lignes
    var days = {};
    for (var i = 0; i < 31; i++) {
      var arr = fmtTime(values[i][0]);
      var dep = fmtTime(values[i][1]);
      if (arr || dep) days[i + 1] = { arr: arr, dep: dep };
    }
    months[m + 1] = days;
  }
  return { ok: true, rate: rate, months: months };
}

/** Écrit une journée (et le taux) dans l'onglet du mois concerné. */
function writeOne(p) {
  var m = parseInt(p.month, 10) - 1;     // 1..12 -> 0..11
  var day = parseInt(p.day, 10);
  var year = parseInt(p.year, 10);
  if (isNaN(m) || m < 0 || m > 11 || isNaN(day) || day < 1 || day > 31) {
    return { ok: false, error: 'paramètres invalides' };
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(MONTHS[m]);
  if (!sh) return { ok: false, error: 'onglet introuvable : ' + MONTHS[m] };

  var lock = LockService.getScriptLock();
  lock.tryLock(8000);
  try {
    var row = FIRST_DATA_ROW + (day - 1);
    // Arrivée / Départ : texte "HH:MM" (ou vide pour effacer)
    sh.getRange(row, COL_ARR).setValue(p.arr || '');
    sh.getRange(row, COL_DEP).setValue(p.dep || '');
    // Heures / Montant : nombres calculés par l'app (ou vide)
    sh.getRange(row, COL_HEURES).setValue(p.hours !== undefined && p.hours !== '' ? parseFloat(p.hours) : '');
    sh.getRange(row, COL_MONTANT).setValue(p.amount !== undefined && p.amount !== '' ? parseFloat(p.amount) : '');
    // Date / Jour : garde la mise en page cohérente avec l'année choisie
    if (!isNaN(year)) sh.getRange(row, COL_DATE).setValue(new Date(year, m, day));
    if (p.jour) sh.getRange(row, COL_JOUR).setValue(p.jour);
    // Taux horaire
    if (p.rate) sh.getRange(RATE_CELL).setValue(parseFloat(p.rate));
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

/** Écrit le taux horaire en B1 de tous les onglets mensuels. */
function setRate(p) {
  var r = parseFloat(p.rate);
  if (isNaN(r) || r < 0) return { ok: false, error: 'taux invalide' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  for (var m = 0; m < 12; m++) {
    var sh = ss.getSheetByName(MONTHS[m]);
    if (sh) sh.getRange(RATE_CELL).setValue(r);
  }
  return { ok: true };
}

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
