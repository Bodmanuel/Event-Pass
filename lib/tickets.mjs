import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** `EVPP1.<ticketId>.<nonce>.<sig>` — short enough to encode as a QR and verifiable offline. */
const PREFIX = "EVPP1";

function signature(secret, eventId, ticketId, nonce) {
  return createHmac("sha256", secret).update(`${eventId}|${ticketId}|${nonce}`).digest("base64url").slice(0, 22);
}

export function createTicketCode(secret, { eventId, ticketId }) {
  const nonce = randomBytes(6).toString("base64url");
  return { nonce, code: `${PREFIX}.${ticketId}.${nonce}.${signature(secret, eventId, ticketId, nonce)}` };
}

export function parseTicketCode(code) {
  const parts = String(code).trim().split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return undefined;
  const [, ticketId, nonce, sig] = parts;
  if (!ticketId || !nonce || !sig) return undefined;
  return { ticketId, nonce, sig };
}

/** Constant-time check that a code was issued by this server for this event. */
export function verifyTicketCode(secret, eventId, code) {
  const parsed = parseTicketCode(code);
  if (!parsed) return undefined;
  const expected = signature(secret, eventId, parsed.ticketId, parsed.nonce);
  const a = Buffer.from(expected);
  const b = Buffer.from(parsed.sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return parsed;
}

export function redeemUrl(baseUrl, code) {
  return `${baseUrl}/t/${code}`;
}

export function qrImageUrl(baseUrl, code) {
  return `${baseUrl}/q/${code}.svg`;
}
