import { describe, expect, it } from "@effect/vitest";
import {
  OrchestratorMcpProviderUsageResult,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderUsage from "./ProviderUsage.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const { providerUsageReport } = ProviderUsage;

const encodeResult = Schema.encodeSync(OrchestratorMcpProviderUsageResult);
const generatedAt = "2026-09-03T12:00:00.000Z";
const checkedAt = "2026-09-03T11:59:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 37.4,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 } as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const report = (
  providers: ReadonlyArray<ServerProvider>,
  sources: UsageLimitSourceSnapshot[] = [],
) => providerUsageReport({ providers, sources, generatedAt });

describe("providerUsageReport", () => {
  it("reports windows with remaining percent, nulls for unknowns, and no credential data", () => {
    const result = report([
      provider({
        auth: { status: "authenticated", label: "ChatGPT Pro", email: "user@example.com" },
        usageLimits: {
          checkedAt,
          windows: [session, weekly],
          credentialFingerprint: "fingerprint-secret",
          resetCredits: { availableCount: 2, nextCreditId: "credit-secret" },
          externalUsage: { label: "Usage", url: "https://example.com/usage" },
        },
      }),
    ]);

    expect(result.providers[0]).toEqual({
      providerInstanceId: "codex",
      driverKind: "codex",
      displayName: null,
      enabled: true,
      status: "ready",
      plan: "ChatGPT Pro",
      available: true,
      reason: null,
      message: null,
      stale: false,
      checkedAt,
      windows: [
        { ...session, remainingPercent: 63 },
        { ...weekly, remainingPercent: 0, windowDurationMins: null, resetsAt: null },
      ],
      resetCredits: { availableCount: 2, nextExpiresAt: null },
      externalUsageUrl: "https://example.com/usage",
    });
    const json = JSON.stringify(encodeResult(result));
    for (const secret of ["fingerprint-secret", "credit-secret", "user@example.com"]) {
      expect(json).not.toContain(secret);
    }
  });

  it.each<[string, Partial<ServerProvider>, Record<string, unknown>]>([
    [
      "disabled instance hides its last windows",
      { enabled: false, status: "disabled", usageLimits: { checkedAt, windows: [session] } },
      { available: false, reason: "disabled", windows: [], checkedAt },
    ],
    ["not installed", { installed: false }, { available: false, reason: "notInstalled" }],
    [
      "provider unavailable",
      {
        enabled: false,
        installed: false,
        availability: "unavailable",
        unavailableReason: "Needs an update.",
      },
      { available: false, reason: "providerUnavailable", message: "Needs an update." },
    ],
    [
      "signed out hides its last windows",
      { auth: { status: "unauthenticated" }, usageLimits: { checkedAt, windows: [session] } },
      { available: false, reason: "unauthenticated", windows: [], checkedAt },
    ],
    ["driver never reported limits", {}, { available: false, reason: "notReported" }],
    [
      "account without subscription limits",
      { usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } } },
      { available: false, reason: "unsupported", checkedAt },
    ],
    [
      "failed read with nothing kept",
      {
        usageLimits: {
          checkedAt,
          windows: [],
          unavailable: { reason: "probeFailed", message: "HTTP 503" },
        },
      },
      { available: false, reason: "probeFailed", message: "HTTP 503" },
    ],
    [
      "failed read keeps the last good windows",
      {
        usageLimits: {
          checkedAt,
          windows: [session],
          unavailable: { reason: "probeFailed", message: "HTTP 503" },
        },
      },
      { available: true, reason: null, stale: true, message: "HTTP 503" },
    ],
    [
      "read returned no windows",
      { usageLimits: { checkedAt, windows: [] } },
      { available: false, reason: "noWindows" },
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(report([provider(overrides)]).providers[0]).toMatchObject(expected);
  });

  it("reports CLI Proxy accounts without their ids, emails, or workspace ids", () => {
    const result = report(
      [],
      [
        {
          id: UsageLimitSourceId.make("hub"),
          kind: "cliproxy",
          label: "Team hub",
          checkedAt,
          accounts: [
            {
              id: "claude-user@example.com.json",
              driver: ProviderDriverKind.make("claudeAgent"),
              email: "user@example.com",
              workspaceId: "workspace-secret",
              plan: "max",
              usageLimits: { checkedAt, windows: [session] },
            },
          ],
        },
      ],
    );
    expect(result.sources).toEqual([
      {
        sourceId: "hub",
        kind: "cliproxy",
        label: "Team hub",
        checkedAt,
        error: null,
        accounts: [
          {
            driverKind: "claudeAgent",
            plan: "max",
            available: true,
            reason: null,
            message: null,
            stale: false,
            checkedAt,
            windows: [{ ...session, remainingPercent: 63 }],
            resetCredits: null,
          },
        ],
      },
    ]);
    const json = JSON.stringify(result);
    for (const secret of ["user@example.com", "workspace-secret"]) {
      expect(json).not.toContain(secret);
    }
  });

  it.effect("refreshes providers and hubs at most once per five minutes", () =>
    Effect.gen(function* () {
      const refreshes = yield* Ref.make(0);
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
      const usage = yield* ProviderUsage.make.pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Ref.get(providers),
              refresh: () =>
                Effect.andThen(
                  Ref.update(refreshes, (count) => count + 1),
                  Ref.updateAndGet(providers, () => [provider({})]),
                ),
            }),
            Layer.mock(UsageLimitSources.UsageLimitSources)({
              current: Effect.succeed([]),
              refresh: Ref.update(refreshes, (count) => count + 1),
            }),
          ),
        ),
      );
      yield* Effect.all([usage.read, usage.read], { concurrency: "unbounded" });
      yield* TestClock.adjust("4 minutes");
      const cached = yield* usage.read;
      expect(yield* Ref.get(refreshes)).toBe(2);
      expect(cached.providers.map((entry) => entry.providerInstanceId)).toEqual(["codex"]);
      yield* TestClock.adjust("2 minutes");
      yield* usage.read;
      expect(yield* Ref.get(refreshes)).toBe(4);
    }),
  );
});
