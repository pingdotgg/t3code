import { CommandId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { nextRunForThread } from "./ScheduledTaskService.ts";

export class ScheduledTaskSnoozeReactor extends Context.Service<
  ScheduledTaskSnoozeReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/scheduledTasks/ScheduledTaskSnoozeReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;

  // Runs for every domain event; most events return before any work is needed.
  const handle: ScheduledTaskSnoozeReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.updated" || event.payload.status !== "completed") return;
      const { snoozeThreadsUntilScheduledTask } = yield* settings.getSettings;
      if (!snoozeThreadsUntilScheduledTask) return;
      const run = event.payload;
      // Automatic follow-ups leave their result visible, and so does a task's own run
      // unless it scheduled a new task for this thread.
      const { messages } = yield* projections.getThreadRecords(event.threadId, ["messages"], {
        messageIds: [run.userMessageId],
      });
      const message = messages.find((candidate) => candidate.id === run.userMessageId);
      if (message?.notification !== undefined || message?.delegatedCompletion !== undefined) {
        return;
      }
      if (message?.scheduledTaskId !== undefined && run.startedAt === null) return;
      const nextRun = yield* nextRunForThread(
        event.threadId,
        yield* DateTime.now,
        message?.scheduledTaskId === undefined ? undefined : (run.startedAt ?? undefined),
      ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      if (nextRun === null) return;
      // Completion is re-emitted (checkpoints, delegated rewrites); one id per run keeps a
      // later manual wake from being undone.
      yield* engine.autoSnoozeAfterRun({
        commandId: CommandId.make(`server:scheduled-task-snooze:${run.id}`),
        threadId: event.threadId,
        runId: run.id,
        snoozedUntil: nextRun,
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("snoozing a thread until its scheduled task failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: ScheduledTaskSnoozeReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("scheduled task snooze event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies ScheduledTaskSnoozeReactor["Service"];
});

export const layer = Layer.effect(ScheduledTaskSnoozeReactor, make);
