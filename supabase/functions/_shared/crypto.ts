export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function base64UrlSha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBase64Url(bytes = 32): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  const base64 = btoa(String.fromCharCode(...array));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function encryptAesGcm(plaintext: string, secretKeyHex: string, aadContext: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const keyBytes = new Uint8Array(secretKeyHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);

  const encryptedBuf = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(aadContext),
      tagLength: 128,
    },
    cryptoKey,
    new TextEncoder().encode(plaintext)
  );

  const encryptedBytes = new Uint8Array(encryptedBuf);
  const data = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const tag = encryptedBytes.slice(encryptedBytes.length - 16);

  return JSON.stringify({
    v: 1,
    alg: "aes-256-gcm",
    iv: btoa(String.fromCharCode(...iv)),
    tag: btoa(String.fromCharCode(...tag)),
    data: btoa(String.fromCharCode(...data)),
  });
}

export async function decryptAesGcm(envelopeJson: string, secretKeyHex: string, aadContext: string): Promise<string> {
  const envelope = JSON.parse(envelopeJson);
  const iv = Uint8Array.from(atob(envelope.iv), (c) => c.charCodeAt(0));
  const tag = Uint8Array.from(atob(envelope.tag), (c) => c.charCodeAt(0));
  const data = Uint8Array.from(atob(envelope.data), (c) => c.charCodeAt(0));

  const keyBytes = new Uint8Array(secretKeyHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);

  const combined = new Uint8Array(data.length + tag.length);
  combined.set(data, 0);
  combined.set(tag, data.length);

  const decryptedBuf = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(aadContext),
      tagLength: 128,
    },
    cryptoKey,
    combined
  );

  return new TextDecoder().decode(decryptedBuf);
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
