import {
  type ProviderConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  ProviderSetupError,
  type ServerProvider,
  type UsageLimitSourceError,
} from "@t3tools/contracts";
import { resetCreditReach } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

export class ResetCredits extends Context.Service<
  ResetCredits,
  {
    /** Redeems a banked reset, then ends the waits of threads stopped by the limits it refilled. */
    readonly redeem: (
      input: ProviderConsumeResetCreditInput,
    ) => Effect.Effect<
      ProviderConsumeResetCreditResult,
      ProviderSetupError | UsageLimitSourceError
    >;
  }
>()("t3/usage/ResetCredits") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
  const scope = yield* Effect.scope;

  const consume = Effect.fn("ResetCredits.consume")(function* (
    input: ProviderConsumeResetCreditInput,
  ) {
    if ("sourceId" in input) {
      return { result: yield* usageLimitSources.consumeResetCredit(input) };
    }
    const instance = yield* providerInstances.getInstance(input.instanceId);
    if (instance === undefined || !instance.enabled) {
      return yield* new ProviderSetupError({
        instanceId: input.instanceId,
        operation: "consume-reset-credit",
        detail: instance ? "This provider is disabled." : "Provider instance not found.",
      });
    }
    if (instance.consumeResetCredit === undefined) {
      return yield* new ProviderSetupError({
        instanceId: input.instanceId,
        operation: "consume-reset-credit",
        detail: "This provider does not bank reset credits.",
      });
    }
    const outcome = yield* instance.consumeResetCredit(input.creditId).pipe(
      Effect.mapError(
        (error) =>
          new ProviderSetupError({
            instanceId: input.instanceId,
            operation: "consume-reset-credit",
            detail: error.detail,
            cause: error,
          }),
      ),
    );
    // The registry hears of the redemption's own limits read only later.
    const result: ProviderConsumeResetCreditResult = { outcome };
    return { result, redeemedOn: yield* instance.snapshot.getSnapshot };
  });

  // The credit is spent by now, so a failure here must not fail its redemption.
  const endLimitWaits = Effect.fn("ResetCredits.endLimitWaits")(
    function* (
      input: ProviderConsumeResetCreditInput,
      since: DateTime.Utc,
      redeemedOn: ServerProvider | undefined,
    ) {
      const providers = yield* providerRegistry.getProviders;
      const reach = resetCreditReach(
        input,
        redeemedOn
          ? [
              redeemedOn,
              ...providers.filter((provider) => provider.instanceId !== redeemedOn.instanceId),
            ]
          : providers,
        yield* usageLimitSources.current,
        DateTime.toEpochMillis(since),
      );
      if (reach === null) return;
      yield* orchestrator.recordLimitReset({
        providerInstanceIds: reach.instanceIds,
        failedBefore: since,
        ...(reach.resetBefore === undefined
          ? {}
          : { resetBefore: DateTime.makeUnsafe(reach.resetBefore) }),
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("limit recovery skipped after a usage reset", { cause }),
    ),
  );

  const redeem: ResetCredits["Service"]["redeem"] = Effect.fn("ResetCredits.redeem")(
    function* (input) {
      const startedAt = yield* DateTime.now;
      return yield* consume(input).pipe(
        // A warning means the hub may still refuse until its cooldown ends.
        Effect.tap(({ result, redeemedOn }) =>
          result.outcome === "reset" && result.warning === undefined
            ? endLimitWaits(input, startedAt, redeemedOn)
            : Effect.void,
        ),
        Effect.map(({ result }) => result),
        // The credit may be spent before the caller hears of it. A caller that goes away must
        // not leave the threads waiting, so only service shutdown ends this.
        Effect.forkIn(scope),
        Effect.flatMap(Fiber.join),
      );
    },
  );

  return ResetCredits.of({ redeem });
});

export const layer = Layer.effect(ResetCredits, make);
