export type SeedTier = {
  tierId: string;
  name: string;
  faceCents: number;
  feeCents: number;
  remaining: number;
  maxPerOrder: number;
};

export type SeedEvent = {
  eventId: string;
  name: string;
  genre: string;
  city: string;
  venue: string;
  startsAt: string;
  timezone: string;
  organizer: string;
  organizerVerified: boolean;
  tiers: SeedTier[];
};

/** Exact cent-to-decimal conversion; never routes money through a float. */
export function centsToUsdc(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error("cents must be a nonnegative integer");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function tierTotalCents(tier: SeedTier): number {
  return tier.faceCents + tier.feeCents;
}

export function lowestTotalCents(event: SeedEvent): number {
  return Math.min(...event.tiers.map(tierTotalCents));
}

/**
 * Bundled copy of the launch catalogue. The hosted API is the source of truth for
 * inventory; this exists so event discovery still answers when the API is
 * unreachable, and so the plugin's sample call works with no network at all.
 */
export const SEED_EVENTS: SeedEvent[] = [
  {
    eventId: "evt_afrogroove_2026",
    name: "AfroGroove Fest",
    genre: "Afrobeat",
    city: "New York",
    venue: "Brooklyn Paramount",
    startsAt: "2026-10-17T23:00:00Z",
    timezone: "America/New_York",
    organizer: "AfroGroove Live",
    organizerVerified: true,
    tiers: [
      { tierId: "tier_ga", name: "General Admission", faceCents: 800, feeCents: 150, remaining: 40, maxPerOrder: 6 },
      { tierId: "tier_vip", name: "VIP Front Row", faceCents: 2200, feeCents: 250, remaining: 10, maxPerOrder: 4 },
    ],
  },
];
