import * as Effect from "effect/Effect";

import type { AutomationRule, AutomationRun } from "../shared/schema.ts";
import type { makeAutomationRepositories } from "./repositories.ts";
import type {
  ReadyPreparedRun,
  RestoreInterruptibility,
  ScheduledRunPreparation,
} from "./runtimeTypes.ts";

type AutomationRepositories = ReturnType<typeof makeAutomationRepositories>;

export function makeAutomationScheduler(input: {
  readonly listRules: AutomationRepositories["listRules"];
  readonly repairListedRuleSchedule: (
    rule: AutomationRule,
    triggeredAt: string,
  ) => Effect.Effect<unknown, Error>;
  readonly prepareScheduledRun: (
    rule: AutomationRule,
    expectedScheduleState: NonNullable<AutomationRule["scheduleState"]>,
    triggeredAt: string,
  ) => Effect.Effect<ScheduledRunPreparation, Error>;
  readonly executePreparedRun: (prepared: ReadyPreparedRun) => Effect.Effect<AutomationRun, Error>;
}) {
  const processDueScheduledRuns = <E, R>(
    triggeredAt: string,
    runPrepared: (
      prepared: ReadyPreparedRun,
      restore: RestoreInterruptibility,
    ) => Effect.Effect<void, E, R>,
  ): Effect.Effect<void, Error | E, R> =>
    Effect.gen(function* () {
      const rules = yield* input.listRules({ enabled: true });
      for (const rule of rules) {
        const state = rule.scheduleState;
        if (state === undefined || state.updatedAt !== rule.updatedAt) {
          yield* input.repairListedRuleSchedule(rule, triggeredAt);
          continue;
        }

        if (state.nextRunAt > triggeredAt) {
          continue;
        }

        yield* Effect.uninterruptibleMask((restore) =>
          input
            .prepareScheduledRun(rule, state, triggeredAt)
            .pipe(
              Effect.flatMap((prepared) =>
                prepared.status === "idle" || prepared.status === "skipped"
                  ? Effect.void
                  : runPrepared(prepared, restore),
              ),
            ),
        );
      }
    });

  const runDueScheduledRuns = (triggeredAt: string) =>
    processDueScheduledRuns(triggeredAt, (prepared, restore) =>
      restore(input.executePreparedRun(prepared)).pipe(Effect.asVoid),
    );

  const tickSchedules = (triggeredAt: string) =>
    processDueScheduledRuns(triggeredAt, (prepared, restore) =>
      restore(
        input.executePreparedRun(prepared).pipe(
          Effect.asVoid,
          Effect.catch((cause) =>
            Effect.logWarning("Automation schedule run failed", {
              ruleId: prepared.rule.id,
              cause,
            }),
          ),
          Effect.forkScoped,
        ),
      ).pipe(Effect.asVoid),
    );

  return { runDueScheduledRuns, tickSchedules } as const;
}
