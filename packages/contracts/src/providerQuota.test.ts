import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ProviderQuotaConsumeResetError,
  ProviderQuotaConsumeResetInput,
  ProviderQuotaSnapshot,
  ProviderQuotaSummary,
  PROVIDER_QUOTA_BANKED_RESETS_MAX_ITEMS,
  PROVIDER_QUOTA_DETAIL_MAX_PROPERTIES,
  PROVIDER_QUOTA_METRICS_MAX_ITEMS,
  PROVIDER_QUOTA_SUMMARY_MAX_INSTANCES,
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

  it.each([
    [
      "metrics",
      (count: number) => ({
        metrics: Array.from({ length: count }, () => currentCodexSnapshot.metrics[0]),
      }),
      PROVIDER_QUOTA_METRICS_MAX_ITEMS,
    ],
    [
      "banked resets",
      (count: number) => ({
        bankedResets: {
          ...currentCodexSnapshot.bankedResets,
          resets: Array.from({ length: count }, () => currentCodexSnapshot.bankedResets.resets[0]),
        },
      }),
      PROVIDER_QUOTA_BANKED_RESETS_MAX_ITEMS,
    ],
    [
      "detail properties",
      (count: number) => ({
        detail: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`key-${index}`, "value"]),
        ),
      }),
      PROVIDER_QUOTA_DETAIL_MAX_PROPERTIES,
    ],
  ] as const)("accepts %s at its cardinality limit and rejects one more", (_name, patch, limit) => {
    expect(() => decodeSnapshot({ ...currentCodexSnapshot, ...patch(limit) })).not.toThrow();
    expect(() => decodeSnapshot({ ...currentCodexSnapshot, ...patch(limit + 1) })).toThrow();
  });

  it("accepts provider display strings exactly at their wire boundaries", () => {
    expect(() =>
      decodeSnapshot({
        ...currentCodexSnapshot,
        source: "s".repeat(128),
        readAt: "r".repeat(64),
        lastSuccessfulReadAt: "l".repeat(64),
        headlineMetricKey: "h".repeat(128),
        metrics: [
          {
            ...currentCodexSnapshot.metrics[0],
            key: "k".repeat(128),
            label: "l".repeat(256),
            resetsAt: "t".repeat(64),
          },
        ],
        credits: { ...currentCodexSnapshot.credits, balance: "b".repeat(256) },
        bankedResets: {
          ...currentCodexSnapshot.bankedResets,
          resets: [
            {
              ...currentCodexSnapshot.bankedResets.resets[0],
              id: "i".repeat(128),
              title: "t".repeat(256),
              description: "d".repeat(512),
              grantedAt: "g".repeat(64),
              expiresAt: "e".repeat(64),
              resetType: "r".repeat(128),
            },
          ],
        },
        detail: { ["k".repeat(128)]: "v".repeat(512) },
        message: "m".repeat(512),
      }),
    ).not.toThrow();
  });

  it.each([
    ["source", () => ({ source: "s".repeat(129) })],
    ["read timestamp", () => ({ readAt: "r".repeat(65) })],
    ["last-success timestamp", () => ({ lastSuccessfulReadAt: "l".repeat(65) })],
    ["headline key", () => ({ headlineMetricKey: "h".repeat(129) })],
    [
      "metric key",
      () => ({ metrics: [{ ...currentCodexSnapshot.metrics[0], key: "k".repeat(129) }] }),
    ],
    [
      "metric label",
      () => ({ metrics: [{ ...currentCodexSnapshot.metrics[0], label: "l".repeat(257) }] }),
    ],
    [
      "metric reset timestamp",
      () => ({ metrics: [{ ...currentCodexSnapshot.metrics[0], resetsAt: "t".repeat(65) }] }),
    ],
    [
      "credit balance",
      () => ({ credits: { ...currentCodexSnapshot.credits, balance: "b".repeat(257) } }),
    ],
    [
      "reset id",
      () => ({
        bankedResets: {
          ...currentCodexSnapshot.bankedResets,
          resets: [{ ...currentCodexSnapshot.bankedResets.resets[0], id: "i".repeat(129) }],
        },
      }),
    ],
    [
      "reset title",
      () => ({
        bankedResets: {
          ...currentCodexSnapshot.bankedResets,
          resets: [{ ...currentCodexSnapshot.bankedResets.resets[0], title: "t".repeat(257) }],
        },
      }),
    ],
    [
      "reset description",
      () => ({
        bankedResets: {
          ...currentCodexSnapshot.bankedResets,
          resets: [
            { ...currentCodexSnapshot.bankedResets.resets[0], description: "d".repeat(513) },
          ],
        },
      }),
    ],
    [
      "reset granted timestamp",
      () => ({
        bankedResets: {
          ...currentCodexSnapshot.bankedResets,
          resets: [{ ...currentCodexSnapshot.bankedResets.resets[0], grantedAt: "g".repeat(65) }],
        },
      }),
    ],
    [
      "reset expiry timestamp",
      () => ({
        bankedResets: {
          ...currentCodexSnapshot.bankedResets,
          resets: [{ ...currentCodexSnapshot.bankedResets.resets[0], expiresAt: "e".repeat(65) }],
        },
      }),
    ],
    [
      "reset type",
      () => ({
        bankedResets: {
          ...currentCodexSnapshot.bankedResets,
          resets: [{ ...currentCodexSnapshot.bankedResets.resets[0], resetType: "r".repeat(129) }],
        },
      }),
    ],
    ["detail key", () => ({ detail: { ["k".repeat(129)]: "value" } })],
    ["detail value", () => ({ detail: { key: "v".repeat(513) } })],
    ["message", () => ({ message: "m".repeat(513) })],
  ] as const)("rejects an overlong %s", (_name, patch) => {
    expect(() => decodeSnapshot({ ...currentCodexSnapshot, ...patch() })).toThrow();
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

  it("rejects an overlong summary read timestamp", () => {
    expect(() =>
      decodeSummary({
        readAt: "r".repeat(65),
        instances: [currentCodexSnapshot],
      }),
    ).toThrow();
  });

  it("accepts the instance cardinality limit and rejects one more", () => {
    const instances = Array.from({ length: PROVIDER_QUOTA_SUMMARY_MAX_INSTANCES }, (_, index) => ({
      ...currentCodexSnapshot,
      instanceId: `codex-${index}`,
    }));

    expect(() => decodeSummary({ readAt: currentCodexSnapshot.readAt, instances })).not.toThrow();
    expect(() =>
      decodeSummary({
        readAt: currentCodexSnapshot.readAt,
        instances: [...instances, { ...currentCodexSnapshot, instanceId: "codex-overflow" }],
      }),
    ).toThrow();
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

  it("bounds reset credit and idempotency identifiers", () => {
    expect(() =>
      decodeConsumeResetInput({
        instanceId: "codex_personal",
        creditId: "c".repeat(128),
        idempotencyKey: "i".repeat(128),
      }),
    ).not.toThrow();
    expect(() =>
      decodeConsumeResetInput({
        instanceId: "codex_personal",
        creditId: "c".repeat(129),
        idempotencyKey: "valid",
      }),
    ).toThrow();
    expect(() =>
      decodeConsumeResetInput({
        instanceId: "codex_personal",
        creditId: null,
        idempotencyKey: "i".repeat(129),
      }),
    ).toThrow();
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
