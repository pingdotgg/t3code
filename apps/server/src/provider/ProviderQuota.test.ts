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
  it("allows a fixed public-message override", () => {
    expect(
      unknownProviderQuotaSnapshot(
        instance,
        "2026-08-11T09:00:00.000Z",
        "Quota information could not be refreshed.",
      ).message,
    ).toBe("Quota information could not be refreshed.");
  });

  it("falls back when an untrusted override crosses the type boundary", () => {
    const snapshot = unknownProviderQuotaSnapshot(
      instance,
      "2026-08-11T09:00:00.000Z",
      "API_TOKEN=sk-live-secret C:\\Users\\lucas\\.codex\\config.json HOME=/private/home" as never,
    );

    expect(snapshot.message).toBe("Quota information is unavailable for this provider.");
    expect(JSON.stringify(snapshot)).not.toContain("sk-live-secret");
    expect(JSON.stringify(snapshot)).not.toContain("C:\\Users\\lucas");
    expect(JSON.stringify(snapshot)).not.toContain("/private/home");
  });
});

describe("errorProviderQuotaSnapshot", () => {
  it("marks previous successful data stale without exposing adapter detail", () => {
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
        detail:
          "API_TOKEN=sk-live-secret failed at C:\\Users\\lucas\\.codex\\config.json with HOME=/private/home",
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
      message: "Quota information could not be refreshed.",
    });
    expect(snapshot).not.toHaveProperty("cause");
    expect(JSON.stringify(snapshot)).not.toContain("secret-token-value");
    expect(JSON.stringify(snapshot)).not.toContain("sk-live-secret");
    expect(JSON.stringify(snapshot)).not.toContain("C:\\Users\\lucas");
    expect(JSON.stringify(snapshot)).not.toContain("/private/home");
  });
});
