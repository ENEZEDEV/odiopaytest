import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class TokenVault {
  #key;

  constructor(key) {
    if (typeof key === 'string') {
      if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
        this.#key = Buffer.from(key, 'hex');
      } else {
        this.#key = Buffer.from(key, 'base64');
      }
    } else if (Buffer.isBuffer(key)) {
      this.#key = Buffer.from(key);
    }
    if (!this.#key || this.#key.length !== 32) {
      throw new Error('token_vault_key_invalid: Key must be exactly 32 bytes (256-bit)');
    }
  }

  seal(value, context) {
    if (typeof context !== 'string' || context.length === 0) {
      throw new Error('token_vault_context_required');
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));

    const payload = typeof value === 'string' ? value : JSON.stringify(value);
    const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return JSON.stringify({
      v: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    });
  }

  open(envelopeJson, context) {
    if (typeof context !== 'string' || context.length === 0) {
      throw new Error('token_vault_context_required');
    }
    try {
      const envelope = typeof envelopeJson === 'string' ? JSON.parse(envelopeJson) : envelopeJson;
      if (envelope.v !== 1 || envelope.alg !== 'aes-256-gcm') {
        throw new Error('unsupported_envelope_version');
      }
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      const data = Buffer.from(envelope.data, 'base64');

      if (iv.length !== 12 || tag.length !== 16) {
        throw new Error('invalid_envelope_parameters');
      }

      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      try {
        return JSON.parse(decrypted);
      } catch {
        return decrypted;
      }
    } catch (err) {
      throw new Error('token_vault_decryption_failed');
    }
  }
}
