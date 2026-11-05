import {
  UsageLimitSourceError,
  type ProviderConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ProviderSetResetWhenEmptyInput,
  type ServerSettings,
} from "@t3tools/contracts";
import { resetCreditTargetKey } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeAccountIdentity = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);

export class ResetCreditsWhenEmpty extends Context.Service<
  ResetCreditsWhenEmpty,
  {
    readonly set: (
      input: ProviderSetResetWhenEmptyInput,
    ) => Effect.Effect<void, UsageLimitSourceError>;
    readonly consume: (
      target: ProviderConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
  }
>()("t3/usage/ResetCreditsWhenEmpty") {}

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const lock = yield* Semaphore.make(1);
  const fail = (detail: string) => new UsageLimitSourceError({ detail });
  const readSettings = settings.getSettings.pipe(
    Effect.mapError(() => fail("Could not read reset settings.")),
  );
  const write = Effect.fn("ResetCreditsWhenEmpty.write")(function* (
    entries: ServerSettings["resetCreditsWhenEmpty"],
  ) {
    yield* settings
      .updateSettings({ resetCreditsWhenEmpty: entries })
      .pipe(Effect.mapError(() => fail("Could not save reset settings.")));
  });
  const accountFor = Effect.fn("ResetCreditsWhenEmpty.accountFor")(function* (
    target: ProviderConsumeResetCreditInput,
  ) {
    if ("instanceId" in target) {
      const provider = (yield* providers.getProviders).find(
        (entry) => entry.instanceId === target.instanceId,
      );
      return {
        limits: provider?.enabled ? provider.usageLimits : undefined,
        nativeAccountIdentity: provider
          ? yield* encodeAccountIdentity([
              provider.driver,
              provider.auth.status,
              provider.auth.type ?? null,
              provider.auth.email?.trim().toLowerCase() ?? null,
              provider.auth.workspaceId ?? null,
              provider.auth.profileId ?? null,
            ]).pipe(Effect.orDie)
          : undefined,
      };
    }
    return {
      limits: (yield* sources.current)
        .find((source) => source.id === target.sourceId)
        ?.accounts.find((account) => account.id === target.accountId)?.usageLimits,
      nativeAccountIdentity: undefined,
    };
  });
  const consumeTarget = Effect.fn("ResetCreditsWhenEmpty.consumeTarget")(function* (
    target: ProviderConsumeResetCreditInput,
  ) {
    if ("sourceId" in target) return yield* sources.consumeResetCredit(target);
    const instance = yield* instances.getInstance(target.instanceId);
    if (!instance?.enabled || !instance.consumeResetCredit)
      return yield* fail("This provider cannot use reset credits.");
    const outcome = yield* instance
      .consumeResetCredit()
      .pipe(Effect.mapError((error) => fail(error.detail)));
    yield* providers.refreshInstance(target.instanceId);
    return { outcome };
  });
  const remove = Effect.fn("ResetCreditsWhenEmpty.remove")(function* (
    target: ProviderConsumeResetCreditInput,
  ) {
    const current = yield* readSettings;
    const remaining = current.resetCreditsWhenEmpty.filter(
      (entry) => resetCreditTargetKey(entry.target) !== resetCreditTargetKey(target),
    );
    if (remaining.length !== current.resetCreditsWhenEmpty.length) yield* write(remaining);
  });
  const set = Effect.fn("ResetCreditsWhenEmpty.set")(function* (
    input: ProviderSetResetWhenEmptyInput,
  ) {
    if (!input.enabled) return yield* remove(input.target);
    const { limits, nativeAccountIdentity } = yield* accountFor(input.target);
    const window = limits?.windows.find((entry) => entry.id === input.windowId);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (
      limits?.unavailable ||
      !window?.resetsAt ||
      Date.parse(window.resetsAt) <= now ||
      !limits?.resetCredits?.availableCount
    ) {
      return yield* fail("Refresh usage before scheduling a reset for this period.");
    }
    if ("creditId" in input.target && input.target.creditId !== limits.resetCredits.nextCreditId)
      return yield* fail("This reset credit is no longer available. Refresh usage first.");
    const current = yield* readSettings;
    yield* write([
      ...current.resetCreditsWhenEmpty.filter(
        (entry) => resetCreditTargetKey(entry.target) !== resetCreditTargetKey(input.target),
      ),
      {
        target: input.target,
        windowId: window.id,
        resetsAt: window.resetsAt,
        availableCount: limits.resetCredits.availableCount,
        ...(limits.resetCredits.nextCreditId
          ? { nextCreditId: limits.resetCredits.nextCreditId }
          : {}),
        ...(nativeAccountIdentity ? { nativeAccountIdentity } : {}),
        ...(limits.credentialFingerprint
          ? { credentialFingerprint: limits.credentialFingerprint }
          : {}),
      },
    ]);
  }, lock.withPermits(1));
  const consume = Effect.fn("ResetCreditsWhenEmpty.consume")(function* (
    target: ProviderConsumeResetCreditInput,
  ) {
    yield* remove(target);
    return yield* consumeTarget(target);
  }, lock.withPermits(1));
  const check = Effect.fn("ResetCreditsWhenEmpty.check")(
    function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      for (const entry of (yield* readSettings).resetCreditsWhenEmpty) {
        const { limits, nativeAccountIdentity } = yield* accountFor(entry.target);
        const window = limits?.windows.find((candidate) => candidate.id === entry.windowId);
        const expired = Date.parse(entry.resetsAt) <= now;
        const changed =
          limits &&
          !limits.unavailable &&
          (window?.resetsAt !== entry.resetsAt ||
            limits.credentialFingerprint !== entry.credentialFingerprint ||
            nativeAccountIdentity !== entry.nativeAccountIdentity ||
            (limits.resetCredits?.availableCount ?? 0) !== entry.availableCount ||
            entry.nextCreditId !== limits.resetCredits?.nextCreditId);
        if (expired || changed) {
          yield* remove(entry.target);
          continue;
        }
        if (!limits || limits.unavailable || !window || window.usedPercent < 100) continue;
        // Persist disarming before spending so reconnects and server restarts cannot spend twice.
        yield* remove(entry.target);
        yield* consumeTarget(entry.target).pipe(Effect.ignoreCause({ log: true }));
      }
    },
    lock.withPermits(1),
    Effect.ignoreCause({ log: true }),
  );
  const refresh = Effect.fn("ResetCreditsWhenEmpty.refresh")(
    function* () {
      const entries = (yield* readSettings).resetCreditsWhenEmpty;
      if (entries.some((entry) => "sourceId" in entry.target)) yield* sources.refresh;
      const ids = new Set(
        entries.flatMap((entry) => ("instanceId" in entry.target ? [entry.target.instanceId] : [])),
      );
      yield* Effect.forEach(ids, (id) => providers.refreshInstance(id), { concurrency: 4 });
      yield* check();
    },
    Effect.ignoreCause({ log: true }),
  );
  // Poll armed accounts even when no client is open and ordinary idle probes are paused.
  yield* Effect.forever(refresh().pipe(Effect.andThen(Effect.sleep("30 seconds")))).pipe(
    Effect.forkScoped,
  );
  return { set, consume } satisfies ResetCreditsWhenEmpty["Service"];
});

export const layer = Layer.effect(ResetCreditsWhenEmpty, make);
