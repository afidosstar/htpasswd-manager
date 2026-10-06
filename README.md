# htpasswd-manager

Micro-application web pour créer et maintenir un fichier d'authentification compatible
Mailpit (`MP_UI_AUTH_FILE` / `MP_SMTP_AUTH_FILE`), Apache `htpasswd` et Nginx `auth_basic_user_file`.

## Démarrage

```sh
cp .env.example .env && chmod 600 .env      # puis éditez ADMIN_PASSWORD
docker compose up -d --build
# Interface : http://127.0.0.1:8080
docker compose --profile mailpit up -d       # optionnel : Mailpit branché sur le même fichier
```

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `HTPASSWD_PATH` | `/data/passwords` | Fichier géré (son répertoire doit être un volume) |
| `ADMIN_USER` / `ADMIN_PASSWORD` | vide | Basic Auth de l'interface. Vides = accès libre. Un seul des deux défini = refus de démarrer |
| `ADMIN_USER_FILE` / `ADMIN_PASSWORD_FILE` | — | Variante Docker secrets |
| `DEFAULT_ALGORITHM` | `bcrypt-2y` | `bcrypt-2y`, `bcrypt-2a`, `sha512`, `sha256`, `apr1`, `md5`, `ssha`, `sha`, `plain` |
| `BCRYPT_COST` | `10` | Coût bcrypt (borné 4–14) |
| `SHACRYPT_ROUNDS` | `5000` | Itérations `$5$`/`$6$` (`rounds=` écrit seulement si ≠ 5000) |
| `FILE_MODE` | `0640` | Permissions du fichier écrit |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Écoute HTTP |

## API (même origine, en-tête `X-Requested-With: htpasswd-manager` requis pour les écritures)

- `GET /api/users` : utilisateurs + contenu brut
- `POST /api/users` `{"username","password","algorithm"}` : création (201) ou mise à jour (200)
- `DELETE /api/users/:username`
- `GET /api/download` : téléchargement du fichier
- `GET /healthz` : sonde de santé (sans authentification)

## Sécurité

- Basic Auth à comparaison en temps constant, verrouillage 15 min après 10 échecs par IP.
- Anti-CSRF : JSON obligatoire, `Sec-Fetch-Site`/`Origin` vérifiés, en-tête personnalisé exigé.
- CSP stricte sans script inline, rendu DOM sans `innerHTML`.
- Écriture atomique (tmp + fsync + rename + fsync du répertoire), mutex contre les écritures concurrentes.
- Conteneur non-root, système de fichiers en lecture seule, capacités supprimées, npm retiré de l'image.
- Bcrypt : refus des mots de passe > 72 octets (troncature silencieuse sinon).
- Placez l'interface derrière un reverse proxy TLS : la Basic Auth circule en clair sur HTTP.

## Tests

`npm test` : vecteurs de référence OpenSSL / Drepper pour chaque format, atomicité et concurrence du stockage.
Les tests sont aussi exécutés pendant `docker build`.
