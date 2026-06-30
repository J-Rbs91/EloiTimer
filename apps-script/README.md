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
- L'app reste la référence des calculs (arrondi à la demi-heure inclus) : elle
  écrit aussi les colonnes *Heures* et *Montant* pour que la feuille affiche les
  mêmes valeurs.
- **Taux horaire daté** : l'historique des taux est conservé dans un onglet
  **`Taux`** (créé automatiquement) — colonne A = date de début (`AAAA-MM-JJ`),
  colonne B = taux €/h. Chaque jour est payé au taux en vigueur à sa date ; la
  cellule `B1` des onglets mensuels reflète le taux du jour courant. Si tu
  recolles une ancienne version du script, l'onglet `Taux` est simplement ignoré.
- Hors-ligne, l'app fonctionne sur son cache local et renvoie les modifications
  dès que la connexion revient.
- En cas de modification simultanée, c'est la **dernière écriture qui gagne**
  (au niveau de chaque jour).

## Mettre à jour le script plus tard

Recolle `Code.gs`, puis **Déployer → Gérer les déploiements → (crayon) →
Version : Nouvelle version → Déployer**. L'URL `/exec` reste la même.
