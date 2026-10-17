import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { requireThat } from './errors.js';

export function config(env = process.env) {
  requireThat(env.ODIOPAY_MODE === 'sandbox' && env.NODE_ENV !== 'production', 500, 'sandbox_mode_required');
  const port = Number(env.PORT ?? 3100);
  requireThat(Number.isInteger(port) && port >= 1024 && port <= 65535, 500, 'invalid_port');
  requireThat(typeof env.ODIOPAY_WEBHOOK_SECRET === 'string' && Buffer.byteLength(env.ODIOPAY_WEBHOOK_SECRET) >= 32, 500, 'webhook_secret_required');
  return { port, webhookSecret: env.ODIOPAY_WEBHOOK_SECRET, database: resolve(env.ODIOPAY_DB ?? 'data/odiopay.sqlite') };
}

export function prepareDatabaseDirectory(path) { mkdirSync(dirname(path), { recursive: true }); }
