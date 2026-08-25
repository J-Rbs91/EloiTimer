/* =========================================================================
 * Planning Eloi — interface de pointage & calculs
 *
 * Reproduit la feuille de calcul Google Sheets :
 *   - 12 onglets mensuels (Janvier → Décembre) + un onglet "Récap mensuel"
 *   - Colonnes : Date | Jour | Arrivée | Départ | Heures | Montant (€)
 *   - Heures  = Départ − Arrivée
 *   - Montant = Heures × taux horaire en vigueur à la date du jour
 *   - TOTAL des heures et des montants par mois, et récapitulatif annuel
 *
 * Aucune dépendance : HTML/CSS/JS pur. Les saisies sont conservées dans
 * le localStorage du navigateur (clé "eloitimer.v1"), et peuvent en option
 * être synchronisées avec une feuille Google partagée via Apps Script
 * (voir apps-script/ et le module « Synchronisation » plus bas).
 * ===================================================================== */

(() => {
  'use strict';

  // Défense en profondeur : si le module partagé n'a pas pu être chargé (cache
  // incohérent servant index.html + app.js mais PAS sync-core.js), l'app ne
  // peut pas fonctionner. Plutôt que d'échouer en silence et de rester bloquée
  // sur l'écran de démarrage, on RÉPARE : purge des caches, désinscription du
  // service worker, puis un seul rechargement (garde anti-boucle en sessionStorage).
  if (!window.EloiSync) {
    try {
      if (!sessionStorage.getItem('eloi-selfheal')) {
        sessionStorage.setItem('eloi-selfheal', '1');
        const clearCaches = (typeof caches !== 'undefined' && caches.keys)
          ? caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).catch(() => {})
          : Promise.resolve();
        clearCaches.then(() => {
          if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
            return navigator.serviceWorker.getRegistrations()
              .then((rs) => Promise.all(rs.map((r) => r.unregister()))).catch(() => {});
          }
        }).finally(() => location.reload());
      }
    } catch (e) { /* dernier recours : abandon propre */ }
    return; // on n'exécute pas le reste avec un module manquant
  }

  // Fonctions pures partagées (sync-core.js, chargé avant app.js).
  const SC = window.EloiSync;
  // Chargement OK : on lève la garde pour qu'une panne future puisse re-réparer.
  try { sessionStorage.removeItem('eloi-selfheal'); } catch (e) { /* ignore */ }

  const STORAGE_KEY = 'eloitimer.v1';

  const MONTHS = [
    'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
    'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
  ];

  // Jours de la semaine, index = Date.getDay() (0 = dimanche)
  const WEEKDAYS = [
    'dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi',
  ];

  // ---- Formatage à la française -----------------------------------------
  const nf2 = new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const fmtHours = (h) => nf2.format(h);
  const fmtEuro = (v) => `${nf2.format(v)} €`;
  const pad2 = (n) => String(n).padStart(2, '0');

  // ---- Taux horaire (historique daté) -----------------------------------
  // Le taux change dans le temps : on conserve une liste de taux, chacun
  // valable À PARTIR d'une date (`from`, "YYYY-MM-DD"). Le taux appliqué à
  // une journée est celui dont la date de début est la plus récente sans
  // dépasser la date de la journée. Le dernier taux s'applique indéfiniment.
  const DEFAULT_RATE = SC.DEFAULT_RATE;   // 2.66
  const EPOCH = SC.EPOCH;                  // « depuis toujours » (taux initial / migration)

  // ---- État persistant ---------------------------------------------------
  /** @type {{rates:Array<{from:string,value:number}>, entries:Object<string,{arr?:string,dep?:string}>}} */
  let state = load();
  let currentYear = new Date().getFullYear();
  let currentMonth = new Date().getMonth(); // 0-11, ou -1 pour le récap

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          rates: normalizeRates(parsed.rates, parsed.rate),
          entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
        };
      }
    } catch (e) {
      console.warn('Lecture du stockage impossible :', e);
    }
    return { rates: [{ from: EPOCH, value: DEFAULT_RATE }], entries: {} };
  }

  // Construction/normalisation de la liste des taux et sélection du taux daté :
  // délégués au module pur partagé (voir sync-core.js).
  const normalizeRates = (rates, legacyRate) => SC.normalizeRates(rates, legacyRate);
  const sortRates = (list) => SC.sortRates(list);

  /** Taux applicable à une date "YYYY-MM-DD". */
  function rateForDate(dateStr) {
    return SC.rateForDate(state.rates, dateStr);
  }

  /** Taux applicable à une journée (année/mois 0-11/jour). */
  function rateForDay(year, month, day) {
    return rateForDate(`${year}-${pad2(month + 1)}-${pad2(day)}`);
  }

  /** Taux en vigueur aujourd'hui (= le taux « en cours »). */
  function currentRate() {
    const now = new Date();
    return rateForDate(`${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`);
  }

  /** "YYYY-MM-DD" -> "DD/MM/YYYY" pour l'affichage. */
  function fmtDateFr(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : dateStr;
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Sauvegarde impossible :', e);
    }
  }

  // =======================================================================
  //  Synchronisation avec la feuille Google (optionnelle, via Apps Script)
  //  Transport : JSONP (balise <script>) pour contourner le CORS.
  //  La feuille fait office de base partagée : « comme un Excel partagé ».
  //
  //  Modèle : « outbox » d'opérations UNITAIRES par champ. Chaque saisie est
  //  d'abord enregistrée localement (state + outbox), puis envoyée. Une
  //  opération n'est retirée qu'après confirmation explicite du serveur. Le
  //  serveur gère l'idempotence (par identifiant d'op) et la détection de
  //  conflit (par révision de cellule).
  // =======================================================================
  const SYNC_KEY = 'eloitimer.sync';
  const LEGACY_PENDING_KEY = 'eloitimer.pending'; // ancienne file (clés de jour)
  const OUTBOX_KEY = 'eloitimer.outbox';
  const DEVICE_KEY = 'eloitimer.device';
  const REV_KEY = 'eloitimer.rev';                // { cellKey: révision serveur connue }
  const SCHEMA_KEY = 'eloitimer.schema';
  const SCHEMA_VERSION = 2;
  const POLL_MS = 60000;                           // repli périodique
  const MAX_BACKOFF_MS = 5 * 60 * 1000;            // plafond de temporisation

  let sync = loadSync();                 // { url, year }
  const deviceId = loadDeviceId();       // identifiant persistant de l'appareil
  let outbox = loadOutbox();             // [op...] opérations en attente
  let knownRevs = loadRevs();            // révisions serveur connues par cellule
  let jsonpSeq = 0;
  let flushTimer = null;
  let retryTimer = null;
  let retryDelay = 0;
  let pollTimer = null;
  let isFlushing = false;                // écriture distante en cours
  let flushPromise = null;               // partage le flush courant entre les appelants
  let isSyncing = false;                 // cycle complet push -> pull en cours
  let syncCyclePromise = null;           // sérialise les cycles de synchronisation
  let syncCycleQueued = false;           // rejoue un cycle si un événement arrive pendant le précédent
  let lastError = false;                 // dernière tentative distante en erreur
  let justSavedUntil = 0;                // fenêtre d'affichage « Enregistré… »

  function loadSync() {
    try {
      const p = JSON.parse(localStorage.getItem(SYNC_KEY) || '{}');
      return { url: typeof p.url === 'string' ? p.url : '', year: p.year || null };
    } catch (e) {
      return { url: '', year: null };
    }
  }
  function saveSync() {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch (e) { /* quota */ }
  }
  const syncEnabled = () => !!sync.url;
  const syncedYear = () => sync.year || currentYear;

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function loadDeviceId() {
    let id = null;
    try { id = localStorage.getItem(DEVICE_KEY); } catch (e) { /* ignore */ }
    if (!id) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'dev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try { localStorage.setItem(DEVICE_KEY, id); } catch (e) { /* ignore */ }
    }
    return id;
  }

  function loadOutbox() {
    try {
      const arr = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
      return Array.isArray(arr) ? arr.filter((o) => o && o.id && o.field) : [];
    } catch (e) { return []; }
  }
  function saveOutbox() {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox)); } catch (e) { /* quota */ }
  }
  function loadRevs() {
    try {
      const o = JSON.parse(localStorage.getItem(REV_KEY) || '{}');
      return o && typeof o === 'object' ? o : {};
    } catch (e) { return {}; }
  }
  function saveRevs() {
    try { localStorage.setItem(REV_KEY, JSON.stringify(knownRevs)); } catch (e) { /* quota */ }
  }

  const outboxForYear = () => outbox.filter((o) => o.year === syncedYear());
  const removeOp = (id) => { outbox = outbox.filter((o) => o.id !== id); saveOutbox(); };

  // ---- Migration de l'ancien stockage (idempotente) ----------------------
  function runMigration() {
    let schema = 0;
    try { schema = parseInt(localStorage.getItem(SCHEMA_KEY) || '0', 10) || 0; } catch (e) { /* ignore */ }
    if (schema >= SCHEMA_VERSION) return;

    let legacy = [];
    try { legacy = JSON.parse(localStorage.getItem(LEGACY_PENDING_KEY) || '[]'); } catch (e) { legacy = []; }
    if (Array.isArray(legacy) && legacy.length) {
      const base = Date.now();
      const newOps = SC.migratePending(
        legacy, state.entries, sync.year || null, outbox,
        (i) => ({ id: newId(), deviceId, createdAt: new Date(base + i).toISOString() })
      );
      if (newOps.length) { outbox = outbox.concat(newOps); saveOutbox(); }
    }
    // On ne retire l'ancienne file qu'APRÈS avoir écrit l'outbox migrée.
    try { localStorage.removeItem(LEGACY_PENDING_KEY); } catch (e) { /* ignore */ }
    try { localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION)); } catch (e) { /* ignore */ }
  }

  /** Appel JSONP à l'application Web Apps Script (avec anti-cache). */
  function jsonp(params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!sync.url) return reject(new Error('URL non configurée'));
      const cb = '__eloi_cb_' + (++jsonpSeq);
      const p = Object.assign({}, params, { _: Date.now() }); // anti-cache
      const qs = Object.keys(p)
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(p[k]))
        .join('&');
      const sep = sync.url.indexOf('?') === -1 ? '?' : '&';
      const script = document.createElement('script');
      const timer = setTimeout(() => { cleanup(); reject(new Error('délai dépassé')); }, timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cb] = (data) => { cleanup(); resolve(data); };
      script.onerror = () => { cleanup(); reject(new Error('échec réseau')); };
      script.src = sync.url + sep + qs + '&callback=' + cb;
      document.head.appendChild(script);
    });
  }

  // ---- Enfilement d'une opération (déclenché à chaque saisie) ------------
  function enqueueOp(year, month0, day, field, value) {
    if (!syncEnabled() || year !== syncedYear()) return;
    // Une op non confirmée déjà présente pour cette cellule est remplacée par
    // la dernière valeur voulue ; un éventuel conflit sur cette cellule est
    // levé par cette nouvelle saisie explicite.
    outbox = outbox.filter((o) => !(o.year === year && o.month === month0 + 1 && o.day === day && o.field === field));
    const ck = SC.cellKey(year, month0 + 1, day, field);
    outbox.push(SC.makeOp(year, month0 + 1, day, field, value || '', knownRevs[ck] | 0, {
      id: newId(), deviceId, createdAt: new Date().toISOString(),
    }));
    saveOutbox();
    justSavedUntil = Date.now() + 1600;
    renderSyncStatus();
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

  function writeParams(op) {
    return {
      action: 'writeField',
      id: op.id, deviceId: op.deviceId,
      year: op.year, month: op.month, day: op.day,
      field: op.field, value: op.value,
      baseRevision: op.baseRevision,
    };
  }

  /** Fonction centrale : vide l'outbox. Les appels concurrents attendent le même flush. */
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

  function markConflict(op, res) {
    const ck = SC.cellKey(op.year, op.month, op.day, op.field);
    if (typeof res.serverRevision === 'number') { knownRevs[ck] = res.serverRevision; saveRevs(); }
    outbox = outbox.map((o) => (o.id === op.id ? Object.assign({}, o, {
      conflict: {
        serverValue: res.serverValue || '',
        serverRevision: res.serverRevision || 0,
        serverDevice: res.serverDevice || '',
        serverAt: res.serverAt || '',
      },
    }) : o));
    saveOutbox();
  }

  /**
   * Récupère les données distantes et les FUSIONNE avec l'état local sans
   * jamais écraser une opération locale en attente (voir SC.mergeRemote).
   */
  async function cloudPull() {
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

  function applyRemote(data) {
    const year = syncedYear();
    // Historique des taux (nouveau format) ; repli sur l'ancien taux unique.
    if (Array.isArray(data.rates) && data.rates.length) {
      state.rates = normalizeRates(data.rates, null);
    } else if (typeof data.rate === 'number' && data.rate > 0) {
      state.rates = normalizeRates(null, data.rate);
    }
    // Révisions serveur connues (ne jamais rabaisser une révision plus récente).
    if (data.revs && typeof data.revs === 'object') {
      Object.keys(data.revs).forEach((k) => {
        const r = data.revs[k] | 0;
        if (!(k in knownRevs) || r > knownRevs[k]) knownRevs[k] = r;
      });
      saveRevs();
    }
    // Fusion NON destructive : distant + protection des cellules en attente.
    state.entries = SC.mergeRemote(state.entries, data.months || {}, outbox, year);
    save();
    renderRatesUi();
    renderContent();
  }

  /** Propage l'historique des taux ; le serveur recalcule lui-même les montants. */
  async function pushRates() {
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

  /** Statut forcé (message transitoire) — l'état calculé reprend ensuite la main. */
  function setSyncStatus(kind, text) {
    const elStatus = document.getElementById('sync-status');
    if (!elStatus) return;
    if (!syncEnabled()) { elStatus.classList.add('hidden'); return; }
    elStatus.classList.remove('hidden');
    elStatus.className = 'sync-status ' + kind;
    elStatus.textContent = text;
    elStatus.onclick = null;
  }

  /** Statut CALCULÉ à partir de l'outbox, de l'état réseau et des conflits. */
  function renderSyncStatus(forceKind, forceText) {
    const elStatus = document.getElementById('sync-status');
    if (!elStatus) return;
    if (!syncEnabled()) { elStatus.classList.add('hidden'); return; }
    if (forceKind) { setSyncStatus(forceKind, forceText); return; }
    elStatus.classList.remove('hidden');
    const st = SC.computeSyncStatus({
      outbox: outboxForYear(),
      isFlushing: isFlushing || isSyncing,
      online: (typeof navigator.onLine === 'boolean') ? navigator.onLine : true,
      justSaved: Date.now() < justSavedUntil,
      error: lastError,
    });
    elStatus.className = 'sync-status ' + st.kind;
    elStatus.textContent = st.text;
    elStatus.onclick = st.kind === 'conflict' ? openConflictModal : null;
  }

  function isEditingTime() {
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

  // ---- Résolution de conflit multi-appareils ----------------------------
  const isConflictModalOpen = () =>
    !document.getElementById('conflict-modal').classList.contains('hidden');

  function openConflictModal() {
    if (!outbox.some((o) => o.conflict)) return;
    renderConflictList();
    document.getElementById('conflict-modal').classList.remove('hidden');
  }
  function closeConflictModal() {
    document.getElementById('conflict-modal').classList.add('hidden');
  }

  function conflictChoice(who, val, onClick) {
    const b = el('button', 'conflict-choice');
    b.type = 'button';
    const w = el('span', 'who'); w.textContent = who;
    const v = el('span', 'val'); v.textContent = val || '(vide)';
    b.appendChild(w); b.appendChild(v);
    b.addEventListener('click', onClick);
    return b;
  }

  function renderConflictList() {
    const list = document.getElementById('conflict-list');
    if (!list) return;
    list.innerHTML = '';
    const conflicts = outbox.filter((o) => o.conflict);
    if (!conflicts.length) { closeConflictModal(); return; }
    conflicts.forEach((op) => {
      const li = el('li', 'conflict-item');
      const where = el('div', 'conflict-where');
      const label = op.field === 'dep' ? 'Départ' : 'Arrivée';
      where.textContent = `${pad2(op.day)}/${pad2(op.month)}/${op.year} · ${label}`;
      li.appendChild(where);
      const choices = el('div', 'conflict-choices');
      choices.appendChild(conflictChoice('Conserver ma valeur', op.value, () => resolveConflict(op, 'mine')));
      choices.appendChild(conflictChoice('Conserver la valeur synchronisée', op.conflict.serverValue, () => resolveConflict(op, 'server')));
      li.appendChild(choices);
      list.appendChild(li);
    });
  }

  function resolveConflict(op, keep) {
    const ck = SC.cellKey(op.year, op.month, op.day, op.field);
    const serverRev = op.conflict ? (op.conflict.serverRevision | 0) : (knownRevs[ck] | 0);
    if (keep === 'server') {
      // Adopter la valeur distante localement, puis retirer l'opération.
      const k = dayKey(op.year, op.month - 1, op.day);
      const entry = Object.assign({}, state.entries[k]);
      const v = op.conflict ? op.conflict.serverValue : '';
      if (v) entry[op.field] = v; else delete entry[op.field];
      if (entry.arr || entry.dep) state.entries[k] = entry; else delete state.entries[k];
      knownRevs[ck] = serverRev;
      save(); saveRevs();
      removeOp(op.id);
    } else {
      // Garder ma valeur : NOUVELLE opération basée sur la révision serveur actuelle.
      knownRevs[ck] = serverRev;
      outbox = outbox.map((o) => (o.id === op.id
        ? SC.makeOp(o.year, o.month, o.day, o.field, o.value, serverRev,
            { id: newId(), deviceId, createdAt: new Date().toISOString() })
        : o));
      saveRevs(); saveOutbox();
    }
    renderContent();
    renderConflictList();
    renderSyncStatus();
    scheduleSync(0);
  }

  function setupConflictModal() {
    const modal = document.getElementById('conflict-modal');
    document.getElementById('conflict-close').addEventListener('click', closeConflictModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeConflictModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeConflictModal();
    });
  }

  // ---- Clés & calculs ----------------------------------------------------
  const dayKey = (year, month, day) => `${year}-${pad2(month + 1)}-${pad2(day)}`;

  function getEntry(year, month, day) {
    return state.entries[dayKey(year, month, day)] || {};
  }

  function setEntry(year, month, day, field, value) {
    const key = dayKey(year, month, day);
    const entry = state.entries[key] || {};
    if (value) entry[field] = value;
    else delete entry[field];
    if (entry.arr || entry.dep) state.entries[key] = entry;
    else delete state.entries[key];
    save();                                  // 1) enregistré localement d'abord
    enqueueOp(year, month, day, field, value); // 2) puis mis dans l'outbox (envoi)
  }

  // Conversion / arrondi / calcul des heures : délégués au module pur partagé
  // (sync-core.js). Le serveur (Code.gs) en tient une copie équivalente.
  const timeToHours = (value) => SC.timeToHours(value);
  const roundedTimes = (arr, dep) => SC.roundedTimes(arr, dep);
  const computeHours = (arr, dep) => SC.computeHours(arr, dep);
  const hoursToTime = (h) => SC.hoursToTime(h);

  /** Texte d'info-bulle expliquant l'arrondi appliqué à une ligne. */
  function roundInfo(arr, dep) {
    const r = roundedTimes(arr, dep);
    if (!r) return '';
    return `Arrivée comptée ${hoursToTime(r.arr)} · Départ compté ${hoursToTime(r.dep)}`;
  }

  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  /** Totaux (heures + montant) d'un mois donné. */
  function monthTotals(year, month) {
    let hours = 0;
    let amount = 0;
    const n = daysInMonth(year, month);
    for (let day = 1; day <= n; day++) {
      const dow = new Date(year, month, day).getDay();
      if (dow === 0 || dow === 6) continue; // week-ends : non travaillés
      const { arr, dep } = getEntry(year, month, day);
      const h = computeHours(arr, dep);
      hours += h;
      amount += h * rateForDay(year, month, day); // chaque jour au taux de sa date
    }
    return { hours, amount };
  }

  // =======================================================================
  //  Rendu
  // =======================================================================
  const tabsEl = document.getElementById('tabs');
  const contentEl = document.getElementById('content');

  function renderTabs() {
    tabsEl.innerHTML = '';
    MONTHS.forEach((name, idx) => {
      const btn = document.createElement('button');
      btn.className = 'tab' + (idx === currentMonth ? ' active' : '');
      btn.textContent = name;
      btn.addEventListener('click', () => {
        currentMonth = idx;
        renderTabs();
        renderContent();
      });
      tabsEl.appendChild(btn);
    });

    const recap = document.createElement('button');
    recap.className = 'tab recap' + (currentMonth === -1 ? ' active' : '');
    recap.textContent = 'Récap mensuel';
    recap.addEventListener('click', () => {
      currentMonth = -1;
      renderTabs();
      renderContent();
    });
    tabsEl.appendChild(recap);
  }

  function renderContent() {
    contentEl.innerHTML = '';
    contentEl.appendChild(currentMonth === -1 ? buildRecap() : buildMonth(currentMonth));
  }

  // ---- Vue d'un mois -----------------------------------------------------
  function buildMonth(month) {
    const panel = el('section', 'panel');
    const totals = monthTotals(currentYear, month);
    const now = new Date();

    // Bandeau de synthèse
    const bar = el('div', 'summary-bar');
    bar.innerHTML = `<div class="title">${MONTHS[month]} ${currentYear}</div>`;
    const totalsBox = el('div', 'totals');
    totalsBox.appendChild(totalBox('Total heures', fmtHours(totals.hours)));
    totalsBox.appendChild(totalBox('Total à payer', fmtEuro(totals.amount)));
    bar.appendChild(totalsBox);
    panel.appendChild(bar);

    // Tableau
    const wrap = el('div', 'table-wrap');
    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr>
          <th>Date</th>
          <th>Jour</th>
          <th>Arrivée</th>
          <th>Départ</th>
          <th class="num">Heures</th>
          <th class="num">Montant (€)</th>
        </tr>
      </thead>`;

    const tbody = document.createElement('tbody');
    const n = daysInMonth(currentYear, month);

    for (let day = 1; day <= n; day++) {
      const date = new Date(currentYear, month, day);
      const dow = date.getDay();
      const isWeekend = dow === 0 || dow === 6;
      const entry = getEntry(currentYear, month, day);
      const hours = computeHours(entry.arr, entry.dep);

      const tr = document.createElement('tr');
      if (isWeekend) tr.classList.add('weekend');
      if (
        day === now.getDate() &&
        month === now.getMonth() &&
        currentYear === now.getFullYear()
      ) {
        tr.classList.add('today');
      }

      tr.appendChild(td(`${pad2(day)}/${pad2(month + 1)}/${currentYear}`));
      tr.appendChild(td(WEEKDAYS[dow], 'day'));

      // Week-ends : on n'affiche que la date et le nom du jour (cellules vides).
      if (isWeekend) {
        tr.appendChild(td('', 'empty'));
        tr.appendChild(td('', 'empty'));
        tr.appendChild(td('', 'num empty'));
        tr.appendChild(td('', 'num empty'));
        tbody.appendChild(tr);
        continue;
      }

      tr.appendChild(timeCell(month, day, 'arr', entry.arr));
      tr.appendChild(timeCell(month, day, 'dep', entry.dep));

      const hoursCell = td(hours ? fmtHours(hours) : '0,00', 'num');
      hoursCell.title = roundInfo(entry.arr, entry.dep);
      tr.appendChild(hoursCell);

      const amountCell = td(fmtEuro(hours * rateForDay(currentYear, month, day)), 'num amount');
      tr.appendChild(amountCell);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    wrap.appendChild(table);
    panel.appendChild(wrap);
    return panel;
  }

  /**
   * Cellule contenant un champ horaire (arrivée/départ).
   * On n'utilise PAS <input type="time"> : sur Android, le sélecteur natif
   * (horloge système) tronque ses propres boutons (« Définir » coupé). On
   * affiche donc un champ en lecture seule qui ouvre notre sélecteur maison,
   * dont on maîtrise entièrement la mise en page.
   */
  function timeCell(month, day, field, value) {
    const cell = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-input';
    input.readOnly = true;
    input.inputMode = 'none';
    input.placeholder = '--:--';
    input.dataset.day = String(day);
    input.dataset.month = String(month);
    input.dataset.field = field;
    input.value = value || '';
    const open = (e) => {
      e.preventDefault();
      openTimePicker(input);
    };
    input.addEventListener('click', open);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') open(e);
    });
    cell.appendChild(input);
    return cell;
  }

  /** Recalcule la ligne et les totaux du mois sans tout reconstruire. */
  function refreshRow(input, month, day) {
    const tr = input.closest('tr');
    const entry = getEntry(currentYear, month, day);
    const hours = computeHours(entry.arr, entry.dep);
    const cells = tr.querySelectorAll('td');
    cells[4].textContent = hours ? fmtHours(hours) : '0,00';
    cells[4].title = roundInfo(entry.arr, entry.dep);
    cells[5].textContent = fmtEuro(hours * rateForDay(currentYear, month, day));

    const totals = monthTotals(currentYear, month);
    const titleTotal = document.querySelectorAll('.total-box .value');
    if (titleTotal.length === 2) {
      titleTotal[0].textContent = fmtHours(totals.hours);
      titleTotal[1].textContent = fmtEuro(totals.amount);
    }
  }

  // ---- Vue récapitulative ------------------------------------------------
  function buildRecap() {
    const panel = el('section', 'panel');
    let yHours = 0;
    let yAmount = 0;

    const bar = el('div', 'summary-bar');
    bar.innerHTML = `<div class="title">Récapitulatif ${currentYear}</div>`;
    panel.appendChild(bar);

    const wrap = el('div', 'table-wrap');
    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr>
          <th>Mois</th>
          <th class="num">Total heures</th>
          <th class="num">Montant (€)</th>
        </tr>
      </thead>`;

    const tbody = document.createElement('tbody');
    MONTHS.forEach((name, idx) => {
      const t = monthTotals(currentYear, idx);
      yHours += t.hours;
      yAmount += t.amount;

      const tr = el('tr', 'recap-row');
      tr.appendChild(td(name, 'month'));
      tr.appendChild(td(fmtHours(t.hours), 'num'));
      tr.appendChild(td(fmtEuro(t.amount), 'num amount'));
      tr.addEventListener('click', () => {
        currentMonth = idx;
        renderTabs();
        renderContent();
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    const tfoot = document.createElement('tfoot');
    const ftr = document.createElement('tr');
    ftr.innerHTML = `
      <td>TOTAL ANNÉE</td>
      <td class="num">${fmtHours(yHours)}</td>
      <td class="num amount">${fmtEuro(yAmount)}</td>`;
    tfoot.appendChild(ftr);
    table.appendChild(tfoot);

    wrap.appendChild(table);
    panel.appendChild(wrap);

    // Totaux dans le bandeau
    const totalsBox = el('div', 'totals');
    totalsBox.appendChild(totalBox('Total heures', fmtHours(yHours)));
    totalsBox.appendChild(totalBox('Total à payer', fmtEuro(yAmount)));
    bar.appendChild(totalsBox);

    return panel;
  }

  // ---- Export CSV --------------------------------------------------------
  function exportCsv() {
    const rows = [];
    const isRecap = currentMonth === -1;

    if (isRecap) {
      rows.push(['Mois', 'Total heures', 'Montant (€)']);
      let yHours = 0;
      let yAmount = 0;
      MONTHS.forEach((name, idx) => {
        const t = monthTotals(currentYear, idx);
        yHours += t.hours;
        yAmount += t.amount;
        rows.push([name, fmtHours(t.hours), fmtHours(t.amount)]);
      });
      rows.push(['TOTAL ANNÉE', fmtHours(yHours), fmtHours(yAmount)]);
    } else {
      const month = currentMonth;
      rows.push(['Date', 'Jour', 'Arrivée', 'Départ', 'Heures', 'Taux (€/h)', 'Montant (€)']);
      const n = daysInMonth(currentYear, month);
      for (let day = 1; day <= n; day++) {
        const date = new Date(currentYear, month, day);
        const entry = getEntry(currentYear, month, day);
        const hours = computeHours(entry.arr, entry.dep);
        const rate = rateForDay(currentYear, month, day);
        rows.push([
          `${pad2(day)}/${pad2(month + 1)}/${currentYear}`,
          WEEKDAYS[date.getDay()],
          entry.arr || '',
          entry.dep || '',
          fmtHours(hours),
          fmtHours(rate),
          fmtHours(hours * rate),
        ]);
      }
      const t = monthTotals(currentYear, month);
      rows.push(['TOTAL', '', '', '', fmtHours(t.hours), '', fmtHours(t.amount)]);
    }

    // CSV séparé par ; (convention FR) avec échappement des guillemets
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';'))
      .join('\r\n');

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = isRecap
      ? `planning-eloi-recap-${currentYear}.csv`
      : `planning-eloi-${MONTHS[currentMonth]}-${currentYear}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Petits utilitaires DOM -------------------------------------------
  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }
  function td(text, className) {
    const cell = el('td', className);
    cell.textContent = text;
    return cell;
  }
  function totalBox(label, value) {
    const box = el('div', 'total-box');
    box.innerHTML = `<span class="label">${label}</span><span class="value">${value}</span>`;
    return box;
  }

  // ---- Initialisation & contrôles ---------------------------------------
  function initControls() {
    const yearSel = document.getElementById('year-select');
    const thisYear = new Date().getFullYear();
    for (let y = thisYear - 3; y <= thisYear + 3; y++) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      if (y === currentYear) opt.selected = true;
      yearSel.appendChild(opt);
    }
    yearSel.addEventListener('change', () => {
      currentYear = Number(yearSel.value);
      renderContent();
    });

    // Le taux horaire se gère désormais dans une fenêtre dédiée (historique daté).
    document.getElementById('rates-btn').addEventListener('click', () => {
      closeSettings();
      openRatesModal();
    });
    renderRatesUi();

    // Actions issues du panneau Réglages : on ferme d'abord les Réglages.
    document.getElementById('share-btn').addEventListener('click', () => { closeSettings(); openShareModal(); });
    document.getElementById('export-btn').addEventListener('click', () => { closeSettings(); exportCsv(); });
    document.getElementById('reset-btn').addEventListener('click', () => { closeSettings(); openConfirmModal(); });
  }

  // ---- Panneau Réglages -------------------------------------------------
  function openSettings() {
    document.getElementById('settings-modal').classList.remove('hidden');
  }

  function closeSettings() {
    document.getElementById('settings-modal').classList.add('hidden');
  }

  function setupSettingsModal() {
    const modal = document.getElementById('settings-modal');
    document.getElementById('settings-btn').addEventListener('click', openSettings);
    document.getElementById('settings-close').addEventListener('click', closeSettings);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeSettings(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeSettings();
    });
  }

  // ---- Fenêtre de confirmation de réinitialisation ----------------------
  function openConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-message').textContent =
      `Toutes les saisies de l'année ${currentYear} seront définitivement effacées. ` +
      `Cette action est irréversible.`;
    modal.classList.remove('hidden');
    // Place le focus sur « Annuler » (option la moins destructrice) par défaut.
    document.getElementById('confirm-cancel').focus();
  }

  function closeConfirmModal() {
    document.getElementById('confirm-modal').classList.add('hidden');
  }

  function performReset() {
    const prefix = `${currentYear}-`;
    const clears = [];
    Object.keys(state.entries).forEach((k) => {
      if (!k.startsWith(prefix)) return;
      const entry = state.entries[k] || {};
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k);
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

  function setupConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-cancel').addEventListener('click', closeConfirmModal);
    document.getElementById('confirm-ok').addEventListener('click', () => {
      closeConfirmModal();
      performReset();
    });
    // Clic sur le fond ou touche Échap : annule (ne supprime rien).
    modal.addEventListener('click', (e) => { if (e.target === modal) closeConfirmModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeConfirmModal();
    });
  }

  // ---- Gestion des taux horaires (historique daté) ----------------------
  /** "YYYY-MM-DD" -> veille (jour précédent), en "YYYY-MM-DD". */
  function dayBefore(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d - 1);
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }

  function todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  }

  /** Libellé de la période d'application d'un taux (liste triée croissante). */
  function ratePeriodLabel(sorted, i) {
    const item = sorted[i];
    const isFirst = i === 0;
    const isLast = i === sorted.length - 1;
    if (isLast) {
      // Dernier taux : ouvert indéfiniment.
      if (item.from > todayKey()) return `À partir du ${fmtDateFr(item.from)}`; // pas encore en vigueur
      if (isFirst && item.from === EPOCH) return 'Depuis le début · en cours';
      return `Depuis le ${fmtDateFr(item.from)} · en cours`;
    }
    const end = fmtDateFr(dayBefore(sorted[i + 1].from));
    if (isFirst && item.from === EPOCH) return `Jusqu'au ${end}`;
    return `Du ${fmtDateFr(item.from)} au ${end}`;
  }

  /** Met à jour l'affichage du taux en cours (Réglages) + la liste si ouverte. */
  function renderRatesUi() {
    const disp = document.getElementById('current-rate-display');
    if (disp) disp.textContent = `${fmtEuro(currentRate())}/h`;
    const list = document.getElementById('rates-list');
    if (list && !document.getElementById('rates-modal').classList.contains('hidden')) {
      renderRatesList();
    }
  }

  function renderRatesList() {
    const list = document.getElementById('rates-list');
    list.innerHTML = '';
    const sorted = sortRates(state.rates);
    const today = todayKey();
    // Indice du taux en vigueur aujourd'hui (le plus récent <= aujourd'hui).
    let activeIdx = 0;
    sorted.forEach((it, i) => { if (it.from <= today) activeIdx = i; });

    // Affichage du plus récent au plus ancien.
    for (let i = sorted.length - 1; i >= 0; i--) {
      const it = sorted[i];
      const li = el('li', 'rate-item');
      if (i === activeIdx) li.classList.add('active');

      const info = el('div', 'rate-info');
      const val = el('span', 'rate-value');
      val.textContent = `${fmtEuro(it.value)}/h`;
      const per = el('span', 'rate-period');
      per.textContent = ratePeriodLabel(sorted, i);
      info.appendChild(val);
      info.appendChild(per);
      if (i === activeIdx) {
        const badge = el('span', 'rate-badge');
        badge.textContent = 'actuel';
        info.appendChild(badge);
      }
      li.appendChild(info);

      // Suppression (interdite s'il ne reste qu'un seul taux).
      const del = el('button', 'rate-del');
      del.type = 'button';
      del.textContent = '✕';
      del.title = 'Supprimer ce taux';
      del.setAttribute('aria-label', 'Supprimer ce taux');
      if (sorted.length <= 1) del.disabled = true;
      else del.addEventListener('click', () => deleteRate(it.from));
      li.appendChild(del);

      list.appendChild(li);
    }
  }

  function setRatesFeedback(text, kind) {
    const fb = document.getElementById('rates-feedback');
    if (!fb) return;
    fb.textContent = text || '';
    fb.className = 'modal-feedback' + (kind ? ' ' + kind : '');
  }

  function addRate() {
    const valInput = document.getElementById('rate-value');
    const fromInput = document.getElementById('rate-from');
    const value = parseFloat(valInput.value);
    const from = fromInput.value; // "YYYY-MM-DD" (ou "" si non saisi)

    if (!Number.isFinite(value) || value < 0) {
      setRatesFeedback('Saisis un taux valide (€/h).', 'err');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      setRatesFeedback("Choisis une date d'entrée en vigueur.", 'err');
      return;
    }
    // Une seule entrée par date : on remplace la valeur si la date existe déjà.
    const existing = state.rates.find((r) => r.from === from);
    if (existing) existing.value = value;
    else state.rates.push({ from, value });
    state.rates = sortRates(state.rates);

    save();
    if (syncEnabled()) pushRates();
    renderContent();      // recalcule tous les montants affichés
    renderRatesList();
    renderRatesUi();
    valInput.value = '';
    setRatesFeedback(`Taux ${fmtEuro(value)}/h enregistré (depuis le ${fmtDateFr(from)}).`, 'ok');
  }

  function deleteRate(from) {
    if (state.rates.length <= 1) return;
    state.rates = sortRates(state.rates.filter((r) => r.from !== from));
    save();
    if (syncEnabled()) pushRates();
    renderContent();
    renderRatesList();
    renderRatesUi();
    setRatesFeedback('Taux supprimé.', 'info');
  }

  function openRatesModal() {
    const modal = document.getElementById('rates-modal');
    setRatesFeedback('');
    // Date par défaut = aujourd'hui, pour éviter une saisie vide.
    const fromInput = document.getElementById('rate-from');
    if (!fromInput.value) fromInput.value = todayKey();
    modal.classList.remove('hidden');
    renderRatesList();
  }

  function closeRatesModal() {
    document.getElementById('rates-modal').classList.add('hidden');
  }

  function setupRatesModal() {
    const modal = document.getElementById('rates-modal');
    document.getElementById('rate-add').addEventListener('click', addRate);
    document.getElementById('rates-close').addEventListener('click', closeRatesModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeRatesModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeRatesModal();
    });
  }

  // ---- Sélecteur d'horaire maison (remplace le picker natif) ------------
  // Cellule en cours d'édition (renseignée à l'ouverture du sélecteur).
  let activeTimeCell = null;

  function closeTimeModal() {
    document.getElementById('time-modal').classList.add('hidden');
    activeTimeCell = null;
  }

  /** Ouvre le sélecteur pour le champ horaire associé à `input`. */
  function openTimePicker(input) {
    const modal = document.getElementById('time-modal');
    const hoursSel = document.getElementById('time-hours');
    const minutesSel = document.getElementById('time-minutes');
    const month = Number(input.dataset.month);
    const day = Number(input.dataset.day);
    const field = input.dataset.field;
    activeTimeCell = { input, month, day, field };

    // Titre : « Arrivée » / « Départ » + la date concernée.
    document.getElementById('time-title').textContent =
      field === 'dep' ? 'Heure de départ' : "Heure d'arrivée";
    document.getElementById('time-subtitle').textContent =
      `${pad2(day)}/${pad2(month + 1)}/${currentYear} · ${WEEKDAYS[new Date(currentYear, month, day).getDay()]}`;

    // Valeur courante, ou 09:00 par défaut si le champ est vide.
    const m = /^(\d{1,2}):(\d{2})$/.exec((input.value || '').trim());
    hoursSel.value = m ? pad2(Number(m[1])) : '09';
    minutesSel.value = m ? pad2(Number(m[2])) : '00';

    modal.classList.remove('hidden');
    hoursSel.focus();
  }

  /** Applique (ou efface) la valeur saisie sur la cellule active. */
  function commitTime(value) {
    if (!activeTimeCell) return;
    const { input, month, day, field } = activeTimeCell;
    input.value = value;
    setEntry(currentYear, month, day, field, value);
    refreshRow(input, month, day);
    closeTimeModal();
  }

  function setupTimeModal() {
    const modal = document.getElementById('time-modal');
    const hoursSel = document.getElementById('time-hours');
    const minutesSel = document.getElementById('time-minutes');

    // Remplit les listes Heures (00–23) et Minutes (00–59).
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement('option');
      opt.value = pad2(h);
      opt.textContent = pad2(h);
      hoursSel.appendChild(opt);
    }
    for (let mi = 0; mi < 60; mi++) {
      const opt = document.createElement('option');
      opt.value = pad2(mi);
      opt.textContent = pad2(mi);
      minutesSel.appendChild(opt);
    }

    document.getElementById('time-confirm').addEventListener('click', () => {
      commitTime(`${hoursSel.value}:${minutesSel.value}`);
    });
    document.getElementById('time-clear').addEventListener('click', () => commitTime(''));
    document.getElementById('time-cancel').addEventListener('click', closeTimeModal);
    // Clic sur le fond ou touche Échap : annule (ne modifie rien).
    modal.addEventListener('click', (e) => { if (e.target === modal) closeTimeModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeTimeModal();
    });
  }

  // ---- Fenêtre de partage (configuration de la synchro) -----------------
  function openShareModal() {
    const modal = document.getElementById('share-modal');
    const urlInput = document.getElementById('share-url');
    const yearSel = document.getElementById('share-year');
    const feedback = document.getElementById('share-feedback');

    // Liste d'années autour de l'année courante
    yearSel.innerHTML = '';
    const thisYear = new Date().getFullYear();
    for (let y = thisYear - 3; y <= thisYear + 3; y++) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      yearSel.appendChild(opt);
    }
    urlInput.value = sync.url || '';
    yearSel.value = String(sync.year || currentYear);
    feedback.textContent = '';
    feedback.className = 'modal-feedback';
    document.getElementById('share-disable').classList.toggle('hidden', !syncEnabled());

    modal.classList.remove('hidden');
    urlInput.focus();
  }

  function closeShareModal() {
    document.getElementById('share-modal').classList.add('hidden');
  }

  function setupShareModal() {
    const modal = document.getElementById('share-modal');
    const urlInput = document.getElementById('share-url');
    const yearSel = document.getElementById('share-year');
    const feedback = document.getElementById('share-feedback');

    document.getElementById('share-cancel').addEventListener('click', closeShareModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeShareModal(); });

    document.getElementById('share-disable').addEventListener('click', () => {
      sync = { url: '', year: null };
      saveSync();
      clearInterval(pollTimer);
      setSyncStatus('off', '');
      document.getElementById('sync-status').classList.add('hidden');
      closeShareModal();
    });

    document.getElementById('share-save').addEventListener('click', async () => {
      const url = urlInput.value.trim();
      const year = Number(yearSel.value);
      if (!/^https:\/\/script\.google\.com\/.*\/exec$/.test(url)) {
        feedback.className = 'modal-feedback err';
        feedback.textContent = "L'URL doit ressembler à https://script.google.com/macros/s/…/exec";
        return;
      }
      feedback.className = 'modal-feedback info';
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
          : 'Connexion impossible. Vérifie l\'URL et le déploiement (accès « Tout le monde »).';
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
    });
  }

  /**
   * À l'ouverture, place le curseur sur le champ à saisir pour AUJOURD'HUI :
   *  - sur l'heure d'arrivée si elle n'est pas encore renseignée ;
   *  - sur l'heure de départ si l'arrivée est déjà saisie (et pas le départ).
   * N'agit que si l'on affiche bien le mois courant de l'année courante.
   */
  function focusTodayInput() {
    const now = new Date();
    if (currentMonth !== now.getMonth() || currentYear !== now.getFullYear()) return;

    const day = now.getDate();
    const { arr, dep } = getEntry(currentYear, currentMonth, day);

    // Champ cible : arrivée si absente, sinon départ si l'arrivée est saisie.
    let field = null;
    if (!arr) field = 'arr';
    else if (!dep) field = 'dep';
    if (!field) return; // journée déjà complète : on ne force rien

    const input = contentEl.querySelector(
      `.cell-input[data-day="${day}"][data-field="${field}"]`
    );
    if (!input) return;

    input.scrollIntoView({ block: 'center', behavior: 'auto' });
    // léger délai : laisse le rendu/scroll se stabiliser avant le focus
    setTimeout(() => {
      input.focus({ preventScroll: true });
      input.classList.add('focus-today');
    }, 60);
  }

  // ---- Démarrage ---------------------------------------------------------
  runMigration(); // migre l'ancienne file `eloitimer.pending` -> outbox
  if (syncEnabled() && sync.year) currentYear = sync.year;

  initControls();
  setupSettingsModal();
  setupShareModal();
  setupConfirmModal();
  setupRatesModal();
  setupTimeModal();
  setupConflictModal();
  renderTabs();
  renderContent();
  focusTodayInput();
  setupSyncTriggers();

  if (syncEnabled()) {
    renderSyncStatus();
    // L'UI s'affiche immédiatement depuis le local, puis UN SEUL cycle sérialisé
    // pousse l'outbox avant de lire/fusionner le distant. Plus de course push/pull.
    syncNow().then(() => { focusTodayInput(); startPolling(); });
  }
})();
