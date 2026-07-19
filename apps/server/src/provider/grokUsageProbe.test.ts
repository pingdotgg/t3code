import { describe, expect, it } from "vite-plus/test";

import { grokAuthFromSubscriptionProbe, parseGrokAuthCheckSubscription } from "./grokUsageProbe.ts";

describe("grokUsageProbe", () => {
  it("parses authenticated subscription probes", () => {
    expect(
      parseGrokAuthCheckSubscription({
        authenticated: true,
        meta: {
          email: "user@example.com",
          auth_mode: "Oidc",
          subscription_tier: "SuperGrok",
        },
      }),
    ).toEqual({
      authenticated: true,
      email: "user@example.com",
      authMode: "Oidc",
      subscriptionTier: "SuperGrok",
    });
  });

  it("parses unauthenticated subscription probes", () => {
    expect(parseGrokAuthCheckSubscription({ authenticated: false })).toEqual({
      authenticated: false,
    });
  });

  it("maps authenticated probes to provider auth metadata", () => {
    expect(
      grokAuthFromSubscriptionProbe({
        authenticated: true,
        email: "user@example.com",
        subscriptionTier: "SuperGrok",
      }),
    ).toEqual({
      status: "authenticated",
      email: "user@example.com",
      type: "SuperGrok",
      label: "SuperGrok",
    });
  });
});
