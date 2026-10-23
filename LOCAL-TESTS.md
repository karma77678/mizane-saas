# Lancer Mizan en local pour des tests manuels

## Prérequis

- Node.js 22 ou plus récent
- pnpm (la workspace utilise `pnpm-lock.yaml`)
- Docker Desktop, ou un serveur PostgreSQL disponible localement

## 0. Diagnostic rapide (à faire en premier)

```bash
pnpm run check:env
```

Affiche les variables chargées (sans jamais afficher de secret) et teste la
joignabilité TCP du port PostgreSQL. C'est ce qui permet de distinguer :

- `connected` : le port est ouvert ; un échec restant vient de TLS, des
  identifiants ou du schéma. Démarrez l'API et ouvrez `/api/readyz`.
- `timed out` : les paquets sont **jetés** — c'est un pare-feu réseau, pas un
  bug applicatif. Plusieurs réseaux d'entreprise bloquent les ports 5432/6543 ;
  un partage de connexion mobile permet de le confirmer.
- `refused` : l'hôte répond mais rien n'écoute sur ce port.

Tests automatisés :

```bash
pnpm run test       # 128 tests : contrat HTTP de l'API, contrôles des corrections, de la revue IA et du Niveau 2 sémantique, compteur de consommation Groq, scénario d'audit hybride de bout en bout (faux Groq local), logique d'import, règle FISC-03 du moteur d'audit. Ni base ni réseau requis.
pnpm run test:db    # end-to-end sur PostgreSQL, dont l'audit hybride. Nécessite MIZAN_TEST_DATABASE_URL (voir §5).
pnpm run test:live  # audit hybride contre le vrai Groq (données fictives, ~4 000 tokens). Nécessite MIZAN_LIVE_GROQ=1 (voir §5 bis).
```

## 1. Installer les dépendances et lancer PostgreSQL

Depuis la racine du projet :

```bash
pnpm install
docker compose -f docker-compose.local.yml up -d
```

La base Docker de développement écoute sur `127.0.0.1:5432` avec la base `mizan` et les identifiants `mizan / mizan_dev_only`. Ils sont uniquement destinés aux tests locaux.

Copiez `.env.local.example` vers `.env.local`. Sous PowerShell :

```powershell
Copy-Item .env.local.example .env.local
$env:DATABASE_URL = "postgresql://mizan:mizan_dev_only@127.0.0.1:5432/mizan"
```

Sous macOS/Linux/Git Bash :

```bash
cp .env.local.example .env.local
set -a; source .env.local; set +a
```

## 2. Créer le schéma de la base

Dans un terminal où `DATABASE_URL` est défini :

```bash
pnpm run db:push
```

N’utilisez cette commande que sur la base locale de développement. Pour une base existante, sauvegardez-la et relisez les changements avant d’appliquer le schéma.

## 3. Démarrer l’API et l’interface

Ouvrez **deux terminaux** à la racine du projet. Chargez/définissez `DATABASE_URL` dans les deux terminaux.

**Terminal A — API Express :**

PowerShell :

```powershell
$env:PORT = "8080"
pnpm run dev:api
```

macOS/Linux/Git Bash :

```bash
PORT=8080 pnpm run dev:api
```

**Terminal B — frontend Vite :**

PowerShell :

```powershell
$env:PORT = "19711"
$env:BASE_PATH = "/"
$env:API_PROXY_TARGET = "http://127.0.0.1:8080"
pnpm run dev:web
```

macOS/Linux/Git Bash :

```bash
PORT=19711 BASE_PATH=/ API_PROXY_TARGET=http://127.0.0.1:8080 pnpm run dev:web
```

Ouvrez ensuite **http://localhost:19711**. L’API de santé doit répondre à **http://localhost:8080/api/healthz** avec `{"status":"ok"}`.

## 4. Parcours de test recommandé

1. Créer un compte depuis l’écran d’inscription et vérifier que le cabinet et le dossier initial apparaissent.
2. Se déconnecter puis se reconnecter pour vérifier la persistance de la session.
3. Importer un petit CSV/XLSX de test, confirmer l’import et vérifier que l’import et les constats restent visibles après rafraîchissement.
4. Ouvrir la revue d’audit, cliquer un constat, inspecter la ligne source, changer son statut et vérifier qu’il persiste.
5. Générer un rapport Excel et vérifier les feuilles `Résumé`, `Constats` et `Dossier de travail`.
6. Tester l’IA séparément. Elle est facultative et nécessite `GROQ_API_KEY` dans l’environnement du terminal de l’API ; clé gratuite sur console.groq.com, avec quotas limités. N’envoyez pas de vraies données clients sans autorisation.

## 5. Tests end-to-end sur PostgreSQL

`pnpm run test:db` exécute le parcours complet (inscription, connexion,
import, persistance après reconnexion, synchronisation des constats,
isolation entre cabinets, rôle `client` en lecture seule) contre une vraie
base de données.

La suite est **désactivée par défaut** et exige une variable distincte de
`DATABASE_URL`, afin de ne jamais viser une base de production par accident :

```powershell
$env:MIZAN_TEST_DATABASE_URL = "postgresql://USER:PASSWORD@HOST:6543/postgres"
pnpm run test:db
```

Elle ne crée que ses propres lignes, chacune marquée par un identifiant de
session unique, et les supprime à la fin. Elle ne supprime, ne tronque et ne
modifie aucune table, et ne touche aucune ligne qu’elle n’a pas créée.

## 5 bis. Scénario d’audit hybride (Niveau 1 + Niveau 2)

Le même scénario, sur un journal fictif de 10 lignes, est joué à trois niveaux :

1. Niveau 1 déterministe exécuté localement, sans appel IA.
2. Niveau 2 par lots regroupés par pièce, avec réponse inventée filtrée par le serveur, pause sur 429 et refus des lots invalides.
3. Accepter & fusionner / Rejeter, enregistrés dans `constats` puis relus.
4. Correction IA sur le constat fusionné, puis revue agrégée limitée aux codes du Niveau 1.
5. Page « Consommation IA » : requêtes, tokens au jeton près, quota lu dans les en-têtes Groq, clé refusée ou absente.

| Suite | Fichier | Groq | Base | Lancement |
|---|---|---|---|---|
| Intégration hors ligne | `hybrid-audit.test.mjs` | faux serveur local (`fake-groq.mjs`) | aucune | `pnpm run test` |
| De bout en bout | `hybrid-audit.db.test.mjs` | faux serveur local | PostgreSQL de test | `pnpm run test:db` |
| Live | `hybrid-audit.live.test.mjs` | vrai Groq | aucune | `pnpm run test:live` |

Les suites hors ligne et live montent les vraies routes IA dans le processus de test (`ai-routes-harness.mjs`) ; seule la vérification de session est remplacée, elle est couverte par la suite avec base. Le faux Groq est branché par la variable `GROQ_BASE_URL`.

```powershell
$env:MIZAN_LIVE_GROQ = "1"
$env:NODE_OPTIONS = "--use-system-ca"   # réseau d’entreprise avec inspection TLS
pnpm run test:live                      # GROQ_API_KEY lue dans l’environnement ou .env.local
```

## Dépannage

- `DATABASE_URL must be set` : le terminal qui lance l’API ou la migration n’a pas cette variable d’environnement. `pnpm run check:env` indique quels fichiers `.env` ont été chargés.
- **Le bouton « Confirmer l’importation » semble bloqué** : lancez `pnpm run check:env`. Un résultat `timed out` signale un port PostgreSQL bloqué par le réseau. L’application répond désormais par une erreur explicite au bout du délai configuré (`DATABASE_CONNECTION_TIMEOUT_MS`, 10 s par défaut) au lieu d’attendre indéfiniment, et le message s’affiche sous le bouton.
- **Un `#` dans `DATABASE_URL`** : un commentaire a été écrit sur la même ligne que la valeur dans le fichier `.env`. Un `#` ne commence un commentaire que s’il est précédé d’une espace ; sinon il fait partie de la chaîne de connexion. Mettez le commentaire sur sa propre ligne. `pnpm run check:env` détecte ce cas.
- Erreur de connexion PostgreSQL : vérifiez que le conteneur tourne avec `docker compose -f docker-compose.local.yml ps`.
- Erreur `EADDRINUSE` : les ports `8080` ou `19711` sont déjà utilisés ; arrêtez le processus correspondant ou choisissez un autre `PORT` et adaptez `API_PROXY_TARGET`.
- L’écran s’ouvre, mais les routes `/api` échouent : vérifiez que l’API tourne sur `8080` et que le frontend a démarré avec `API_PROXY_TARGET=http://127.0.0.1:8080`.
- Erreur de certificat TLS vers la base : la vérification du certificat est active par défaut (elle ne doit pas être désactivée). Pour une connexion directe `db.<ref>.supabase.co`, pointez `DATABASE_CA_CERT_PATH` sur le bundle CA Supabase à jour. Pour une base locale sans TLS, `DATABASE_SSL=disable`.
- **L’IA répond « Impossible de générer une proposition » et les logs de l’API indiquent `Connection error`** (souvent `SELF_SIGNED_CERT_IN_CHAIN`) : le réseau d’entreprise inspecte le trafic HTTPS (pare-feu de type Palo Alto) et Node ne fait pas confiance à son certificat racine, alors que Windows oui. Lancez l’API avec le magasin de certificats du système, sans désactiver la vérification TLS. Sous PowerShell : `$env:NODE_OPTIONS = "--use-system-ca"; pnpm run dev:api` (Git Bash : `NODE_OPTIONS=--use-system-ca pnpm run dev:api`). Nécessite Node 22.15 ou plus récent. Inutile sur Railway, Replit ou un réseau sans inspection.
- Pour effacer les données de test et supprimer le volume PostgreSQL : `docker compose -f docker-compose.local.yml down -v`. Cette action est destructive.

## Niveau de validation

`pnpm run typecheck`, `pnpm run build` (sous Windows) et `pnpm run test`
(128 tests) sont exécutés et passent. `pnpm run test:db` n’a **pas** pu être
exécuté dans l’environnement de préparation : le réseau y bloquait le port
PostgreSQL de Supabase (`check:env` → `timed out`) et aucune base locale
n’était disponible. Lancez-le depuis un réseau où la base est joignable
(partage de connexion mobile) pour valider la persistance et l’isolation.

## Build multiplateforme

L’étape de pré-build qui produit `mizan-code-source.zip` est un script Node
(`scripts/build-mizan-source-zip.mjs`) : elle ne requiert ni `bash` ni le
binaire `zip`, et `pnpm run build` fonctionne donc sous PowerShell, cmd,
macOS, Linux et en CI. `scripts/build-mizan-source-zip.sh` est conservé
uniquement comme passerelle pour les appelants POSIX existants.

Cette archive ne désactive plus les dépendances natives Windows de esbuild,
Rollup, Lightning CSS et Tailwind. À la première installation, laissez pnpm
mettre à jour `pnpm-lock.yaml` si nécessaire. Utilisez Node.js 22.12+ pour
Vite 7.
