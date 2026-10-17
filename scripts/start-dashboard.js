import { randomBytes } from 'node:crypto';
process.env.ODIOPAY_MODE = 'sandbox';
process.env.ODIOPAY_DB ??= 'data/dashboard.sqlite';
process.env.ODIOPAY_WEBHOOK_SECRET ??= randomBytes(32).toString('hex');
await import('../src/main.js');
