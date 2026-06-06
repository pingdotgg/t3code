import type { PluginActivationContext } from "@t3tools/plugin-api/server";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { AutomationRun } from "../shared/schema.ts";
import type { makeAutomationRepositories } from "./repositories.ts";
import type { ReadyPreparedRun } from "./runtimeTypes.ts";
import { automationThreadTitle, nowIso } from "./time.ts";

type AutomationRepositories = ReturnType<typeof makeAutomationRepositories>;

export function makeAutomationExecutor(input: {
  readonly ctx: PluginActivationContext;
  readonly ruleExists: AutomationRepositories["ruleExists"];
  readonly writeRun: AutomationRepositories["writeRun"];
  readonly writeRunAndTrimForRule: AutomationRepositories["writeRunAndTrimForRule"];
}) {
  const executePreparedRun = (prepared: ReadyPreparedRun) => {
    const { rule, queuedRun } = prepared;
    const ruleId = rule.id;
    const scheduledFor = queuedRun.scheduledFor;
    return Effect.gen(function* () {
      let latestRun = queuedRun;
      const writeFailedRun = (error: string) =>
        Effect.gen(function* () {
          const failedRun: AutomationRun = {
            ...latestRun,
            status: "failed",
            completedAt: yield* nowIso,
            error,
          };
          if (yield* input.ruleExists(ruleId)) {
            yield* input.writeRunAndTrimForRule(failedRun, {
              runId: failedRun.id,
              ruleId,
            });
          }
          return failedRun;
        });

      const run = Effect.gen(function* () {
        const startedAt = yield* nowIso;
        latestRun = {
          ...queuedRun,
          status: "running",
          startedAt,
        };
        yield* input.writeRun(latestRun);

        const launched = yield* input.ctx.runtime.createAndSendThread({
          projectId: rule.projectId,
          title: automationThreadTitle(rule, scheduledFor),
          prompt: rule.prompt,
        });
        latestRun = {
          ...latestRun,
          threadId: launched.threadId,
        };

        const completedRun: AutomationRun = {
          ...latestRun,
          status: "completed",
          completedAt: yield* nowIso,
        };
        if (yield* input.ruleExists(ruleId)) {
          yield* input.writeRunAndTrimForRule(completedRun, {
            runId: completedRun.id,
            ruleId,
          });
        }
        return completedRun;
      });

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(restore(run));
          if (Exit.isSuccess(exit)) {
            return exit.value;
          }
          const failedRun = yield* writeFailedRun(
            Cause.hasInterrupts(exit.cause)
              ? "Automation run was interrupted."
              : Cause.pretty(exit.cause),
          );
          if (Cause.hasInterrupts(exit.cause)) {
            return yield* Effect.interrupt;
          }
          return failedRun;
        }).pipe(Effect.ensuring(prepared.release)),
      );
    });
  };

  return { executePreparedRun } as const;
}
