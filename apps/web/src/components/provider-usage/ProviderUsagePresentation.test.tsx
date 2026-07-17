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
  it("headlines the session limit while it has capacity, even when weekly is tighter", () => {
    const headline = deriveProviderUsageHeadline(
      makeUsage({
        windows: [
          { id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 85 },
          { id: "session", label: "Session", kind: "session", usedPercent: 20 },
        ],
      }),
    );

    expect(headline).toEqual({ label: "80% left", usedPercent: 20 });
  });

  it("moves to the weekly limit once the session limit is exhausted", () => {
    const headline = deriveProviderUsageHeadline(
      makeUsage({
        windows: [
          { id: "session", label: "Session", kind: "session", usedPercent: 100 },
          { id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 60 },
        ],
      }),
    );

    expect(headline).toEqual({ label: "40% left", usedPercent: 60 });
  });

  it("never lets credits pre-empt an unexhausted session limit", () => {
    const headline = deriveProviderUsageHeadline(
      makeUsage({
        windows: [{ id: "session", label: "Session", kind: "session", usedPercent: 50 }],
        credits: { label: "Extra usage", usedCredits: 95, monthlyLimit: 100 },
      }),
    );

    expect(headline).toEqual({ label: "50% left", usedPercent: 50 });
  });

  it("never lets model windows pre-empt the session limit", () => {
    const headline = deriveProviderUsageHeadline(
      makeUsage({
        windows: [
          { id: "session", label: "Session", kind: "session", usedPercent: 10 },
          { id: "model:opus", label: "Opus", kind: "model", usedPercent: 90 },
        ],
      }),
    );

    expect(headline).toEqual({ label: "90% left", usedPercent: 10 });
  });

  it("headlines consumed credits once session and weekly are exhausted", () => {
    const headline = deriveProviderUsageHeadline(
      makeUsage({
        windows: [
          { id: "session", label: "Session", kind: "session", usedPercent: 100 },
          { id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 100 },
        ],
        credits: { label: "Extra usage", usedCredits: 12, monthlyLimit: 100 },
      }),
    );

    expect(headline).toEqual({ label: "$88.00 left", usedPercent: 12 });
  });

  it("keeps showing the exhausted limit while metered credits are untouched", () => {
    const headline = deriveProviderUsageHeadline(
      makeUsage({
        windows: [
          { id: "session", label: "Session", kind: "session", usedPercent: 100 },
          { id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 100 },
        ],
        credits: { label: "Extra usage", usedCredits: 0, monthlyLimit: 100 },
      }),
    );

    expect(headline).toEqual({ label: "0% left", usedPercent: 100 });
  });

  it("falls back to a credit balance when no windows exist", () => {
    const headline = deriveProviderUsageHeadline(
      makeUsage({ credits: { label: "Credits", usedCredits: 12, monthlyLimit: 100 } }),
    );

    expect(headline).toEqual({ label: "$88.00 left", usedPercent: 12 });
  });

  it("falls back to the most constrained remaining window without session/weekly limits", () => {
    const headline = deriveProviderUsageHeadline(
      makeUsage({
        windows: [
          { id: "model:opus", label: "Opus", kind: "model", usedPercent: 30 },
          { id: "spend", label: "Spend limit", kind: "other", usedPercent: 70 },
        ],
      }),
    );

    expect(headline).toEqual({ label: "30% left", usedPercent: 70 });
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
