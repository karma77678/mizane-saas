# Déploiement de Mizan

Mizan tourne aujourd'hui en local. Ce document décrit la configuration
nécessaire pour le mettre en ligne plus tard (Railway, AWS, ou tout
hébergeur de conteneurs) **sans dépendance à une plateforme particulière**.
Aucun déploiement n'est effectué ici.

## 1. Architecture

Deux artefacts indépendants :

| Artefact | Rôle | Commande de production |
|---|---|---|
| `artifacts/api-server` | API Express + accès PostgreSQL | `node dist/index.mjs` |
| `artifacts/audit-maroc` | Interface React (fichiers statiques) | `dist/public/` à servir |

Deux modes de déploiement sont possibles, au choix :

**Mode A — processus unique (le plus simple).** L'API sert aussi l'interface.
Définissez `SERVE_STATIC_DIR` : l'API expose les fichiers statiques et renvoie
`index.html` pour les routes côté client, `/api/*` restant prioritaire.
Un seul service, une seule origine, pas de CORS, pas de `APP_ORIGIN`.

```
SERVE_STATIC_DIR=../audit-maroc/dist/public   # relatif au dossier de travail de l'API
```

**Mode B — deux services.** L'interface est servie par un CDN ou un hébergeur
statique, l'API séparément. Il faut alors définir `APP_ORIGIN` sur l'origine
exacte de l'interface ; cela active CORS avec credentials et bascule le cookie
de session en `SameSite=None; Secure`.

```
APP_ORIGIN=https://app.mon-cabinet.ma
```

> Le mode A est recommandé pour démarrer : moins de configuration, et le cookie
> de session reste en `SameSite=Lax`, ce qui est plus robuste.

## 2. Variables d'environnement

`.env.example` est la référence complète et commentée. Résumé :

### Obligatoire

| Variable | Description |
|---|---|
| `DATABASE_URL` | Chaîne de connexion PostgreSQL. Supabase : *Project settings → Database → Connection string → URI*. Privilégiez l'hôte pooler (port 6543) pour le trafic applicatif. |

### Fortement recommandé en production

| Variable | Valeur | Effet |
|---|---|---|
| `NODE_ENV` | `production` | Cookie de session `Secure`, logs JSON (pas de `pino-pretty`). |
| `PORT` | injecté par la plateforme | Port d'écoute. Défaut `8080`. |
| `TRUST_PROXY` | `1` derrière un load balancer | Lit l'IP client dans `X-Forwarded-For`. **Important** : les limiteurs de débit (connexion, IA) utilisent `req.ip` ; activer cette option sans proxy réel permettrait de contourner ces limites en falsifiant l'en-tête. Par défaut : `1` si `NODE_ENV=production`, sinon désactivé. |
| `MIZAN_BOOTSTRAP_ADMIN_EMAIL` | l'e-mail de l'administrateur | Seul cet e-mail exact reçoit le rôle admin global à l'inscription. |

### Optionnel

| Variable | Défaut | Description |
|---|---|---|
| `APP_ORIGIN` | vide | Origine de l'interface si elle est hébergée séparément (mode B). |
| `SERVE_STATIC_DIR` | vide | Sert l'interface depuis l'API (mode A). |
| `GROQ_API_KEY` | vide | Active le Niveau 2 (analyse sémantique IA), les brouillons de correction IA et la revue agrégée. Vide = aucun appel IA ; le Niveau 1 déterministe fonctionne seul. |
| `GROQ_PLAN` | `free` | Plan affiché sur la page « Consommation IA » (`free` ou `paid`). Groq n’expose pas d’API de facturation. |
| `GROQ_BASE_URL` | API Groq officielle | Réservé aux tests : redirige vers un serveur compatible OpenAI (le faux Groq des suites). Ne pas définir en production. |
| `GROQ_DAILY_TOKEN_LIMIT` / `GROQ_DAILY_REQUEST_LIMIT` | `200000` / `1000` | Limites journalières des jauges de consommation (plan gratuit Groq pour `openai/gpt-oss-120b`). Le compteur de tokens est en mémoire du processus. |
| `LOG_LEVEL` | `info` | Niveau de log pino. |
| `REQUEST_TIMEOUT_MS` | `120000` | Délai maximal d'une requête HTTP avant un `504` JSON. |
| `JSON_BODY_LIMIT` | `50mb` | Taille maximale du corps JSON (imports structurés). |
| `DATABASE_SSL` | `auto` | `auto` \| `require` \| `verify-full` \| `disable`. `auto` ne désactive TLS que pour les hôtes locaux. **La vérification du certificat reste toujours active.** |
| `DATABASE_CA_CERT_PATH` | `./prod-ca-2021.crt` si présent | CA supplémentaire, ajoutée **en plus** du magasin système (nécessaire pour une connexion directe `db.<ref>.supabase.co`). |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `10000` | Attente maximale d'une connexion. Évite qu'un port PostgreSQL bloqué fasse attendre une requête indéfiniment. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `60000` | Durée maximale d'une requête SQL (côté serveur et client). |
| `DATABASE_IDLE_TIMEOUT_MS` | `30000` | Fermeture des connexions inactives. |
| `DATABASE_POOL_MAX` | `8` | Connexions simultanées. À ajuster selon les limites du pooler et le nombre d'instances. |

### Secrets — règles

- Ne committez jamais `.env` ni `.env.local` (uniquement les `.example`).
- Fournissez les secrets par le gestionnaire de la plateforme
  (Railway Variables, AWS Secrets Manager / SSM Parameter Store).
- Tout identifiant qui a été committé doit être considéré comme compromis et
  **renouvelé** : Supabase → *Project settings → Database → Reset database
  password*, puis mise à jour de `DATABASE_URL`.

## 3. Construction et démarrage

```bash
pnpm install --frozen-lockfile
pnpm run build          # typecheck + API (esbuild) + interface (Vite) + archive source
pnpm run start          # node artifacts/api-server/dist/index.mjs
```

`pnpm run build` fonctionne sous Windows, macOS, Linux et en CI : l'étape de
pré-build qui produit `mizan-code-source.zip` est un script Node
(`scripts/build-mizan-source-zip.mjs`) et ne requiert ni `bash` ni `zip`.

Vérification avant démarrage :

```bash
pnpm run check:env      # variables + joignabilité TCP de PostgreSQL, sans afficher de secret
```

## 4. Base de données

Le schéma est décrit dans `lib/db/src/schema/index.ts` et dans la migration
`lib/db/migrations/0001_mizan_saas.sql` (7 tables : `users`, `workspaces`,
`workspace_members`, `dossiers`, `imports`, `constats`, `sessions`).

- **Première installation** : appliquer `lib/db/migrations/0001_mizan_saas.sql`.
- **Base existante** : ne lancez pas `pnpm run db:push` à l'aveugle. `drizzle-kit
  push` compare et modifie le schéma ; relisez toujours le plan proposé et
  sauvegardez avant d'appliquer quoi que ce soit.
- `drizzle.config.ts` lit `DATABASE_URL` depuis l'environnement et refuse de
  démarrer si la variable est absente, pour ne jamais viser une base par défaut.

## 5. Vérifications de santé

| Route | Usage |
|---|---|
| `GET /api/healthz` | Liveness. Ne touche pas la base. À utiliser pour le health check de la plateforme. |
| `GET /api/readyz` | Readiness. Exécute `select 1` ; renvoie `503` et la cause si la base est injoignable. |

Configurez le health check de la plateforme sur `/api/healthz` : l'instance ne
sera pas redémarrée en boucle pendant une indisponibilité passagère de la base.

## 6. Exemples de plateformes

Rien dans le code n'est spécifique à une plateforme ; seules les variables
changent.

**Railway** — un service par artefact, ou le mode A :
- Build : `pnpm install --frozen-lockfile && pnpm run build`
- Start : `pnpm run start`
- Variables : `DATABASE_URL`, `NODE_ENV=production`, `TRUST_PROXY=1`,
  `SERVE_STATIC_DIR=../audit-maroc/dist/public`, `MIZAN_BOOTSTRAP_ADMIN_EMAIL`.
- `PORT` est injecté automatiquement.

**AWS (ECS/Fargate, App Runner, Elastic Beanstalk)** :
- Même build. Démarrage `node artifacts/api-server/dist/index.mjs`.
- `TRUST_PROXY=1` derrière un ALB.
- Secrets via Secrets Manager / SSM, injectés comme variables d'environnement.
- Si la base est un RDS avec une CA privée, pointez `DATABASE_CA_CERT_PATH`
  sur le bundle correspondant. Ne désactivez pas la vérification TLS.

**Conteneur** : l'image doit contenir Node 22+, les dépendances installées et
`dist/` construit. Le processus gère `SIGTERM` : l'écoute HTTP est fermée puis
le pool PostgreSQL est drainé avant la sortie, ce qui rend les redéploiements
propres.

## 7. Notes de montée en charge

À connaître avant de passer à plusieurs instances :

- `DATABASE_POOL_MAX` est **par instance**. Avec un pooler Supabase, gardez
  `instances × DATABASE_POOL_MAX` sous la limite du pooler.
- Les sessions sont en base (table `sessions`), donc partagées entre instances :
  aucune affinité de session n'est nécessaire.
- Les limiteurs de débit (`express-rate-limit`) et le quota journalier de revue
  IA sont **en mémoire du processus**. Avec plusieurs instances, les limites
  sont donc appliquées par instance. Pour une limite globale, il faudra un
  magasin partagé (Redis) ; ce n'est pas nécessaire sur une instance unique.
- Les lignes `sessions` expirées ne sont purgées que lors de la connexion de
  l'utilisateur concerné. Une tâche périodique
  (`delete from sessions where expires_at < now()`) est souhaitable à terme.
