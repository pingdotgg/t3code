import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildProviderUsageSubtitle,
  deriveProviderUsageHeadline,
  ProviderUsageDetails,
  type ProviderUsagePresentation,
} from "./ProviderUsagePresentation";

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
  sourceNodes: ["Local"],
  status: "ok",
  windows: [],
  ...overrides,
});

describe("deriveProviderUsageHeadline", () => {
  it("uses the limit with the least remaining capacity", () => {
    const headline = deriveProviderUsageHeadline(
      makeUsage({
        windows: [
          { id: "session", label: "Session", kind: "session", usedPercent: 20 },
          { id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 85 },
        ],
      }),
    );

    expect(headline).toEqual({ label: "15% left", usedPercent: 85 });
  });

  it("falls back to a credit balance when no windows exist", () => {
    const headline = deriveProviderUsageHeadline(
      makeUsage({ credits: { label: "Credits", usedCredits: 12, monthlyLimit: 100 } }),
    );

    expect(headline).toEqual({ label: "$88.00 left", usedPercent: 12 });
  });

  it("does not summarize non-success states", () => {
    expect(deriveProviderUsageHeadline(makeUsage({ status: "unauthenticated" }))).toBeNull();
  });
});

describe("buildProviderUsageSubtitle", () => {
  it("combines account and source environments", () => {
    expect(buildProviderUsageSubtitle("person@example.com", ["Local", "VPS"])).toBe(
      "person@example.com · via Local, VPS",
    );
  });
});

describe("ProviderUsageDetails", () => {
  it("renders meters only for limits with numeric usage data", () => {
    const unlimitedMarkup = renderToStaticMarkup(
      <ProviderUsageDetails
        usage={makeUsage({ credits: { label: "Credits", unlimited: true } })}
        nowMs={Date.parse("2026-07-17T10:00:00.000Z")}
      />,
    );
    const numericMarkup = renderToStaticMarkup(
      <ProviderUsageDetails
        usage={makeUsage({ credits: { label: "Credits", usedCredits: 12, monthlyLimit: 100 } })}
        nowMs={Date.parse("2026-07-17T10:00:00.000Z")}
      />,
    );

    expect(unlimitedMarkup).toContain("Unlimited");
    expect(unlimitedMarkup).not.toContain('role="progressbar"');
    expect(numericMarkup).toContain('role="progressbar"');
  });
});
