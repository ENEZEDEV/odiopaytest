import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { provisionMerchant, digest } from './security.js';
import { SandboxProvider } from './provider.js';
import { requireThat } from './errors.js';
import { exactObject } from './validation.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/dark.css', ['dark.css', 'text/css; charset=utf-8']],
  ['/nz-dev.jpg', ['nz-dev.jpg', 'image/jpeg']]
]);
const cookieName = 'odiopay_demo';

export class Dashboard {
  sessions = new Map();
  constructor(db, payments, wallet) { Object.assign(this, { db, payments, wallet }); }
  session(req) {
    const value = /(?:^|;\s*)odiopay_demo=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    const session = value && this.sessions.get(digest(value));
    requireThat(session && session.expires > Date.now(), 401, 'session_expired');
    return session;
  }
  confirm(merchant, id) {
    const p = this.payments.get(merchant.id, id);
    if (p.status === 'pending') {
      new SandboxProvider(this.db).settle(p.providerId, 'succeeded');
      this.payments.confirm({ id: randomUUID(), paymentId: id, providerId: p.providerId, merchantId: merchant.id, amountCents: p.amountCents, currency: 'BRL', method: p.method, status: 'succeeded' });
    }
    this.wallet.settlePayment(id);
  }
  startSession() {
    for (const [key, s] of this.sessions) if (s.expires <= Date.now()) this.sessions.delete(key);
    requireThat(this.sessions.size < 30, 429, 'demo_capacity');
    const credentials = provisionMerchant(this.db, 'Minha loja · Demo');
    // The demo never issues or exposes an API key to the browser.
    this.db.prepare('UPDATE api_keys SET revoked=1 WHERE merchant_id=?').run(credentials.id);
    const merchant = { id: credentials.id, name: 'Minha loja', plan: 'standard' };
    for (const [index, amount] of [25990, 14900, 8900, 42500, 19900, 6490].entries()) {
      const method = index % 2 ? 'card' : 'pix';
      const payment = this.payments.create(merchant, { amountCents: amount, currency: 'BRL', method, ...(method === 'card' ? { cardToken: 'tok_sandbox_dashboard123456789' } : {}) }, randomUUID()).payment;
      if (index < 4) this.confirm(merchant, payment.id);
    }
    const token = randomBytes(32).toString('hex');
    const session = { merchant, csrf: randomBytes(32).toString('hex'), expires: Date.now() + 60 * 60_000 };
    this.sessions.set(digest(token), session);
    return { token, session };
  }
  async handle(req, res, send, readBody, parseJson) {
    const asset = assets.get(req.url);
    if (!asset && !req.url?.startsWith('/app-api/')) return false;
    const expectedHost = `127.0.0.1:${req.socket.localPort}`;
    requireThat(req.headers.host === expectedHost, 403, 'invalid_host');
    if (asset && req.method === 'GET') {
      res.setHeader('Content-Type', asset[1]);
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      res.end(readFileSync(new URL(`../public/${asset[0]}`, import.meta.url)));
      return true;
    }
    requireThat(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']), 403, 'cross_site_request');
    requireThat(req.method === 'GET' || req.method === 'POST', 405, 'method_not_allowed');
    if (req.method === 'POST') requireThat(req.headers.origin === `http://${expectedHost}`, 403, 'invalid_origin');
    if (req.url === '/app-api/demo' && req.method === 'POST') {
      requireThat(req.headers['x-odiopay-demo'] === '1', 403, 'invalid_demo_request');
      exactObject(parseJson(await readBody(req)), []);
      const { token, session } = this.startSession();
      res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
      send(201, { csrf: session.csrf });
      return true;
    }
    const session = this.session(req);
    if (req.method === 'POST') requireThat(req.headers['x-csrf-token'] === session.csrf, 403, 'invalid_csrf');
    const merchant = session.merchant;
    if (req.url === '/app-api/overview' && req.method === 'GET') {
      send(200, { merchant, csrf: session.csrf, wallet: this.wallet.balance(merchant.id), payments: this.payments.list(merchant.id), withdrawals: this.wallet.list(merchant.id), destinations: this.wallet.destinations(merchant.id) });
    } else if (req.url === '/app-api/logout' && req.method === 'POST') {
      for (const [key, value] of this.sessions) if (value === session) this.sessions.delete(key);
      res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      send(200, { ok: true });
    } else if (req.url === '/app-api/payments' && req.method === 'POST') {
      send(201, this.payments.create(merchant, parseJson(await readBody(req)), req.headers['idempotency-key']));
    } else if (req.url === '/app-api/withdrawals' && req.method === 'POST') {
      send(201, this.wallet.request(merchant.id, parseJson(await readBody(req)), req.headers['idempotency-key']));
    } else if (req.url === '/app-api/simulate-payment' && req.method === 'POST') {
      const input = parseJson(await readBody(req)); exactObject(input, ['id']);
      this.confirm(merchant, input.id);
      send(200, { ok: true });
    } else if (req.url === '/app-api/simulate-withdrawal' && req.method === 'POST') {
      const input = parseJson(await readBody(req)); exactObject(input, ['id', 'status']);
      this.wallet.get(merchant.id, input.id);
      send(200, this.wallet.finishWithdrawal(input.id, input.status));
    } else requireThat(false, 404, 'not_found');
    return true;
  }
}
