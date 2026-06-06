import type { PluginActivationContext } from "@t3tools/plugin-api/server";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { AutomationRuleId } from "../shared/schema.ts";
import {
  type AutomationCollections,
  makeAutomationRepositories,
  registerAutomationCollections,
} from "./repositories.ts";
import { makeAutomationExecutor } from "./execution.ts";
import { makeAutomationRecovery } from "./recovery.ts";
import { makeAutomationRunPreparation } from "./runPreparation.ts";
import type { AutomationRunReason } from "./runtimeTypes.ts";
import { makeAutomationScheduler } from "./scheduler.ts";
import { nowIso } from "./time.ts";

export { registerAutomationCollections };

export function makeAutomationsRuntime(
  ctx: PluginActivationContext,
  collections: AutomationCollections,
) {
  return Effect.gen(function* () {
    const activeRuleIds = new Set<AutomationRuleId>();
    const repositories = makeAutomationRepositories(ctx, collections);
    const {
      listRules,
      getRule,
      ruleExists,
      listRuns,
      listRunsForRule,
      publishChanged,
      publishCatalogInvalidated,
      isFailedOrSkippedRun,
      countFailedOrSkippedRuns,
      writeRun,
      writeRunAndTrimForRule,
    } = repositories;
    const {
      saveRule,
      updateRule,
      withRulePreparationLock,
      repairListedRuleSchedule,
      prepareManualRun,
      prepareScheduledRun,
      prepareExistingQueuedRunForCurrentRule,
    } = yield* makeAutomationRunPreparation({
      collections,
      activeRuleIds,
      repositories,
    });

    const { executePreparedRun } = makeAutomationExecutor({
      ctx,
      ruleExists,
      writeRun,
      writeRunAndTrimForRule,
    });

    const executeRule = (
      ruleId: AutomationRuleId,
      reason: AutomationRunReason,
      scheduledFor: string,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const prepared = yield* prepareManualRun(ruleId, reason, scheduledFor);
          if (prepared.status === "skipped") {
            return prepared.run;
          }
          return yield* restore(executePreparedRun(prepared));
        }),
      );

    const deleteRule = (ruleId: AutomationRuleId) =>
      withRulePreparationLock(
        ruleId,
        Effect.gen(function* () {
          const runs = yield* listRunsForRule(ruleId);
          yield* Effect.forEach(runs, (run) => collections.runs.delete(run.id), {
            concurrency: 1,
            discard: true,
          });
          yield* collections.rules.delete(ruleId);
          yield* publishChanged({ ruleId, deleted: true });
          if (runs.some(isFailedOrSkippedRun)) {
            yield* publishCatalogInvalidated({ ruleId, deleted: true });
          }
        }),
      );

    const { markInterruptedRunsFailed, recoverQueuedScheduledRuns } = makeAutomationRecovery({
      listRuns,
      getRun: collections.runs.get,
      getRule,
      writeRunAndTrimForRule,
      withRulePreparationLock,
      prepareExistingQueuedRunForCurrentRule,
      executePreparedRun,
    });

    const { runDueScheduledRuns, tickSchedules } = makeAutomationScheduler({
      listRules,
      repairListedRuleSchedule,
      prepareScheduledRun,
      executePreparedRun,
    });

    return {
      listRules,
      executeRule,
      saveRule,
      updateRule,
      tickSchedules,
      runDueScheduledRuns,
      deleteRule,
      countFailedOrSkippedRuns,
      listRunsForRule,
      listRuns,
      markInterruptedRunsFailed,
      recoverQueuedScheduledRuns,
      publishChanged,
    } as const;
  });
}

export type AutomationsRuntime = Effect.Success<ReturnType<typeof makeAutomationsRuntime>>;

export const startAutomationScheduleLoop = (runtime: AutomationsRuntime) =>
  Effect.forever(
    Effect.sleep(Duration.seconds(60)).pipe(
      Effect.flatMap(() => nowIso),
      Effect.flatMap((triggeredAt) => runtime.tickSchedules(triggeredAt)),
      Effect.catch((cause) =>
        Effect.logWarning("Automation scheduler tick failed", {
          cause,
        }),
      ),
    ),
  ).pipe(Effect.forkScoped);

export const startAutomationRecovery = (runtime: AutomationsRuntime) =>
  runtime.recoverQueuedScheduledRuns().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Automation schedule recovery failed", {
        cause,
      }),
    ),
    Effect.forkScoped,
  );
