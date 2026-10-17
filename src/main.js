import { config, prepareDatabaseDirectory } from './config.js';
import { openDatabase } from './database.js';
import { SandboxProvider } from './provider.js';
import { Payments } from './payments.js';
import { createApi } from './http.js';

try {
  const settings = config();
  prepareDatabaseDirectory(settings.database);
  const db = openDatabase(settings.database);
  const server = createApi({ db, payments: new Payments(db, new SandboxProvider(db)), webhookSecret: settings.webhookSecret, logger: entry => console.error(JSON.stringify(entry)) });
  server.listen(settings.port, '127.0.0.1', () => console.log(`ODIOPAY SANDBOX: http://127.0.0.1:${settings.port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { db.close(); process.exit(0); }));
} catch (error) {
  console.error(`Falha ao iniciar: ${error.code ?? 'configuration_error'}`);
  process.exitCode = 1;
}
