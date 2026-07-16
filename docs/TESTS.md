# Tests — Planning Eloi

## Tests automatisés (fonctions pures + logique serveur)

```bash
npm test        # équivaut à : node tests/run.js
```

Couvre : calcul des heures (arrondi demi-heure + service de nuit), taux daté,
fusion non destructive (`mergeRemote`), migration de l'ancienne file
(`migratePending`), statut de synchro (`computeSyncStatus`), et — via un modèle
serveur en mémoire miroir de `apps-script/Code.gs` — l'idempotence, la détection
de conflit et la fusion multi-appareils.

> Le modèle `tests/server-model.js` reproduit la logique de décision de
> `writeField`/`readAll`. **Toute évolution de cette logique dans `Code.gs`
> doit être répercutée dans le modèle** (et inversement).

Résultat attendu : `✓ TOUS LES TESTS PASSENT`.

## Tests non automatisables ici

Les scénarios ci-dessous dépendent d'un vrai service worker, d'un navigateur et
d'une vraie feuille Google. Ils ont été validés avec un navigateur piloté
(Chromium/Playwright) contre l'app statique + un point d'accès Apps Script
simulé ; ils restent à re-vérifier manuellement sur un téléphone après
déploiement réel (voir procédure ci-dessous).

## Procédure manuelle reproductible

Prérequis : app déployée (GitHub Pages) et script Apps Script déployé, URL
`/exec` collée dans **☁ Synchronisation** sur chaque appareil.

### 1. Ouverture hors-ligne

1. Ouvrir l'app **en ligne**, attendre quelques secondes (installation du SW).
2. Fermer complètement l'app (ou l'onglet).
3. Couper **entièrement** le réseau (mode avion).
4. Rouvrir l'app.
5. **Attendu** : l'interface apparaît immédiatement (pas d'attente réseau) et
   les données locales sont visibles.

### 2. Persistance hors-ligne

1. Réseau coupé.
2. Saisir une **arrivée**.
3. **Attendu** : le bandeau indique « Enregistré sur ce téléphone » puis
   « 1 modification en attente » (ou « Hors ligne · 1 modification en attente »).
4. Fermer complètement l'app.
5. Rouvrir **toujours hors-ligne**.
6. **Attendu** : l'arrivée est présente et l'opération est toujours en attente
   (elle n'a pas été perdue).

### 3. Retour du réseau

1. Créer une saisie hors-ligne (comme ci-dessus).
2. Rétablir le réseau.
3. **Attendu** : la synchronisation démarre **automatiquement**, le bandeau
   passe à « Synchronisation… » puis « Synchronisé ».
4. Vérifier la valeur dans **Google Sheets**.
5. **Attendu** : l'opération ne disparaît de l'attente qu'après confirmation.

### 4. Réponse perdue (idempotence)

1. Depuis un appareil, saisir une valeur (elle est écrite dans la feuille).
2. Couper le réseau **juste après l'envoi** (simule une réponse perdue), puis
   le rétablir : l'app rejoue l'opération.
3. **Attendu** : la valeur n'est **pas** appliquée deux fois ; le serveur
   renvoie un succès idempotent (même révision).

### 5. Multi-appareils **sans** conflit

1. Téléphone **A** (hors-ligne) modifie l'**arrivée** d'un jour.
2. Téléphone **B** (en ligne) modifie le **départ** du **même** jour.
3. Téléphone A retrouve le réseau.
4. **Attendu** : l'arrivée **et** le départ sont conservés tous les deux (aucun
   ne remplace l'autre).

### 6. Multi-appareils **avec** conflit

1. Téléphones A et B chargent la même valeur d'un champ (même révision).
2. Les deux modifient **le même champ** (ex. l'arrivée).
3. A synchronise (accepté).
4. B synchronise.
5. **Attendu** : B reçoit un **conflit**, le bandeau affiche « Conflit à
   vérifier ». En cliquant dessus, B voit sa valeur et la valeur synchronisée,
   et choisit laquelle conserver. Aucune valeur n'est écrasée en silence.

### 7. Pull après échec de push

1. Créer une opération locale.
2. Rendre le serveur injoignable (réseau coupé) : le push échoue.
3. Rétablir la lecture (revenir en ligne) : un pull a lieu.
4. **Attendu** : la valeur locale n'est **pas** remplacée par le pull, et
   l'opération reste dans l'outbox jusqu'à confirmation.

### 8. Mise à jour de la PWA

1. Installer/ouvrir une ancienne version.
2. Déployer une nouvelle version (nouveau `CACHE` dans `sw.js`).
3. Ouvrir avec un réseau lent.
4. **Attendu** : l'ancienne version fonctionnelle s'affiche immédiatement ; la
   nouvelle est récupérée en arrière-plan ; un bandeau discret « Une nouvelle
   version est prête · Actualiser » apparaît. L'actualisation ne perd aucune
   saisie locale en attente.
