export const ORGANIZER = {
  name: "AfroGroove Live",
  verified: true,
  // Organizers can only redeem tickets for their own events.
  events: ["evt_afrogroove_2026"],
};

export const EVENTS = [
  {
    eventId: "evt_afrogroove_2026",
    name: "AfroGroove Fest",
    genre: "Afrobeat",
    city: "New York",
    venue: "Brooklyn Paramount",
    address: "385 Flatbush Ave Ext, Brooklyn, NY",
    startsAt: "2026-10-17T23:00:00Z",
    doorsAt: "2026-10-17T22:00:00Z",
    timezone: "America/New_York",
    organizer: ORGANIZER.name,
    organizerVerified: ORGANIZER.verified,
    tiers: [
      { tierId: "tier_ga", name: "General Admission", faceCents: 800, feeCents: 150, remaining: 40, maxPerOrder: 6 },
      { tierId: "tier_vip", name: "VIP Front Row", faceCents: 2200, feeCents: 250, remaining: 10, maxPerOrder: 4 },
    ],
  },
];

/** The launch event the SQL seed writes. `seedSql` assumes exactly two tiers. */
export const SEED_EVENT = EVENTS[0];
