import {
  CommandId,
  MessageId,
  ProviderRequestKind,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { reportLabel } from "@t3tools/provider-core/server/notification";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class DelegatedTaskRequestReactor extends Context.Service<
  DelegatedTaskRequestReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/DelegatedTaskRequestReactor") {}

const isApprovalRequestKind = Schema.is(ProviderRequestKind);

const isRoutedRequestKind = (kind: OrchestrationV2RuntimeRequest["kind"]) =>
  kind === "user_input" || isApprovalRequestKind(kind);

// Questions can be answered by the parent; approvals need a live callback and only a human can decide them.
const routesToParent = (
  request: Pick<OrchestrationV2RuntimeRequest, "kind" | "responseCapability">,
) =>
  request.kind === "user_input" ||
  (isApprovalRequestKind(request.kind) && request.responseCapability.type === "live");

const isTerminalTask = (task: OrchestrationV2Subagent) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(task.status);

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const wakeParent = Effect.fnUntraced(function* (
    task: OrchestrationV2Subagent,
    request: OrchestrationV2RuntimeRequest,
  ) {
    if (task.childThreadId === null) return;
    const key = `${task.threadId}:${request.id}`;
    const label = reportLabel(task.title?.trim() || task.prompt);
    const question = request.kind === "user_input";
    const situation = question
      ? request.responseCapability.type === "message"
        ? `Delegated task ${task.id} asked a question and is still working.`
        : `Delegated task ${task.id} is blocked on a question and cannot continue until it is answered.`
      : `Delegated task ${task.id} needs the user's approval.`;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:delegated-task-question:${key}`),
      threadId: task.threadId,
      messageId: MessageId.make(`message:delegated-task-question:${key}`),
      text: !question
        ? `${situation} Ask the user to open [the child thread](t3-thread://v1/${task.childThreadId}) and handle request ${request.id} there. Only the user can approve; do not answer this request with t3_pending_request_respond. If it is no longer pending, no action is needed.`
        : `${situation} Read it with t3_pending_request_read using threadId ${task.childThreadId} and requestId ${request.id}. Answer it with t3_pending_request_respond when the answer follows from the task or the user's instructions; otherwise ask the user, then answer it. If it is no longer pending, it was answered or dismissed.`,
      notification: {
        source: { kind: "delegated_task", taskIds: [task.id], childThreadId: task.childThreadId },
        outcome: "updated",
        summary: `Delegated task${label === undefined ? "" : ` "${label}"`} ${question ? "has a question" : "needs approval"}`,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  // Runs for every domain event; most events return before any work is needed.
  const handle: DelegatedTaskRequestReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "run.updated") {
        if (!["completed", "failed", "waiting"].includes(event.payload.status)) return;
        const parent = yield* projections.getThreadRecords(event.threadId, ["subagents"]);
        if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;
        for (const task of parent.subagents) {
          if (
            task.origin !== "app_owned" ||
            task.runId !== event.payload.id ||
            task.completionDelivery?.state === "disposed" ||
            task.childThreadId === null ||
            isTerminalTask(task)
          ) {
            continue;
          }
          const child = yield* projections.getThreadRecords(task.childThreadId, [
            "runtimeRequests",
          ]);
          for (const request of child.runtimeRequests) {
            // An incomplete wait upgrades the task to "always" after returning the request itself.
            if (
              !routesToParent(request) ||
              request.status !== "pending" ||
              task.completionWake !== "settled_only" ||
              request.responseCapability.type !== "live"
            ) {
              continue;
            }
            yield* wakeParent(task, request).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("catching up a delegated task request failed", {
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
      // Withdrawal must not depend on capability: interruption ends a live approval as not_resumable.
      if (event.type !== "runtime-request.updated" || !isRoutedRequestKind(event.payload.kind)) {
        return;
      }
      const child = yield* projections.getThread(event.threadId);
      const parentThreadId = child.lineage.parentThreadId;
      if (parentThreadId === null) return;
      const request = yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
      const key = `${parentThreadId}:${event.payload.id}`;
      const messageId = MessageId.make(`message:delegated-task-question:${key}`);
      if (event.payload.status !== "pending" || request?.status !== "pending") {
        const parent = yield* projections.getThreadRecords(parentThreadId, ["runs"]);
        const queued = parent.runs.find(
          (run) => run.status === "queued" && run.userMessageId === messageId,
        );
        if (queued !== undefined) {
          yield* engine.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`server:delegated-task-question-cancel:${key}`),
            threadId: parentThreadId,
            runId: queued.id,
          });
        }
        return;
      }
      if (!routesToParent(request)) return;
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
        task === undefined ||
        task.childThreadId !== child.id ||
        task.completionDelivery?.state === "disposed" ||
        isTerminalTask(task) ||
        parent.thread.archivedAt !== null ||
        parent.thread.deletedAt !== null
      ) {
        return;
      }
      // A blocking delegate_task wait delivers live questions and approvals itself.
      if (
        task.completionWake === "settled_only" &&
        (request.kind !== "user_input" || request.responseCapability.type === "live") &&
        parent.runs.some(
          (run) =>
            run.id === task.runId &&
            (run.status === "preparing" || run.status === "starting" || run.status === "running"),
        )
      ) {
        return;
      }
      yield* wakeParent(task, request);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("waking the parent of a delegated task request failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: DelegatedTaskRequestReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task request event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies DelegatedTaskRequestReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskRequestReactor, make);
