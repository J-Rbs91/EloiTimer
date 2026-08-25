from pathlib import Path
import json

app_path = Path('app.js')
app = app_path.read_text(encoding='utf-8')


def replace_once(old, new, label):
    global app
    count = app.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, got {count}')
    app = app.replace(old, new, 1)


replace_once(
"""  let pollTimer = null;
  let isFlushing = false;                // verrou anti-concurrence de flushOutbox
  let flushQueued = false;               // un appel est arrivé pendant un flush
  let lastError = false;                 // dernière tentative distante en erreur
  let justSavedUntil = 0;                // fenêtre d'affichage « Enregistré… »
""",
"""  let pollTimer = null;
  let isFlushing = false;                // écriture distante en cours
  let flushPromise = null;               // partage le flush courant entre les appelants
  let isSyncing = false;                 // cycle complet push -> pull en cours
  let syncCyclePromise = null;           // sérialise les cycles de synchronisation
  let syncCycleQueued = false;           // rejoue un cycle si un événement arrive pendant le précédent
  let lastError = false;                 // dernière tentative distante en erreur
  let justSavedUntil = 0;                // fenêtre d'affichage « Enregistré… »
""",
'sync state')

replace_once(
"""    renderSyncStatus();
    scheduleFlush(300);
  }

  function scheduleFlush(delay) {
    if (!syncEnabled()) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flushOutbox(); }, delay || 0);
  }

  function scheduleRetry() {
    retryDelay = retryDelay ? Math.min(retryDelay * 2, MAX_BACKOFF_MS) : 2000;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { flushOutbox(); }, retryDelay);
  }
""",
"""    renderSyncStatus();
    scheduleSync(300);
  }

  /** Planifie un cycle COMPLET (push de l'outbox, puis pull distant). */
  function scheduleSync(delay) {
    if (!syncEnabled()) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { syncNow(); }, delay || 0);
  }

  function scheduleRetry() {
    retryDelay = retryDelay ? Math.min(retryDelay * 2, MAX_BACKOFF_MS) : 2000;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { syncNow(); }, retryDelay);
  }
""",
'scheduler')

start = app.index("  /** Fonction centrale : vide l'outbox. Un seul flux à la fois (verrou). */")
end = app.index("\n  function markConflict", start)
app = app[:start] + """  /** Fonction centrale : vide l'outbox. Les appels concurrents attendent le même flush. */
  async function flushOutbox() {
    if (!syncEnabled()) { renderSyncStatus(); return false; }
    if (flushPromise) return flushPromise;

    flushPromise = (async () => {
      const ops = SC.sortOutbox(outbox).filter((o) => o.year === syncedYear() && !o.conflict);
      if (!ops.length) return true;

      isFlushing = true;
      renderSyncStatus();
      let networkError = false;
      try {
        for (const op of ops) {
          if (!outbox.some((o) => o.id === op.id && !o.conflict)) continue;
          let res;
          try {
            res = await jsonp(writeParams(op));
          } catch (e) {
            lastError = true;
            networkError = true;
            break;
          }
          if (res && res.ok) {
            const ck = SC.cellKey(op.year, op.month, op.day, op.field);
            if (typeof res.revision === 'number') { knownRevs[ck] = res.revision; saveRevs(); }
            removeOp(op.id);
          } else if (res && res.conflict) {
            markConflict(op, res);
          } else {
            lastError = true;
            networkError = true;
            break;
          }
        }
      } finally {
        isFlushing = false;
      }

      if (networkError) scheduleRetry();
      else retryDelay = 0;

      renderSyncStatus();
      if (isConflictModalOpen()) renderConflictList();
      return !networkError;
    })();

    try {
      return await flushPromise;
    } finally {
      flushPromise = null;
    }
  }
""" + app[end:]

replace_once(
"""  async function cloudPull() {
    if (!syncEnabled()) return;
    renderSyncStatus('sync', 'Synchronisation…');
    let data;
    try {
      data = await jsonp({ action: 'read' });
    } catch (e) {
      // Simple absence de réseau : on reste sur le cache local, sans erreur dure.
      renderSyncStatus();
      return;
    }
    if (!data || !data.ok) { lastError = true; renderSyncStatus(); return; }
    applyRemote(data);
    lastError = false;
    renderSyncStatus();
    // La fusion faite, on tente d'envoyer les opérations encore en attente.
    flushOutbox();
  }
""",
"""  async function cloudPull() {
    if (!syncEnabled()) return false;
    renderSyncStatus('sync', 'Synchronisation…');
    let data;
    try {
      data = await jsonp({ action: 'read' });
    } catch (e) {
      // Le cache local reste utilisable, mais on ne doit surtout pas afficher
      // « Synchronisé » si la lecture distante n'a pas abouti.
      lastError = true;
      renderSyncStatus();
      return false;
    }
    if (!data || !data.ok) { lastError = true; renderSyncStatus(); return false; }
    applyRemote(data);
    renderSyncStatus();
    return true;
  }

  /**
   * Cycle unique de synchronisation :
   *   1) pousser et CONFIRMER l'outbox ;
   *   2) seulement ensuite lire/fusionner la feuille distante.
   * Tous les déclencheurs passent ici afin d'éviter les courses push/pull.
   */
  async function syncNow() {
    if (!syncEnabled()) { renderSyncStatus(); return false; }
    if (syncCyclePromise) {
      syncCycleQueued = true;
      return syncCyclePromise;
    }

    isSyncing = true;
    renderSyncStatus();
    syncCyclePromise = (async () => {
      const flushOk = await flushOutbox();
      const pullOk = await cloudPull();
      const ok = flushOk && pullOk;
      lastError = !ok;
      return ok;
    })();

    try {
      return await syncCyclePromise;
    } finally {
      syncCyclePromise = null;
      isSyncing = false;
      renderSyncStatus();
      if (syncCycleQueued) {
        syncCycleQueued = false;
        scheduleSync(0);
      }
    }
  }
""",
'pull + cycle')

replace_once(
"""  function pushRates() {
    if (!syncEnabled()) return;
    jsonp({ action: 'setrates', rates: JSON.stringify(state.rates) })
      .then(() => cloudPull())
      .catch(() => {});
  }
""",
"""  async function pushRates() {
    if (!syncEnabled()) return;
    try {
      const res = await jsonp({ action: 'setrates', rates: JSON.stringify(state.rates) });
      if (!res || !res.ok) throw new Error('échec setrates');
      await syncNow();
    } catch (e) {
      lastError = true;
      renderSyncStatus();
    }
  }
""",
'rates')

replace_once(
"""      outbox: outboxForYear(),
      isFlushing,
      online: (typeof navigator.onLine === 'boolean') ? navigator.onLine : true,
""",
"""      outbox: outboxForYear(),
      isFlushing: isFlushing || isSyncing,
      online: (typeof navigator.onLine === 'boolean') ? navigator.onLine : true,
""",
'status')

replace_once(
"""  function startPolling() {
    clearInterval(pollTimer);
    if (!syncEnabled()) return;
    pollTimer = setInterval(() => {
      // Ne pas rafraîchir l'affichage pendant une saisie en cours
      const active = document.activeElement;
      if (active && active.classList && active.classList.contains('cell-input')) return;
      if (outboxForYear().some((o) => !o.conflict)) flushOutbox();
      else cloudPull();
    }, POLL_MS);
  }

  /** Déclencheurs de synchronisation (retour réseau, premier plan, focus). */
  function setupSyncTriggers() {
    window.addEventListener('online', () => { retryDelay = 0; renderSyncStatus(); scheduleFlush(0); });
    window.addEventListener('offline', () => renderSyncStatus());
    window.addEventListener('focus', () => { if (syncEnabled()) scheduleFlush(0); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !syncEnabled()) return;
      const active = document.activeElement;
      const editing = active && active.classList && active.classList.contains('cell-input');
      if (outboxForYear().some((o) => !o.conflict)) scheduleFlush(0);
      else if (!editing) cloudPull();
    });
  }
""",
"""  function isEditingTime() {
    const modal = document.getElementById('time-modal');
    if (modal && !modal.classList.contains('hidden')) return true;
    const active = document.activeElement;
    return !!(active && active.classList && active.classList.contains('cell-input'));
  }

  function startPolling() {
    clearInterval(pollTimer);
    if (!syncEnabled()) return;
    pollTimer = setInterval(() => {
      // Ne jamais reconstruire le tableau pendant que le sélecteur horaire est ouvert.
      if (isEditingTime()) return;
      syncNow();
    }, POLL_MS);
  }

  /** Déclencheurs de synchronisation (retour réseau, premier plan, focus). */
  function setupSyncTriggers() {
    window.addEventListener('online', () => {
      retryDelay = 0;
      renderSyncStatus();
      if (syncEnabled() && !isEditingTime()) scheduleSync(0);
    });
    window.addEventListener('offline', () => renderSyncStatus());
    window.addEventListener('focus', () => {
      if (syncEnabled() && !isEditingTime()) scheduleSync(0);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !syncEnabled() || isEditingTime()) return;
      scheduleSync(0);
    });
  }
""",
'triggers')

replace_once(
"    scheduleFlush(0);\n  }\n\n  function setupConflictModal()",
"    scheduleSync(0);\n  }\n\n  function setupConflictModal()",
'conflict followup')

replace_once(
"""  function performReset() {
    const prefix = `${currentYear}-`;
    Object.keys(state.entries).forEach((k) => {
      if (k.startsWith(prefix)) delete state.entries[k];
    });
    save();
    renderContent();
  }
""",
"""  function performReset() {
    const prefix = `${currentYear}-`;
    const clears = [];
    Object.keys(state.entries).forEach((k) => {
      if (!k.startsWith(prefix)) return;
      const entry = state.entries[k] || {};
      const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(k);
      if (m && currentYear === syncedYear()) {
        const month0 = Number(m[2]) - 1;
        const day = Number(m[3]);
        if (entry.arr) clears.push({ month0, day, field: 'arr' });
        if (entry.dep) clears.push({ month0, day, field: 'dep' });
      }
      delete state.entries[k];
    });
    save();
    // Une réinitialisation d'une année partagée doit aussi effacer le distant :
    // chaque cellule supprimée devient une opération explicite dans l'outbox.
    clears.forEach((c) => enqueueOp(currentYear, c.month0, c.day, c.field, ''));
    renderContent();
  }
""",
'reset')

replace_once(
"""      feedback.className = 'modal-feedback info';
      feedback.textContent = 'Test de la connexion…';
      // Applique temporairement pour tester
      const previous = sync;
      sync = { url, year };
      try {
        const res = await jsonp({ action: 'ping' }, 15000);
        if (!res || !res.ok) throw new Error('réponse inattendue');
      } catch (e) {
        sync = previous;
        feedback.className = 'modal-feedback err';
        feedback.textContent = 'Connexion impossible. Vérifie l\\'URL et le déploiement (accès « Tout le monde »).';
        return;
      }
      saveSync();
      currentYear = year;
      const yearSelMain = document.getElementById('year-select');
      if (yearSelMain) yearSelMain.value = String(year);
      feedback.className = 'modal-feedback ok';
      feedback.textContent = 'Connecté ! Synchronisation en cours…';
      setSyncStatus('sync', 'Synchronisation…');
      await cloudPull();
      startPolling();
      setTimeout(closeShareModal, 600);
""",
"""      feedback.className = 'modal-feedback info';
      feedback.textContent = 'Test de la connexion et du protocole…';
      // Applique temporairement pour tester, sans enregistrer tant que le
      // backend n'a pas prouvé qu'il supporte bien writeField (protocole v2).
      const previous = sync;
      const targetChanged = previous.url !== url || Number(previous.year) !== year;
      const unresolved = previous.url
        ? outbox.filter((o) => o.year === (previous.year || currentYear))
        : [];
      if (targetChanged && unresolved.length) {
        feedback.className = 'modal-feedback err';
        feedback.textContent = `${unresolved.length} modification(s) sont encore en attente ou en conflit. Synchronise-les avant de changer de feuille.`;
        return;
      }

      sync = { url, year };
      try {
        const ping = await jsonp({ action: 'ping' }, 15000);
        if (!ping || !ping.ok) throw new Error('connexion');
        // Requête volontairement invalide et sans écriture : un backend v2
        // répond « champ invalide », tandis qu'un ancien script ne connaît pas writeField.
        const probe = await jsonp({ action: 'writeField', field: '__protocol_probe__' }, 15000);
        if (!probe || probe.error !== 'champ invalide') throw new Error('protocole-v2');
      } catch (e) {
        sync = previous;
        feedback.className = 'modal-feedback err';
        feedback.textContent = e && e.message === 'protocole-v2'
          ? 'Le Google Apps Script déployé est trop ancien. Mets Code.gs à jour puis crée une nouvelle version du déploiement.'
          : 'Connexion impossible. Vérifie l\\'URL et le déploiement (accès « Tout le monde »).';
        return;
      }

      if (targetChanged) {
        knownRevs = {};
        saveRevs();
      }
      saveSync();
      currentYear = year;
      const yearSelMain = document.getElementById('year-select');
      if (yearSelMain) yearSelMain.value = String(year);
      feedback.className = 'modal-feedback ok';
      feedback.textContent = 'Connecté ! Synchronisation en cours…';
      setSyncStatus('sync', 'Synchronisation…');
      await syncNow();
      startPolling();
      setTimeout(closeShareModal, 600);
""",
'share protocol')

replace_once(
"""  if (syncEnabled()) {
    renderSyncStatus();
    // 1) on affiche immédiatement l'état local, 2) on tente d'envoyer l'outbox,
    // 3) on fusionne les données distantes (non destructif), puis on démarre le
    // repli périodique. L'UI n'attend jamais le réseau pour s'afficher.
    flushOutbox();
    cloudPull().then(() => { focusTodayInput(); startPolling(); });
  }
""",
"""  if (syncEnabled()) {
    renderSyncStatus();
    // L'UI s'affiche immédiatement depuis le local, puis UN SEUL cycle sérialisé
    // pousse l'outbox avant de lire/fusionner le distant. Plus de course push/pull.
    syncNow().then(() => { focusTodayInput(); startPolling(); });
  }
""",
'startup')

app_path.write_text(app, encoding='utf-8')

sw_path = Path('sw.js')
sw = sw_path.read_text(encoding='utf-8')
if sw.count("const CACHE = 'eloitimer-v28';") != 1:
    raise SystemExit('unexpected service worker cache version')
sw_path.write_text(sw.replace("const CACHE = 'eloitimer-v28';", "const CACHE = 'eloitimer-v29';"), encoding='utf-8')

test = r'''\
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
'''
Path('tests/client-sync-structure.js').write_text(test, encoding='utf-8')

pkg_path = Path('package.json')
pkg = json.loads(pkg_path.read_text(encoding='utf-8'))
pkg['scripts']['test'] = 'node tests/run.js && node tests/client-sync-structure.js'
pkg_path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
