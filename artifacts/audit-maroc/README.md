# Mizan — Audit comptable marocain

Mizan importe des documents comptables dans un espace local au navigateur, exécute des contrôles arithmétiques et de cohérence explicables, puis enregistre les décisions de revue. Aucune écriture source n’est modifiée automatiquement.

## Formats pris en charge

- CSV et fichiers texte délimités
- Classeurs XLS/XLSX (choix de feuille lorsque le fichier en contient plusieurs)
- PDF textuels dont le texte est sélectionnable

Les PDF scannés nécessitent un OCR préalable. L’extraction de tableaux PDF est indicative : vérifiez l’aperçu et l’association des colonnes avant de confirmer. Les fichiers sont limités à 100 Mo et 250 000 lignes.

## Données et IA

L’audit fonctionne sur deux niveaux. **Niveau 1** : le moteur déterministe (`src/lib/audit-engine.ts`) s’exécute dans le navigateur à chaque import, sans IA ni coût API. **Niveau 2** (facultatif, onglet « Constats sémantiques IA » de la revue) : après consentement explicite, les lignes du périmètre choisi (200 lignes par analyse, par lots de 50 regroupés par pièce) sont envoyées à `POST /api/audit/semantic-review`. Sont transmis la date, le compte, son libellé, la pièce, le libellé d’écriture, le débit et le crédit, jamais le nom du fichier ou du client. Le serveur ne garde que les codes `IA-*` connus et les lignes réellement envoyées, et calcule lui-même le titre et le montant. Une prédiction n’entre dans le dossier de travail (constats, rapport Excel, correction IA) qu’après « Accepter & fusionner » ; la décision est enregistrée dans la table `constats` (référence « Niveau 2 IA · fusionné|rejeté · … »). La page « Consommation IA » (`GET /api/ai/usage`) affiche requêtes, tokens, statut de la clé et plan.

Les lignes importées et l’historique de revue restent dans le navigateur utilisé. N’utilisez pas un ordinateur partagé pour des documents sensibles. La revue IA optionnelle n’est appelée qu’après consentement ; elle reçoit l’exercice, les totaux débit/crédit, les écarts et, pour chaque code de règle, son intitulé fixe défini par Mizan et le nombre de constats, jamais les fichiers, comptes, descriptions ou écritures détaillées. L’API est limitée à 6 demandes par minute et 60 par jour et n’accepte pas les demandes de navigateur intersites. L’usage de Groq est décompté sur le compte associé à `GROQ_API_KEY` (offre gratuite avec quotas). Ajoutez la clé dans les Secrets du projet ; ne l’inscrivez jamais dans le code.

## Exécution dans Replit

Utilisez les workflows gérés `artifacts/audit-maroc: web` et `artifacts/api-server: API Server`. Ils fournissent les variables d’exécution telles que `PORT` et `BASE_PATH`. Le mode d’audit local fonctionne sans clé Groq ; cette clé n’est nécessaire que pour la revue IA facultative.

## Portée comptable et fiscale

Les contrôles comprennent notamment :

- `DUP-01` : même référence, compte et montant, avec des dates identiques ou séparées de trois jours au plus.
- `BAL-02` : compte fournisseur `4411` débiteur ou compte client `3421` créditeur.
- `BAL-03` : compte de caisse `5161` créditeur à une date ou sur la balance.
- `REG-01` : mouvement débiteur sur `3491`/`4497` dans un journal `BQ`/`CS` sans référence de pièce importée.
- `FISC-01` : crédit caisse supérieur à 5 000 MAD avec contrepartie de charge de classe 6.
- `FISC-02` : utilisation d’un compte `6583` ou sous-compte.
- `FISC-03` : taux reconstitué sur `3455` comparé à la charge liée de classe 6 ; les taux par défaut sont 20, 14, 10 et 7 %, modifiables dans les paramètres. Le constat porte toutes les lignes de la pièce (charge et TVA en premier), pour que la correction IA connaisse le compte fournisseur.

`REG-01` ne prouve pas l’absence d’une pièce : l’application ne vérifie que les références présentes dans le fichier importé. Les règles et seuils fiscaux sont des indicateurs configurables à confirmer selon l’exercice et les textes en vigueur. Faites vérifier les résultats par un professionnel qualifié.

## Archive du code

Depuis la racine du workspace, exécutez `pnpm build:mizan-source-zip`. L’archive sera disponible sous `artifacts/audit-maroc/public/mizan-code-source.zip`.
