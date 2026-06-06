import * as Effect from "effect/Effect";

import type { AutomationRule, AutomationRuleId, AutomationRun } from "../shared/schema.ts";
import { scheduledRunId } from "./ids.ts";
import type { makeAutomationRepositories } from "./repositories.ts";
import type { PreparedRun, ReadyPreparedRun } from "./runtimeTypes.ts";
import { nowIso } from "./time.ts";

type AutomationRepositories = ReturnType<typeof makeAutomationRepositories>;

export const isRecoverableQueuedScheduledRun = (run: AutomationRun) =>
  run.status === "queued" &&
  run.reason === "schedule" &&
  run.id === scheduledRunId(run.ruleId, run.scheduledFor);

export function makeAutomationRecovery(input: {
  readonly listRuns: AutomationRepositories["listRuns"];
  readonly getRun: (runId: AutomationRun["id"]) => Effect.Effect<AutomationRun | null, Error>;
  readonly getRule: AutomationRepositories["getRule"];
  readonly writeRunAndTrimForRule: AutomationRepositories["writeRunAndTrimForRule"];
  readonly withRulePreparationLock: <A, E, R>(
    ruleId: AutomationRuleId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly prepareExistingQueuedRunForCurrentRule: (
    rule: AutomationRule,
    queuedRun: AutomationRun,
  ) => Effect.Effect<PreparedRun, Error>;
  readonly executePreparedRun: (prepared: ReadyPreparedRun) => Effect.Effect<AutomationRun, Error>;
}) {
  const failInterruptedRun = (
    run: AutomationRun,
    completedAt: string,
    error = "Automation run did not complete before server restart.",
  ) =>
    Effect.gen(function* () {
      const failedRun: AutomationRun = {
        ...run,
        status: "failed",
        completedAt,
        error,
      };
      yield* input.writeRunAndTrimForRule(failedRun, {
        runId: failedRun.id,
        ruleId: run.ruleId,
      });
    });

  const markInterruptedRunsFailed = Effect.gen(function* () {
    const completedAt = yield* nowIso;
    const runs = yield* input.listRuns();
    yield* Effect.forEach(
      runs.filter(
        (run) =>
          (run.status === "queued" || run.status === "running") &&
          !isRecoverableQueuedScheduledRun(run),
      ),
      (run) => failInterruptedRun(run, completedAt),
      { concurrency: 1, discard: true },
    );
  });

  const claimRecoverableQueuedScheduledRun = (queuedRun: AutomationRun) =>
    input.withRulePreparationLock(
      queuedRun.ruleId,
      Effect.gen(function* () {
        const latestRun = yield* input.getRun(queuedRun.id);
        if (latestRun === null || !isRecoverableQueuedScheduledRun(latestRun)) {
          return null;
        }

        const rule = yield* input.getRule(latestRun.ruleId);
        const staleRule =
          rule === null ||
          !rule.enabled ||
          latestRun.ruleUpdatedAt === undefined ||
          latestRun.ruleUpdatedAt !== rule.updatedAt;
        if (staleRule) {
          const completedAt = yield* nowIso;
          yield* failInterruptedRun(
            latestRun,
            completedAt,
            "Queued scheduled automation is no longer recoverable after server restart.",
          );
          return null;
        }

        const prepared = yield* input.prepareExistingQueuedRunForCurrentRule(rule, latestRun);
        return prepared.status === "ready" ? prepared : null;
      }),
    );

  const recoverQueuedScheduledRuns = () =>
    Effect.gen(function* () {
      const runs = yield* input.listRuns();
      yield* Effect.forEach(
        runs.filter(isRecoverableQueuedScheduledRun),
        (run) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const prepared = yield* claimRecoverableQueuedScheduledRun(run);
              if (prepared !== null) {
                const recoveredRun = restore(input.executePreparedRun(prepared)).pipe(
                  Effect.asVoid,
                  Effect.catch((cause) =>
                    Effect.logWarning("Automation schedule recovery failed", {
                      ruleId: prepared.rule.id,
                      cause,
                    }),
                  ),
                );
                yield* recoveredRun;
              }
            }),
          ),
        { concurrency: 1, discard: true },
      );
    });

  return { markInterruptedRunsFailed, recoverQueuedScheduledRuns } as const;
}
