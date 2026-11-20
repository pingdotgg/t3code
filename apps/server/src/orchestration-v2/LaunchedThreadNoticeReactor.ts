import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Notification,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { reportLabel } from "@t3tools/provider-core/server/notification";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * Tells the thread that launched a thread here (its `delegatedFrom`) when one of that thread's
 * runs ends, as a delegated task's notice: steered into the launcher's turn or queued to wake it.
 */
export class LaunchedThreadNoticeReactor extends Context.Service<
  LaunchedThreadNoticeReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/LaunchedThreadNoticeReactor") {}

// A delegated task's result inlines up to the same size before it points at a read.
const RESULT_INLINE_BYTES = 16_000;

const OUTCOMES: Partial<
  Record<
    OrchestrationV2Run["status"],
    { readonly outcome: OrchestrationV2Notification["outcome"]; readonly verb: string }
  >
> = {
  completed: { outcome: "completed", verb: "completed" },
  failed: { outcome: "failed", verb: "failed" },
  interrupted: { outcome: "cancelled", verb: "was interrupted" },
};

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );

  /** The launcher here of the thread whose run ended, or null when there is none to tell. */
  const launcherOf = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    if (event.type !== "run.updated" || OUTCOMES[event.payload.status] === undefined) return null;
    const from = (yield* projections.findThread(event.threadId))?.delegatedFrom;
    // A linked environment's task is reported by its follower there.
    return from == null || from.environmentId !== hereId ? null : from.threadId;
  });

  const handle: LaunchedThreadNoticeReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.updated") return;
      const ended = OUTCOMES[event.payload.status];
      const launcherId = yield* launcherOf(event);
      if (ended === undefined || launcherId === null) return;
      const launcher = yield* projections.findThread(launcherId);
      if (launcher === null || launcher.archivedAt !== null || launcher.deletedAt !== null) return;
      const run = event.payload;
      const child = yield* projections.getThreadRecords(
        event.threadId,
        ["messages", "turnItems", "providerTurns"],
        {
          messageRunIds: [run.id],
          turnItemRunIds: [run.id],
          turnItemTypes: ["assistant_message", "error", "system_notice"],
          providerTurnAttemptIds: run.activeAttemptId === null ? [] : [run.activeAttemptId],
        },
      );
      // The user typed this run's message there, or its own pull request watch or Monitor woke it:
      // the launcher did not ask for it.
      const wake = child.messages.find((message) => message.id === run.userMessageId);
      if (wake?.createdBy === "user" || wake?.notification?.source.kind === "monitor") return;
      const label = `Launched thread ${child.thread.id} (${child.thread.title}) [${run.status}]`;
      const result = subagentResultForRun(child, run).text;
      const text =
        Buffer.byteLength(result) <= RESULT_INLINE_BYTES
          ? `${label}:\n${result}`
          : `${label}. Use t3_thread_read with threadId ${child.thread.id} to read the result.`;
      const title = reportLabel(child.thread.title);
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:launched-thread-notice:${run.id}`),
        threadId: launcherId,
        messageId: MessageId.make(`message:launched-thread-notice:${run.id}`),
        text,
        notification: {
          source: { kind: "delegated_task", taskIds: [], childThreadId: child.thread.id },
          outcome: ended.outcome,
          summary: `Launched thread${title === undefined ? "" : ` "${title}"`} ${ended.verb}`,
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("telling the launcher of a thread that its run ended failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: LaunchedThreadNoticeReactor["Service"]["start"] = Effect.fn(
    "LaunchedThreadNoticeReactor.start",
  )(function* () {
    // Keyed by launcher, so a busy launcher delays only its own notices.
    const launcherReactions = yield* KeyedLock.makeRunner<ThreadId>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        launcherOf(event).pipe(
          Effect.flatMap((launcherId) =>
            launcherId === null ? Effect.void : launcherReactions.run(launcherId, handle(event)),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("finding the launcher of a thread failed", {
              threadId: event.threadId,
              cause,
            }),
          ),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("launched thread notice event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, handle } satisfies LaunchedThreadNoticeReactor["Service"];
});

export const layer = Layer.effect(LaunchedThreadNoticeReactor, make);
