# Partage multi-appareils via ta feuille Google (sans backend ni VPS)

Ce dossier contient le petit script qui transforme **ta feuille Google** en
base de données partagée pour la PWA. Google héberge ce script gratuitement :
tu n'as **aucun serveur** à installer ni à maintenir.

> Modèle d'accès choisi : **lien secret, sans code**.
> L'URL du script *est* le secret — toute personne qui la possède peut lire et
> écrire le planning. Ne la partage qu'avec les bonnes personnes.

## Installation (une seule fois, ~3 minutes)

1. Ouvre **ta feuille Google** (celle avec les onglets Janvier→Décembre).
2. Menu **Extensions → Apps Script**.
3. Efface le contenu par défaut, **colle tout le contenu de `Code.gs`**, puis
   enregistre (icône disquette).
4. Clique **Déployer → Nouveau déploiement**.
   - Roue dentée → type **« Application Web »**.
   - **Exécuter en tant que** : *Moi*.
   - **Qui a accès** : *Tout le monde*.
   - **Déployer**, puis autorise l'accès (écran Google « non vérifié » →
     *Paramètres avancés* → *Accéder au projet*). C'est ton propre script.
5. Copie l'**URL de l'application Web** (elle se termine par `/exec`).

## Connexion de l'app

1. Ouvre la PWA, clique le bouton **☁ Synchronisation**.
2. Colle l'URL `/exec`, choisis l'**année** que représente la feuille
   (ex. 2027), puis **Tester & enregistrer**.
3. C'est tout : chaque saisie est écrite dans la feuille, et l'app se
   resynchronise à l'ouverture et périodiquement. Installe la PWA sur chaque
   appareil et colle la même URL → tout le monde voit les mêmes données.

## Notes

- **Une feuille = une année** (12 onglets mensuels). Pour une autre année,
  duplique la feuille et déploie le même script dessus.
- Le serveur **recalcule lui-même** les colonnes *Heures* et *Montant* (arrondi
  à la demi-heure inclus, même logique que l'app) à chaque écriture, et à chaque
  changement de taux. Tu n'as rien à faire.
- **Taux horaire daté** : l'historique des taux est conservé dans un onglet
  **`Taux`** (créé automatiquement) — colonne A = date de début (`AAAA-MM-JJ`),
  colonne B = taux €/h. Chaque jour est payé au taux en vigueur à sa date ; la
  cellule `B1` des onglets mensuels reflète le taux du jour courant.
- Hors-ligne, l'app fonctionne sur son cache local et renvoie les modifications
  dès que la connexion revient.

## Écritures par champ, idempotence et conflits (v2)

Le script écrit désormais **un seul champ à la fois** (arrivée **ou** départ) :
une modification de l'arrivée ne peut plus effacer le départ d'un autre
téléphone.

Deux onglets techniques sont créés automatiquement et **masqués** :

| Onglet       | Rôle                                                              |
|--------------|------------------------------------------------------------------|
| `_SyncMeta`  | Une ligne par cellule synchronisée : `cellKey`, `révision`, `valeur`, dernier `opId`, `deviceId`, date serveur. Sert à détecter les conflits et à exposer la révision courante. |
| `_SyncOps`   | Journal des identifiants d'opérations déjà appliqués (idempotence). Taille **bornée** à `OPS_CAP` (2000) : les plus anciens sont supprimés en FIFO. |

- **Idempotence** : si une réponse réseau est perdue et que l'app rejoue la même
  opération, le script la reconnaît (par `opId`, ou par égalité de valeur si le
  journal a été purgé) et renvoie un succès **sans** ré-appliquer.
- **Conflit** : si la révision de base envoyée par l'app est périmée **et** que
  la valeur voulue diffère de la valeur serveur, le script renvoie un conflit
  explicite (valeur et révision serveur incluses). Aucune valeur n'est écrasée
  en silence — l'utilisateur tranche dans l'app.
- **Verrou** : le script utilise `LockService` correctement — si le verrou n'est
  **pas** acquis, il n'écrit rien et renvoie une erreur exploitable
  (`busy: true`) ; l'app réessaie plus tard.

> Ces onglets techniques ne doivent pas être supprimés ni renommés. Si tu les
> effaces, ils seront recréés vides : les révisions repartent de zéro (sans
> perte de données de planning). Tu peux les afficher (clic droit sur un onglet
> → *Afficher les feuilles masquées*) pour inspection.

## Mettre à jour le script plus tard

Recolle **tout** le contenu de `Code.gs`, puis **Déployer → Gérer les
déploiements → (crayon) → Version : Nouvelle version → Déployer**. L'URL `/exec`
reste la même — rien à recoller côté app.

> Compatibilité : l'ancienne action `write` (jour entier) reste acceptée le
> temps qu'un appareil encore sur l'ancienne version se mette à jour. Une fois
> tous les appareils à jour, seules les écritures par champ sont utilisées.
