/* RF基準線トラッカー 自動同期（v1.5.0）: 暗号化エンベロープの復号と設定文字列の解釈。
 * 純関数＋WebCrypto。ブラウザ(window.RFSync)とNode(module.exports)の両方で動く。
 * 配信元は非公開GitHubリポジトリの data.enc（AES-256-GCM）。鍵・トークンは端末のIndexedDB metaにのみ置く。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RFSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const webcrypto = () => (typeof crypto !== 'undefined' && crypto.subtle) ? crypto : require('crypto').webcrypto;
  const ENC_FILE = 'data.enc';

  function b64urlToBytes(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /* 設定文字列 "rfsync1:<owner>/<repo>:<key(base64url 32bytes)>" → {repo, key}。不正なら null */
  function parseSetup(str) {
    const m = /^\s*rfsync1:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):([A-Za-z0-9_-]{43})\s*$/.exec(String(str || ''));
    if (!m) return null;
    if (b64urlToBytes(m[2]).length !== 32) return null;
    return { repo: m[1], key: m[2] };
  }

  async function importKey(keyB64url, usages) {
    return webcrypto().subtle.importKey('raw', b64urlToBytes(keyB64url), { name: 'AES-GCM' }, false, usages);
  }

  /* エンベロープ {v:1, alg:'AES-256-GCM', iv:b64url(12B), ct:b64url(ciphertext||tag), updated:ISO} → 平文文字列 */
  async function decryptEnvelope(envelope, keyB64url) {
    const env = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
    if (!env || env.v !== 1 || env.alg !== 'AES-256-GCM') throw new Error('未対応のエンベロープ形式');
    const key = await importKey(keyB64url, ['decrypt']);
    const pt = await webcrypto().subtle.decrypt({ name: 'AES-GCM', iv: b64urlToBytes(env.iv) }, key, b64urlToBytes(env.ct));
    return new TextDecoder().decode(pt);
  }

  /* 検証・テスト用（本番の暗号化はMac側 scripts/sync_push.py） */
  async function encryptEnvelope(text, keyB64url, updated) {
    const key = await importKey(keyB64url, ['encrypt']);
    const iv = new Uint8Array(12);
    webcrypto().getRandomValues(iv);
    const ct = await webcrypto().subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    return { v: 1, alg: 'AES-256-GCM', iv: bytesToB64url(iv), ct: bytesToB64url(new Uint8Array(ct)), updated: updated || new Date().toISOString() };
  }

  /* GitHub Contents API から data.enc を取得。fetchFn は注入可（テスト用）。
   * 返り値: {ok:true, envelope} | {ok:false, reason:'auth'|'notfound'|'network'|'http', status} */
  async function fetchEnvelope(repo, token, fetchFn) {
    const f = fetchFn || (typeof fetch === 'function' ? fetch : null);
    if (!f) return { ok: false, reason: 'network', status: 0 };
    let res;
    try {
      res = await f(`https://api.github.com/repos/${repo}/contents/${ENC_FILE}`, {
        headers: { Accept: 'application/vnd.github.raw+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
        cache: 'no-store'
      });
    } catch (e) {
      return { ok: false, reason: 'network', status: 0 };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth', status: res.status };
    if (res.status === 404) return { ok: false, reason: 'notfound', status: 404 };
    if (!res.ok) return { ok: false, reason: 'http', status: res.status };
    try {
      return { ok: true, envelope: JSON.parse(await res.text()) };
    } catch (e) {
      return { ok: false, reason: 'http', status: res.status };
    }
  }

  return { ENC_FILE, b64urlToBytes, bytesToB64url, parseSetup, decryptEnvelope, encryptEnvelope, fetchEnvelope };
});
