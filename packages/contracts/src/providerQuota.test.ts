import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ProviderQuotaConsumeResetError,
  ProviderQuotaConsumeResetInput,
  ProviderQuotaSnapshot,
  ProviderQuotaSummary,
} from "./providerQuota.ts";

const decodeSnapshot = Schema.decodeUnknownSync(ProviderQuotaSnapshot);
const decodeSummary = Schema.decodeUnknownSync(ProviderQuotaSummary);
const encodeSnapshot = Schema.encodeSync(ProviderQuotaSnapshot);
const decodeConsumeResetInput = Schema.decodeUnknownSync(ProviderQuotaConsumeResetInput);
const decodeConsumeResetError = Schema.decodeUnknownSync(ProviderQuotaConsumeResetError);

const currentCodexSnapshot = {
  instanceId: "codex_personal",
  driver: "codex",
  status: "current" as const,
  source: "codex-app-server",
  readAt: "2026-08-11T10:00:00.000Z",
  lastSuccessfulReadAt: "2026-08-11T10:00:00.000Z",
  headlineMetricKey: "primary",
  metrics: [
    {
      key: "primary",
      label: "5-hour window",
      remainingPercent: 72.5,
      usedPercent: 27.5,
      resetsAt: "2026-08-11T13:00:00.000Z",
      windowMinutes: 300,
      blocking: true,
    },
    {
      key: "secondary",
      label: "Weekly window",
      remainingPercent: 48,
      usedPercent: 52,
      resetsAt: "2026-08-18T10:00:00.000Z",
      windowMinutes: 10_080,
      blocking: true,
    },
  ],
  credits: {
    hasCredits: true,
    unlimited: false,
    balance: "3",
  },
  bankedResets: {
    availableCount: 1,
    detailsComplete: true,
    resets: [
      {
        id: "reset-credit-1",
        title: "Monthly reset",
        description: "Restores the current rate-limit window.",
        grantedAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-09-01T00:00:00.000Z",
        resetType: "rateLimit",
        status: "available" as const,
      },
    ],
  },
  detail: {
    accountPlan: "Plus",
    rateLimitReached: "false",
  },
  message: null,
};

describe("ProviderQuotaSnapshot", () => {
  it("round-trips a current Codex snapshot with windows, credits, and reset details", () => {
    const decoded = decodeSnapshot(currentCodexSnapshot);

    expect(decoded).toEqual(currentCodexSnapshot);
    expect(encodeSnapshot(decoded)).toEqual(currentCodexSnapshot);
  });

  it.each(["unknown", "stale", "authRequired", "error"] as const)(
    "decodes a %s snapshot with nullable quota detail",
    (status) => {
      const decoded = decodeSnapshot({
        ...currentCodexSnapshot,
        status,
        lastSuccessfulReadAt: null,
        headlineMetricKey: null,
        metrics: [],
        credits: null,
        bankedResets: null,
        detail: {},
        message: null,
      });

      expect(decoded.status).toBe(status);
      expect(decoded.credits).toBeNull();
      expect(decoded.bankedResets).toBeNull();
      expect(decoded.message).toBeNull();
    },
  );

  it("rejects a non-finite metric percentage", () => {
    expect(() =>
      decodeSnapshot({
        ...currentCodexSnapshot,
        metrics: [{ ...currentCodexSnapshot.metrics[0], remainingPercent: Number.NaN }],
      }),
    ).toThrow();
  });

  it("rejects a negative banked reset count", () => {
    expect(() =>
      decodeSnapshot({
        ...currentCodexSnapshot,
        bankedResets: { ...currentCodexSnapshot.bankedResets, availableCount: -1 },
      }),
    ).toThrow();
  });
});

describe("ProviderQuotaSummary", () => {
  it("decodes an instance-aware summary without historical usage fields", () => {
    expect(
      decodeSummary({
        readAt: "2026-08-11T10:00:00.000Z",
        instances: [currentCodexSnapshot],
      }),
    ).toEqual({
      readAt: "2026-08-11T10:00:00.000Z",
      instances: [currentCodexSnapshot],
    });
  });
});

describe("ProviderQuotaConsumeResetInput", () => {
  it("rejects blank provider instance, reset credit, and idempotency identifiers", () => {
    const validInput = {
      instanceId: "codex_personal",
      creditId: "reset-credit-1",
      idempotencyKey: "018d8a1f-4038-7d4e-a26b-80f5bf246bd5",
    };

    for (const input of [
      { ...validInput, instanceId: "   " },
      { ...validInput, creditId: "   " },
      { ...validInput, idempotencyKey: "   " },
    ]) {
      expect(() => decodeConsumeResetInput(input)).toThrow();
    }
  });
});

describe("ProviderQuotaConsumeResetError", () => {
  it("accepts only stable reasons and bounded user-safe detail", () => {
    expect(
      decodeConsumeResetError({
        _tag: "ProviderQuotaConsumeResetError",
        reason: "authRequired",
        detail: "Sign in to Codex before consuming a reset.",
      }),
    ).toMatchObject({
      reason: "authRequired",
      detail: "Sign in to Codex before consuming a reset.",
    });

    expect(() =>
      decodeConsumeResetError({
        _tag: "ProviderQuotaConsumeResetError",
        reason: "rawProviderFailure",
        detail: "Provider failure",
      }),
    ).toThrow();
    expect(() =>
      decodeConsumeResetError({
        _tag: "ProviderQuotaConsumeResetError",
        reason: "providerFailed",
        detail: "x".repeat(513),
      }),
    ).toThrow();
  });
});
