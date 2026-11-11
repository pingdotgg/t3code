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

const sourceId = UsageLimitSourceId.make("hub");
const codex = ProviderInstanceId.make("codex");
const weeklyReset = "1970-01-05T00:00:00.000Z";
const usedUp = { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 } as const;

/** What the redeemed account's limits look like when they are read after the redemption. */
const LIMITS_AFTER = {
  refilled: () => [],
  // Monthly spend has no reset, so no thread waits on it.
  weeklyUsedUp: () => [
    { ...usedUp, resetsAt: weeklyReset },
    { ...usedUp, id: "monthly_spend" },
  ],
} as const;

const redeem = (input: {
  readonly on: "instance" | "hub";
  readonly outcome: ProviderConsumeResetCreditOutcome;
  readonly limits?: keyof typeof LIMITS_AFTER | "notReadAgain";
  readonly recordLimitReset: Orchestrator.OrchestratorV2["Service"]["recordLimitReset"];
}) =>
  Effect.gen(function* () {
    const limits = input.limits ?? "refilled";
    const startedAt = yield* DateTime.now;
    const usageLimits = DateTime.now.pipe(
      Effect.map((now) => ({
        checkedAt: DateTime.formatIso(limits === "notReadAgain" ? startedAt : now),
        windows: limits === "notReadAgain" ? [] : LIMITS_AFTER[limits](),
      })),
    );
    const provider = (id: string, email: string, extra: Partial<ServerProvider> = {}) =>
      ({
        instanceId: ProviderInstanceId.make(id),
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        auth: { status: "authenticated", email },
        ...extra,
      }) as ServerProvider;
    const consume = TestClock.adjust("5 seconds").pipe(Effect.as(input.outcome));
    const result = yield* Effect.gen(function* () {
      return yield* (yield* ResetCredits.ResetCredits).redeem(
        input.on === "hub"
          ? { sourceId, accountId: "pooled", creditId: "credit" }
          : { instanceId: codex },
      );
    }).pipe(
      Effect.provide(
        ResetCredits.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Orchestrator.OrchestratorV2)({
                recordLimitReset: input.recordLimitReset,
              }),
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
                      checkedAt: DateTime.formatIso(startedAt),
                      windows: [{ ...usedUp, resetsAt: weeklyReset }],
                    },
                  }),
                  provider("codex-second-home", "same@example.com"),
                  provider("codex-other-account", "other@example.com"),
                ]),
              }),
              Layer.mock(UsageLimitSources.UsageLimitSources)({
                consumeResetCredit: () => consume.pipe(Effect.map((outcome) => ({ outcome }))),
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
        ),
      ),
    );
    return { result, startedAt };
  });

it.effect.each([
  { on: "instance", outcome: "reset", ends: "all" },
  { on: "hub", outcome: "reset", ends: "all" },
  // A retry of a redemption whose answer was lost.
  { on: "instance", outcome: "alreadyRedeemed", ends: "all" },
  { on: "instance", outcome: "reset", limits: "weeklyUsedUp", ends: "beforeWeeklyReset" },
  { on: "hub", outcome: "reset", limits: "weeklyUsedUp", ends: "beforeWeeklyReset" },
  { on: "instance", outcome: "reset", limits: "notReadAgain", ends: "none" },
  { on: "hub", outcome: "reset", limits: "notReadAgain", ends: "none" },
  { on: "instance", outcome: "nothingToReset", ends: "none" },
  { on: "instance", outcome: "noCredit", ends: "none" },
  { on: "instance", outcome: "reset", ends: "all", recordFails: true },
] as const)(
  "a reset credit redeemed on $on with outcome $outcome and limits $limits ends $ends limit waits",
  ({
    ends,
    recordFails,
    ...input
  }: {
    readonly on: "instance" | "hub";
    readonly outcome: ProviderConsumeResetCreditOutcome;
    readonly limits?: keyof typeof LIMITS_AFTER | "notReadAgain";
    readonly ends: "all" | "beforeWeeklyReset" | "none";
    readonly recordFails?: boolean;
  }) =>
    Effect.gen(function* () {
      const resets = yield* Queue.unbounded<LimitReset>();
      const { result, startedAt } = yield* redeem({
        ...input,
        recordLimitReset: (reset) =>
          Queue.offer(resets, reset).pipe(
            Effect.andThen(recordFails ? Effect.die("store unavailable") : Effect.void),
          ),
      });
      // The credit is spent either way, so the redemption reports its outcome.
      assert.deepEqual(result, { outcome: input.outcome });
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
    const recording = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const resets = yield* Queue.unbounded<LimitReset>();
    const fiber = yield* redeem({
      on: "instance",
      outcome: "reset",
      recordLimitReset: (reset) =>
        Deferred.succeed(recording, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Queue.offer(resets, reset)),
        ),
    }).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(recording);
    const leaving = yield* Fiber.interrupt(fiber).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(leaving);
    assert.lengthOf(yield* Queue.clear(resets), 1);
  }),
);
