import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../src/database.js';
import { SandboxProvider } from '../src/provider.js';
import { Payments } from '../src/payments.js';

const db = openDatabase(workerData.path);
try {
  const payments = new Payments(db, new SandboxProvider(db));
  parentPort.postMessage(payments.create(workerData.merchant, { amountCents: 10000, currency: 'BRL', method: 'pix' }, workerData.key));
} finally { db.close(); }
