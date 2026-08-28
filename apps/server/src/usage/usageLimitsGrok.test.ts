import { describe, expect, it } from "@effect/vitest";

import {
  GROK_DEFAULT_PROXY_BASE_URL,
  grokPlanLabel,
  parseGrokAuthCredentials,
  parseGrokBillingWindows,
  parseGrokUserProfile,
  resolveGrokProxyBaseUrl,
} from "./usageLimitsGrok.ts";

describe("resolveGrokProxyBaseUrl", () => {
  it("prefers the env override and normalises it", () => {
    expect(
      resolveGrokProxyBaseUrl({
        envBaseUrl: "https://proxy.corp.example/v1/",
        modelsCacheRaw: null,
      }),
    ).toBe("https://proxy.corp.example/v1");
  });

  it("fails closed on an unparseable override instead of using the default", () => {
    expect(resolveGrokProxyBaseUrl({ envBaseUrl: "not a url", modelsCacheRaw: null })).toBeNull();
    expect(
      resolveGrokProxyBaseUrl({ envBaseUrl: "ftp://proxy.example/v1", modelsCacheRaw: null }),
    ).toBeNull();
  });

  it("derives the base from the models cache origin, else defaults", () => {
    expect(
      resolveGrokProxyBaseUrl({
        envBaseUrl: undefined,
        modelsCacheRaw: JSON.stringify({
          auth_method: "session",
          origin: "https://team-proxy.example/v1/models",
        }),
      }),
    ).toBe("https://team-proxy.example/v1");
    expect(resolveGrokProxyBaseUrl({ envBaseUrl: undefined, modelsCacheRaw: "junk" })).toBe(
      GROK_DEFAULT_PROXY_BASE_URL,
    );
    expect(resolveGrokProxyBaseUrl({ envBaseUrl: undefined, modelsCacheRaw: null })).toBe(
      GROK_DEFAULT_PROXY_BASE_URL,
    );
  });
});

describe("parseGrokAuthCredentials", () => {
  it("picks the OIDC entry from the issuer-keyed map", () => {
    const raw = JSON.stringify({
      "https://auth.x.ai::client-uuid": {
        key: "bearer-token",
        auth_mode: "oidc",
        email: "user@example.com",
        refresh_token: "r",
      },
    });
    expect(parseGrokAuthCredentials(raw)).toEqual({
      key: "bearer-token",
      authMode: "oidc",
      email: "user@example.com",
    });
  });

  it("prefers OIDC over other entries and falls back otherwise", () => {
    const raw = JSON.stringify({
      a: { key: "api-ish", auth_mode: "api_key" },
      b: { key: "oidc-token", auth_mode: "oidc" },
    });
    expect(parseGrokAuthCredentials(raw)?.key).toBe("oidc-token");
    expect(
      parseGrokAuthCredentials(JSON.stringify({ a: { key: "k", auth_mode: "api_key" } })),
    ).toEqual({ key: "k", authMode: "api_key", email: null });
  });

  it("returns null for junk", () => {
    expect(parseGrokAuthCredentials("not json")).toBeNull();
    expect(parseGrokAuthCredentials("{}")).toBeNull();
    expect(parseGrokAuthCredentials(JSON.stringify({ a: { key: "  " } }))).toBeNull();
  });
});

describe("grokPlanLabel", () => {
  it("maps known tiers and spaces unknown camel-case ones", () => {
    expect(grokPlanLabel("XPremium")).toBe("X Premium");
    expect(grokPlanLabel("SuperGrok")).toBe("SuperGrok");
    expect(grokPlanLabel("SuperGrokHeavy")).toBe("SuperGrok Heavy");
    expect(grokPlanLabel("MegaTier")).toBe("Mega Tier");
    expect(grokPlanLabel(null)).toBeNull();
  });
});

describe("parseGrokUserProfile", () => {
  it("reads email and tier, tolerating junk", () => {
    expect(
      parseGrokUserProfile({ email: "user@example.com", subscriptionTier: "XPremium" }),
    ).toEqual({ email: "user@example.com", subscriptionTier: "XPremium" });
    expect(parseGrokUserProfile(null)).toEqual({ email: null, subscriptionTier: null });
  });
});

describe("parseGrokBillingWindows", () => {
  // Shape observed live from cli-chat-proxy.grok.com (grok CLI 1.0.3).
  const liveResponse = {
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-10T03:52:10.269564+00:00",
        end: "2026-08-17T03:52:10.269564+00:00",
      },
      creditUsagePercent: 60.0,
      onDemandCap: { val: 0 },
      productUsage: [
        { product: "GrokBuild", usagePercent: 57.0 },
        { product: "GrokChat", usagePercent: 3.0 },
      ],
      isUnifiedBillingUser: true,
      billingPeriodEnd: "2026-08-17T03:52:10.269564+00:00",
    },
  };

  it("maps the credit budget and per-product splits", () => {
    expect(parseGrokBillingWindows(liveResponse)).toEqual([
      {
        id: "credits",
        label: "Weekly limit",
        detail: "All products · weekly credit window",
        utilization: 60,
        resetsAt: "2026-08-17T03:52:10.269564+00:00",
      },
      {
        id: "credits:GrokBuild",
        label: "Weekly limit (Grok Build)",
        detail: "Weekly credit window",
        utilization: 57,
        resetsAt: "2026-08-17T03:52:10.269564+00:00",
      },
      {
        id: "credits:GrokChat",
        label: "Weekly limit (Grok Chat)",
        detail: "Weekly credit window",
        utilization: 3,
        resetsAt: "2026-08-17T03:52:10.269564+00:00",
      },
    ]);
  });

  it("handles a bare config and unknown period types", () => {
    const windows = parseGrokBillingWindows({
      creditUsagePercent: 12.5,
      currentPeriod: { type: "USAGE_PERIOD_TYPE_MYSTERY", end: null },
      billingPeriodEnd: "2026-09-01T00:00:00+00:00",
    });
    expect(windows).toEqual([
      {
        id: "credits",
        label: "Usage limit",
        detail: "All products · credit window",
        utilization: 12.5,
        resetsAt: "2026-09-01T00:00:00+00:00",
      },
    ]);
  });

  it("returns empty for malformed documents", () => {
    expect(parseGrokBillingWindows(null)).toEqual([]);
    expect(parseGrokBillingWindows({ config: { creditUsagePercent: "lots" } })).toEqual([]);
  });
});
