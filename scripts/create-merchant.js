import { config, prepareDatabaseDirectory } from '../src/config.js';
import { openDatabase } from '../src/database.js';
import { provisionMerchant } from '../src/security.js';

try {
  const settings = config();
  prepareDatabaseDirectory(settings.database);
  const db = openDatabase(settings.database);
  try {
    const merchant = provisionMerchant(db, process.argv[2], process.argv[3] ?? 'standard');
    console.log('Credencial sandbox: copie para um local privado. Esta é a única exibição da chave.');
    console.log(JSON.stringify(merchant, null, 2));
  } finally { db.close(); }
} catch (error) {
  console.error(error.code ?? 'configuration_error');
  process.exitCode = 1;
}
