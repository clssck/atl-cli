/** RFC 7636 PKCE (S256) and OAuth `state` generation. */

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

function randomBase64url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** 32 random bytes, base64url without padding (43 characters). */
export function createCodeVerifier(): string {
  return randomBase64url(32);
}

/** BASE64URL(SHA256(ASCII(verifier))). */
export function codeChallengeS256(verifier: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(verifier).digest();
  return base64url(digest);
}

export function createState(): string {
  return randomBase64url(32);
}
