# htpasswd-manager

Micro-application web pour créer et maintenir un fichier d'authentification compatible
Mailpit (`MP_UI_AUTH_FILE` / `MP_SMTP_AUTH_FILE`), Apache `htpasswd` et Nginx `auth_basic_user_file`.

## Image Docker

L'image est publiée sur Docker Hub : [`afidos/htpasswd-manager`](https://hub.docker.com/r/afidos/htpasswd-manager).

```sh
docker pull afidos/htpasswd-manager:latest
```

Lancement autonome (sans compose) :

```sh
docker run -d --name htpasswd-manager \
  -e ADMIN_USER=admin -e ADMIN_PASSWORD='changez-moi' \
  -v htpasswd-data:/data \
  -p 127.0.0.1:8080:8080 \
  --read-only --tmpfs /tmp:size=1m --cap-drop ALL --security-opt no-new-privileges:true \
  afidos/htpasswd-manager:latest
```

## Démarrage (compose)

```sh
cp .env.example .env && chmod 600 .env      # puis éditez ADMIN_PASSWORD
docker compose pull && docker compose up -d  # htpasswd-manager + Mailpit
# ou : docker compose up -d --build          # construction locale
# Interface : http://127.0.0.1:8080 — Mailpit : http://127.0.0.1:8025
```

## Prise en compte des modifications : webhook de rechargement

Nginx et Apache relisent le fichier à chaque requête : rien à faire. Mailpit, lui, ne le lit qu'au démarrage
et doit être relancé. Quand `RELOAD_WEBHOOK_URL` est défini, htpasswd-manager appelle cette URL après chaque
modification ; le service appelé (Dokploy, pipeline…) relance Mailpit. htpasswd-manager n'a besoin d'aucun
accès à Docker.

- Regroupement : plusieurs modifications rapprochées (`RELOAD_WEBHOOK_DELAY_MS`, 2 s) produisent un seul appel.
- Échec (code HTTP hors 2xx, réseau, délai de 10 s) : 3 nouvelles tentatives (2 s, 10 s, 30 s).
- Résultat visible dans l'interface (« rechargement demandé » / « échec du rechargement ») et dans le journal d'audit.
- Corps par défaut : `{"event":"htpasswd.changed","file":"/data/passwords","ts":"…"}`.

### Avec Dokploy

Déployez Mailpit comme **application Dokploy distincte** (image `axllent/mailpit`), pour que seule elle soit
relancée. L'API `application.reload` relance son conteneur sans reconstruire l'image :

```sh
RELOAD_WEBHOOK_URL=https://dokploy.example.fr/api/application.reload
RELOAD_WEBHOOK_HEADERS=x-api-key: <clé API Dokploy>
RELOAD_WEBHOOK_BODY={"applicationId":"<id de l'application Mailpit>","appName":"<nom interne>"}
```

Vérifiez les champs attendus dans le Swagger de votre instance (`https://<dokploy>/swagger`). La clé API
donne accès à Dokploy : gardez-la dans `.env` (`chmod 600`) ou dans un fichier via `RELOAD_WEBHOOK_HEADERS_FILE`.

### Mailpit

- Définissez `MP_DATABASE` sur un volume, sinon les messages capturés sont perdus à chaque relance.
- Tout compte de l'interface Mailpit voit **tous** les messages : Mailpit n'isole pas les boîtes par utilisateur.
  `MP_TAGS_USERNAME=true` étiquette les messages par compte SMTP (tri, pas contrôle d'accès).

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `ENV_FILE` | `.env` | Fichier dotenv chargé au démarrage s'il existe (obligatoire s'il est défini explicitement). Ne remplace jamais une variable déjà présente dans l'environnement |
| `HTPASSWD_PATH` | `/data/passwords` | Fichier géré (son répertoire doit être un volume) |
| `ADMIN_USER` / `ADMIN_PASSWORD` | vide | Identifiants de l'interface. Vides = accès libre. Un seul des deux défini = refus de démarrer |
| `ADMIN_USER_FILE` / `ADMIN_PASSWORD_FILE` | — | Variante Docker secrets |
| `DEFAULT_ALGORITHM` | `bcrypt-2y` | `bcrypt-2y`, `bcrypt-2a`, `sha512`, `sha256`, `apr1`, `md5`, `ssha`, `sha`, `plain` |
| `BCRYPT_COST` | `10` | Coût bcrypt (borné 4–14) |
| `SHACRYPT_ROUNDS` | `5000` | Itérations `$5$`/`$6$` (`rounds=` écrit seulement si ≠ 5000) |
| `SESSION_IDLE_MINUTES` | `60` | Déconnexion après inactivité |
| `SESSION_MAX_HOURS` | `12` | Durée de vie maximale d'une session |
| `COOKIE_SECURE` | `auto` | `auto` (Secure si HTTPS ou `X-Forwarded-Proto: https`), `true`, `false` |
| `TRUST_PROXY` | `false` | `true` derrière un reverse proxy : l'IP client (verrouillage) est lue dans `X-Forwarded-For` |
| `RELOAD_WEBHOOK_URL` | vide | URL appelée après chaque modification (désactivé si vide). Aussi `RELOAD_WEBHOOK_URL_FILE` |
| `RELOAD_WEBHOOK_METHOD` | `POST` | `GET`, `POST`, `PUT` ou `PATCH` |
| `RELOAD_WEBHOOK_HEADERS` | vide | En-têtes `Nom: valeur`, séparés par `;` ou un saut de ligne. Aussi `RELOAD_WEBHOOK_HEADERS_FILE` |
| `RELOAD_WEBHOOK_BODY` | JSON d'événement | Corps envoyé tel quel (`Content-Type: application/json`) |
| `RELOAD_WEBHOOK_DELAY_MS` | `2000` | Délai de regroupement des modifications |
| `LOG_LEVEL` | `info` | Niveau des journaux JSON (pino) |
| `FILE_MODE` | `0640` | Permissions du fichier écrit (octal ; un mode modifiable par tous est refusé) |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Écoute HTTP |

## Interface

Trois sections dans une barre latérale :

- **Utilisateurs** : résumé de sécurité (formats forts, à migrer, en clair), recherche, badge de robustesse par compte,
  ajout et modification dans un panneau latéral, suppression avec confirmation.
- **Fichier brut** : contenu exact du fichier, copie et téléchargement.
- **Journal d'audit** : connexions, échecs et modifications de comptes (500 derniers événements en mémoire ;
  l'historique complet est dans les journaux du conteneur).

## Connexion

L'interface affiche une page de connexion (`/login`) et un bouton de déconnexion dans la barre latérale.
Les sessions sont gardées en mémoire : un redémarrage du conteneur déconnecte tout le monde
(et le service doit tourner en une seule réplique).

Depuis un script, ouvrir une session puis réutiliser le cookie :

```sh
curl -c jar -H 'X-Requested-With: htpasswd-manager' -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"…"}' http://127.0.0.1:8080/api/login
curl -b jar http://127.0.0.1:8080/api/users
```

## API (même origine, en-tête `X-Requested-With: htpasswd-manager` requis pour les écritures)

- `POST /api/login` `{"username","password"}` : ouvre une session (cookie `hm_session`)
- `POST /api/logout` : ferme la session
- `GET /api/users` : utilisateurs (format, robustesse `strong`/`weak`/`none`), contenu brut, date de modification
- `GET /api/audit` : derniers événements d'audit
- `POST /api/users` `{"username","password","algorithm"}` : création (201) ou mise à jour (200)
- `DELETE /api/users/:username`
- `GET /api/download` : téléchargement du fichier
- `GET /healthz` : sonde de santé (sans authentification)

## Sécurité

- Comparaison des identifiants en temps constant, verrouillage 15 min après 10 échecs par IP.
- Session : jeton aléatoire 256 bits, cookie `HttpOnly; SameSite=Strict` (`Secure` en HTTPS), expiration glissante et absolue.
- Anti-CSRF : JSON obligatoire, `Sec-Fetch-Site`/`Origin` vérifiés, en-tête personnalisé exigé.
- CSP stricte sans script inline, rendu DOM sans `innerHTML`.
- Écriture atomique (tmp + fsync + rename + fsync du répertoire), mutex contre les écritures concurrentes.
- Conteneur non-root, système de fichiers en lecture seule, capacités supprimées, npm retiré de l'image.
- Bcrypt : refus des mots de passe > 72 octets (troncature silencieuse sinon).
- Placez l'interface derrière un reverse proxy TLS : mot de passe et cookie circulent en clair sur HTTP.
  En production, forcez `COOKIE_SECURE=true` (le mode `auto` dépend de l'en-tête `X-Forwarded-Proto` du proxy).
- Derrière un proxy, activez `TRUST_PROXY=true` : sinon tous les clients partagent l'IP du proxy et 10 échecs
  verrouillent l'accès pour tout le monde. À l'inverse, ne l'activez pas si l'application est exposée directement :
  `X-Forwarded-For` serait falsifiable et le verrouillage contournable.
- Le fichier `.env` contient le mot de passe administrateur : `chmod 600` (un avertissement est journalisé sinon).
  Il est exclu de l'image Docker et du dépôt Git ; en production, préférez `ADMIN_PASSWORD_FILE` (Docker secrets).
- Les échecs de connexion sont journalisés sans l'identifiant tenté (un mot de passe saisi dans le mauvais champ
  n'apparaît jamais en clair).

## Développement

TypeScript (serveur Fastify + interface), Node.js ≥ 22.18.

```sh
npm ci
npm run dev        # compile dans dist/ puis lance le serveur
npm run typecheck  # vérification des types (serveur, tests, interface)
npm test           # compile puis lance tous les tests
```

```
src/
  server.ts          point d'entrée (config, vérifications, écoute)
  app.ts             assemblage Fastify (injectable, testé via app.inject)
  config.ts          variables d'environnement
  validation.ts      validation des entrées
  audit/             journal d'audit en mémoire
  reload/            webhook de rechargement (regroupement, nouvelles tentatives)
  auth/              sessions, garde (cookie + anti-CSRF), limitation des tentatives
  http/              en-têtes de sécurité, erreurs, fichiers statiques
  routes/            pages, connexion, utilisateurs
  htpasswd/          formats de hachage, stockage atomique du fichier
public/              interface : HTML, CSS et TypeScript compilé vers dist/public
  app.ts             navigation entre les vues
  views/             utilisateurs, fichier brut, journal d'audit
  ui.ts, lib.ts      icônes, notifications, confirmation, client de l'API
test/                tests (node:test)
```

Les tests couvrent les vecteurs de référence OpenSSL / Drepper de chaque format, l'atomicité et la concurrence
du stockage, les sessions et l'API HTTP complète (connexion, CSRF, verrouillage, validation).
Ils sont aussi exécutés pendant `docker build`.

### Image multi-architecture

Construite sur un Mac Apple Silicon, l'image est en arm64 et ne démarre pas sur un serveur amd64
(`exec format error`). Publier les deux architectures :

```sh
docker buildx create --name multiarch --driver docker-container --use   # une seule fois
docker buildx build --platform linux/amd64,linux/arm64 --target runtime \
  -t afidos/htpasswd-manager:latest --push .
```
