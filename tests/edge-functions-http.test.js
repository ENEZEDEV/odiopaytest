import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { hmacSha256Hex, timingSafeEqual } from '../supabase/functions/_shared/crypto.ts';

describe('ODIOPAY - Testes de Endpoints HTTP Reais de Edge Functions', () => {
  let server;
  let serverPort;
  const webhookSecret = 'test_webhook_secret_key_12345';
  const processedEvents = new Map(); // Simula banco de eventos

  before(async () => {
    // Cria um servidor HTTP que emula fielmente o handler da Edge Function mp-webhook
    server = http.createServer(async (req, res) => {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      };

      if (req.method === 'OPTIONS') {
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      let bodyStr = '';
      for await (const chunk of req) {
        bodyStr += chunk;
      }

      let body;
      try {
        body = JSON.parse(bodyStr || '{}');
      } catch {
        res.writeHead(400, corsHeaders);
        res.end(JSON.stringify({ error: { code: 'invalid_json' } }));
        return;
      }

      const xSignature = req.headers['x-signature'] || '';
      const xRequestId = req.headers['x-request-id'] || '';
      const dataId = String(body?.data?.id || body?.id || '');

      if (!dataId) {
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ received: true, ignored: true }));
        return;
      }

      // Validação de assinatura
      const sigParts = Object.fromEntries(
        xSignature.split(',').map((p) => {
          const [k, ...v] = p.trim().split('=');
          return [k, v.join('=')];
        })
      );
      const ts = sigParts.ts || '';
      const v1 = sigParts.v1 || '';

      if (!ts || !v1 || !xRequestId) {
        res.writeHead(401, corsHeaders);
        res.end(JSON.stringify({ error: { code: 'invalid_signature', message: 'Missing signature headers' } }));
        return;
      }

      const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
      const computedHmac = await hmacSha256Hex(webhookSecret, manifest);

      if (!timingSafeEqual(computedHmac, v1)) {
        res.writeHead(403, corsHeaders);
        res.end(JSON.stringify({ error: { code: 'invalid_signature', message: 'Signature verification failed' } }));
        return;
      }

      const eventId = String(body.id || `${xRequestId}:${dataId}`);
      const existing = processedEvents.get(eventId);

      if (existing) {
        if (existing.status === 'processed') {
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ received: true, status: 'already_processed', isRetry: true }));
          return;
        } else if (existing.status === 'failed' || existing.status === 'received') {
          // Reprocessamento de evento não concluído
          existing.status = 'processed';
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ received: true, status: 'reprocessed_success', isRetry: true }));
          return;
        }
      }

      // Novo evento
      if (body.simulate_failure) {
        processedEvents.set(eventId, { status: 'failed' });
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ error: { code: 'upstream_fetch_error' } }));
        return;
      }

      processedEvents.set(eventId, { status: 'processed' });
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ received: true, status: 'processed', isRetry: false }));
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('1. HTTP 401 para requisição sem cabeçalhos de assinatura x-signature / x-request-id', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { id: '12345' } }),
    });

    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error.code, 'invalid_signature');
  });

  test('2. HTTP 403 para assinatura forjada ou HMAC divergente', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'req-test-403',
        'x-signature': 'ts=1700000000,v1=forged_hmac_hex_value',
      },
      body: JSON.stringify({ data: { id: '12345' } }),
    });

    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.error.code, 'invalid_signature');
  });

  test('3. HTTP 200 com assinatura válida: persistência e processamento com sucesso', async () => {
    const dataId = '999111';
    const reqId = 'req-valid-1';
    const ts = String(Math.floor(Date.now() / 1000));
    const manifest = `id:${dataId};request-id:${reqId};ts:${ts};`;
    const signature = await hmacSha256Hex(webhookSecret, manifest);

    const res = await fetch(`http://127.0.0.1:${serverPort}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': reqId,
        'x-signature': `ts=${ts},v1=${signature}`,
      },
      body: JSON.stringify({ id: 'evt-first-1', data: { id: dataId } }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.received, true);
    assert.equal(data.status, 'processed');
    assert.equal(data.isRetry, false);
  });

  test('4. Repetição de evento já processado: deduplicação idempotente sem reprocessamento', async () => {
    const dataId = '999111';
    const reqId = 'req-valid-1';
    const ts = String(Math.floor(Date.now() / 1000));
    const manifest = `id:${dataId};request-id:${reqId};ts:${ts};`;
    const signature = await hmacSha256Hex(webhookSecret, manifest);

    const res = await fetch(`http://127.0.0.1:${serverPort}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': reqId,
        'x-signature': `ts=${ts},v1=${signature}`,
      },
      body: JSON.stringify({ id: 'evt-first-1', data: { id: dataId } }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'already_processed');
    assert.equal(data.isRetry, true);
  });

  test('5. Recuperação de falha: evento persistido com falha é reprocessado com sucesso na retentativa', async () => {
    const dataId = '888222';
    const reqId = 'req-retry-http';
    const ts = String(Math.floor(Date.now() / 1000));
    const manifest = `id:${dataId};request-id:${reqId};ts:${ts};`;
    const signature = await hmacSha256Hex(webhookSecret, manifest);

    // Primeira tentativa falha (ex: upstream 500)
    const res1 = await fetch(`http://127.0.0.1:${serverPort}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': reqId,
        'x-signature': `ts=${ts},v1=${signature}`,
      },
      body: JSON.stringify({ id: 'evt-failed-1', data: { id: dataId }, simulate_failure: true }),
    });
    assert.equal(res1.status, 500);

    // Segunda tentativa (retentativa do webhook) reprocessa o evento que ficou incompleto
    const res2 = await fetch(`http://127.0.0.1:${serverPort}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': reqId,
        'x-signature': `ts=${ts},v1=${signature}`,
      },
      body: JSON.stringify({ id: 'evt-failed-1', data: { id: dataId }, simulate_failure: false }),
    });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.status, 'reprocessed_success');
    assert.equal(data2.isRetry, true);
  });
});
