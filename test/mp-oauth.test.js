import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { provisionMerchant } from '../src/security.js';
import { MercadoPagoOAuth } from '../src/mp-oauth.js';
import { TokenVault } from '../src/token-vault.js';

const sessionBinding = 'session-that-is-bound-to-user-123456789';
const token = { access_token: 'TEST-fake_access_token_12345', refresh_token: 'fake_refresh_token_12345',
  public_key: 'TEST-public-key-example', token_type: 'bearer', expires_in: 3600, scope: 'read write offline_access', user_id: 12345, live_mode: false };
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function fixture(t, fetchImpl = async () => json(token)) {
  const db = openDatabase(); t.after(() => db.close());
  const a = provisionMerchant(db, 'Loja A').id; const b = provisionMerchant(db, 'Loja B').id;
  const config = { db, encryptionKey: randomBytes(32), clientId: '123456', clientSecret: 'fake_client_secret_123456',
    redirectUri: 'https://odiopay.example/oauth/callback', fetchImpl };
  const service = new MercadoPagoOAuth(config);
  const begin = (merchantId = a) => new URL(service.begin(merchantId, sessionBinding).authorizationUrl);
  const complete = (url, merchantId = a, binding = sessionBinding) => service.complete({ merchantId, sessionBinding: binding, state: url.searchParams.get('state'), code: 'fake_authorization_code' });
  return { db, a, b, service, config, begin, complete };
}

test('OAuth usa state opaco, PKCE S256 e redirect estático; persiste apenas dados cifrados', async t => {
  let request;
  const f = fixture(t, async (url, options) => { request = { url, ...options, body: JSON.parse(options.body) }; return json(token); });
  const url = f.begin();
  assert.equal(url.origin, 'https://auth.mercadopago.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), f.config.redirectUri);
  assert.ok(!url.href.includes(f.a)); assert.ok(!url.href.includes(sessionBinding));
  const status = await f.complete(url);
  assert.equal(status.sellerId, '12345'); assert.equal(status.status, 'active');
  assert.equal(request.url, 'https://api.mercadopago.com/oauth/token'); assert.equal(request.redirect, 'error');
  assert.equal(request.body.test_token, true); assert.equal(request.body.grant_type, 'authorization_code');
  assert.equal(createHash('sha256').update(request.body.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  const persisted = JSON.stringify(f.db.prepare('SELECT * FROM mp_connections').all());
  assert.ok(!persisted.includes(token.access_token)); assert.ok(!persisted.includes(token.refresh_token));
  assert.ok(!JSON.stringify(status).includes('token')); assert.equal(JSON.stringify(f.service), '{}');
  await f.service.withConnection(f.a, credentials => assert.equal(credentials.accessToken, token.access_token));
  await assert.rejects(f.service.withConnection(f.b, () => assert.fail()), { code: 'mp_connection_unavailable' });
});
test('OAuth rejeita outra loja e sessão sem consumir a tentativa legítima; callback é de uso único', async t => {
  const f = fixture(t); const url = f.begin();
  await assert.rejects(f.complete(url, f.b), { code: 'mp_invalid_state' });
  await assert.rejects(f.complete(url, f.a, 'different-session-binding-123456789'), { code: 'mp_invalid_state' });
  await f.complete(url);
  await assert.rejects(f.complete(url), { code: 'mp_invalid_state' });
});
test('OAuth expira tentativa e nova tentativa invalida state anterior', async t => {
  const f = fixture(t); const old = f.begin(); const current = f.begin();
  await assert.rejects(f.complete(old), { code: 'mp_invalid_state' });
  f.db.prepare('UPDATE mp_oauth_attempts SET expires_at=0').run();
  await assert.rejects(f.complete(current), { code: 'mp_invalid_state' });
});
test('OAuth duas chamadas simultâneas ao callback fazem uma troca de código', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; return json(token); });
  const url = f.begin(); const results = await Promise.allSettled([f.complete(url), f.complete(url)]);
  assert.equal(calls, 1); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});
test('OAuth callback antigo não sobrescreve reconexão mais recente', async t => {
  let resolve; const f = fixture(t, () => new Promise(r => { resolve = r; }));
  const old = f.begin(); const pending = f.complete(old); f.begin(); resolve(json(token));
  await assert.rejects(pending, { code: 'mp_connection_superseded' }); assert.equal(f.service.status(f.a).connected, false);
});
test('OAuth desconexão invalida troca em andamento', async t => {
  let resolve; const f = fixture(t, () => new Promise(r => { resolve = r; }));
  const url = f.begin(); const pending = f.complete(url); f.service.disconnect(f.a); resolve(json(token));
  await assert.rejects(pending, { code: 'mp_connection_superseded' });
});
test('OAuth não permite duas lojas vinculadas à mesma conta financeira', async t => {
  const f = fixture(t); await f.complete(f.begin());
  await assert.rejects(f.complete(f.begin(f.b), f.b), { code: 'mp_seller_already_linked' });
});
for (const change of [{ live_mode: true }, { access_token: 'APP_USR-production' }, { scope: 'read write' }, { expires_in: 0 }, { token_type: 7 }, { user_id: 9007199254740992 }]) {
  test(`OAuth rejeita resposta insegura: ${Object.keys(change)[0]}`, async t => {
    const f = fixture(t, async () => json({ ...token, ...change }));
    await assert.rejects(f.complete(f.begin()), { code: 'mp_invalid_oauth_response' });
    assert.equal(f.service.status(f.a).connected, false);
  });
}
test('OAuth erro de rede não persiste segredo e exige nova autorização após resposta incerta', async t => {
  const f = fixture(t, async () => { throw new Error(token.refresh_token); }); const url = f.begin();
  await assert.rejects(f.complete(url), { code: 'mp_unavailable', message: 'mp_unavailable' });
  await assert.rejects(f.complete(url), { code: 'mp_invalid_state' });
});
test('OAuth refresh substitui o par de tokens, usa refresh atual e bloqueia concorrência', async t => {
  let resolve; let calls = 0;
  const f = fixture(t, async (_url, options) => {
    calls++; const body = JSON.parse(options.body);
    if (calls === 1) return json(token);
    assert.equal(body.refresh_token, token.refresh_token);
    return new Promise(r => { resolve = r; });
  });
  await f.complete(f.begin()); const pending = f.service.refresh(f.a);
  await assert.rejects(f.service.refresh(f.a), { code: 'mp_refresh_unavailable' });
  await assert.rejects(f.service.withConnection(f.a, () => assert.fail()), { code: 'mp_connection_unavailable' });
  resolve(json({ ...token, access_token: 'TEST-new_access_token_123', refresh_token: 'new_refresh_token_123' }));
  await pending;
  await f.service.withConnection(f.a, credentials => assert.equal(credentials.accessToken, 'TEST-new_access_token_123'));
  assert.equal(calls, 2);
});
test('OAuth falha incerta de refresh bloqueia uso e exige reconexão', async t => {
  let calls = 0; const f = fixture(t, async () => { if (++calls === 1) return json(token); throw new Error('network'); });
  await f.complete(f.begin()); await assert.rejects(f.service.refresh(f.a), { code: 'mp_unavailable' });
  assert.equal(f.service.status(f.a).status, 'reconnect_required');
  await assert.rejects(f.service.refresh(f.a), { code: 'mp_refresh_unavailable' });
});
test('OAuth estado e tokens persistem entre instâncias; chave incorreta não abre dados', async t => {
  const f = fixture(t); const url = f.begin(); const second = new MercadoPagoOAuth(f.config);
  await second.complete({ merchantId: f.a, sessionBinding, state: url.searchParams.get('state'), code: 'fake-code' });
  const wrong = new MercadoPagoOAuth({ ...f.config, encryptionKey: randomBytes(32) });
  await assert.rejects(wrong.withConnection(f.a, () => assert.fail()), { code: 'token_vault_invalid' });
});
test('OAuth token expirado não pode autorizar chamada financeira', async t => {
  const f = fixture(t); await f.complete(f.begin());
  f.db.prepare('UPDATE mp_connections SET expires_at=0').run();
  assert.equal(f.service.status(f.a).status, 'expired');
  await assert.rejects(f.service.withConnection(f.a, () => assert.fail()), { code: 'mp_connection_unavailable' });
});
test('OAuth refresh que troca recebedor bloqueia a conexão', async t => {
  let calls = 0; const f = fixture(t, async () => json({ ...token, user_id: ++calls === 1 ? 12345 : 67890 }));
  await f.complete(f.begin()); await assert.rejects(f.service.refresh(f.a), { code: 'mp_seller_mismatch' });
  assert.equal(f.service.status(f.a).status, 'reconnect_required');
});
test('cofre detecta adulteração, troca de lojista e usa nonce único', () => {
  const vault = new TokenVault(randomBytes(32)); const sealed = vault.seal(token, 'merchant-A');
  assert.notEqual(sealed, vault.seal(token, 'merchant-A'));
  assert.deepEqual(vault.open(sealed, 'merchant-A'), token);
  assert.throws(() => vault.open(sealed, 'merchant-B'), { code: 'token_vault_invalid' });
  const tampered = JSON.parse(sealed); tampered.tag = Buffer.alloc(16).toString('base64');
  assert.throws(() => vault.open(JSON.stringify(tampered), 'merchant-A'), { code: 'token_vault_invalid' });
  assert.throws(() => new TokenVault(Buffer.alloc(16)), { code: 'token_vault_key_required' });
});
test('OAuth rejeita redirect inseguro ou variável', t => {
  const f = fixture(t);
  for (const redirectUri of ['http://example.test/callback', 'https://a.test/callback?next=x', 'https://a.test/#frag', 'https://user:pass@a.test/']) {
    assert.throws(() => new MercadoPagoOAuth({ ...f.config, redirectUri }), { code: 'mp_https_redirect_required' });
  }
});
