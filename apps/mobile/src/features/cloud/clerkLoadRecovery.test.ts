import { describe, expect, it } from "vite-plus/test";

import { clerkAccountRowLabel } from "./clerkLoadRecovery";

describe("clerkAccountRowLabel", () => {
  it("shows Checking until Clerk loads", () => {
    expect(
      clerkAccountRowLabel({
        email: undefined,
        isLoaded: false,
        isSignedIn: false,
      }),
    ).toBe("Checking");
  });

  it("shows Sign in when loaded and signed out", () => {
    expect(
      clerkAccountRowLabel({
        email: undefined,
        isLoaded: true,
        isSignedIn: false,
      }),
    ).toBe("Sign in");
  });

  it("prefers the account email when signed in", () => {
    expect(
      clerkAccountRowLabel({
        email: "c@mwolson.org",
        isLoaded: true,
        isSignedIn: true,
      }),
    ).toBe("c@mwolson.org");
  });
});
