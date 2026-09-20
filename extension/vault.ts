/**
 * vault.ts — AES-GCM-256 encrypted local profile vault.
 *
 * The user's private data (name, email, phone, etc.) is stored ONLY here,
 * encrypted with a per-device key in chrome.storage.local.
 * This data is NEVER sent to any server. The vault resolves {{TOKEN}}
 * placeholders received from the server into real values, locally.
 *
 * Encryption scheme:
 *   - AES-GCM-256 via Web Crypto SubtleCrypto API
 *   - A fresh random AES key is generated on first run and stored as a JWK
 *     under the extension's sandboxed chrome.storage.local
 *   - Each save generates a fresh 12-byte random IV
 *   - Ciphertext is stored as base64(iv) + "." + base64(ciphertext)
 */

const api = (globalThis as any).browser || (globalThis as any).chrome;
const VAULT_KEY_STORE  = '__privexa_vault_key_v1__';
const VAULT_DATA_STORE = '__privexa_vault_data_v1__';

export type VaultData = {
  NAME?:     string;
  EMAIL?:    string;
  PHONE?:    string;
  ADDRESS?:  string;
  AADHAAR?:  string;
  PAN?:      string;
  PASSWORD?: string;
};

/** Tokens that the server is allowed to send in a FILL action. */
export type VaultToken = '{{NAME}}' | '{{EMAIL}}' | '{{PHONE}}' | '{{ADDRESS}}' | '{{AADHAAR}}' | '{{PAN}}' | '{{PASSWORD}}';

/** Resolve a server-issued {{TOKEN}} to its local vault value. Returns null if not set. */
export function resolveToken(token: string, vault: VaultData): string | null {
  const map: Record<string, keyof VaultData> = {
    '{{NAME}}':     'NAME',
    '{{EMAIL}}':    'EMAIL',
    '{{PHONE}}':    'PHONE',
    '{{ADDRESS}}':  'ADDRESS',
    '{{AADHAAR}}':  'AADHAAR',
    '{{PAN}}':      'PAN',
    '{{PASSWORD}}': 'PASSWORD',
  };
  const key = map[token];
  if (!key) return null;
  return vault[key] ?? null;
}

/** Human-readable token label for UI display (same for all, password shown as asterisks). */
export function tokenDisplayLabel(token: string): string {
  const labels: Record<string, string> = {
    '{{NAME}}':     'Your Name',
    '{{EMAIL}}':    'Your Email',
    '{{PHONE}}':    'Your Phone Number',
    '{{ADDRESS}}':  'Your Address',
    '{{AADHAAR}}':  'Your Aadhaar',
    '{{PAN}}':      'Your PAN',
    '{{PASSWORD}}': 'Your Password',
  };
  return labels[token] ?? token;
}

// ── Crypto Internals ──────────────────────────────────────────────────────────

async function getOrCreateCryptoKey(): Promise<CryptoKey> {
  const stored = await chromeGet(VAULT_KEY_STORE) as { jwk?: JsonWebKey } | undefined;
  if (stored?.jwk) {
    return crypto.subtle.importKey('jwk', stored.jwk, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  }
  // Generate a fresh 256-bit AES-GCM key on first use
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  await chromeSet(VAULT_KEY_STORE, { jwk });
  return key;
}

function b64Encode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64Decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function encryptVault(data: VaultData, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return b64Encode(iv.buffer) + '.' + b64Encode(ciphertext);
}

async function decryptVault(payload: string, key: CryptoKey): Promise<VaultData> {
  const [ivB64, ctB64] = payload.split('.');
  if (!ivB64 || !ctB64) throw new Error('invalid vault payload');
  const iv = b64Decode(ivB64);
  const ciphertext = b64Decode(ctB64);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as VaultData;
}

// ── Chrome Storage Helpers ────────────────────────────────────────────────────

function chromeGet(key: string): Promise<any> {
  return new Promise((resolve) => {
    api.storage.local.get(key, (result: any) => resolve(result?.[key]));
  });
}
function chromeSet(key: string, value: any): Promise<void> {
  return new Promise((resolve) => {
    api.storage.local.set({ [key]: value }, resolve);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Load and decrypt the vault. Returns empty object if not yet set. */
export async function getVault(): Promise<VaultData> {
  try {
    const payload = await chromeGet(VAULT_DATA_STORE) as string | undefined;
    if (!payload || typeof payload !== 'string') return {};
    const key = await getOrCreateCryptoKey();
    return await decryptVault(payload, key);
  } catch {
    // Vault unreadable (e.g. corrupted). Return empty — user will need to re-enter.
    return {};
  }
}

/** Encrypt and save vault data to chrome.storage.local. */
export async function saveVault(data: VaultData): Promise<void> {
  // Strip empty strings so resolveToken returns null (not '') for unfilled fields
  const clean: VaultData = {};
  for (const [k, v] of Object.entries(data) as [keyof VaultData, string][]) {
    if (v && v.trim()) (clean as any)[k] = v.trim();
  }
  const key = await getOrCreateCryptoKey();
  const payload = await encryptVault(clean, key);
  await chromeSet(VAULT_DATA_STORE, payload);
}

/** Clear the vault entirely. */
export async function clearVault(): Promise<void> {
  await new Promise<void>((resolve) => {
    api.storage.local.remove([VAULT_DATA_STORE], resolve);
  });
}
