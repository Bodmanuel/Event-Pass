export const USDC_DECIMALS = 6;

// USDC has 6 decimals; ticket money is held in integer cents, so one cent is 10^4 atomic units.
const ATOMIC_PER_CENT = 10n ** BigInt(USDC_DECIMALS - 2);

export function assertCents(cents) {
  if (!Number.isInteger(cents) || cents < 0) throw new Error("cents must be a nonnegative integer");
  return cents;
}

export function centsToUsdc(cents) {
  assertCents(cents);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function centsToAtomic(cents) {
  assertCents(cents);
  return (BigInt(cents) * ATOMIC_PER_CENT).toString();
}

/** Parses a decimal USDC string without touching floating point. */
export function usdcToCents(decimal) {
  const text = String(decimal).trim();
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(text)) {
    throw new Error("amount must be a nonnegative decimal with at most 6 places");
  }
  const [whole, fraction = ""] = text.split(".");
  const atomic = BigInt(`${whole}${fraction.padEnd(USDC_DECIMALS, "0")}`);
  if (atomic % ATOMIC_PER_CENT !== 0n) throw new Error("amount is more precise than one cent");
  return Number(atomic / ATOMIC_PER_CENT);
}

export function atomicToCents(atomic) {
  const value = BigInt(atomic);
  if (value % ATOMIC_PER_CENT !== 0n) throw new Error("amount is not a whole number of cents");
  return Number(value / ATOMIC_PER_CENT);
}
