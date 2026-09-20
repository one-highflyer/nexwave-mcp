const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return toBase64Url(value);
}

export async function encryptSecret(value: string, base64Key: string): Promise<string> {
  const key = await importEncryptionKey(base64Key);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    encoder.encode(value).buffer as ArrayBuffer,
  );
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(value: string, base64Key: string): Promise<string> {
  const [version, ivValue, ciphertextValue] = value.split(".");
  if (version !== "v1" || !ivValue || !ciphertextValue) {
    throw new Error("The stored secret format is not supported.");
  }
  const key = await importEncryptionKey(base64Key);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(ivValue).buffer as ArrayBuffer },
    key,
    fromBase64Url(ciphertextValue).buffer as ArrayBuffer,
  );
  return decoder.decode(decrypted);
}

export function safeBaseUrl(value: string): string {
  const url = new URL(value);
  requireSafeProtocol(url);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The site URL cannot contain credentials, a query, or a fragment.");
  }
  if (url.pathname !== "/") {
    throw new Error("Enter the site origin without a path.");
  }
  return url.origin;
}

export function siteOriginFromInput(value: string): string {
  const url = new URL(value.trim());
  requireSafeProtocol(url);
  if (url.username || url.password) {
    throw new Error("The site URL cannot contain credentials.");
  }
  return url.origin;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character];
  });
}

export function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [cookieName, ...rest] = part.trim().split("=");
    if (cookieName === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function cookieName(request: Request): string {
  return new URL(request.url).protocol === "https:" ? "__Host-nexwave_oauth" : "nexwave_oauth";
}

export function makeCookie(request: Request, value: string, maxAge = 600): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${cookieName(request)}=${encodeURIComponent(value)}; HttpOnly${secure}; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie(request: Request): string {
  return makeCookie(request, "", 0);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importEncryptionKey(base64Key: string): Promise<CryptoKey> {
  const bytes = fromBase64Url(base64Key);
  if (bytes.byteLength !== 32) {
    throw new Error("CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }
  return crypto.subtle.importKey("raw", bytes.buffer as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function requireSafeProtocol(url: URL): void {
  const isLocal = url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new Error("Use an HTTPS URL. HTTP is permitted only for localhost.");
  }
}
