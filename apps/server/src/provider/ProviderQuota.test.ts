import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderQuotaMetric,
  type ProviderQuotaSnapshot,
} from "@t3tools/contracts";

import {
  errorProviderQuotaSnapshot,
  ProviderQuotaAdapterError,
  remainingPercentFromUsed,
  resolveHeadlineMetricKey,
  unknownProviderQuotaSnapshot,
} from "./ProviderQuota.ts";

const instance = {
  instanceId: ProviderInstanceId.make("codexPersonal"),
  driverKind: ProviderDriverKind.make("codex"),
};

const metric = (input: {
  readonly key: string;
  readonly remainingPercent: number | null;
  readonly blocking: boolean;
}): ProviderQuotaMetric => ({
  key: input.key,
  label: input.key,
  remainingPercent: input.remainingPercent,
  usedPercent: null,
  resetsAt: null,
  windowMinutes: null,
  blocking: input.blocking,
});

describe("remainingPercentFromUsed", () => {
  it("clamps used percentages without rounding provider precision", () => {
    expect(remainingPercentFromUsed(-10)).toBe(100);
    expect(remainingPercentFromUsed(12.345)).toBe(87.655);
    expect(remainingPercentFromUsed(150)).toBe(0);
  });
});

describe("resolveHeadlineMetricKey", () => {
  it("uses the lowest finite remaining blocking metric, not credits or spend detail", () => {
    expect(
      resolveHeadlineMetricKey([
        metric({ key: "credit-balance", remainingPercent: 0, blocking: false }),
        metric({ key: "spend", remainingPercent: 1, blocking: false }),
        metric({ key: "weekly", remainingPercent: 12.5, blocking: true }),
        metric({ key: "five-hour", remainingPercent: 47, blocking: true }),
        metric({ key: "unknown", remainingPercent: null, blocking: true }),
      ]),
    ).toBe("weekly");
  });

  it("ignores non-finite remaining values received outside the schema boundary", () => {
    expect(
      resolveHeadlineMetricKey([
        metric({ key: "invalid", remainingPercent: Number.NaN, blocking: true }),
        metric({ key: "weekly", remainingPercent: 12.5, blocking: true }),
      ]),
    ).toBe("weekly");
  });
});

describe("unknownProviderQuotaSnapshot", () => {
  it("returns an unsupported snapshot without provider-specific data", () => {
    expect(
      unknownProviderQuotaSnapshot(instance, "2026-08-11T09:00:00.000Z", "Not available."),
    ).toEqual({
      instanceId: ProviderInstanceId.make("codexPersonal"),
      driver: ProviderDriverKind.make("codex"),
      status: "unknown",
      source: "unsupported",
      readAt: "2026-08-11T09:00:00.000Z",
      lastSuccessfulReadAt: null,
      headlineMetricKey: null,
      metrics: [],
      credits: null,
      bankedResets: null,
      detail: {},
      message: "Not available.",
    });
  });

  it("normalizes caller-provided fallback messages before exposing them", () => {
    expect(
      unknownProviderQuotaSnapshot(instance, "2026-08-11T09:00:00.000Z", "  Not available.  ")
        .message,
    ).toBe("Not available.");
  });
});

describe("errorProviderQuotaSnapshot", () => {
  it("marks previous successful data stale and exposes only normalized failure detail", () => {
    const previous: ProviderQuotaSnapshot = {
      instanceId: ProviderInstanceId.make("codexPersonal"),
      driver: ProviderDriverKind.make("codex"),
      status: "current",
      source: "codex-app-server",
      readAt: "2026-08-11T08:00:00.000Z",
      lastSuccessfulReadAt: "2026-08-11T08:00:00.000Z",
      headlineMetricKey: "five-hour",
      metrics: [metric({ key: "five-hour", remainingPercent: 25, blocking: true })],
      credits: null,
      bankedResets: null,
      detail: { account: "personal" },
      message: null,
    };

    const snapshot = errorProviderQuotaSnapshot(
      instance,
      "2026-08-11T09:00:00.000Z",
      new ProviderQuotaAdapterError({
        reason: "timeout",
        detail: "  Provider request timed out.  ",
        cause: new Error("secret-token-value"),
      }),
      previous,
    );

    expect(snapshot).toMatchObject({
      ...previous,
      status: "stale",
      readAt: "2026-08-11T09:00:00.000Z",
      lastSuccessfulReadAt: "2026-08-11T08:00:00.000Z",
      detail: { reason: "timeout" },
      message: "Provider request timed out.",
    });
    expect(snapshot).not.toHaveProperty("cause");
    expect(JSON.stringify(snapshot)).not.toContain("secret-token-value");
  });
});
