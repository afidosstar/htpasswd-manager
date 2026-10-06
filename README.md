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
docker compose pull && docker compose up -d  # image publiée
# ou : docker compose up -d --build          # construction locale
# Interface : http://127.0.0.1:8080
docker compose --profile mailpit up -d       # optionnel : Mailpit branché sur le même fichier, rechargé à chaque modification
```

## Prise en compte des modifications : `htpasswd-watch`

Beaucoup de services ne lisent leur fichier de mots de passe qu'au démarrage (Mailpit) ou ne le relisent
que sur signal (NATS, Nginx : `SIGHUP`). `htpasswd-watch`, fourni dans l'image, lance le service dans **son
propre conteneur**, surveille le fichier et, à chaque modification (2 s environ) :

- **relance** le service (par défaut) ;
- ou lui **envoie un signal** (`--signal HUP`), sans couper les connexions.

Aucun accès à Docker (`/var/run/docker.sock`) n'est nécessaire. C'est un script POSIX `sh` : il fonctionne
dans toute image Alpine ou Debian (pas dans une image `scratch`, sans shell : prendre la variante `-alpine`).

```
htpasswd-watch [-f FICHIER] [-i SECONDES] [-s SIGNAL] -- commande [arguments...]
```

Le script est livré dans l'image htpasswd-manager. On le fournit au service **sans modifier son image** :
on remplace seulement son `entrypoint`, et le script arrive par une config Swarm (ou un bind mount en compose).
Il doit être à la même version que htpasswd-manager ; l'extraire de l'image déployée :

```sh
docker run --rm --entrypoint cat afidos/htpasswd-manager:1.0.0 /usr/local/bin/htpasswd-watch > htpasswd-watch
```

### Mailpit sous Docker Swarm

Stack complète dans `examples/swarm/stack.yml` (secrets, placement, volumes). L'essentiel :

```yaml
services:
  mailpit:
    image: axllent/mailpit:latest
    init: true
    entrypoint: ["/bin/sh", "/usr/local/bin/htpasswd-watch", "--", "/mailpit"]
    environment:
      HTPASSWD_WATCH_FILE: /auth/passwords
      MP_UI_AUTH_FILE: /auth/passwords
      MP_SMTP_AUTH_FILE: /auth/passwords
      MP_DATABASE: /data/mailpit.db        # sinon les messages sont perdus à chaque relance
    configs:
      - source: htpasswd-watch
        target: /usr/local/bin/htpasswd-watch
        mode: 0555
    volumes:
      - htpasswd-data:/auth:ro
      - mailpit-data:/data

configs:
  htpasswd-watch:
    name: htpasswd-watch-1.0.0             # configs immuables : un nom par version
    file: ./htpasswd-watch
```

- Les volumes Swarm sont locaux au nœud : placez htpasswd-manager et Mailpit sur le même nœud (contrainte).
- Mailpit est relancé à chaque modification : les connexions SMTP en cours sont coupées (moins d'une seconde).
- Tout compte de l'interface Mailpit voit **tous** les messages : Mailpit n'isole pas les boîtes par utilisateur.
  `MP_TAGS_USERNAME=true` étiquette les messages par compte SMTP (tri, pas contrôle d'accès).

En compose (`docker compose --profile mailpit up -d`), le script est monté depuis `bin/` :
`./bin/htpasswd-watch:/usr/local/bin/htpasswd-watch:ro`.

### NATS, Nginx (rechargement par signal)

Même principe, en mode signal : le service recharge sa configuration sans couper les connexions.

```yaml
entrypoint: ["/bin/sh", "/usr/local/bin/htpasswd-watch", "-f", "/etc/nats/users.conf", "-s", "HUP", "--",
             "nats-server", "-c", "/etc/nats/nats.conf"]
```

NATS ne lit pas le format htpasswd : htpasswd-manager ne gère pas ses utilisateurs, mais `htpasswd-watch`
peut recharger NATS quand son propre fichier change. Nginx et Apache relisent le fichier htpasswd à chaque
requête : rien à recharger.

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
  auth/              sessions, garde (cookie + anti-CSRF), limitation des tentatives
  http/              en-têtes de sécurité, erreurs, fichiers statiques
  routes/            pages, connexion, utilisateurs
  htpasswd/          formats de hachage, stockage atomique du fichier
bin/htpasswd-watch   relance ou signale un service quand le fichier change (POSIX sh)
examples/swarm/      stack Swarm : htpasswd-manager + Mailpit rechargé automatiquement
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
