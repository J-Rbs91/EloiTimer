/* =========================================================================
 * Planning Eloi — interface de pointage & calculs
 *
 * Reproduit la feuille de calcul Google Sheets :
 *   - 12 onglets mensuels (Janvier → Décembre) + un onglet "Récap mensuel"
 *   - Colonnes : Date | Jour | Arrivée | Départ | Heures | Montant (€)
 *   - Heures  = Départ − Arrivée
 *   - Montant = Heures × taux horaire
 *   - TOTAL des heures et des montants par mois, et récapitulatif annuel
 *
 * Aucune dépendance : HTML/CSS/JS pur. Les saisies sont conservées dans
 * le localStorage du navigateur (clé "eloitimer.v1").
 * ===================================================================== */

(() => {
  'use strict';

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

  // ---- État persistant ---------------------------------------------------
  /** @type {{rate:number, entries:Object<string,{arr?:string,dep?:string}>}} */
  let state = load();
  let currentYear = new Date().getFullYear();
  let currentMonth = new Date().getMonth(); // 0-11, ou -1 pour le récap

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          rate: typeof parsed.rate === 'number' ? parsed.rate : 2.66,
          entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
        };
      }
    } catch (e) {
      console.warn('Lecture du stockage impossible :', e);
    }
    return { rate: 2.66, entries: {} };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Sauvegarde impossible :', e);
    }
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
    save();
  }

  /** Convertit "HH:MM" en heures décimales, ou null si invalide. */
  function timeToHours(value) {
    if (!value) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h + min / 60;
  }

  /**
   * Arrondi à la demi-heure, en faveur d'Eloi :
   *  - arrivée arrondie au PLANCHER  (9h01 / 9h29  -> 9h00)
   *  - départ  arrondi  au PLAFOND   (18h01 / 18h29 -> 18h30)
   * Renvoie les heures décimales arrondies, ou null si saisie incomplète.
   */
  function roundedTimes(arr, dep) {
    const a = timeToHours(arr);
    const d = timeToHours(dep);
    if (a === null || d === null) return null;
    return {
      arr: Math.floor(a * 2) / 2, // plancher à la demi-heure
      dep: Math.ceil(d * 2) / 2,  // plafond à la demi-heure
    };
  }

  /** Heures travaillées (après arrondi), gère le passage de minuit. */
  function computeHours(arr, dep) {
    const r = roundedTimes(arr, dep);
    if (!r) return 0;
    let diff = r.dep - r.arr;
    if (diff < 0) diff += 24; // service de nuit
    return diff;
  }

  /** Convertit des heures décimales en "HH:MM" (pour l'info-bulle). */
  function hoursToTime(h) {
    const hh = Math.floor(h) % 24;
    const mm = Math.round((h - Math.floor(h)) * 60);
    return `${pad2(hh)}:${pad2(mm)}`;
  }

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
    const n = daysInMonth(year, month);
    for (let day = 1; day <= n; day++) {
      const { arr, dep } = getEntry(year, month, day);
      hours += computeHours(arr, dep);
    }
    return { hours, amount: hours * state.rate };
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
      const entry = getEntry(currentYear, month, day);
      const hours = computeHours(entry.arr, entry.dep);

      const tr = document.createElement('tr');
      if (dow === 0 || dow === 6) tr.classList.add('weekend');
      if (
        day === now.getDate() &&
        month === now.getMonth() &&
        currentYear === now.getFullYear()
      ) {
        tr.classList.add('today');
      }

      tr.appendChild(td(`${pad2(day)}/${pad2(month + 1)}/${currentYear}`));
      tr.appendChild(td(WEEKDAYS[dow], 'day'));

      tr.appendChild(timeCell(month, day, 'arr', entry.arr));
      tr.appendChild(timeCell(month, day, 'dep', entry.dep));

      const hoursCell = td(hours ? fmtHours(hours) : '0,00', 'num');
      hoursCell.title = roundInfo(entry.arr, entry.dep);
      tr.appendChild(hoursCell);

      const amountCell = td(fmtEuro(hours * state.rate), 'num amount');
      tr.appendChild(amountCell);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const tfoot = document.createElement('tfoot');
    const ftr = document.createElement('tr');
    ftr.innerHTML = `
      <td colspan="4">TOTAL</td>
      <td class="num" data-total="hours">${fmtHours(totals.hours)}</td>
      <td class="num amount" data-total="amount">${fmtEuro(totals.amount)}</td>`;
    tfoot.appendChild(ftr);
    table.appendChild(tfoot);

    wrap.appendChild(table);
    panel.appendChild(wrap);
    return panel;
  }

  /** Cellule contenant un champ horaire (arrivée/départ). */
  function timeCell(month, day, field, value) {
    const cell = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'time';
    input.className = 'cell-input';
    input.dataset.day = String(day);
    input.dataset.field = field;
    input.value = value || '';
    input.addEventListener('change', () => {
      setEntry(currentYear, month, day, field, input.value);
      refreshRow(input, month, day);
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
    cells[5].textContent = fmtEuro(hours * state.rate);

    const totals = monthTotals(currentYear, month);
    const table = tr.closest('table');
    table.querySelector('[data-total="hours"]').textContent = fmtHours(totals.hours);
    table.querySelector('[data-total="amount"]').textContent = fmtEuro(totals.amount);

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
      rows.push([`Taux horaire`, fmtHours(state.rate)]);
      rows.push(['Date', 'Jour', 'Arrivée', 'Départ', 'Heures', 'Montant (€)']);
      const n = daysInMonth(currentYear, month);
      for (let day = 1; day <= n; day++) {
        const date = new Date(currentYear, month, day);
        const entry = getEntry(currentYear, month, day);
        const hours = computeHours(entry.arr, entry.dep);
        rows.push([
          `${pad2(day)}/${pad2(month + 1)}/${currentYear}`,
          WEEKDAYS[date.getDay()],
          entry.arr || '',
          entry.dep || '',
          fmtHours(hours),
          fmtHours(hours * state.rate),
        ]);
      }
      const t = monthTotals(currentYear, month);
      rows.push(['TOTAL', '', '', '', fmtHours(t.hours), fmtHours(t.amount)]);
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

    const rateInput = document.getElementById('rate-input');
    rateInput.value = state.rate;
    rateInput.addEventListener('input', () => {
      const v = parseFloat(rateInput.value);
      state.rate = Number.isFinite(v) && v >= 0 ? v : 0;
      save();
      renderContent();
    });

    document.getElementById('export-btn').addEventListener('click', exportCsv);

    document.getElementById('reset-btn').addEventListener('click', () => {
      if (!confirm(`Effacer toutes les saisies de l'année ${currentYear} ?`)) return;
      const prefix = `${currentYear}-`;
      Object.keys(state.entries).forEach((k) => {
        if (k.startsWith(prefix)) delete state.entries[k];
      });
      save();
      renderContent();
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

  initControls();
  renderTabs();
  renderContent();
  focusTodayInput();
})();
