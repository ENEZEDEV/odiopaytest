import { randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../src/database.js';
import { Wallet } from '../src/wallet.js';

const db = openDatabase(workerData.path);
try {
  try {
    const result = new Wallet(db).request(workerData.merchant.id, { amountCents: 9900, currency: 'BRL', destinationId: workerData.merchant.destinationId }, randomUUID());
    parentPort.postMessage({ accepted: true, id: result.withdrawal.id });
  } catch (error) {
    if (error.code !== 'insufficient_balance') throw error;
    parentPort.postMessage({ accepted: false, code: error.code });
  }
} finally { db.close(); }
