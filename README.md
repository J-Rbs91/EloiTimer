# Planning Eloi — EloiTimer

Interface web autonome qui reproduit la feuille de calcul Google Sheets
**« Tididi Timer / Planning Eloi »** : pointage des heures et calcul
automatique de la rémunération.

## Fonctionnalités

- **12 onglets mensuels** (Janvier → Décembre) + un onglet **Récap mensuel**.
- Pour chaque jour : **Date · Jour · Arrivée · Départ · Heures · Montant (€)**.
- Calculs automatiques :
  - `Heures  = Départ − Arrivée` (gère le passage de minuit / service de nuit) ;
  - `Montant = Heures × taux horaire`.
- **TOTAL** des heures et des montants par mois, et **récapitulatif annuel**.
- **Taux horaire** modifiable (2,66 € par défaut, comme la feuille d'origine).
- **Année** sélectionnable : les dates et jours de la semaine sont recalculés.
- **Sauvegarde automatique** dans le navigateur (`localStorage`).
- **Export CSV** du mois affiché ou du récapitulatif (séparateur `;`, format FR).
- Surlignage des week-ends, mise en page proche de la feuille de calcul.

## Utilisation

Aucune installation ni build : ouvrez simplement `index.html` dans un
navigateur. Pour servir en local :

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

## Fichiers

| Fichier       | Rôle                                            |
|---------------|-------------------------------------------------|
| `index.html`  | Structure de la page                            |
| `styles.css`  | Mise en page et thème                           |
| `app.js`      | Calculs, rendu des tableaux et persistance      |
