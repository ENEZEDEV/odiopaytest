import { createHash, randomBytes } from 'node:crypto';
import { transaction } from './database.js';
import { digest } from './security.js';
import { requireThat } from './errors.js';
import { isId } from './validation.js';
import { mercadoPagoRequest } from './mercadopago.js';
import { TokenVault } from './token-vault.js';

// Test-only domain service. No HTTP callback is exposed until real identity and HTTPS exist.
export class MercadoPagoOAuth {
  #db; #vault; #clientId; #clientSecret; #redirectUri; #fetch; #now;
  constructor({ db, encryptionKey, clientId, clientSecret, redirectUri, fetchImpl = fetch, now = Date.now }) {
    requireThat(typeof clientId === 'string' && /^[1-9]\d{0,24}$/.test(clientId), 500, 'mp_client_id_required');
    requireThat(typeof clientSecret === 'string' && clientSecret.length >= 16 && !/[\r\n]/.test(clientSecret), 500, 'mp_client_secret_required');
    let url;
    try { url = new URL(redirectUri); } catch { /* validated below */ }
    requireThat(url && url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search, 500, 'mp_https_redirect_required');
    this.#db = db; this.#vault = new TokenVault(encryptionKey); this.#clientId = clientId;
    this.#clientSecret = clientSecret; this.#redirectUri = url.href; this.#fetch = fetchImpl; this.#now = now;
  }
  #context(merchantId, purpose) { return `mp:test:${this.#clientId}:${merchantId}:${purpose}`; }
  #epoch(merchantId) {
    return this.#db.prepare(`INSERT INTO mp_oauth_epochs VALUES (?,1) ON CONFLICT(merchant_id)
      DO UPDATE SET epoch=epoch+1 RETURNING epoch`).get(merchantId).epoch;
  }
  #current(merchantId, epoch) {
    requireThat(this.#db.prepare('SELECT epoch FROM mp_oauth_epochs WHERE merchant_id=?').get(merchantId)?.epoch === epoch, 409, 'mp_connection_superseded');
  }
  begin(merchantId, sessionBinding) {
    requireThat(isId(merchantId) && typeof sessionBinding === 'string' && sessionBinding.length >= 32, 401, 'mp_identity_required');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    transaction(this.#db, () => {
      const epoch = this.#epoch(merchantId);
      this.#db.prepare('DELETE FROM mp_oauth_attempts WHERE merchant_id=? OR expires_at<=?').run(merchantId, this.#now());
      this.#db.prepare('INSERT INTO mp_oauth_attempts VALUES (?,?,?,?,?,?)').run(digest(state), merchantId,
        digest(sessionBinding), epoch, this.#now() + 600000, this.#vault.seal({ verifier }, this.#context(merchantId, 'attempt')));
    });
    const url = new URL('https://auth.mercadopago.com/authorization');
    url.search = new URLSearchParams({ client_id: this.#clientId, response_type: 'code', platform_id: 'mp',
      state, redirect_uri: this.#redirectUri, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
    return { authorizationUrl: url.href };
  }
  async #exchange(fields) {
    return mercadoPagoRequest({ path: '/oauth/token', method: 'POST', fetchImpl: this.#fetch,
      body: { client_id: this.#clientId, client_secret: this.#clientSecret, ...fields, test_token: true } });
  }
  #save(merchantId, epoch, body, expectedSeller) {
    requireThat(body && typeof body === 'object' && body.live_mode === false &&
      typeof body.access_token === 'string' && /^TEST-[A-Za-z0-9_-]{10,}$/.test(body.access_token) &&
      typeof body.refresh_token === 'string' && body.refresh_token.length >= 10 && body.refresh_token.length <= 4096 &&
      typeof body.public_key === 'string' && body.public_key.length >= 10 &&
      typeof body.token_type === 'string' && body.token_type.toLowerCase() === 'bearer' && typeof body.scope === 'string' &&
      body.scope.split(' ').includes('offline_access') && Number.isInteger(body.expires_in) &&
      body.expires_in > 60 && body.expires_in <= 366 * 86400, 502, 'mp_invalid_oauth_response');
    const seller = String(body.user_id);
    requireThat(/^[1-9]\d{0,19}$/.test(seller) && (typeof body.user_id === 'string' || Number.isSafeInteger(body.user_id)), 502, 'mp_invalid_oauth_response');
    requireThat(!expectedSeller || seller === expectedSeller, 409, 'mp_seller_mismatch');
    transaction(this.#db, () => {
      this.#current(merchantId, epoch);
      const occupied = this.#db.prepare('SELECT merchant_id FROM mp_connections WHERE seller_id=?').get(seller);
      requireThat(!occupied || occupied.merchant_id === merchantId, 409, 'mp_seller_already_linked');
      const sealed = this.#vault.seal({ accessToken: body.access_token, refreshToken: body.refresh_token,
        publicKey: body.public_key }, this.#context(merchantId, 'connection'));
      this.#db.prepare(`INSERT INTO mp_connections VALUES (?,?,?,?,?,'active') ON CONFLICT(merchant_id)
        DO UPDATE SET seller_id=excluded.seller_id,epoch=excluded.epoch,expires_at=excluded.expires_at,sealed=excluded.sealed,status='active'`)
        .run(merchantId, seller, epoch, this.#now() + body.expires_in * 1000, sealed);
    });
    return this.status(merchantId);
  }
  async complete({ merchantId, sessionBinding, state, code }) {
    requireThat(isId(merchantId) && typeof sessionBinding === 'string' && sessionBinding.length >= 32 &&
      typeof state === 'string' && /^[A-Za-z0-9_-]{43}$/.test(state) &&
      typeof code === 'string' && code.length >= 5 && code.length <= 2048 && !/[\r\n]/.test(code), 400, 'mp_invalid_callback');
    // Consume before network I/O; an uncertain exchange requires starting a new authorization.
    const attempt = this.#db.prepare(`DELETE FROM mp_oauth_attempts WHERE state_hash=? AND merchant_id=?
      AND session_hash=? AND expires_at>? RETURNING *`).get(digest(state), merchantId, digest(sessionBinding), this.#now());
    requireThat(attempt, 401, 'mp_invalid_state'); this.#current(merchantId, attempt.epoch);
    const { verifier } = this.#vault.open(attempt.sealed, this.#context(merchantId, 'attempt'));
    const body = await this.#exchange({ grant_type: 'authorization_code', code, redirect_uri: this.#redirectUri, code_verifier: verifier });
    return this.#save(merchantId, attempt.epoch, body);
  }
  status(merchantId) {
    const row = this.#db.prepare('SELECT seller_id,expires_at,status FROM mp_connections WHERE merchant_id=?').get(merchantId);
    return row ? { connected: true, sellerId: row.seller_id, expiresAt: row.expires_at,
      status: row.expires_at <= this.#now() ? 'expired' : row.status, environment: 'test' } : { connected: false, environment: 'test' };
  }
  async withConnection(merchantId, action) {
    const row = this.#db.prepare("SELECT * FROM mp_connections WHERE merchant_id=? AND status='active'").get(merchantId);
    requireThat(row && row.expires_at > this.#now() + 60000, 409, 'mp_connection_unavailable');
    const credentials = this.#vault.open(row.sealed, this.#context(merchantId, 'connection'));
    // Server-only capability; the callback must not return credentials to an HTTP response.
    return action({ accessToken: credentials.accessToken, sellerId: row.seller_id, publicKey: credentials.publicKey });
  }
  async refresh(merchantId) {
    const claim = transaction(this.#db, () => {
      const row = this.#db.prepare("SELECT * FROM mp_connections WHERE merchant_id=? AND status='active'").get(merchantId);
      requireThat(row, 409, 'mp_refresh_unavailable');
      const epoch = this.#epoch(merchantId);
      this.#db.prepare("UPDATE mp_connections SET status='refreshing',epoch=? WHERE merchant_id=?").run(epoch, merchantId);
      return { ...row, epoch };
    });
    try {
      const token = this.#vault.open(claim.sealed, this.#context(merchantId, 'connection'));
      const body = await this.#exchange({ grant_type: 'refresh_token', refresh_token: token.refreshToken });
      return this.#save(merchantId, claim.epoch, body, claim.seller_id);
    } catch (error) {
      this.#db.prepare("UPDATE mp_connections SET status='reconnect_required' WHERE merchant_id=? AND epoch=?").run(merchantId, claim.epoch);
      throw error;
    }
  }
  disconnect(merchantId) {
    transaction(this.#db, () => {
      this.#epoch(merchantId);
      this.#db.prepare('DELETE FROM mp_oauth_attempts WHERE merchant_id=?').run(merchantId);
      this.#db.prepare('DELETE FROM mp_connections WHERE merchant_id=?').run(merchantId);
    });
    // Local disconnection only; remote grant revocation is a separate operation.
    return this.status(merchantId);
  }
}
