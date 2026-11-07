import { describe, expect, it } from "vite-plus/test";

import { canShareWithGuest } from "./guestShareAvailability";

describe("mobile guest sharing availability", () => {
  it("requires permission and the beta, and respects the environment's Connect policy", () => {
    const enabled = { settings: { guestSharingEnabled: true } };
    expect(canShareWithGuest(true, enabled)).toBe(true);
    expect(canShareWithGuest(false, enabled)).toBe(false);
    expect(canShareWithGuest(true, undefined)).toBe(false);
    expect(canShareWithGuest(true, { settings: { guestSharingEnabled: false } })).toBe(false);
    expect(
      canShareWithGuest(true, {
        ...enabled,
        managedPolicy: {
          organization: "Example",
          lockedSettings: [],
          limits: { connect: false },
        },
      }),
    ).toBe(false);
    expect(
      canShareWithGuest(true, {
        ...enabled,
        managedPolicy: { organization: "Example", lockedSettings: [] },
      }),
    ).toBe(true);
  });
});
