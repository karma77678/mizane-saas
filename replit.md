# Mizan — SaaS d’audit comptable marocain

Mizan propose des contrôles indicatifs pour journaux, grands livres et balances, une revue assistée par IA, des propositions de régularisation et un export de dossier de travail. Les données sources ne sont jamais modifiées automatiquement ; toute proposition doit être confirmée explicitement.

## Configuration Replit

1. Provisionner PostgreSQL dans Replit et ajouter `DATABASE_URL` aux Secrets du projet.
2. Optionnel : ajouter `GROQ_API_KEY` pour activer les demandes de correction IA et la revue agrégée. L’interface confirme explicitement avant d’envoyer à Groq les lignes nécessaires à une correction détaillée.
3. Optionnel : définir `MIZAN_BOOTSTRAP_ADMIN_EMAIL` pour attribuer le rôle global `admin` au compte correspondant au moment de son inscription. Les rôles de membre (`admin`, `auditeur`, `client`) sont gérés séparément par cabinet.
4. Pour un déploiement sur une seule origine, laisser `APP_ORIGIN` vide. Si le frontend est sur une autre origine, renseigner l’origine publique exacte dans `APP_ORIGIN`.
5. Installer les dépendances puis appliquer le schéma Drizzle à la base configurée :

   ```bash
   pnpm install
   pnpm --filter @workspace/db run push
   pnpm run typecheck
   pnpm run build
   ```

   Le SQL de référence versionné est `lib/db/migrations/0001_mizan_saas.sql`. `push` synchronise le schéma Drizzle courant avec la base cible ; faire une sauvegarde et une revue du diff avant de l’utiliser sur une base qui contient déjà des données.


## Exécution et tests en local (Windows / macOS / Linux)

Prérequis : Node.js 22+, pnpm compatible avec le lockfile, et Docker Desktop (ou un PostgreSQL local). Les commandes `pnpm` doivent être lancées depuis la racine du dépôt.

1. Installer les dépendances : `pnpm install`.
2. Démarrer PostgreSQL avec `docker compose -f docker-compose.local.yml up -d`. Ce fichier utilise des identifiants réservés au poste local ; ne les réutilisez jamais dans un environnement exposé.
3. Copier `.env.local.example` vers `.env.local`, puis charger `DATABASE_URL` dans chaque terminal. Sur PowerShell, exécutez `$env:DATABASE_URL = "postgresql://mizan:mizan_dev_only@127.0.0.1:5432/mizan"`. Sur macOS/Linux/Git Bash, exécutez `set -a; source .env.local; set +a`.
4. Appliquer le schéma à la base locale **de développement uniquement** : `pnpm run db:push`.
5. Dans le terminal 1, charger les variables puis lancer l’API : sur PowerShell, définir `$env:PORT = "8080"` et exécuter `pnpm run dev:api`. Sur macOS/Linux/Git Bash, exécuter `PORT=8080 pnpm run dev:api`.
6. Dans le terminal 2, lancer le frontend : sur PowerShell, définir `$env:PORT = "19711"`, `$env:BASE_PATH = "/"`, `$env:API_PROXY_TARGET = "http://127.0.0.1:8080"`, puis exécuter `pnpm run dev:web`. Sur macOS/Linux/Git Bash, exécuter `PORT=19711 BASE_PATH=/ API_PROXY_TARGET=http://127.0.0.1:8080 pnpm run dev:web`.
7. Ouvrir `http://localhost:19711`. L’API de santé doit répondre sur `http://localhost:8080/api/healthz`. Créer un compte à l’écran : l’inscription crée aussi un cabinet et un dossier de test.

L’IA est optionnelle : laissez `GROQ_API_KEY` vide pour tester import, contrôles, revue et export sans appels facturés. Avant de tester l’IA, ajoutez une vraie clé dans l’environnement du terminal API, jamais dans le code ou dans un dépôt public. Pour repartir d’une base locale vierge, supprimez le volume Docker avec `docker compose -f docker-compose.local.yml down -v` (cette action efface les données locales).

## Stack

- pnpm workspaces, TypeScript 5.9
- UI : React + Vite (`artifacts/audit-maroc`)
- API : Express 5 (`artifacts/api-server`), montée sous `/api` sur le port 8080 de l’artefact
- Base : PostgreSQL + Drizzle ORM (`lib/db`)
- Authentification : mots de passe hachés avec scrypt, sessions opaques dont seul le hash est stocké en base, cookie `HttpOnly`, expiration 14 jours
- IA : Groq `openai/gpt-oss-120b` (API compatible OpenAI), optionnelle et protégée par session + limitation de débit

## Architecture et isolation des données

- Tables : `users`, `workspaces`, `workspace_members`, `dossiers`, `imports`, `constats`, `sessions`.
- Toute lecture et mutation de dossiers, imports et constats est contrôlée à partir de l’appartenance à un cabinet. Les membres `client` sont en lecture seule dans l’API.
- Les fichiers sont décodés et présentés dans le navigateur pour l’aperçu ; après confirmation d’import, les données structurées et les lignes sources utiles sont conservées dans PostgreSQL, attachées au dossier.
- Les règles locales s’exécutent sur une source comptable active à la fois pour éviter de compter deux fois un journal, grand livre et balance qui représenteraient le même exercice.
- La revue agrégée IA transmet des totaux, l’exercice et des décomptes de règles. La correction IA détaillée nécessite une confirmation séparée et ne transmet que le constat sélectionné et jusqu’à 50 lignes sources associées.
- Le bouton `Confirmer et Appliquer` confirme et enregistre la proposition de régularisation dans le dossier de travail. L’écriture source importée demeure immuable ; la proposition acceptée et son statut sont persistés et reportés dans Excel.
- `Revue d’audit` comprend le tableau des constats, les références pièce/ligne, une grille source avec les cellules utiles surlignées, et un export Excel avec `Résumé`, `Constats` et `Dossier de travail`.

## Commandes

- `pnpm --filter @workspace/api-server run dev` — API Express
- `pnpm --filter @workspace/db run push` — synchronisation du schéma sur la base de développement configurée
- `pnpm run typecheck` — vérification TypeScript complète
- `pnpm run build` — typecheck puis build des artefacts
- `pnpm --filter @workspace/api-spec run codegen` — régénérer le client depuis OpenAPI
- `pnpm run build:mizan-source-zip` — créer l’archive source distribuable

## Limites

- Les PDF scannés nécessitent un OCR avant import ; l’extraction de PDF textuels doit être relue.
- Les contrôles fiscaux et les propositions IA sont indicatifs, peuvent manquer de contexte et nécessitent la vérification d’un professionnel marocain.
- La migration SQL est fournie avec le code, mais son application effective dépend de `DATABASE_URL` dans l’environnement Replit visé.
