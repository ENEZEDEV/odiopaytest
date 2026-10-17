import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AppError, requireThat } from './errors.js';
import { authenticate, RateLimiter, verifyWebhook } from './security.js';
import { Wallet } from './wallet.js';
import { Dashboard } from './dashboard.js';

const MAX_BODY = 16_384;

async function readBody(req) {
  requireThat(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? ''), 415, 'json_required');
  requireThat(!req.headers['content-encoding'], 415, 'encoding_not_supported');
  requireThat(!req.headers['content-length'] || Number(req.headers['content-length']) <= MAX_BODY, 413, 'body_too_large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    requireThat(size <= MAX_BODY, 413, 'body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(raw) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw new AppError(400, 'invalid_json'); }
}

export function createApi({ db, payments, webhookSecret, rateLimiter = new RateLimiter(), logger = () => {} }) {
  const wallet = new Wallet(db);
  const dashboard = new Dashboard(db, payments, wallet);
  requireThat(typeof webhookSecret === 'string' && Buffer.byteLength(webhookSecret) >= 32, 500, 'webhook_secret_required');
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5000 }, async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('X-Request-Id', requestId);
    const send = (status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    try {
      requireThat(rateLimiter.allow(req.socket.remoteAddress ?? 'unknown'), 429, 'rate_limited');
      if (await dashboard.handle(req, res, send, readBody, parseJson)) return;
      // Browser callers are not supported by this service-to-service sandbox API.
      requireThat(!req.headers.origin, 403, 'browser_origin_not_allowed');
      requireThat(req.url && req.url.length <= 2048, 414, 'uri_too_long');
      if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', environment: 'sandbox' });
      if (req.method === 'POST' && req.url === '/v1/webhooks/sandbox') {
        const raw = await readBody(req);
        verifyWebhook(webhookSecret, req.headers['x-odiopay-timestamp'], req.headers['x-odiopay-signature'], raw);
        return send(200, payments.confirm(parseJson(raw)));
      }
      const merchant = authenticate(db, req.headers.authorization);
      if (req.method === 'GET' && req.url === '/v1/wallet') return send(200, { wallet: wallet.balance(merchant.id) });
      if (req.method === 'GET' && req.url === '/v1/withdrawal-destinations') return send(200, { destinations: wallet.destinations(merchant.id) });
      if (req.method === 'POST' && req.url === '/v1/withdrawals') {
        const result = wallet.request(merchant.id, parseJson(await readBody(req)), req.headers['idempotency-key']);
        return send(result.replayed ? 200 : 201, result);
      }
      if (req.method === 'GET' && req.url === '/v1/withdrawals') return send(200, { withdrawals: wallet.list(merchant.id), limit: 100 });
      const withdrawalMatch = /^\/v1\/withdrawals\/([^/?]+)$/.exec(req.url);
      if (req.method === 'GET' && withdrawalMatch) return send(200, { withdrawal: wallet.get(merchant.id, withdrawalMatch[1]) });
      if (req.method === 'POST' && req.url === '/v1/payments') {
        const result = payments.create(merchant, parseJson(await readBody(req)), req.headers['idempotency-key']);
        return send(result.replayed ? 200 : 201, result);
      }
      if (req.method === 'GET' && req.url === '/v1/payments') return send(200, { payments: payments.list(merchant.id), limit: 100 });
      const match = /^\/v1\/payments\/([^/?]+)$/.exec(req.url);
      if (req.method === 'GET' && match) return send(200, { payment: payments.get(merchant.id, match[1]) });
      throw new AppError(404, 'not_found');
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      const code = error instanceof AppError ? error.code : 'internal_error';
      // Only structured metadata: never bodies, headers, keys, tokens or SQL errors.
      logger({ requestId, status, code });
      if (status === 429) res.setHeader('Retry-After', '60');
      if (!req.complete) res.setHeader('Connection', 'close');
      if (!res.destroyed) send(status, { error: { code, requestId } });
    }
  });
  server.timeout = 15_000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  return server;
}
