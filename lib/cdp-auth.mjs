/**
 * CDP facilitator authentication — the one implementation, shared by every
 * caller. Nothing else in this codebase may build a CDP token.
 *
 * CDP expects a short-lived EdDSA JWT over Ed25519 as `Authorization: Bearer …`
 * on /verify and /settle. Two details are easy to get wrong and both fail the
 * same way — a 401 that looks like a bad API key:
 *
 *  1. The secret is base64 of 64 bytes (32-byte seed + 32-byte public key). Node
 *     cannot import a bare seed; it must be wrapped in the PKCS#8 DER header
 *     below (RFC 8410 PrivateKeyInfo).
 *  2. The `uri` claim is "<METHOD> <host><path>", and the path is the WHOLE
 *     request path. A facilitator mounted at /platform/v2/x402 is addressed at
 *     /platform/v2/x402/verify; a token claiming /verify names a different
 *     request and CDP rejects it.
 *
 * `facilitatorEndpoint` exists so the URL fetched and the path signed come from
 * one value. Callers must pass its `host` and `path` straight into `cdpJwt`;
 * deriving either independently is what made the original bug possible.
 */
import { createPrivateKey, createPublicKey, randomBytes, sign as signWith } from "node:crypto";

/** CDP bearer tokens live two minutes; refresh well inside that. */
const JWT_TTL_SECONDS = 120;

/**
 * The PKCS#8 DER prefix for an Ed25519 private key. CDP hands you a base64
 * secret whose first 32 bytes are the raw seed; Node cannot import a bare seed,
 * so it is wrapped in this fixed header (RFC 8410's
 * `PrivateKeyInfo { version, algorithm 1.3.101.112, OCTET STRING seed }`).
 */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function ed25519FromSeed(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) {
    throw new Error("An Ed25519 seed must be exactly 32 bytes.");
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/**
 * The raw 32-byte public key for a seed, as Base58-free hex-free bytes. Used by
 * tests to build a realistic 64-byte CDP secret and to verify signatures.
 */
export function ed25519PublicKeyFromSeed(seed) {
  const privateKey = ed25519FromSeed(seed);
  const publicKey = createPublicKey(privateKey);
  return publicKey.export({ type: "spki", format: "der" }).subarray(-32);
}

/**
 * Decodes a CDP API key secret to its 32-byte Ed25519 seed.
 *
 * CDP documents the secret as base64 of 64 bytes (32-byte seed followed by the
 * public key). A bare 32-byte secret is also accepted, since that is what some
 * other tooling emits. The trailing public key is not validated: it is redundant
 * for signing, and rejecting a mismatched one would turn a formatting quirk into
 * an outage. It throws without ever including the secret in the message.
 */
export function seedFromCdpSecret(secret) {
  let decoded;
  try {
    decoded = Buffer.from(String(secret ?? "").trim(), "base64");
  } catch {
    throw new Error("The CDP API key secret is not valid base64.");
  }
  if (decoded.length === 32) return decoded;
  if (decoded.length === 64) return decoded.subarray(0, 32);
  // Never state the length of a secret; it is a (weak) oracle on its value.
  throw new Error("The CDP API key secret must decode to 32 or 64 bytes.");
}

const b64url = (input) => Buffer.from(input).toString("base64url");

/**
 * The absolute endpoint a facilitator call goes to, plus the host and path its
 * JWT must name. Both halves come from one URL so they cannot disagree.
 */
export function facilitatorEndpoint(baseUrl, suffix) {
  const url = new URL(`${String(baseUrl).replace(/\/+$/, "")}${suffix}`);
  return { url: url.toString(), host: url.host, path: `${url.pathname}${url.search}` };
}

/**
 * Builds the Bearer JWT the CDP facilitator expects on /verify and /settle.
 *
 * Header `alg: EdDSA`, `kid` = the API key id. Claims `iss: "cdp"`,
 * `aud: ["cdp_service"]`, `uri` = "<METHOD> <host><path>", and a 120-second
 * `exp`. The token is a credential: it is returned to the caller for exactly one
 * outbound request and must never be logged, echoed, or put in a response.
 */
export function cdpJwt({ keyId, keySecret, method, host, path, now = Date.now() }) {
  if (typeof keyId !== "string" || keyId.trim() === "") {
    throw new Error("CDP_API_KEY_ID is missing.");
  }
  const issuedAt = Math.floor(now / 1000);
  const header = { alg: "EdDSA", typ: "JWT", kid: keyId, nonce: randomBytes(16).toString("hex") };
  const claims = {
    sub: keyId,
    iss: "cdp",
    aud: ["cdp_service"],
    nbf: issuedAt,
    exp: issuedAt + JWT_TTL_SECONDS,
    uri: `${method} ${host}${path}`,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = signWith(null, Buffer.from(signingInput, "utf8"), ed25519FromSeed(seedFromCdpSecret(keySecret)));
  return `${signingInput}.${b64url(signature)}`;
}
