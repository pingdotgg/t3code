import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  ProviderRequestKind,
  type RuntimeRequestId,
  type ThreadId,
  threadParentRelationship,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { reportLabel } from "@t3tools/provider-core/server/notification";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class DelegatedTaskQuestionReactor extends Context.Service<
  DelegatedTaskQuestionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/DelegatedTaskQuestionReactor") {}

// A parent on another environment is out of reach of a local wake.
function localParentThreadId(thread: OrchestrationV2AppThread): ThreadId | null {
  return threadParentRelationship(thread) === "child"
    ? thread.parentEnvironmentId == null
      ? (thread.parentThreadId ?? null)
      : null
    : thread.lineage.parentThreadId;
}

const isApprovalRequestKind = Schema.is(ProviderRequestKind);
const wakesParent = (kind: OrchestrationV2RuntimeRequest["kind"]) =>
  kind === "user_input" || isApprovalRequestKind(kind);

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  // `task` is undefined for a child chat from t3_thread_launch or create_threads.
  const wakeParent = Effect.fnUntraced(function* (
    parentThreadId: ThreadId,
    child: Pick<OrchestrationV2AppThread, "id" | "title">,
    request: OrchestrationV2RuntimeRequest,
    task: OrchestrationV2Subagent | undefined,
  ) {
    const key = `${parentThreadId}:${request.id}`;
    const label = reportLabel(task === undefined ? child.title : task.title?.trim() || task.prompt);
    const subject = task === undefined ? `Child thread ${child.id}` : `Delegated task ${task.id}`;
    const approval = isApprovalRequestKind(request.kind);
    const situation =
      request.responseCapability.type === "message"
        ? `${subject} asked a question and is still working.`
        : `${subject} is blocked on a question and cannot continue until it is answered.`;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:delegated-task-question:${key}`),
      threadId: parentThreadId,
      messageId: MessageId.make(`message:delegated-task-question:${key}`),
      text: approval
        ? `${subject} is blocked on an approval and cannot continue. Read it with t3_thread_read view activity on threadId ${child.id} (the approval_request item), or t3_get_pending_questions. Answer with t3_respond_to_approval threadId ${child.id}, approvalRequestId ${request.id} (add confirmDestructive true for a destructive-command check you approve). Approve it only if the command fits the child's task; otherwise decline and tell the child the safe form.`
        : `${situation} Read it with t3_pending_request action read, threadId ${child.id}, and requestId ${request.id}. Answer it with action respond when the answer follows from the task or the user's instructions; otherwise ask the user, then answer it. If it is no longer pending, it was answered or dismissed.`,
      notification: {
        source:
          task === undefined
            ? { kind: "subagent", childThreadId: child.id }
            : { kind: "delegated_task", taskIds: [task.id], childThreadId: child.id },
        outcome: "updated",
        summary: `${task === undefined ? "Child thread" : "Delegated task"}${label === undefined ? "" : ` "${label}"`} ${approval ? "is waiting for approval" : "has a question"}`,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  // The parent's message is the answer to its child's async questions, so they
  // close instead of lingering until a late answer starts a run that has nothing to do.
  const closeAnsweredQuestions = Effect.fnUntraced(function* (
    event: Extract<OrchestrationV2DomainEvent, { readonly type: "message.updated" }>,
  ) {
    const message = event.payload;
    if (message.role !== "user" || message.senderThreadId === undefined) return;
    const child = yield* projections.getThread(event.threadId);
    if (localParentThreadId(child) !== message.senderThreadId) return;
    const { runtimeRequests } = yield* projections.getThreadRecords(child.id, ["runtimeRequests"]);
    for (const request of runtimeRequests) {
      if (
        request.kind !== "user_input" ||
        request.status !== "pending" ||
        request.responseCapability.type !== "message" ||
        DateTime.isGreaterThan(request.createdAt, message.createdAt)
      ) {
        continue;
      }
      yield* engine
        .dispatch({
          type: "thread.user-input.dismiss",
          commandId: CommandId.make(`server:parent-answered-question:${child.id}:${request.id}`),
          threadId: child.id,
          requestId: request.id,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("closing a question the parent answered failed", {
              threadId: child.id,
              requestId: request.id,
              cause,
            }),
          ),
        );
    }
  });

  const cancelQueuedWakes = Effect.fnUntraced(function* (
    parentThreadId: ThreadId,
    requestIds: ReadonlyArray<RuntimeRequestId>,
  ) {
    const parent = yield* projections.getThreadRecords(parentThreadId, ["runs"]);
    for (const requestId of requestIds) {
      const key = `${parentThreadId}:${requestId}`;
      const messageId = MessageId.make(`message:delegated-task-question:${key}`);
      const queued = parent.runs.find(
        (run) => run.status === "queued" && run.userMessageId === messageId,
      );
      if (queued === undefined) continue;
      yield* engine
        .dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`server:delegated-task-question-cancel:${key}`),
          threadId: parentThreadId,
          runId: queued.id,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("cancelling a delegated task question wake failed", {
              threadId: parentThreadId,
              requestId,
              cause,
            }),
          ),
        );
    }
  });

  // Runs for every domain event; most events return before any work is needed.
  const handle: DelegatedTaskQuestionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "message.updated") return yield* closeAnsweredQuestions(event);
      if (event.type === "run.updated") {
        if (!["completed", "failed", "waiting"].includes(event.payload.status)) return;
        const parent = yield* projections.getThreadRecords(event.threadId, ["subagents"]);
        if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;
        for (const task of parent.subagents) {
          if (
            task.origin !== "app_owned" ||
            task.runId !== event.payload.id ||
            task.completionWake !== "settled_only" ||
            task.completionDelivery?.state === "disposed" ||
            task.childThreadId === null ||
            ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
          ) {
            continue;
          }
          const child = yield* projections.getThreadRecords(task.childThreadId, [
            "runtimeRequests",
          ]);
          for (const request of child.runtimeRequests) {
            if (
              !wakesParent(request.kind) ||
              request.status !== "pending" ||
              request.responseCapability.type !== "live"
            ) {
              continue;
            }
            yield* wakeParent(task.threadId, child.thread, request, task).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("catching up a delegated task question failed", {
                  taskId: task.id,
                  requestId: request.id,
                  cause,
                }),
              ),
            );
          }
        }
        return;
      }
      if (event.type === "subagent.updated") {
        const task = event.payload;
        if (
          task.origin !== "app_owned" ||
          task.childThreadId === null ||
          !["completed", "failed", "cancelled", "interrupted"].includes(task.status)
        ) {
          return;
        }
        // A settled task can no longer use an answer to its still-pending questions.
        const { runtimeRequests } = yield* projections.getThreadRecords(task.childThreadId, [
          "runtimeRequests",
        ]);
        const questions = runtimeRequests.filter((request) => wakesParent(request.kind));
        if (questions.length === 0) return;
        const child = yield* projections.getThreadRecords(task.childThreadId, ["runs", "nodes"]);
        const taskRunIds = new Set(
          child.runs
            .filter(
              (run) =>
                run.delegatedTaskId === task.id ||
                (run.delegatedTaskId === undefined &&
                  child.thread.forkedFrom?.type === "node" &&
                  child.thread.forkedFrom.nodeId === task.id),
            )
            .map((run) => run.id),
        );
        const taskNodeIds = new Set(
          child.nodes
            .filter((node) => node.runId !== null && taskRunIds.has(node.runId))
            .map((node) => node.id),
        );
        yield* cancelQueuedWakes(
          task.threadId,
          questions
            .filter((request) => taskNodeIds.has(request.nodeId))
            .map((request) => request.id),
        );
        return;
      }
      if (event.type !== "runtime-request.updated" || !wakesParent(event.payload.kind)) {
        return;
      }
      const child = yield* projections.getThread(event.threadId);
      const relationship = threadParentRelationship(child);
      const parentThreadId = localParentThreadId(child);
      if (parentThreadId === null) return;
      const request = yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
      if (event.payload.status !== "pending" || request?.status !== "pending") {
        yield* cancelQueuedWakes(parentThreadId, [event.payload.id]);
        return;
      }
      const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents", "runs"]);
      const { runs } = yield* projections.getThreadRecords(child.id, ["runs"]);
      const run =
        runs.find((run) => run.id === event.runId) ??
        runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      const taskId =
        run?.delegatedTaskId ??
        (child.forkedFrom?.type === "node" ? child.forkedFrom.nodeId : undefined);
      const task = parent.subagents.find(
        (candidate) => candidate.origin === "app_owned" && candidate.id === taskId,
      );
      if (
        (task === undefined && relationship !== "child") ||
        parent.thread.archivedAt !== null ||
        parent.thread.deletedAt !== null
      ) {
        return;
      }
      // A blocking delegate_task wait delivers the question itself.
      if (
        task?.completionWake === "settled_only" &&
        event.payload.responseCapability.type === "live" &&
        parent.runs.some(
          (run) =>
            run.id === task.runId &&
            (run.status === "preparing" || run.status === "starting" || run.status === "running"),
        )
      ) {
        return;
      }
      yield* wakeParent(parentThreadId, child, request, task);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("waking the parent of a delegated task question failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  // Every wake and cancel goes to the parent, so keying by it keeps a question's wake ahead of
  // its task's cancel while a busy parent's lock delays only that parent's reactions.
  const parentOf = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "run.updated":
        return Effect.succeed(event.threadId);
      case "subagent.updated":
        return Effect.succeed(event.payload.threadId);
      case "runtime-request.updated":
        return event.payload.kind === "user_input"
          ? projections
              .getThread(event.threadId)
              .pipe(Effect.map((child) => child.lineage.parentThreadId))
          : Effect.succeed(null);
      default:
        return Effect.succeed(null);
    }
  };

  const start: DelegatedTaskQuestionReactor["Service"]["start"] = Effect.fn(
    "DelegatedTaskQuestionReactor.start",
  )(function* () {
    const parentReactions = yield* KeyedLock.makeRunner<ThreadId>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        parentOf(event).pipe(
          Effect.flatMap((parentThreadId) =>
            parentThreadId === null
              ? Effect.void
              : parentReactions.run(parentThreadId, handle(event)),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("finding the parent of a delegated task question failed", {
              threadId: event.threadId,
              cause,
            }),
          ),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task question event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, handle } satisfies DelegatedTaskQuestionReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskQuestionReactor, make);
