/**
 * htpasswd-manager — point d'entrée : configuration, vérifications, écoute.
 */
import { ConfigError, loadConfig, loadEnvFile } from './config.ts';
import { HtpasswdStore } from './htpasswd/store.ts';
import { buildApp } from './app.ts';

let config;
let envFile: ReturnType<typeof loadEnvFile>;
try {
  envFile = loadEnvFile();
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exit(1);
}

const store = new HtpasswdStore(config.file, { mode: config.fileMode });
try {
  await store.check();
} catch (err) {
  console.error(`Répertoire ${store.dir} inaccessible en écriture (${(err as NodeJS.ErrnoException).code}). Vérifiez le volume et les permissions.`);
  process.exit(1);
}

const app = await buildApp(config, { store, logger: { level: process.env.LOG_LEVEL || 'info' } });
app.server.headersTimeout = 10_000;

await app.listen({ host: config.host, port: config.port });
app.log.info(`fichier géré : ${store.file}`);
if (envFile) {
  app.log.info(`variables chargées depuis ${envFile.file}`);
  if (envFile.exposed) app.log.warn(`${envFile.file} est lisible par d'autres utilisateurs : exécutez chmod 600 sur ce fichier.`);
}
if (!config.authEnabled) app.log.warn('ADMIN_USER/ADMIN_PASSWORD non définis : interface accessible sans authentification.');

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    app.log.info(`${sig} reçu, arrêt propre…`);
    setTimeout(() => process.exit(0), 5_000).unref();
    await app.close();
    process.exit(0);
  });
}
