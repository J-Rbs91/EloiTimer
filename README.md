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
- **Ouverture instantanée & hors-ligne** (PWA *offline-first*) : après une
  première visite, l'app s'ouvre depuis son cache sans attendre le réseau, et
  reste pleinement utilisable sans connexion. Aucune ressource distante n'est
  requise au premier rendu (police système, aucune police Google).
- **Partage multi-appareils** optionnel via **ta feuille Google** (sans backend
  ni VPS) : la feuille sert de base partagée, « comme un Excel partagé ».
  Voir [`apps-script/README.md`](apps-script/README.md).
- **Synchronisation fiable** : chaque saisie est enregistrée localement *avant*
  tout envoi réseau, mise en file (« outbox ») et poussée dès que le réseau
  revient — une saisie n'est jamais perdue et n'est retirée qu'après
  confirmation du serveur. Les modifications de deux téléphones fusionnent
  (une arrivée ne remplace plus un départ), et un vrai conflit est signalé, pas
  écrasé en silence.
- **Export CSV** du mois affiché ou du récapitulatif (séparateur `;`, format FR).
- Surlignage des week-ends, mise en page proche de la feuille de calcul.

## Partage multi-appareils (optionnel)

Par défaut, les données restent **locales** à l'appareil. Pour les partager
entre plusieurs téléphones/ordinateurs sans serveur :

1. Déploie le script `apps-script/Code.gs` dans **ta feuille Google**
   (notice détaillée : [`apps-script/README.md`](apps-script/README.md)).
2. Dans l'app, bouton **☁ Partage** → colle l'URL `/exec` + l'année de la feuille.

La feuille devient la source partagée : chaque saisie y est écrite et l'app se
resynchronise à l'ouverture, au retour du réseau, au retour au premier plan et
périodiquement (repli). L'URL `/exec` est un **lien secret** (quiconque la
possède peut lire/écrire) ; ne la partage qu'aux personnes concernées.

### Comment fonctionne la synchronisation

- **Outbox** — chaque saisie crée une *opération unitaire* par champ
  (`arr` **ou** `dep`) enregistrée dans `localStorage` (`eloitimer.outbox`)
  avant tout appel réseau. Elle porte un identifiant unique, un identifiant
  d'appareil et la révision serveur de référence. Elle n'est supprimée
  qu'**après confirmation explicite** de la feuille.
- **Fusion non destructive** — à la lecture, les données distantes sont
  fusionnées avec l'état local : toute cellule couverte par une opération en
  attente est **protégée** (jamais écrasée par un pull).
- **Idempotence** — si une réponse réseau est perdue et que l'opération est
  rejouée, le serveur la reconnaît (par identifiant) et ne l'applique pas deux
  fois.
- **Conflits** — si un autre téléphone a modifié le même champ entre-temps, le
  serveur renvoie un conflit ; l'app affiche les deux valeurs et te laisse
  choisir (« Conserver ma valeur » / « Conserver la valeur synchronisée »).
  Rien n'est résolu silencieusement.
- **Statuts** — le bandeau indique l'état réel : *Enregistré sur ce téléphone*,
  *N modifications en attente*, *Synchronisation…*, *Synchronisé*, *Hors ligne*
  ou *Conflit à vérifier*. « Synchronisé » n'apparaît jamais tant qu'une
  opération reste en attente ou en conflit.

### Migration des données existantes

La mise à jour est **automatique** et sans perte : l'ancienne file
`eloitimer.pending` (clés de jour) est convertie en opérations d'outbox à
partir de l'état local, puis retirée ; une version de schéma
(`eloitimer.schema`) est enregistrée pour rendre l'opération idempotente. Les
horaires déjà saisis et l'historique des taux sont conservés.

## Tests

Tests automatisés des fonctions pures (calcul des heures, taux daté, fusion,
migration, statut) et des scénarios serveur (idempotence, conflit,
multi-appareils) :

```bash
npm test        # ou : node tests/run.js
```

Un scénario manuel reproductible (ouverture hors-ligne, persistance, retour
réseau, réponse perdue, multi-appareils, conflit, mise à jour PWA) est décrit
dans [`docs/TESTS.md`](docs/TESTS.md).

## Utilisation

Aucune installation ni build : ouvrez simplement `index.html` dans un
navigateur. Pour servir en local :

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

## Fichiers

| Fichier            | Rôle                                                 |
|--------------------|------------------------------------------------------|
| `index.html`       | Structure de la page                                 |
| `styles.css`       | Mise en page et thème                                |
| `app.js`           | Calculs, rendu des tableaux, persistance et synchro  |
| `sync-core.js`     | Fonctions pures partagées (calcul, fusion, migration)|
| `sw.js`            | Service worker *offline-first* (cache-first / SWR)   |
| `apps-script/Code.gs` | Pont vers la feuille Google (écriture par champ)  |
| `tests/`           | Tests Node des fonctions pures et scénarios serveur  |
| `docs/TESTS.md`    | Procédure de test manuel reproductible               |
