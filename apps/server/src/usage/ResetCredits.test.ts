import { assert, it } from "@effect/vitest";
import {
  type ProviderConsumeResetCreditOutcome,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ResetCredits from "./ResetCredits.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

type LimitReset = Parameters<Orchestrator.OrchestratorV2["Service"]["recordLimitReset"]>[0];
type LimitsAfter = "refilled" | "weeklyUsedUp" | "notReadAgain";

const sourceId = UsageLimitSourceId.make("hub");
const codex = ProviderInstanceId.make("codex");
const weeklyReset = "1970-01-05T00:00:00.000Z";
const usedUp = { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 } as const;
const provider = (id: string, email: string, extra: Partial<ServerProvider> = {}) =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    auth: { status: "authenticated", email },
    ...extra,
  }) as ServerProvider;

/** The service over fake providers whose redemption takes five seconds. */
const layerRedeeming = (input: {
  readonly outcome: ProviderConsumeResetCreditOutcome;
  readonly limits?: LimitsAfter;
  readonly warning?: string;
  /** Runs once the provider has spent the credit, before it answers. */
  readonly afterSpend?: Effect.Effect<void>;
  readonly recordLimitReset: Orchestrator.OrchestratorV2["Service"]["recordLimitReset"];
}) => {
  const consume = TestClock.adjust("5 seconds").pipe(
    Effect.andThen(input.afterSpend ?? Effect.void),
    Effect.as(input.outcome),
  );
  // What the redeemed account's limits look like when they are read after the redemption.
  const usageLimits = DateTime.now.pipe(
    Effect.map((now) => ({
      checkedAt: DateTime.formatIso(
        input.limits === "notReadAgain" ? DateTime.subtract(now, { seconds: 5 }) : now,
      ),
      windows:
        input.limits === "weeklyUsedUp"
          ? // Monthly spend has no reset, so no thread waits on it.
            [
              { ...usedUp, resetsAt: weeklyReset },
              { ...usedUp, id: "monthly_spend" },
            ]
          : [],
    })),
  );
  return ResetCredits.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({ recordLimitReset: input.recordLimitReset }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () =>
            Effect.succeed({
              enabled: true,
              consumeResetCredit: () => consume,
              snapshot: {
                getSnapshot: usageLimits.pipe(
                  Effect.map((usageLimits) =>
                    provider("codex", "same@example.com", { usageLimits }),
                  ),
                ),
              },
            } as never),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          // The registry still holds the redeemed instance's limits from before.
          getProviders: Effect.succeed([
            provider("codex", "same@example.com", {
              usageLimits: {
                checkedAt: "1970-01-01T00:00:00.000Z",
                windows: [{ ...usedUp, resetsAt: weeklyReset }],
              },
            }),
            provider("codex-second-home", "same@example.com"),
            provider("codex-other-account", "other@example.com"),
          ]),
        }),
        Layer.mock(UsageLimitSources.UsageLimitSources)({
          consumeResetCredit: () =>
            consume.pipe(
              Effect.map((outcome) =>
                input.warning === undefined ? { outcome } : { outcome, warning: input.warning },
              ),
            ),
          current: usageLimits.pipe(
            Effect.map((usageLimits) => [
              {
                id: sourceId,
                kind: "cliproxy" as const,
                label: "Hub",
                checkedAt: usageLimits.checkedAt,
                accounts: [
                  {
                    id: "pooled",
                    driver: ProviderDriverKind.make("codex"),
                    email: "same@example.com",
                    usageLimits,
                  },
                ],
              },
            ]),
          ),
        }),
      ),
    ),
  );
};

const redeemOn = Effect.fn("test.redeemOn")(function* (on: "instance" | "hub") {
  return yield* (yield* ResetCredits.ResetCredits).redeem(
    on === "hub" ? { sourceId, accountId: "pooled", creditId: "credit" } : { instanceId: codex },
  );
});

it.effect.each([
  { on: "instance", outcome: "reset", ends: "all" },
  { on: "hub", outcome: "reset", ends: "all" },
  { on: "instance", outcome: "reset", limits: "weeklyUsedUp", ends: "beforeWeeklyReset" },
  { on: "hub", outcome: "reset", limits: "weeklyUsedUp", ends: "beforeWeeklyReset" },
  { on: "instance", outcome: "reset", limits: "notReadAgain", ends: "none" },
  { on: "hub", outcome: "reset", limits: "notReadAgain", ends: "none" },
  { on: "hub", outcome: "reset", warning: "Cooldown not cleared.", ends: "none" },
  { on: "instance", outcome: "nothingToReset", ends: "none" },
  { on: "instance", outcome: "noCredit", ends: "none" },
  // The provider does not say whether this request's credit refilled anything.
  { on: "instance", outcome: "alreadyRedeemed", ends: "none" },
  { on: "instance", outcome: "reset", ends: "all", recordFails: true },
] as const)(
  "a reset credit redeemed on $on with outcome $outcome and limits $limits ends $ends limit waits",
  ({
    on,
    ends,
    recordFails,
    ...redemption
  }: {
    readonly on: "instance" | "hub";
    readonly outcome: ProviderConsumeResetCreditOutcome;
    readonly limits?: LimitsAfter;
    readonly warning?: string;
    readonly ends: "all" | "beforeWeeklyReset" | "none";
    readonly recordFails?: boolean;
  }) =>
    Effect.gen(function* () {
      const resets = yield* Queue.unbounded<LimitReset>();
      const startedAt = yield* DateTime.now;
      const result = yield* redeemOn(on).pipe(
        Effect.provide(
          layerRedeeming({
            ...redemption,
            recordLimitReset: (reset) =>
              Queue.offer(resets, reset).pipe(
                Effect.andThen(recordFails ? Effect.die("store unavailable") : Effect.void),
              ),
          }),
        ),
      );
      // The credit is spent either way, so the redemption reports its outcome.
      assert.deepEqual(
        result,
        redemption.warning === undefined
          ? { outcome: redemption.outcome }
          : { outcome: redemption.outcome, warning: redemption.warning },
      );
      assert.deepEqual(
        yield* Queue.clear(resets),
        ends === "none"
          ? []
          : [
              {
                providerInstanceIds: [codex, ProviderInstanceId.make("codex-second-home")],
                // A run that failed while the provider was redeeming is not counted as reset.
                failedBefore: startedAt,
                ...(ends === "beforeWeeklyReset"
                  ? {
                      resetBefore: DateTime.subtract(DateTime.makeUnsafe(weeklyReset), {
                        minutes: 1,
                      }),
                    }
                  : {}),
              },
            ],
      );
    }),
);

it.effect("a caller that leaves once the credit is spent still ends the limit waits", () =>
  Effect.gen(function* () {
    const spent = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<void>();
    const recorded = yield* Deferred.make<LimitReset>();
    yield* Effect.gen(function* () {
      const caller = yield* redeemOn("instance").pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(spent);
      yield* Fiber.interrupt(caller);
      yield* Deferred.succeed(answer, undefined);
      assert.deepEqual((yield* Deferred.await(recorded)).providerInstanceIds, [
        codex,
        ProviderInstanceId.make("codex-second-home"),
      ]);
    }).pipe(
      Effect.provide(
        layerRedeeming({
          outcome: "reset",
          afterSpend: Deferred.succeed(spent, undefined).pipe(
            Effect.andThen(Deferred.await(answer)),
          ),
          recordLimitReset: (reset) => Deferred.succeed(recorded, reset),
        }),
      ),
    );
  }),
);
