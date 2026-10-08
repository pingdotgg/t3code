import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as UsageLimitsService from "./UsageLimitsService.ts";

const checkedAt = "1969-12-31T23:59:00.000Z";
const window = {
  id: "primary",
  kind: "session",
  label: "Session",
  usedPercent: 25,
  resetsAt: "1969-12-31T23:59:30.000Z",
  windowDurationMins: 300,
} as const;
const provider = (id: string, usageLimits?: ServerProviderUsageLimits): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("codex"),
  enabled: false,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  ...(usageLimits === undefined ? {} : { usageLimits }),
  message: "secret-diagnostic",
  runtimePaths: { homePath: "/private/secret", shadowHomePath: null },
});

it.effect(
  "reads all cached accounts, preserves freshness and quota, and omits sensitive metadata without probing",
  () =>
    Effect.gen(function* () {
      const limits = {
        checkedAt,
        windows: [window],
        credentialFingerprint: "secret-fingerprint",
        externalUsage: { label: "secret", url: "https://secret" },
        resetCredits: { availableCount: 1, nextCreditId: "secret-credit" },
      };
      const layerDependencies = Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            provider("work", limits),
            provider("personal", {
              checkedAt,
              windows: [
                { ...window, usedPercent: 100 },
                { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 0 },
              ],
            }),
            provider("missing"),
            provider("unsupported", {
              checkedAt,
              windows: [],
              unavailable: { reason: "unsupported", message: "secret-unavailable" },
            }),
            provider("failed", {
              checkedAt,
              windows: [],
              unavailable: { reason: "probeFailed", message: "secret-error" },
            }),
            provider("empty", { checkedAt, windows: [] }),
          ]),
          refresh: () => Effect.die("must not refresh"),
          refreshInstance: () => Effect.die("must not refresh"),
        }),
        Layer.mock(UsageLimitSources.UsageLimitSources)({
          current: Effect.succeed([
            {
              id: UsageLimitSourceId.make("hub"),
              kind: "cliproxy",
              label: "secret-source-label",
              checkedAt,
              accounts: [
                {
                  id: "account",
                  driver: ProviderDriverKind.make("claudeCode"),
                  email: "secret@example.com",
                  plan: "secret-plan",
                  usageLimits: limits,
                },
              ],
            },
            {
              id: UsageLimitSourceId.make("failed-hub"),
              kind: "cliproxy",
              label: "secret",
              checkedAt,
              accounts: [],
              error: "secret-management-key",
            },
          ]),
          refresh: Effect.die("must not refresh"),
        }),
      );
      const result = yield* Effect.gen(function* () {
        return yield* (yield* UsageLimitsService.UsageLimitsService).read;
      }).pipe(Effect.provide(UsageLimitsService.layer.pipe(Layer.provide(layerDependencies))));
      expect(result.readAt).toBe("1970-01-01T00:00:00.000Z");
      expect(result.providers.map((entry) => entry.quota.status)).toEqual([
        "available",
        "available",
        "notReported",
        "unavailable",
        "error",
        "available",
      ]);
      expect(result.providers[0]?.quota).toEqual({
        status: "available",
        checkedAt,
        ageSeconds: 60,
        windows: [{ ...window, remainingPercent: 75 }],
      });
      expect(result.providers[1]?.quota.windows[0]?.remainingPercent).toBe(0);
      expect(result.providers[1]?.quota.windows[1]).toEqual({
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 0,
        remainingPercent: 100,
      });
      expect(result.providers[2]?.quota.checkedAt).toBeUndefined();
      expect(result.sources[0]?.accounts[0]?.quota.windows[0]?.remainingPercent).toBe(75);
      expect(result.sources[1]).toEqual({
        sourceId: "failed-hub",
        status: "error",
        checkedAt,
        ageSeconds: 60,
        accounts: [],
      });
      expect(JSON.stringify(result)).not.toContain("secret");
    }),
);

it.effect("returns empty collections when no snapshots exist", () =>
  Effect.gen(function* () {
    const service = yield* UsageLimitsService.UsageLimitsService;
    expect(yield* service.read).toEqual({
      readAt: "1970-01-01T00:00:00.000Z",
      providers: [],
      sources: [],
    });
  }).pipe(
    Effect.provide(
      UsageLimitsService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(UsageLimitSources.UsageLimitSources)({ current: Effect.succeed([]) }),
          ),
        ),
      ),
    ),
  ),
);
