// Minimal Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) using only WebCrypto.

const enc = new TextEncoder();

export const b64u = {
  enc(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str) {
    let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  },
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

export async function encryptPayload({ p256dh, auth }, payload) {
  const uaPublic = b64u.dec(p256dh);
  const authSecret = b64u.dec(auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, enc.encode("Content-Encoding: aes128gcm\0\x01"))).slice(0, 16);
  const nonce = (await hmac(prk, enc.encode("Content-Encoding: nonce\0\x01"))).slice(0, 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat(enc.encode(payload), new Uint8Array([2])); // 0x02 = last record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

export async function vapidHeader(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const part = (o) => b64u.enc(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })}`;
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_PRIVATE_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64u.enc(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

/** Sends one notification. Returns the push service's HTTP status. */
export async function sendPush(env, sub, message, ttl = 3600) {
  const body = await encryptPayload(sub, JSON.stringify(message));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(ttl),
      urgency: "high",
      authorization: await vapidHeader(sub.endpoint, env),
    },
    body,
  });
  if (res.status >= 400) console.warn("push failed", res.status, await res.text().catch(() => ""));
  return res.status;
}
