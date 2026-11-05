import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as ResetCreditsWhenEmpty from "./ResetCreditsWhenEmpty.ts";

const target = {
  sourceId: UsageLimitSourceId.make("hub"),
  accountId: "account",
  creditId: "credit-1",
};
const windowId = "weekly";
const limits: ServerProviderUsageLimits = {
  checkedAt: "1970-01-01T00:00:00.000Z",
  windows: [
    {
      id: windowId,
      kind: "weekly",
      label: "Weekly",
      usedPercent: 96,
      resetsAt: "1970-01-08T00:00:00.000Z",
    },
  ],
  resetCredits: { availableCount: 2, nextCreditId: "credit-1" },
};

const setup = Effect.gen(function* () {
  const usage = yield* Ref.make(limits);
  const spends = yield* Ref.make(0);
  const auth = yield* Ref.make<ServerProviderAuth>({
    status: "authenticated",
    email: "first@example.com",
    workspaceId: "workspace-1",
  });
  const native = ProviderInstanceId.make("codex");
  const settings = yield* ServerSettings.ServerSettingsService;
  const consume = Effect.gen(function* () {
    expect((yield* settings.getSettings.pipe(Effect.orDie)).resetCreditsWhenEmpty).toEqual([]);
    yield* Ref.update(spends, (count) => count + 1);
    return { outcome: "reset" } as const;
  });
  const service = yield* ResetCreditsWhenEmpty.layer.pipe(
    Layer.provide([
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.zipWith(Ref.get(usage), Ref.get(auth), (usageLimits, auth) => [
          {
            instanceId: native,
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth,
            checkedAt: limits.checkedAt,
            models: [],
            slashCommands: [],
            skills: [],
            usageLimits,
          } satisfies ServerProvider,
        ]),
        refreshInstance: () => Effect.succeed([]),
      }),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () =>
          Effect.succeed({
            enabled: true,
            consumeResetCredit: () => consume.pipe(Effect.map((result) => result.outcome)),
          } as unknown as ProviderInstance),
      }),
      Layer.mock(UsageLimitSources.UsageLimitSources)({
        current: Ref.get(usage).pipe(
          Effect.map((usageLimits) => [
            {
              id: target.sourceId,
              kind: "cliproxy",
              label: "Hub",
              checkedAt: limits.checkedAt,
              accounts: [
                { id: target.accountId, driver: ProviderDriverKind.make("codex"), usageLimits },
              ],
            },
          ]),
        ),
        refresh: Effect.void,
        consumeResetCredit: () => consume,
      }),
    ]),
    Layer.build,
  );
  const api = yield* ResetCreditsWhenEmpty.ResetCreditsWhenEmpty.pipe(Effect.provide(service));
  yield* Effect.yieldNow;
  const tick = TestClock.adjust("30 seconds");
  const empty = Ref.update(usage, (value) => ({
    ...value,
    windows: value.windows.map((window) => ({ ...window, usedPercent: 100 })),
  }));
  return { api, usage, auth, spends, tick, empty, native };
});

it.effect("waits for true exhaustion, spends once, and persists disarming before redemption", () =>
  Effect.gen(function* () {
    const { api, usage, spends, tick, empty } = yield* setup;
    yield* api.set({ target, windowId, enabled: true });
    yield* tick;
    expect(yield* Ref.get(spends)).toBe(0);
    yield* Ref.update(usage, (value) => ({
      ...value,
      windows: value.windows.map((window) => ({ ...window, usedPercent: 99.9 })),
    }));
    yield* tick;
    expect(yield* Ref.get(spends)).toBe(0);
    yield* empty;
    yield* tick;
    expect(yield* Ref.get(spends)).toBe(1);
    yield* tick;
    expect(yield* Ref.get(spends)).toBe(1);
  }).pipe(Effect.provide(ServerSettings.layerTest()), Effect.scoped),
);

it.effect(
  "cancels queued resets when toggled off, manually redeemed, or the period rolls over",
  () =>
    Effect.gen(function* () {
      const { api, usage, spends, tick, empty } = yield* setup;
      yield* api.set({ target, windowId, enabled: true });
      yield* api.set({ target, windowId, enabled: false });
      yield* empty;
      yield* tick;
      expect(yield* Ref.get(spends)).toBe(0);
      yield* api.set({ target, windowId, enabled: true });
      yield* api.consume(target);
      yield* tick;
      expect(yield* Ref.get(spends)).toBe(1);
      yield* api.set({ target, windowId, enabled: true });
      yield* Ref.update(usage, (value) => ({
        ...value,
        windows: value.windows.map((window) => ({
          ...window,
          resetsAt: "1970-01-15T00:00:00.000Z",
        })),
      }));
      yield* tick;
      expect(yield* Ref.get(spends)).toBe(1);
      expect(
        (yield* (yield* ServerSettings.ServerSettingsService).getSettings).resetCreditsWhenEmpty,
      ).toEqual([]);
    }).pipe(Effect.provide(ServerSettings.layerTest()), Effect.scoped),
);

it.effect(
  "uses the same one-shot behavior for native provider accounts and skips failed probes",
  () =>
    Effect.gen(function* () {
      const { api, usage, spends, tick, empty, native } = yield* setup;
      yield* api.set({ target: { instanceId: native }, windowId, enabled: true });
      yield* empty;
      yield* Ref.update(usage, (value) => ({
        ...value,
        unavailable: { reason: "probeFailed" as const },
      }));
      yield* tick;
      expect(yield* Ref.get(spends)).toBe(0);
      yield* Ref.update(usage, ({ unavailable: _, resetCredits: __, ...value }) => value);
      yield* tick;
      expect(yield* Ref.get(spends)).toBe(0);
      expect(
        (yield* (yield* ServerSettings.ServerSettingsService).getSettings).resetCreditsWhenEmpty,
      ).toHaveLength(1);
      yield* Ref.update(usage, (value) => ({ ...value, resetCredits: limits.resetCredits }));
      yield* tick;
      expect(yield* Ref.get(spends)).toBe(1);
      yield* tick;
      expect(yield* Ref.get(spends)).toBe(1);
    }).pipe(Effect.provide(ServerSettings.layerTest()), Effect.scoped),
);

it.effect("restores a queued reset after restart and does not rearm a completed one", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      resetCreditsWhenEmpty: [
        {
          target,
          windowId,
          resetsAt: limits.windows[0]!.resetsAt!,
          availableCount: 2,
          nextCreditId: "credit-1",
        },
      ],
    });
    const restored = yield* setup;
    yield* restored.empty;
    yield* restored.tick;
    expect(yield* Ref.get(restored.spends)).toBe(1);
    const restarted = yield* setup;
    yield* restarted.empty;
    yield* restarted.tick;
    expect(yield* Ref.get(restarted.spends)).toBe(0);
  }).pipe(Effect.provide(ServerSettings.layerTest()), Effect.scoped),
);

it.effect.each(["email", "workspace", "credit", "balance"] as const)(
  "cancels a native reset when its %s changes",
  (change) =>
    Effect.gen(function* () {
      const { api, usage, auth, spends, tick, empty, native } = yield* setup;
      yield* api.set({ target: { instanceId: native }, windowId, enabled: true });
      if (change === "email" || change === "workspace") {
        yield* Ref.update(auth, (value) => ({
          ...value,
          ...(change === "email"
            ? { email: "replacement@example.com" }
            : { workspaceId: "workspace-2" }),
        }));
      } else {
        yield* Ref.update(usage, (value) => ({
          ...value,
          resetCredits: {
            availableCount: change === "balance" ? 3 : 2,
            nextCreditId: change === "credit" ? "credit-2" : "credit-1",
          },
        }));
      }
      yield* empty;
      yield* tick;
      expect(yield* Ref.get(spends)).toBe(0);
      expect(
        (yield* (yield* ServerSettings.ServerSettingsService).getSettings).resetCreditsWhenEmpty,
      ).toEqual([]);
    }).pipe(Effect.provide(ServerSettings.layerTest()), Effect.scoped),
);
