import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError, requireThat } from './errors.js';

// Uses authenticated encryption from Node/OpenSSL; never persist this key with the database.
export class TokenVault {
  #key;
  constructor(key) {
    requireThat(Buffer.isBuffer(key) && key.length === 32, 500, 'token_vault_key_required');
    this.#key = Buffer.from(key);
  }
  seal(value, context) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  open(envelope, context) {
    try {
      const value = JSON.parse(envelope);
      if (value.v !== 1) throw new Error();
      const iv = Buffer.from(value.iv, 'base64'); const tag = Buffer.from(value.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
      decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch { throw new AppError(500, 'token_vault_invalid'); }
  }
}
