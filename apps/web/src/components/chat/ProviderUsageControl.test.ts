import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  deriveProviderUsageHeadline,
  type ProviderUsageHeadline,
  type ProviderUsagePresentation,
} from "../provider-usage/ProviderUsagePresentation";
import { shouldShowProviderUsageAlert } from "./ProviderUsageControl";

const makeUsage = (
  overrides: Partial<ProviderUsagePresentation> = {},
): ProviderUsagePresentation => ({
  account: "person@example.com",
  credits: undefined,
  displayName: "Codex",
  driver: ProviderDriverKind.make("codex"),
  fetchedAt: "2026-07-17T10:00:00.000Z",
  instanceId: ProviderInstanceId.make("codex"),
  message: undefined,
  planLabel: "Pro",
  sourceNodes: [],
  status: "ok",
  windows: [],
  ...overrides,
});

const headline = (usedPercent: number | null): ProviderUsageHeadline => ({
  label: usedPercent === null ? "Unlimited" : `${100 - usedPercent}% left`,
  usedPercent,
});

describe("shouldShowProviderUsageAlert", () => {
  it("keeps healthy and nonnumeric usage out of the composer", () => {
    expect(shouldShowProviderUsageAlert(makeUsage(), headline(3))).toBe(false);
    expect(shouldShowProviderUsageAlert(makeUsage(), headline(74))).toBe(false);
    expect(shouldShowProviderUsageAlert(makeUsage(), headline(null))).toBe(false);
  });

  it("shows low-capacity and unavailable usage", () => {
    expect(shouldShowProviderUsageAlert(makeUsage(), headline(75))).toBe(true);
    expect(shouldShowProviderUsageAlert(makeUsage(), headline(95))).toBe(true);
    expect(shouldShowProviderUsageAlert(makeUsage({ status: "unauthenticated" }), null)).toBe(true);
    expect(shouldShowProviderUsageAlert(makeUsage({ status: "error" }), null)).toBe(true);
  });

  it("alerts on nearly consumed credits only after the limits are exhausted", () => {
    const healthySession = makeUsage({
      windows: [{ id: "session", label: "Session", kind: "session", usedPercent: 50 }],
      credits: { label: "Credits", usedCredits: 95, monthlyLimit: 100 },
    });
    const healthyHeadline = deriveProviderUsageHeadline(healthySession);
    expect(healthyHeadline).toEqual({ label: "50% left", usedPercent: 50 });
    expect(shouldShowProviderUsageAlert(healthySession, healthyHeadline)).toBe(false);

    const exhaustedLimits = makeUsage({
      windows: [
        { id: "session", label: "Session", kind: "session", usedPercent: 100 },
        { id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 100 },
      ],
      credits: { label: "Credits", usedCredits: 95, monthlyLimit: 100 },
    });
    const exhaustedHeadline = deriveProviderUsageHeadline(exhaustedLimits);
    expect(exhaustedHeadline).toEqual({ label: "$5.00 left", usedPercent: 95 });
    expect(shouldShowProviderUsageAlert(exhaustedLimits, exhaustedHeadline)).toBe(true);
  });

  it("does not alert for unsupported providers", () => {
    expect(shouldShowProviderUsageAlert(makeUsage({ status: "unsupported" }), null)).toBe(false);
  });
});
