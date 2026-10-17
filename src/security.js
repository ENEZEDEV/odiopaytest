import { createHash, createHmac, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { requireThat } from './errors.js';
import { transaction } from './database.js';

export const digest = value => createHash('sha256').update(value).digest('hex');

export function provisionMerchant(db, name, plan = 'standard') {
  requireThat(typeof name === 'string' && name.trim().length >= 2 && name.length <= 100, 400, 'invalid_name');
  requireThat(['standard', 'pro'].includes(plan), 400, 'invalid_plan');
  const id = randomUUID();
  const destinationId = randomUUID();
  const apiKey = `odi_sandbox_${randomBytes(32).toString('hex')}`;
  transaction(db, () => {
    db.prepare('INSERT INTO merchants VALUES (?,?,?)').run(id, name.trim(), plan);
    db.prepare('INSERT INTO api_keys(digest,merchant_id) VALUES (?,?)').run(digest(apiKey), id);
    db.prepare('INSERT INTO sandbox_destinations(id,merchant_id) VALUES (?,?)').run(destinationId, id);
  });
  return { id, apiKey, destinationId };
}

export function authenticate(db, authorization) {
  requireThat(typeof authorization === 'string' && /^Bearer odi_sandbox_[a-f0-9]{64}$/.test(authorization), 401, 'unauthorized');
  const merchant = db.prepare(`SELECT m.id, m.plan FROM api_keys k JOIN merchants m ON m.id=k.merchant_id WHERE k.digest=? AND k.revoked=0`).get(digest(authorization.slice(7)));
  requireThat(merchant, 401, 'unauthorized');
  return merchant;
}

export function signWebhook(secret, timestamp, rawBody) {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

export function verifyWebhook(secret, timestamp, signature, rawBody, now = Date.now()) {
  requireThat(typeof timestamp === 'string' && /^\d{10}$/.test(timestamp), 401, 'invalid_signature');
  requireThat(Math.abs(Math.floor(now / 1000) - Number(timestamp)) <= 300, 401, 'expired_signature');
  requireThat(typeof signature === 'string' && /^[a-f0-9]{64}$/.test(signature), 401, 'invalid_signature');
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody), 'hex');
  requireThat(timingSafeEqual(expected, Buffer.from(signature, 'hex')), 401, 'invalid_signature');
}

export class RateLimiter {
  #buckets = new Map();
  constructor(limit = 120, windowMs = 60_000, maxBuckets = 10_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxBuckets = maxBuckets;
  }
  allow(key, now = Date.now()) {
    let bucket = this.#buckets.get(key);
    if (!bucket || bucket.expires <= now) {
      for (const [id, value] of this.#buckets) if (value.expires <= now) this.#buckets.delete(id);
      if (this.#buckets.size >= this.maxBuckets && !this.#buckets.has(key)) return false;
      bucket = { count: 0, expires: now + this.windowMs };
      this.#buckets.set(key, bucket);
    }
    return ++bucket.count <= this.limit;
  }
}
