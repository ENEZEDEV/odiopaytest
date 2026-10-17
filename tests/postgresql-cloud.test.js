import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

describe('ODIOPAY - PostgreSQL RLS, Privilégios e Imutabilidade', () => {
  let pool;
  const merchantA_userId = randomUUID();
  const merchantB_userId = randomUUID();
  let merchantA_id;
  let merchantB_id;

  before(async () => {
    pool = new pg.Pool({
      host: '/tmp/pgrun',
      port: 54322,
      user: 'postgres',
    });

    // Setup de teste: Cria os dois lojistas como service_role
    const resA = await pool.query(
      "INSERT INTO public.merchants (auth_user_id, name, plan) VALUES ($1, 'Loja Alfa', 'standard') RETURNING id;",
      [merchantA_userId]
    );
    merchantA_id = resA.rows[0].id;

    const resB = await pool.query(
      "INSERT INTO public.merchants (auth_user_id, name, plan) VALUES ($1, 'Loja Beta', 'pro') RETURNING id;",
      [merchantB_userId]
    );
    merchantB_id = resB.rows[0].id;

    // Cria dados de teste para cada lojista
    await pool.query(
      `INSERT INTO public.payment_intents (merchant_id, idempotency_key, request_digest, amount_cents, fee_cents, currency, method, payer_email, status)
       VALUES ($1, $2, 'digest-a-1', 10000, 100, 'BRL', 'pix', 'pagadorA@teste.com', 'succeeded');`,
      [merchantA_id, `key-a-${randomUUID()}`]
    );

    await pool.query(
      `INSERT INTO public.payment_intents (merchant_id, idempotency_key, request_digest, amount_cents, fee_cents, currency, method, payer_email, status)
       VALUES ($1, $2, 'digest-b-1', 50000, 50, 'BRL', 'pix', 'pagadorB@teste.com', 'succeeded');`,
      [merchantB_id, `key-b-${randomUUID()}`]
    );
  });

  after(async () => {
    await pool.end();
  });

  async function withSession(userId, callback) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN;');
      await client.query('SET LOCAL ROLE authenticated;');
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true);", [userId]);
      const result = await callback(client);
      await client.query('COMMIT;');
      return result;
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }
  }

  test('1. Isolamento RLS entre dois lojistas em public.merchants', async () => {
    await withSession(merchantA_userId, async (client) => {
      const res = await client.query('SELECT * FROM public.merchants;');
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows[0].id, merchantA_id);
      assert.equal(res.rows[0].name, 'Loja Alfa');
    });

    await withSession(merchantB_userId, async (client) => {
      const res = await client.query('SELECT * FROM public.merchants;');
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows[0].id, merchantB_id);
      assert.equal(res.rows[0].name, 'Loja Beta');
    });
  });

  test('2. Isolamento RLS entre dois lojistas em payment_intents', async () => {
    await withSession(merchantA_userId, async (client) => {
      const res = await client.query('SELECT * FROM public.payment_intents;');
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows[0].merchant_id, merchantA_id);

      // Tentativa de buscar explicitamente dados do Lojista B retorna vazio
      const crossRes = await client.query('SELECT * FROM public.payment_intents WHERE merchant_id = $1;', [merchantB_id]);
      assert.equal(crossRes.rows.length, 0);
    });
  });

  test('3. Restrição de privilégios de coluna: usuário não pode alterar seu próprio plano', async () => {
    await withSession(merchantA_userId, async (client) => {
      // Atualizar o nome é permitido
      await client.query('UPDATE public.merchants SET name = $1 WHERE id = $2;', ['Loja Alfa Renomeada', merchantA_id]);

      // Tentativa de alterar o plano para 'pro' deve ser rejeitada pelo PostgreSQL
      await assert.rejects(
        async () => {
          await client.query('UPDATE public.merchants SET plan = $1 WHERE id = $2;', ['pro', merchantA_id]);
        },
        /permission denied/
      );
    });
  });

  test('4. Restrição de escrita: usuário não pode inserir intenções diretamente no banco', async () => {
    await withSession(merchantA_userId, async (client) => {
      await assert.rejects(
        async () => {
          await client.query(
            `INSERT INTO public.payment_intents (merchant_id, idempotency_key, request_digest, amount_cents, fee_cents, currency, method, payer_email, status)
             VALUES ($1, 'forged-key', 'forged-digest', 1000, 0, 'BRL', 'pix', 'hacker@test.com', 'succeeded');`,
            [merchantA_id]
          );
        },
        /permission denied for table payment_intents/
      );
    });
  });

  test('5. Restrição de colunas OAuth: usuário não tem acesso a tokens criptografados', async () => {
    const sellerId = `seller-${randomUUID()}`;
    await pool.query(
      `INSERT INTO public.mp_oauth_connections (merchant_id, seller_id, encrypted_access_token, encrypted_refresh_token, public_key, token_type, expires_at, scope, status)
       VALUES ($1, $2, 'enc_access', 'enc_refresh', 'APP_USR-123', 'Bearer', NOW() + INTERVAL '1 day', 'read', 'active');`,
      [merchantA_id, sellerId]
    );

    await withSession(merchantA_userId, async (client) => {
      // Leitura de metadados permitidos
      const metaRes = await client.query('SELECT merchant_id, seller_id, public_key, status FROM public.mp_oauth_connections;');
      assert.equal(metaRes.rows.length, 1);
      assert.equal(metaRes.rows[0].seller_id, sellerId);

      // Leitura de tokens cifrados bloqueada por privilégio de coluna
      await assert.rejects(
        async () => {
          await client.query('SELECT encrypted_access_token FROM public.mp_oauth_connections;');
        },
        /permission denied for table mp_oauth_connections/
      );
    });
  });

  test('6. Diário contábil da carteira é estritamente append-only (bloqueio por trigger)', async () => {
    const journalId = randomUUID();
    const sourceId = `src-${randomUUID()}`;
    await pool.query(
      `INSERT INTO public.wallet_journal (id, merchant_id, source_id, action, available_delta, reserved_delta, withdrawn_delta)
       VALUES ($1, $2, $3, 'settled', 10000, 0, 0);`,
      [journalId, merchantA_id, sourceId]
    );

    // Tentativa de UPDATE é bloqueada
    await assert.rejects(
      async () => {
        await pool.query('UPDATE public.wallet_journal SET available_delta = 999999 WHERE id = $1;', [journalId]);
      },
      /wallet_journal_is_immutable/
    );

    // Tentativa de DELETE é bloqueada
    await assert.rejects(
      async () => {
        await pool.query('DELETE FROM public.wallet_journal WHERE id = $1;', [journalId]);
      },
      /wallet_journal_is_immutable/
    );
  });
});
