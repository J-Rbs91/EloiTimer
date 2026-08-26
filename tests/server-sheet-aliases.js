'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

let passed = 0;
function ok(condition, message) {
  if (!condition) {
    console.error('  ✗ ÉCHEC : ' + message);
    process.exitCode = 1;
    return;
  }
  passed++;
}

function sheet(name) {
  return { getName: () => name };
}

function spreadsheet(names) {
  const sheets = names.map(sheet);
  return {
    getSheetByName(name) {
      return sheets.find((s) => s.getName() === name) || null;
    },
    getSheets() {
      return sheets;
    },
  };
}

console.log('\n• Apps Script — résolution des onglets mensuels');
ok(sandbox.monthNameKey_('Août') === 'aout', 'Août est normalisé en aout');
ok(sandbox.monthNameKey_('FÉVRIER') === 'fevrier', 'les accents et la casse sont ignorés');

const legacy = spreadsheet(['Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Aout']);
ok(sandbox.getMonthSheet_(legacy, 1).getName() === 'Fevrier', 'Février retrouve l’onglet historique Fevrier');
ok(sandbox.getMonthSheet_(legacy, 7).getName() === 'Aout', 'Août retrouve l’onglet historique Aout');

const canonical = spreadsheet(['Août', 'Aout']);
ok(sandbox.getMonthSheet_(canonical, 7).getName() === 'Août', 'le nom canonique reste prioritaire s’il existe');

const directMonthlyLookups = (code.match(/getSheetByName\(MONTHS\[/g) || []).length;
ok(directMonthlyLookups === 0, 'tous les accès mensuels passent par getMonthSheet_');

if (!process.exitCode) console.log(`\n✓ ONGLETS MENSUELS : ${passed} assertions OK.`);
