import {
  CommandId,
  THREAD_TASK_WATCH_MAX_MS,
  ThreadTaskError,
  threadParentRelationship,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type RuntimeRequestId,
  type ThreadId,
  type ThreadTask,
  type ThreadTaskActor,
  type ThreadTaskAssignInput,
  type ThreadTaskCheckBack,
  type ThreadTaskContinuation,
  type ThreadTaskListResult,
  type ThreadTaskReadInput,
  type ThreadTaskUpdateInput,
  type ThreadTaskView,
  type ThreadTaskWatchInput,
  type EnvironmentId,
  EnvironmentId as EnvironmentIdSchema,
  type ProjectId,
  ThreadTaskRemoteAssignInput as RemoteAssignInputSchema,
  ThreadTaskRemoteDeliverResult as RemoteDeliverResultSchema,
  ThreadTaskView as ThreadTaskViewSchema,
  type ThreadTaskRemoteAssignInput,
  type ThreadTaskBoard,
  type ThreadTaskBoardInput,
  type ThreadTaskProjectSnapshot,
  type ThreadTaskProjectSnapshotInput,
  THREAD_TASK_PROJECT_LIMIT,
  ThreadTaskProjectSnapshot as ProjectSnapshotSchema,
  type ThreadTaskRemoteDeliverInput,
  type ThreadTaskRemoteOwnerActionInput,
  type ThreadSettleAfterTurnInput,
  type ThreadSettleRequest,
  type McpGatewayRelayEvent,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { threadShellHasActiveWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  threadPullRequestWatchesSuspended,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { threadPullRequestsOf } from "../sourceControl/threadPullRequests.ts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { forkParked } from "../serverActivation.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ThreadTaskStore from "./ThreadTaskStore.ts";
import { ThreadTaskTransport, type ThreadTaskRemoteRequest } from "./ThreadTaskTransport.ts";

/**
 * Who is acting. A thread caller comes from the authenticated MCP invocation;
 * `user` is an authorized client without a calling thread, with owner rights.
 */
export type ThreadTaskCaller =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "user" };

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);
const fail = (code: ThreadTaskError["code"], detail: string, currentRevision?: number) =>
  new ThreadTaskError({
    code,
    detail,
    ...(currentRevision === undefined ? {} : { currentRevision }),
  });

const isAccepted = (task: ThreadTask) =>
  task.status === "DONE" && task.acceptance?.revision === task.revision;

const sameContinuation = (
  left: ThreadTaskContinuation | null,
  right: ThreadTaskContinuation | null,
) => {
  if (left === null || right === null) return left === right;
  switch (left.kind) {
    case "run":
      return right.kind === "run";
    case "pull_request":
      return (
        right.kind === "pull_request" &&
        left.repository === right.repository &&
        left.number === right.number
      );
    case "task":
      return right.kind === "task" && left.threadId === right.threadId;
  }
};

const WAKE_MESSAGE_PREFIX = "message:thread-task-wake:";
const sameEvidence = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

/**
 * Typed task records between an owner chat and its child worker chats: the
 * worker reports WAITING/INPUT/DONE and the owner watches or reads those records
 * before accepting. Child activity never dispatches messages to the owner.
 */
export class ThreadTaskService extends Context.Service<
  ThreadTaskService,
  {
    /**
     * `workerEnvironmentId` names a child on another environment: its own
     * server keeps the task, and this one keeps a mirror fed by delivery.
     */
    readonly assign: (
      caller: ThreadTaskCaller,
      input: ThreadTaskAssignInput,
      workerEnvironmentId?: EnvironmentId,
    ) => Effect.Effect<ThreadTaskView, ThreadTaskError>;
    /** Peer calls for a task split across environments, relayed by a connected app. */
    readonly remoteAssign: (
      input: ThreadTaskRemoteAssignInput,
    ) => Effect.Effect<ThreadTaskView, ThreadTaskError>;
    readonly remoteDeliver: (
      input: ThreadTaskRemoteDeliverInput,
    ) => Effect.Effect<{ readonly applied: boolean }, ThreadTaskError>;
    /** This environment's own task records for a project key, for a peer's board read. */
    readonly projectSnapshot: (
      input: ThreadTaskProjectSnapshotInput,
    ) => Effect.Effect<ThreadTaskProjectSnapshot, ThreadTaskError>;
    /**
     * A read-only view of a project's tasks here and on every environment a
     * connected app reaches, grouped by owner, with per-environment coverage.
     * Captains and the user read it; managed workers read their own task.
     */
    readonly board: (
      caller: ThreadTaskCaller,
      input: ThreadTaskBoardInput,
    ) => Effect.Effect<ThreadTaskBoard, ThreadTaskError>;
    readonly remoteOwnerAction: (
      input: ThreadTaskRemoteOwnerActionInput,
    ) => Effect.Effect<ThreadTaskView, ThreadTaskError>;
    /** Assigns a task to a named child chat at launch, unless it already has one. */
    readonly assignLaunchedChild: (input: {
      readonly ownerThreadId: ThreadId;
      readonly workerThreadId: ThreadId;
      readonly summary: string;
    }) => Effect.Effect<void>;
    readonly read: (
      caller: ThreadTaskCaller,
      input: ThreadTaskReadInput,
    ) => Effect.Effect<ThreadTaskListResult, ThreadTaskError>;
    readonly update: (
      caller: ThreadTaskCaller,
      input: ThreadTaskUpdateInput,
    ) => Effect.Effect<ThreadTaskView, ThreadTaskError>;
    /** Changes after `afterCursor`, waiting up to `timeoutMs` for the first one. */
    readonly watch: (
      caller: ThreadTaskCaller,
      input: ThreadTaskWatchInput,
    ) => Effect.Effect<ThreadTaskListResult, ThreadTaskError>;
    /**
     * Records a chat's request to settle once its current turn ends and nothing
     * it owns is still working, or withdraws it. Only the chat itself or the
     * user may ask.
     */
    readonly settleAfterTurn: (
      caller: ThreadTaskCaller,
      input: ThreadSettleAfterTurnInput,
    ) => Effect.Effect<ThreadSettleRequest, ThreadTaskError>;
    /**
     * Whether a chat may message another. A managed worker (a chat with a task)
     * reports through its task instead; it may message only its own children.
     * Chats without a task, and the user, are not restricted here.
     */
    readonly authorizeMessage: (input: {
      readonly senderThreadId: ThreadId;
      /** Null when the target is on another environment. */
      readonly targetThreadId: ThreadId | null;
    }) => Effect.Effect<void, ThreadTaskError>;
    readonly recover: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Waits until every committed event has been handled. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/threadTask/ThreadTaskService") {}

export const make = Effect.gen(function* () {
  const transport = Option.getOrUndefined(yield* Effect.serviceOption(ThreadTaskTransport));
  const projectStore = Option.getOrUndefined(
    yield* Effect.serviceOption(ProjectStore.ProjectStoreV2),
  );
  const repositories = Option.getOrUndefined(
    yield* Effect.serviceOption(RepositoryIdentityResolver.RepositoryIdentityResolver),
  );
  const store = yield* ThreadTaskStore.ThreadTaskStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const writes = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<void>();

  const unavailable = (cause: unknown) =>
    Effect.logWarning("thread task read failed", { cause }).pipe(
      Effect.andThen(Effect.fail(fail("thread_not_found", "The thread could not be read."))),
    );
  const getTask = (workerThreadId: ThreadId) =>
    store.get(workerThreadId).pipe(Effect.catch(unavailable), Effect.map(Option.getOrUndefined));
  const getShell = (threadId: ThreadId) =>
    projections.getThreadShell(threadId).pipe(
      Effect.catch(unavailable),
      Effect.map((shell) => (shell === null || shell.deletedAt != null ? undefined : shell)),
    );
  const requireShell = (threadId: ThreadId) =>
    getShell(threadId).pipe(
      Effect.filterOrFail(
        (shell) => shell !== undefined,
        () => fail("thread_not_found", `Thread ${threadId} was not found.`),
      ),
    );
  const put = (task: ThreadTask): Effect.Effect<ThreadTask, ThreadTaskError> =>
    store.put({ ...task, wake: null }).pipe(
      Effect.tap(() => PubSub.publish(changes, undefined)),
      // The owner is on another environment: record what it has not seen and send it.
      Effect.tap((stored) =>
        stored.ownerEnvironmentId === null
          ? Effect.void
          : store.getLink(stored.workerThreadId).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: (link) =>
                    store
                      .putLink({ ...link, pendingCursor: stored.cursor })
                      .pipe(Effect.andThen(syncs.enqueue(stored.workerThreadId))),
                }),
              ),
            ),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("thread task write failed", { cause }).pipe(
          Effect.andThen(Effect.fail(fail("task_not_found", "The task could not be saved."))),
        ),
      ),
    );
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  /** Durable timestamps for later latency and duplicate review; never fails a caller. */
  const record = (
    workerThreadId: ThreadId,
    kind: ThreadTaskStore.ThreadTaskEventKind,
    revision?: number,
    detail?: string,
  ) =>
    nowIso.pipe(
      Effect.flatMap((at) => store.appendEvent({ at, workerThreadId, kind, revision, detail })),
      Effect.ignore,
    );

  const hasLiveRun = (shell: OrchestrationV2ThreadShell) =>
    shell.activeRunId != null || threadShellHasActiveWork(shell);

  /** Tasks the worker owns that its owner has not accepted yet. */
  const openChildTasks = (workerThreadId: ThreadId) =>
    store.listByOwner(workerThreadId).pipe(
      Effect.map((tasks) => tasks.filter((task) => !isAccepted(task))),
      Effect.catch(unavailable),
    );

  const continuationExists = Effect.fn("ThreadTaskService.continuationExists")(function* (
    task: ThreadTask,
    continuation: ThreadTaskContinuation,
  ) {
    switch (continuation.kind) {
      case "run": {
        const shell = yield* getShell(task.workerThreadId);
        return shell !== undefined && hasLiveRun(shell);
      }
      case "pull_request": {
        // Registered is not live: a settled, archived, or deleted thread parks its watches.
        for (const threadId of [task.workerThreadId, task.ownerThreadId]) {
          const thread = yield* projections
            .getThread(threadId)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (
            thread === undefined ||
            thread.deletedAt != null ||
            threadPullRequestWatchesSuspended(thread)
          )
            continue;
          const watched = visibleThreadPullRequests(threadPullRequestsOf(thread)).some(
            (link) =>
              link.watch !== undefined &&
              link.repository.toLowerCase() === continuation.repository.toLowerCase() &&
              link.number === continuation.number,
          );
          if (watched) return true;
        }
        return false;
      }
      case "task": {
        const child = yield* getTask(continuation.threadId);
        return (
          child !== undefined && child.ownerThreadId === task.workerThreadId && !isAccepted(child)
        );
      }
    }
  });

  /** A declared check-back still in the future covers the task like a live continuation. */
  const checkBackLive = (task: ThreadTask, nowMs: number) =>
    task.status === "WAITING" &&
    task.checkBack != null &&
    DateTime.toEpochMillis(DateTime.makeUnsafe(task.checkBack.at)) > nowMs;

  const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

  const view = Effect.fn("ThreadTaskService.view")(function* (task: ThreadTask) {
    const link = Option.getOrUndefined(
      yield* store.getLink(task.workerThreadId).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    const sync =
      link === undefined
        ? null
        : {
            peerEnvironmentId: link.peerEnvironmentId,
            state: link.state,
            lastSyncedAt: link.lastSyncedAt,
            lastError: link.lastError,
          };
    // A mirror reports the worker's state as its own environment last delivered it.
    if (task.workerEnvironmentId !== null) {
      return {
        task,
        sync,
        workerRun: link?.remoteWorkerRun ?? "idle",
        continuationLive: link?.remoteContinuationLive ?? false,
        accepted: isAccepted(task),
      } as ThreadTaskView;
    }
    const shell = yield* getShell(task.workerThreadId);
    const workerRun: ThreadTaskView["workerRun"] =
      shell?.pendingRuntimeRequest?.kind === "user_input"
        ? "waiting_input"
        : shell !== undefined && hasLiveRun(shell)
          ? "running"
          : "idle";
    const continuationLive =
      task.status === "WAITING" &&
      (checkBackLive(task, yield* nowMillis) ||
        (task.waitingOn !== null && (yield* continuationExists(task, task.waitingOn))));
    return {
      task,
      sync,
      workerRun,
      continuationLive,
      accepted: isAccepted(task),
    } as ThreadTaskView;
  });

  /** The caller's role on a task, checking the owner is still the worker's parent. */
  const roleOf = (
    caller: ThreadTaskCaller,
    task: ThreadTask,
    worker: OrchestrationV2ThreadShell,
  ) => {
    if (worker.parentThreadId !== task.ownerThreadId) return undefined;
    if (caller.kind === "user") return "user" as const;
    if (caller.threadId === task.workerThreadId) return "worker" as const;
    if (caller.threadId === task.ownerThreadId) return "owner" as const;
    return undefined;
  };

  /** Discards every task notification queued by an older server. */
  const clearQueuedWakes = Effect.fn("ThreadTaskService.clearQueuedWakes")(function* (
    ownerThreadId: ThreadId,
  ) {
    const { runs } = yield* projections.getThreadRecords(ownerThreadId, ["runs"], {
      runStatuses: ["queued"],
    });
    if (runs.length === 0) return;
    const { messages } = yield* projections.getThreadRecords(ownerThreadId, ["messages"], {
      messageIds: runs.map((run) => run.userMessageId),
    });
    const wakeIds = new Set(
      messages
        .filter((message) => String(message.id).startsWith(WAKE_MESSAGE_PREFIX))
        .map((message) => message.id),
    );
    for (const run of runs) {
      if (!wakeIds.has(run.userMessageId)) continue;
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make(`server:thread-task-wake-retired:${run.id}`),
        threadId: ownerThreadId,
        runId: run.id,
      });
    }
  });

  /**
   * Settles an accepted worker whose owner consented, once its work is quiet.
   * Settlement cascades to the worker's own sub-runs.
   */
  const evaluateSettlement = Effect.fn("ThreadTaskService.evaluateSettlement")(
    function* (workerThreadId: ThreadId) {
      const task = yield* getTask(workerThreadId);
      if (
        task === undefined ||
        task.settleWhenAccepted === null ||
        task.settlement.state === "settled"
      )
        return;
      const shell = yield* getShell(workerThreadId);
      if (shell === undefined) return;
      const blockedBy: ThreadTask["settlement"]["blockedBy"] = !isAccepted(task)
        ? "not_accepted"
        : hasLiveRun(shell)
          ? "active_run"
          : (yield* openChildTasks(workerThreadId)).length > 0 ||
              (yield* projections
                .hasActiveDescendants(workerThreadId)
                .pipe(Effect.orElseSucceed(() => true)))
            ? "pending_descendant"
            : null;
      let settled = false;
      if (blockedBy === null) {
        settled = yield* orchestrator
          .dispatch({
            type: "thread.settle",
            commandId: CommandId.make(
              `server:thread-task-settle:${workerThreadId}:${task.revision}`,
            ),
            threadId: workerThreadId,
          })
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logInfo("accepted thread task kept its settlement pending", {
                workerThreadId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
            ),
          );
      }
      const settlement: ThreadTask["settlement"] = settled
        ? { state: "settled", blockedBy: null }
        : !isAccepted(task)
          ? { state: "none", blockedBy: "not_accepted" }
          : { state: "pending", blockedBy: blockedBy ?? "active_run" };
      if (
        settlement.state === task.settlement.state &&
        settlement.blockedBy === task.settlement.blockedBy
      )
        return;
      yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getTask(workerThreadId);
          if (current === undefined || current.revision !== task.revision) return;
          yield* put({ ...current, settlement, updatedAt: yield* nowIso });
        }),
      );
    },
    (effect, workerThreadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread task settlement failed", {
            workerThreadId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
  );

  /** repo:<canonical remote> when the project has one, else an environment-local key. */
  const projectKeyFor = Effect.fn("ThreadTaskService.projectKeyFor")(function* (
    projectId: ProjectId,
  ) {
    const project =
      projectStore === undefined
        ? undefined
        : Option.getOrUndefined(
            yield* projectStore.get(projectId).pipe(Effect.orElseSucceed(() => Option.none())),
          );
    const identity =
      project === undefined || repositories === undefined
        ? null
        : yield* repositories.resolve(project.workspaceRoot).pipe(Effect.orElseSucceed(() => null));
    return identity === null
      ? `project:${transport?.localEnvironmentId ?? "local"}:${projectId}`
      : `repo:${identity.canonicalKey}`;
  });

  const writeAssignment = Effect.fn("ThreadTaskService.writeAssignment")(function* (input: {
    readonly ownerEnvironmentId?: EnvironmentId | null;
    readonly projectKey?: string | undefined;
    readonly owner: ThreadId;
    readonly actor: ThreadTaskActor;
    readonly worker: OrchestrationV2ThreadShell;
    readonly summary: string;
    readonly taskId: string | undefined;
    readonly settleWhenAccepted: boolean | undefined;
    readonly clientRequestId: string | undefined;
    readonly existing: ThreadTask | undefined;
  }) {
    const now = yield* nowIso;
    const existing = input.existing;
    const task: ThreadTask = {
      taskId: input.taskId ?? existing?.taskId ?? `task:${yield* randomUuidV4}`,
      workerThreadId: input.worker.id,
      ownerThreadId: input.owner,
      ownerEnvironmentId: input.ownerEnvironmentId ?? null,
      workerEnvironmentId: null,
      projectKey:
        input.projectKey ?? existing?.projectKey ?? (yield* projectKeyFor(input.worker.projectId)),
      status: "WAITING",
      revision: (existing?.revision ?? 0) + 1,
      cursor: 0,
      summary: input.summary,
      needs: null,
      questionRequestId: null,
      evidence: [],
      waitingOn: { kind: "run" },
      settleWhenAccepted:
        input.settleWhenAccepted === true
          ? { grantedBy: input.actor, grantedAt: now }
          : input.settleWhenAccepted === false
            ? null
            : (existing?.settleWhenAccepted ?? null),
      acceptance: null,
      settlement: { state: "none", blockedBy: null },
      wake: null,
      observedRunId: existing?.observedRunId ?? null,
      lastRequestId: input.clientRequestId ?? null,
      assignedAt: now,
      updatedAt: now,
      updatedBy: input.actor,
    };
    return yield* put(task);
  });

  const assign: ThreadTaskService["Service"]["assign"] = (caller, input, workerEnvironmentId) =>
    workerEnvironmentId !== undefined && workerEnvironmentId !== transport?.localEnvironmentId
      ? assignRemoteChild(caller, input, workerEnvironmentId)
      : assignLocal(caller, input);

  const assignLocal = (caller: ThreadTaskCaller, input: ThreadTaskAssignInput) =>
    writes
      .withPermits(1)(
        Effect.gen(function* () {
          const worker = yield* requireShell(input.threadId);
          const owner = worker.parentThreadId;
          if (
            owner == null ||
            worker.parentEnvironmentId != null ||
            threadParentRelationship(worker) !== "child" ||
            (caller.kind === "thread" && caller.threadId !== owner)
          ) {
            return yield* fail(
              "scope_denied",
              "Only the chat that a child chat is nested under can assign it a task.",
            );
          }
          const existing = yield* getTask(worker.id);
          if (
            existing !== undefined &&
            input.clientRequestId !== undefined &&
            existing.lastRequestId === input.clientRequestId
          ) {
            return existing;
          }
          return yield* writeAssignment({
            owner,
            actor: caller.kind === "user" ? "user" : "owner",
            worker,
            summary: input.summary,
            projectKey: input.projectKey,
            taskId: input.taskId,
            settleWhenAccepted: input.settleWhenAccepted,
            clientRequestId: input.clientRequestId,
            existing,
          });
        }),
      )
      .pipe(Effect.flatMap(view));

  const assignLaunchedChild: ThreadTaskService["Service"]["assignLaunchedChild"] = (input) =>
    writes
      .withPermits(1)(
        Effect.gen(function* () {
          const worker = yield* requireShell(input.workerThreadId);
          if (
            worker.parentThreadId !== input.ownerThreadId ||
            threadParentRelationship(worker) !== "child" ||
            (yield* getTask(worker.id)) !== undefined
          )
            return;
          yield* writeAssignment({
            owner: input.ownerThreadId,
            actor: "owner",
            worker,
            summary: input.summary,
            taskId: undefined,
            settleWhenAccepted: undefined,
            clientRequestId: undefined,
            existing: undefined,
          });
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("launched child kept no task", {
            workerThreadId: input.workerThreadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );

  /** Tasks the caller sees that changed after `afterCursor`, and those that left its view. */
  const visibleChanges = (caller: ThreadTaskCaller, afterCursor: number) =>
    Effect.all({
      tasks: store.listVisible({
        threadId: caller.kind === "user" ? null : caller.threadId,
        afterCursor,
      }),
      departures:
        caller.kind === "user"
          ? Effect.succeed([])
          : store.listDepartures({ ownerThreadId: caller.threadId, afterCursor }),
    }).pipe(Effect.catch(unavailable));

  const changeResult = Effect.fn("ThreadTaskService.changeResult")(function* (
    changes: Effect.Success<ReturnType<typeof visibleChanges>>,
    cursor: number,
  ) {
    const removed = changes.departures.map((departure) => departure.workerThreadId);
    return {
      tasks: yield* Effect.forEach(changes.tasks, view),
      ...(removed.length === 0 ? {} : { removed }),
      cursor,
      timedOut: false,
    };
  });

  const read: ThreadTaskService["Service"]["read"] = Effect.fn("ThreadTaskService.read")(
    function* (caller, input) {
      const cursor = yield* store.latestCursor.pipe(Effect.catch(unavailable));
      if (input.threadId === undefined) {
        // The cursor is read first, so a write racing this read is returned again, never lost.
        return yield* changeResult(yield* visibleChanges(caller, input.afterCursor ?? 0), cursor);
      }
      const task = yield* getTask(input.threadId);
      if (task === undefined) {
        return yield* fail("task_not_found", `Thread ${input.threadId} has no task.`);
      }
      // A mirror's worker lives on another environment; only its owner reads it here.
      const allowed =
        task.workerEnvironmentId !== null
          ? caller.kind === "user" || caller.threadId === task.ownerThreadId
          : roleOf(caller, task, yield* requireShell(task.workerThreadId)) !== undefined;
      if (!allowed) {
        return yield* fail("scope_denied", "Only a task's worker or owner can read it.");
      }
      return { tasks: [yield* view(task)], cursor, timedOut: false };
    },
  );

  const validate = Effect.fn("ThreadTaskService.validate")(function* (
    task: ThreadTask,
    worker: OrchestrationV2ThreadShell,
  ) {
    switch (task.status) {
      case "WAITING": {
        if (task.waitingOn === null) {
          return yield* fail("invalid_transition", "WAITING needs waitingOn.");
        }
        if (
          !checkBackLive(task, yield* nowMillis) &&
          !(yield* continuationExists(task, task.waitingOn))
        ) {
          return yield* fail(
            "continuation_missing",
            `Nothing registered resumes this task (waitingOn ${task.waitingOn.kind}).`,
          );
        }
        return;
      }
      case "INPUT": {
        if (task.needs === null) {
          return yield* fail(
            "invalid_transition",
            "INPUT needs `needs`: the missing decision or dependency.",
          );
        }
        if (
          task.questionRequestId !== null &&
          (worker.pendingRuntimeRequest?.id !== task.questionRequestId ||
            worker.pendingRuntimeRequest.kind !== "user_input")
        ) {
          return yield* fail(
            "invalid_transition",
            "questionRequestId must be the worker's pending question.",
          );
        }
        return;
      }
      case "DONE": {
        if (task.evidence.length === 0) {
          return yield* fail("invalid_transition", "DONE needs evidence of the deliverable.");
        }
        const open = yield* openChildTasks(task.workerThreadId);
        if (open.length > 0) {
          return yield* fail(
            "pending_descendant",
            `Child tasks are not accepted yet: ${open.map((child) => child.workerThreadId).join(", ")}.`,
          );
        }
        return;
      }
    }
  });

  const update: ThreadTaskService["Service"]["update"] = Effect.fn("ThreadTaskService.update")(
    function* (caller, input) {
      const workerThreadId =
        input.threadId ?? (caller.kind === "thread" ? caller.threadId : undefined);
      if (workerThreadId !== undefined) yield* ensureTask(workerThreadId);
      const mirror = workerThreadId === undefined ? undefined : yield* getTask(workerThreadId);
      if (mirror?.workerEnvironmentId == null) return yield* updateLocal(caller, input);
      if (caller.kind === "thread" && caller.threadId !== mirror.ownerThreadId) {
        return yield* fail("scope_denied", "Only a task's owner can change it from here.");
      }
      return yield* forwardOwnerAction(caller, mirror, input);
    },
  );

  const updateLocal = (caller: ThreadTaskCaller, input: ThreadTaskUpdateInput) =>
    writes
      .withPermits(1)(
        Effect.gen(function* () {
          const workerThreadId =
            input.threadId ?? (caller.kind === "thread" ? caller.threadId : undefined);
          if (workerThreadId === undefined) {
            return yield* fail("thread_not_found", "threadId is required without a calling chat.");
          }
          const task = yield* getTask(workerThreadId);
          if (task === undefined) {
            return yield* fail("task_not_found", `Thread ${workerThreadId} has no task.`);
          }
          const worker = yield* requireShell(workerThreadId);
          const role = roleOf(caller, task, worker);
          if (role === undefined) {
            return yield* fail("scope_denied", "Only a task's worker or owner can update it.");
          }
          if (input.clientRequestId !== undefined && input.clientRequestId === task.lastRequestId) {
            return { task };
          }
          if (input.expectedRevision !== task.revision) {
            return yield* fail(
              "revision_conflict",
              `The task is at revision ${task.revision}; read it again before updating.`,
              task.revision,
            );
          }
          if (
            role === "worker" &&
            (input.accept !== undefined || input.settleWhenAccepted !== undefined)
          ) {
            return yield* fail(
              "scope_denied",
              "Only the owner can accept a task or consent to its settlement.",
            );
          }
          const now = yield* nowIso;
          const actor: ThreadTaskActor = role;
          const status = input.status ?? task.status;
          const statusChanged = status !== task.status;
          const content = {
            status,
            summary: input.summary ?? task.summary,
            needs:
              status === "INPUT" ? (input.needs !== undefined ? input.needs : task.needs) : null,
            questionRequestId:
              status === "INPUT"
                ? input.questionRequestId !== undefined
                  ? input.questionRequestId
                  : task.questionRequestId
                : null,
            evidence: input.evidence ?? task.evidence,
            waitingOn:
              status === "WAITING"
                ? input.waitingOn !== undefined
                  ? input.waitingOn
                  : statusChanged
                    ? { kind: "run" as const }
                    : task.waitingOn
                : null,
          };
          const contentChanged =
            content.status !== task.status ||
            content.summary !== task.summary ||
            content.needs !== task.needs ||
            content.questionRequestId !== task.questionRequestId ||
            !sameEvidence(content.evidence, task.evidence) ||
            !sameContinuation(content.waitingOn, task.waitingOn);
          if (input.accept === true && contentChanged) {
            return yield* fail(
              "invalid_transition",
              "Accept a revision as it is; send changes in a separate update.",
            );
          }
          // A check-back belongs to the revision it was declared at: any content
          // change clears it unless the same update declares a new one.
          const checkBack: ThreadTaskCheckBack | null =
            input.checkBack === undefined
              ? contentChanged
                ? null
                : (task.checkBack ?? null)
              : input.checkBack === null
                ? null
                : {
                    at: DateTime.formatIso(
                      DateTime.add(DateTime.makeUnsafe(now), { minutes: input.checkBack.minutes }),
                    ),
                    note: input.checkBack.note,
                  };
          if (checkBack !== null && content.status !== "WAITING") {
            return yield* fail("invalid_transition", "checkBack is for a WAITING task.");
          }
          let next: ThreadTask = {
            ...task,
            ...content,
            checkBack,
            revision: contentChanged ? task.revision + 1 : task.revision,
            acceptance: contentChanged ? null : task.acceptance,
            settlement: contentChanged ? { state: "none", blockedBy: null } : task.settlement,
            lastRequestId: input.clientRequestId ?? null,
            updatedAt: now,
            updatedBy: actor,
          };
          if (contentChanged) yield* validate(next, worker);
          if (input.accept === true) {
            if (task.status !== "DONE") {
              return yield* fail("invalid_transition", "Only a DONE task can be accepted.");
            }
            yield* validate(next, worker);
            next = {
              ...next,
              acceptance: { revision: task.revision, acceptedBy: actor, acceptedAt: now },
            };
          }
          if (input.settleWhenAccepted !== undefined) {
            next = {
              ...next,
              settleWhenAccepted: input.settleWhenAccepted
                ? (task.settleWhenAccepted ?? { grantedBy: actor, grantedAt: now })
                : null,
            };
          }
          const stored = yield* put(next);
          if (contentChanged) {
            yield* record(
              stored.workerThreadId,
              "transition",
              stored.revision,
              `${role}:${task.status}->${stored.status}${input.accept === true ? ":accepted" : ""}`,
            );
          } else if (input.accept === true) {
            yield* record(stored.workerThreadId, "transition", stored.revision, `${role}:accepted`);
          }
          return { task: stored };
        }),
      )
      .pipe(
        Effect.tap(({ task }) =>
          Effect.gen(function* () {
            yield* evaluateSettlement(task.workerThreadId);
            // An accepted child task can be the last thing its owner's settle request waits on.
            if (task.ownerEnvironmentId === null) yield* evaluateSettleRequest(task.ownerThreadId);
          }),
        ),
        Effect.flatMap(({ task }) =>
          getTask(task.workerThreadId).pipe(Effect.flatMap((current) => view(current ?? task))),
        ),
      );

  const watch: ThreadTaskService["Service"]["watch"] = (caller, input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const afterCursor = input.afterCursor;
        if (afterCursor === undefined) return yield* read(caller, {});
        const timeout = Duration.millis(
          Math.min(input.timeoutMs ?? 30_000, THREAD_TASK_WATCH_MAX_MS),
        );
        const poll = visibleChanges(caller, afterCursor);
        const hasChanges = (changes: Effect.Success<typeof poll>) =>
          changes.tasks.length > 0 || changes.departures.length > 0;
        const first = yield* poll;
        const changed = hasChanges(first)
          ? first
          : yield* PubSub.take(subscription).pipe(
              Effect.andThen(poll),
              Effect.repeat({ until: hasChanges }),
              Effect.timeoutOption(timeout),
              Effect.map(Option.getOrElse(() => first)),
            );
        const cursor = [...changed.tasks, ...changed.departures].reduce(
          (max, change) => Math.max(max, change.cursor),
          afterCursor,
        );
        return { ...(yield* changeResult(changed, cursor)), timedOut: !hasChanges(changed) };
      }),
    );

  /** A child chat launched as a named agent: a managed worker with or without a task row. */
  const isNamedChild = (shell: OrchestrationV2ThreadShell) =>
    shell.parentThreadId != null &&
    threadParentRelationship(shell) === "child" &&
    shell.profileSnapshot?.profileId != null;

  /**
   * The parent link is canonical: a task's owner is always the worker's parent. A child
   * moved under another chat here takes its task along; otherwise the task goes. Tasks owned
   * on another environment are kept in step by their link instead.
   */
  const followParent = Effect.fn("ThreadTaskService.followParent")(function* (
    workerThreadId: ThreadId,
  ) {
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const task = yield* getTask(workerThreadId);
        if (task === undefined || task.ownerEnvironmentId !== null) return;
        const worker = yield* getShell(workerThreadId);
        if (worker === undefined) return;
        const parent = worker.parentEnvironmentId == null ? worker.parentThreadId : null;
        if (parent === task.ownerThreadId) return;
        if (parent != null && threadParentRelationship(worker) === "child") {
          yield* writeAssignment({
            owner: parent,
            actor: "server",
            worker,
            summary: task.summary,
            taskId: undefined,
            settleWhenAccepted: undefined,
            clientRequestId: undefined,
            existing: task,
          });
          return;
        }
        yield* store.remove(workerThreadId).pipe(Effect.catch(unavailable));
        yield* PubSub.publish(changes, undefined);
      }),
    );
  });

  /**
   * The chat's task, creating it for a named child that has none yet, owned by
   * its parent. A parent on another environment adopts the task on its first
   * delivery. Profile-less chats and top-level chats get no task.
   */
  const ensureTask = Effect.fn("ThreadTaskService.ensureTask")(
    function* (workerThreadId: ThreadId) {
      const existing = yield* getTask(workerThreadId);
      if (existing !== undefined) return existing;
      const worker = yield* getShell(workerThreadId);
      if (worker === undefined || !isNamedChild(worker)) return undefined;
      const adopted = yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const raced = yield* getTask(workerThreadId);
          if (raced !== undefined) return raced;
          const remoteOwner = worker.parentEnvironmentId ?? null;
          if (remoteOwner !== null) {
            yield* store
              .putLink({
                workerThreadId,
                role: "worker",
                peerEnvironmentId: remoteOwner,
                capability: `${yield* randomUuidV4}${yield* randomUuidV4}`,
                deliveredCursor: 0,
                pendingCursor: 0,
                state: "pending",
                lastSyncedAt: null,
                lastError: null,
              })
              .pipe(Effect.catch(unavailable));
          }
          return yield* writeAssignment({
            owner: worker.parentThreadId!,
            ownerEnvironmentId: remoteOwner,
            actor: "server",
            worker,
            summary: worker.title,
            taskId: undefined,
            settleWhenAccepted: undefined,
            clientRequestId: undefined,
            existing: undefined,
          });
        }),
      );
      yield* record(workerThreadId, "transition", adopted.revision, "server:adopted");
      return adopted;
    },
    Effect.orElseSucceed(() => undefined),
  );

  const authorizeMessage: ThreadTaskService["Service"]["authorizeMessage"] = Effect.fn(
    "ThreadTaskService.authorizeMessage",
  )(function* (input) {
    if (input.targetThreadId === input.senderThreadId) return;
    // The role comes from durable facts, never from whether registration
    // worked: a chat with a task, or a named child, is a managed worker. If
    // the sender cannot be read, nothing is sent.
    const unverified = () =>
      fail(
        "scope_denied",
        "This chat's role could not be confirmed, so nothing was sent. Retry shortly, or report through t3_task_update.",
      );
    const senderTask = yield* getTask(input.senderThreadId).pipe(Effect.mapError(unverified));
    if (senderTask === undefined) {
      const sender = yield* getShell(input.senderThreadId).pipe(Effect.mapError(unverified));
      if (sender === undefined) return yield* unverified();
      if (!isNamedChild(sender)) return;
      // A named child launched before tasks existed gets one so it can
      // report; it stays a managed worker even if that fails.
      yield* ensureTask(input.senderThreadId);
    }
    const target =
      input.targetThreadId === null ? undefined : yield* getShell(input.targetThreadId);
    if (target?.parentThreadId === input.senderThreadId && target.parentEnvironmentId == null) {
      return;
    }
    yield* record(
      input.senderThreadId,
      "message_denied",
      undefined,
      input.targetThreadId ?? "another environment",
    );
    return yield* fail(
      "scope_denied",
      "Managed workers do not message other chats. Update your task status with t3_task_update (INPUT for a decision, DONE with evidence); your Captain watches or reads the task and relays requests.",
    );
  });

  /** Settles a requesting chat once it is quiet, or records what still blocks it. */
  const evaluateSettleRequest = Effect.fn("ThreadTaskService.evaluateSettleRequest")(
    function* (threadId: ThreadId) {
      const request = Option.getOrUndefined(yield* store.getSettleRequest(threadId));
      if (request === undefined || request.state !== "pending") return;
      const shell = yield* getShell(threadId);
      const now = yield* nowIso;
      // A message the user wrote after the request means they want the chat active.
      const userSpokeSince =
        shell?.latestUserAuthoredMessageAt != null &&
        DateTime.formatIso(shell.latestUserAuthoredMessageAt) > request.requestedAt;
      if (shell === undefined || userSpokeSince || shell.settledOverride === "settled") {
        yield* store.putSettleRequest({
          ...request,
          state: shell?.settledOverride === "settled" ? "settled" : "cancelled",
          blockedBy: null,
          updatedAt: now,
        });
        return;
      }
      const thread = yield* projections
        .getThread(threadId)
        .pipe(Effect.orElseSucceed(() => undefined));
      const blockedBy: ThreadSettleRequest["blockedBy"] =
        thread?.pinnedAt != null || thread?.autoSettleDisabledAt != null
          ? "held"
          : shell.status === "queued"
            ? "queued_run"
            : hasLiveRun(shell)
              ? "active_run"
              : (yield* openChildTasks(threadId)).length > 0
                ? "open_task"
                : (yield* projections
                      .hasActiveDescendants(threadId)
                      .pipe(Effect.orElseSucceed(() => true))) ||
                    (yield* remoteChildStillWorking(threadId))
                  ? "pending_descendant"
                  : null;
      let settled = false;
      if (blockedBy === null) {
        settled = yield* orchestrator
          .dispatch({
            type: "thread.settle",
            commandId: CommandId.make(
              `server:settle-after-turn:${threadId}:${request.requestedAt}`,
            ),
            threadId,
          })
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logInfo("settle-after-turn kept waiting", {
                threadId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
            ),
          );
      }
      const next: ThreadSettleRequest = settled
        ? { ...request, state: "settled", blockedBy: null, updatedAt: now }
        : { ...request, blockedBy: blockedBy ?? "active_run", updatedAt: now };
      if (next.state !== request.state || next.blockedBy !== request.blockedBy) {
        yield* store.putSettleRequest(next);
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("settle-after-turn evaluation failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
  );

  /**
   * Children on other environments are not in this server's descendant check.
   * An accepted one counts as quiet only once its environment reported it
   * settled, or idle on an up-to-date delivery; a stale mirror keeps blocking.
   */
  const remoteChildStillWorking = Effect.fn("ThreadTaskService.remoteChildStillWorking")(function* (
    ownerThreadId: ThreadId,
  ) {
    const children = yield* store.listByOwner(ownerThreadId).pipe(Effect.catch(unavailable));
    for (const child of children) {
      if (child.workerEnvironmentId === null) continue;
      if (child.settlement.state === "settled") continue;
      const link = Option.getOrUndefined(
        yield* store.getLink(child.workerThreadId).pipe(Effect.catch(unavailable)),
      );
      if (link?.state !== "synced" || link.remoteWorkerRun !== "idle") return true;
    }
    return false;
  });

  const reevaluateSettleRequests = store.listPendingSettleRequests().pipe(
    Effect.flatMap((requests) =>
      Effect.forEach(requests, (request) => evaluateSettleRequest(request.threadId), {
        discard: true,
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("settle-after-turn sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const settleAfterTurn: ThreadTaskService["Service"]["settleAfterTurn"] = Effect.fn(
    "ThreadTaskService.settleAfterTurn",
  )(function* (caller, input) {
    const threadId = input.threadId ?? (caller.kind === "thread" ? caller.threadId : undefined);
    if (threadId === undefined) {
      return yield* fail("thread_not_found", "threadId is required without a calling chat.");
    }
    if (caller.kind === "thread" && caller.threadId !== threadId) {
      return yield* fail(
        "scope_denied",
        "A chat may only ask to settle itself; owners settle workers by accepting their tasks.",
      );
    }
    const shell = yield* requireShell(threadId);
    const existing = Option.getOrUndefined(
      yield* store.getSettleRequest(threadId).pipe(Effect.catch(unavailable)),
    );
    const now = yield* nowIso;
    if (input.cancel === true) {
      if (existing?.state === "pending") {
        yield* store
          .putSettleRequest({ ...existing, state: "cancelled", blockedBy: null, updatedAt: now })
          .pipe(Effect.catch(unavailable));
      }
    } else if (existing?.state !== "pending") {
      yield* store
        .putSettleRequest({
          threadId,
          requestedBy: caller.kind === "user" ? "user" : "self",
          requestedAt: now,
          afterRunId: shell.activeRunId,
          state: "pending",
          blockedBy: null,
          updatedAt: now,
        })
        .pipe(Effect.catch(unavailable));
      yield* evaluateSettleRequest(threadId);
    }
    const current = Option.getOrUndefined(
      yield* store.getSettleRequest(threadId).pipe(Effect.catch(unavailable)),
    );
    if (current === undefined) {
      return yield* fail("task_not_found", `Thread ${threadId} has no settle request.`);
    }
    return current;
  });

  //
  // The worker's environment keeps the authoritative task; the owner's keeps a
  // mirror. Each side stores the task's capability, which only the two servers
  // know, and accepts a peer call only with it. Calls travel through a
  // connected T3 app, whose own session is never treated as the agent.

  const unreachable = (environmentId: EnvironmentId, reason: string) =>
    fail(
      "unreachable",
      `Environment ${environmentId} could not be reached; nothing changed there. ${reason}`,
    );

  /** The modes of the chat behind a call, which the environment it reaches applies there. */
  const callerModes = (caller: ThreadTaskCaller) =>
    caller.kind === "thread"
      ? requireShell(caller.threadId).pipe(
          Effect.map((shell) => ({
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
          })),
        )
      : Effect.undefined;

  const callPeer = (
    environmentId: EnvironmentId,
    request: ThreadTaskRemoteRequest,
    modeCeiling?: McpGatewayRelayEvent["modeCeiling"],
  ) =>
    transport === undefined
      ? Effect.fail(unreachable(environmentId, "No connected T3 app relays to it."))
      : transport
          .call(environmentId, request, modeCeiling)
          .pipe(Effect.mapError((reason) => unreachable(environmentId, reason)));

  const decodeView = Schema.decodeUnknownEffect(ThreadTaskViewSchema);
  const decodeDeliverResult = Schema.decodeUnknownEffect(RemoteDeliverResultSchema);
  const encodeAssign = Schema.encodeEffect(RemoteAssignInputSchema);
  const encodeView = Schema.encodeEffect(ThreadTaskViewSchema);
  const invalidPeerReply = (environmentId: EnvironmentId) => () =>
    unreachable(environmentId, "Its reply was not a task.");

  /** Capabilities are compared in constant time. */
  const sameSecret = (left: string, right: string) => {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index++) {
      difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
  };

  const requireLink = (
    workerThreadId: ThreadId,
    role: ThreadTaskStore.ThreadTaskLink["role"],
    peerEnvironmentId: EnvironmentId,
    capability: string,
  ) =>
    store.getLink(workerThreadId).pipe(
      Effect.catch(unavailable),
      Effect.map(Option.getOrUndefined),
      Effect.filterOrFail(
        (link) =>
          link !== undefined &&
          link.role === role &&
          link.peerEnvironmentId === peerEnvironmentId &&
          sameSecret(link.capability, capability),
        () => fail("scope_denied", "This task is not shared with that environment."),
      ),
    );

  /** Owner side: fold a delivered worker view into the readable mirror. */
  const applyRemoteView = (peerEnvironmentId: EnvironmentId, remote: ThreadTaskView) =>
    writes
      .withPermits(1)(
        Effect.gen(function* () {
          const link = Option.getOrUndefined(
            yield* store.getLink(remote.task.workerThreadId).pipe(Effect.catch(unavailable)),
          );
          if (link === undefined || link.role !== "owner") {
            return yield* fail("scope_denied", "This task is not shared with that environment.");
          }
          if (remote.task.cursor <= link.deliveredCursor) {
            yield* record(remote.task.workerThreadId, "remote_duplicate", remote.task.revision);
            return false;
          }
          yield* put({
            ...remote.task,
            ownerEnvironmentId: null,
            workerEnvironmentId: peerEnvironmentId,
            wake: null,
          });
          const now = yield* nowIso;
          yield* store
            .putLink({
              ...link,
              deliveredCursor: remote.task.cursor,
              state: "synced",
              lastSyncedAt: now,
              lastError: null,
              remoteWorkerRun: remote.workerRun,
              remoteContinuationLive: remote.continuationLive,
            })
            .pipe(Effect.catch(unavailable));
          yield* record(remote.task.workerThreadId, "remote_applied", remote.task.revision);
          return true;
        }),
      )
      .pipe(
        Effect.tap((applied) =>
          // Any delivery can be the last thing the owner's own settle request waits on.
          applied ? evaluateSettleRequest(remote.task.ownerThreadId) : Effect.void,
        ),
      );

  const assignRemoteChild = Effect.fn("ThreadTaskService.assignRemoteChild")(function* (
    caller: ThreadTaskCaller,
    input: ThreadTaskAssignInput,
    workerEnvironmentId: EnvironmentId,
  ) {
    if (caller.kind !== "thread" || transport === undefined) {
      return yield* fail(
        "scope_denied",
        "A task on another environment is assigned by its parent chat's own environment.",
      );
    }
    // A retry (same clientRequestId, or an assignment the worker never
    // acknowledged, for example after a lost reply or a restart) reuses the
    // task and capability; it never starts a second assignment.
    const existingLink = Option.getOrUndefined(
      yield* store.getLink(input.threadId).pipe(Effect.catch(unavailable)),
    );
    const ownLink =
      existingLink?.role === "owner" && existingLink.peerEnvironmentId === workerEnvironmentId
        ? existingLink
        : undefined;
    const mirror = yield* getTask(input.threadId);
    const retry =
      ownLink?.taskId !== undefined &&
      (mirror === undefined ||
        (input.clientRequestId !== undefined && ownLink.assignRequestId === input.clientRequestId));
    if (retry && mirror !== undefined) return yield* view(mirror);
    const capability = ownLink?.capability ?? `${yield* randomUuidV4}${yield* randomUuidV4}`;
    const taskId = retry ? ownLink!.taskId! : (input.taskId ?? `task:${yield* randomUuidV4}`);
    const request = yield* encodeAssign({
      ownerEnvironmentId: transport.localEnvironmentId,
      ownerThreadId: caller.threadId,
      workerThreadId: input.threadId,
      taskId,
      summary: input.summary,
      ...(input.settleWhenAccepted === undefined
        ? {}
        : { settleWhenAccepted: input.settleWhenAccepted }),
      ...(input.projectKey === undefined ? {} : { projectKey: input.projectKey }),
      capability,
    }).pipe(Effect.mapError(() => fail("invalid_transition", "The assignment is not valid.")));
    // Record our side first, so the worker's first delivery is accepted.
    yield* store
      .putLink({
        workerThreadId: input.threadId,
        role: "owner",
        peerEnvironmentId: workerEnvironmentId,
        capability,
        deliveredCursor: ownLink?.deliveredCursor ?? 0,
        pendingCursor: 0,
        state: ownLink?.state ?? "pending",
        lastSyncedAt: ownLink?.lastSyncedAt ?? null,
        lastError: null,
        taskId,
        assignRequestId: input.clientRequestId ?? null,
        ...(ownLink?.remoteWorkerRun === undefined
          ? {}
          : { remoteWorkerRun: ownLink.remoteWorkerRun }),
        ...(ownLink?.remoteContinuationLive === undefined
          ? {}
          : { remoteContinuationLive: ownLink.remoteContinuationLive }),
      })
      .pipe(Effect.catch(unavailable));
    const reply = yield* callPeer(
      workerEnvironmentId,
      { action: "remoteAssign", input: request },
      yield* callerModes(caller),
    );
    const remote = yield* decodeView(reply).pipe(
      Effect.mapError(invalidPeerReply(workerEnvironmentId)),
    );
    yield* applyRemoteView(workerEnvironmentId, remote);
    const applied = yield* getTask(input.threadId);
    return yield* view(applied ?? remote.task);
  });

  /** Owner side: send accept, consent or an owner edit to the worker's environment. */
  const forwardOwnerAction = Effect.fn("ThreadTaskService.forwardOwnerAction")(function* (
    caller: ThreadTaskCaller,
    mirror: ThreadTask,
    input: ThreadTaskUpdateInput,
  ) {
    const peer = mirror.workerEnvironmentId!;
    const link = Option.getOrUndefined(
      yield* store.getLink(mirror.workerThreadId).pipe(Effect.catch(unavailable)),
    );
    if (link === undefined || transport === undefined) {
      return yield* unreachable(peer, "This environment holds no delivery link for the task.");
    }
    const reply = yield* callPeer(
      peer,
      {
        action: "remoteOwnerAction",
        input: {
          ownerEnvironmentId: transport.localEnvironmentId,
          capability: link.capability,
          update: { ...input, threadId: mirror.workerThreadId },
        },
      },
      yield* callerModes(caller),
    );
    const remote = yield* decodeView(reply).pipe(Effect.mapError(invalidPeerReply(peer)));
    yield* record(mirror.workerThreadId, "owner_action", remote.task.revision);
    yield* applyRemoteView(peer, remote);
    const current = yield* getTask(mirror.workerThreadId);
    return yield* view(current ?? remote.task);
  });

  /** Worker side: a parent on another environment assigns this chat's task. */
  const remoteAssign: ThreadTaskService["Service"]["remoteAssign"] = (input) =>
    writes
      .withPermits(1)(
        Effect.gen(function* () {
          const worker = yield* requireShell(input.workerThreadId);
          if (
            worker.parentThreadId !== input.ownerThreadId ||
            worker.parentEnvironmentId !== input.ownerEnvironmentId ||
            threadParentRelationship(worker) !== "child"
          ) {
            return yield* fail(
              "scope_denied",
              "Only the chat this chat is nested under can assign its task.",
            );
          }
          const existing = yield* getTask(worker.id);
          if (
            existing !== undefined &&
            (existing.ownerThreadId !== input.ownerThreadId ||
              existing.ownerEnvironmentId !== input.ownerEnvironmentId)
          ) {
            return yield* fail("scope_denied", "This chat's task belongs to another owner.");
          }
          // The owner retrying an assignment it already made gets that assignment back.
          const currentLink = Option.getOrUndefined(
            yield* store.getLink(worker.id).pipe(Effect.catch(unavailable)),
          );
          if (
            existing !== undefined &&
            existing.taskId === input.taskId &&
            currentLink?.role === "worker" &&
            sameSecret(currentLink.capability, input.capability)
          ) {
            return existing;
          }
          yield* store
            .putLink({
              workerThreadId: worker.id,
              role: "worker",
              peerEnvironmentId: input.ownerEnvironmentId,
              capability: input.capability,
              deliveredCursor: 0,
              pendingCursor: 0,
              state: "pending",
              lastSyncedAt: null,
              lastError: null,
            })
            .pipe(Effect.catch(unavailable));
          const task = yield* writeAssignment({
            owner: input.ownerThreadId,
            ownerEnvironmentId: input.ownerEnvironmentId,
            projectKey: input.projectKey,
            actor: "owner",
            worker,
            summary: input.summary,
            taskId: input.taskId,
            settleWhenAccepted: input.settleWhenAccepted,
            clientRequestId: undefined,
            existing,
          });
          // The owner receives this view as the reply, so it counts as delivered.
          const link = Option.getOrUndefined(
            yield* store.getLink(worker.id).pipe(Effect.catch(unavailable)),
          );
          if (link !== undefined) {
            yield* store
              .putLink({
                ...link,
                deliveredCursor: task.cursor,
                pendingCursor: task.cursor,
                state: "synced",
                lastSyncedAt: yield* nowIso,
              })
              .pipe(Effect.catch(unavailable));
          }
          return task;
        }),
      )
      .pipe(Effect.flatMap(view));

  /** Owner side: the worker's environment delivers a change. */
  const remoteDeliver: ThreadTaskService["Service"]["remoteDeliver"] = Effect.fn(
    "ThreadTaskService.remoteDeliver",
  )(function* (input) {
    // A child adopted on its own environment introduces its task here once:
    // only for a chat on this environment, and never over an existing link.
    const known = Option.getOrUndefined(
      yield* store.getLink(input.view.task.workerThreadId).pipe(Effect.catch(unavailable)),
    );
    if (
      known === undefined &&
      input.view.task.ownerEnvironmentId === transport?.localEnvironmentId &&
      (yield* getTask(input.view.task.workerThreadId)) === undefined &&
      (yield* getShell(input.view.task.ownerThreadId)) !== undefined
    ) {
      yield* store
        .putLink({
          workerThreadId: input.view.task.workerThreadId,
          role: "owner",
          peerEnvironmentId: input.workerEnvironmentId,
          capability: input.capability,
          deliveredCursor: 0,
          pendingCursor: 0,
          state: "pending",
          lastSyncedAt: null,
          lastError: null,
          taskId: input.view.task.taskId,
        })
        .pipe(Effect.catch(unavailable));
      yield* record(
        input.view.task.workerThreadId,
        "transition",
        input.view.task.revision,
        "owner:adopted-remote",
      );
    }
    yield* requireLink(
      input.view.task.workerThreadId,
      "owner",
      input.workerEnvironmentId,
      input.capability,
    );
    return { applied: yield* applyRemoteView(input.workerEnvironmentId, input.view) };
  });

  /** Worker side: the owner's environment accepts, consents, or edits the task. */
  const remoteOwnerAction: ThreadTaskService["Service"]["remoteOwnerAction"] = Effect.fn(
    "ThreadTaskService.remoteOwnerAction",
  )(function* (input) {
    const workerThreadId = input.update.threadId;
    if (workerThreadId === undefined) {
      return yield* fail("thread_not_found", "The worker chat is required.");
    }
    yield* requireLink(workerThreadId, "worker", input.ownerEnvironmentId, input.capability);
    const task = yield* getTask(workerThreadId);
    if (task === undefined) {
      return yield* fail("task_not_found", `Thread ${workerThreadId} has no task.`);
    }
    // The capability proves the owner's environment, which authenticated its own chat.
    return yield* updateLocal({ kind: "thread", threadId: task.ownerThreadId }, input.update);
  });

  /** Worker side: send the owner's environment every change it has not acknowledged. */
  const syncToOwner = Effect.fn("ThreadTaskService.syncToOwner")(
    function* (workerThreadId: ThreadId) {
      const link = Option.getOrUndefined(yield* store.getLink(workerThreadId));
      if (link === undefined || link.role !== "worker") return;
      const task = yield* getTask(workerThreadId);
      if (task === undefined || task.cursor <= link.deliveredCursor) return;
      const current = yield* view(task);
      const encoded = yield* encodeView(current).pipe(Effect.orDie);
      const delivered = yield* callPeer(link.peerEnvironmentId, {
        action: "remoteDeliver",
        input: {
          workerEnvironmentId: transport!.localEnvironmentId,
          capability: link.capability,
          view: encoded,
        },
      }).pipe(
        Effect.flatMap((reply) =>
          decodeDeliverResult(reply).pipe(
            Effect.mapError(invalidPeerReply(link.peerEnvironmentId)),
          ),
        ),
        Effect.result,
      );
      const now = yield* nowIso;
      const latest = Option.getOrUndefined(yield* store.getLink(workerThreadId)) ?? link;
      if (Result.isFailure(delivered)) {
        yield* store.putLink({
          ...latest,
          state: "unreachable",
          lastError: delivered.failure.detail,
        });
        yield* record(
          workerThreadId,
          "remote_sync_failed",
          task.revision,
          delivered.failure.detail,
        );
        return;
      }
      yield* store.putLink({
        ...latest,
        deliveredCursor: Math.max(latest.deliveredCursor, task.cursor),
        state: latest.pendingCursor > task.cursor ? "pending" : "synced",
        lastSyncedAt: now,
        lastError: null,
      });
      yield* record(workerThreadId, "remote_sync_ok", task.revision);
    },
    (effect, workerThreadId) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("thread task delivery failed", {
              workerThreadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );

  const syncs = yield* makeDrainableWorker(syncToOwner);
  const retryPendingDeliveries = store.listPendingLinks().pipe(
    Effect.flatMap((links) =>
      Effect.forEach(links, (link) => syncs.enqueue(link.workerThreadId), { discard: true }),
    ),
    Effect.ignore,
  );

  const decodeSnapshot = Schema.decodeUnknownEffect(ProjectSnapshotSchema);
  const PEER_READ_TIMEOUT = "10 seconds";

  const projectSnapshot: ThreadTaskService["Service"]["projectSnapshot"] = Effect.fn(
    "ThreadTaskService.projectSnapshot",
  )(function* (input) {
    const rows = yield* store
      .listByProjectKey({
        projectKey: input.projectKey,
        limit: THREAD_TASK_PROJECT_LIMIT * 2 + 1,
      })
      .pipe(Effect.catch(unavailable));
    // Only records this environment is the writer for; mirrors are someone else's.
    const own = rows.filter((row) => row.workerEnvironmentId === null);
    return {
      environmentId: transport?.localEnvironmentId ?? EnvironmentIdSchema.make("local"),
      generatedAt: yield* nowIso,
      tasks: yield* Effect.forEach(own.slice(0, THREAD_TASK_PROJECT_LIMIT), view),
      truncated: own.length > THREAD_TASK_PROJECT_LIMIT,
    };
  });

  const board: ThreadTaskService["Service"]["board"] = Effect.fn("ThreadTaskService.board")(
    function* (caller, input) {
      let projectKey = input.projectKey;
      if (caller.kind === "thread") {
        if ((yield* getTask(caller.threadId)) !== undefined) {
          return yield* fail(
            "scope_denied",
            "Managed workers read their own task with t3_task_read; the project board is for Captains.",
          );
        }
        projectKey ??= yield* projectKeyFor((yield* requireShell(caller.threadId)).projectId);
      }
      if (projectKey === undefined) {
        return yield* fail("thread_not_found", "projectKey is required without a calling chat.");
      }
      const key = projectKey;
      const local = yield* projectSnapshot({ projectKey: key });
      const peers = transport?.peers() ?? [];
      const answers = yield* Effect.forEach(
        peers,
        (peer) =>
          callPeer(peer, { action: "projectSnapshot", input: { projectKey: key } }).pipe(
            Effect.flatMap((reply) =>
              decodeSnapshot(reply).pipe(Effect.mapError(invalidPeerReply(peer))),
            ),
            Effect.timeoutOrElse({
              duration: PEER_READ_TIMEOUT,
              orElse: () => Effect.fail(unreachable(peer, "It did not answer in time.")),
            }),
            Effect.result,
            Effect.map((result) => ({ peer, result })),
          ),
        { concurrency: 4 },
      );
      const live = new Map<EnvironmentId, ThreadTaskProjectSnapshot>();
      const coverage: Array<ThreadTaskBoard["coverage"][number]> = [
        {
          environmentId: local.environmentId,
          state: "local",
          tasks: local.tasks.length,
          truncated: local.truncated,
          error: null,
        },
      ];
      for (const { peer, result } of answers) {
        if (Result.isSuccess(result)) {
          live.set(peer, result.success);
          coverage.push({
            environmentId: peer,
            state: "live",
            tasks: result.success.tasks.length,
            truncated: result.success.truncated,
            error: null,
          });
        } else {
          coverage.push({
            environmentId: peer,
            state: "unreachable",
            tasks: 0,
            truncated: false,
            error: result.failure.detail,
          });
        }
      }
      type Entry = ThreadTaskBoard["owners"][number]["tasks"][number] & {
        readonly ownerEnvironmentId: EnvironmentId;
      };
      const entries: Array<Entry> = [];
      for (const snapshot of [local, ...live.values()]) {
        for (const taskView of snapshot.tasks) {
          entries.push({
            workerEnvironmentId: snapshot.environmentId,
            ownerEnvironmentId: taskView.task.ownerEnvironmentId ?? snapshot.environmentId,
            source: "live",
            view: taskView,
          });
        }
      }
      // Children on environments that did not answer are shown from this
      // environment's mirror, marked as such, so the board is never silently partial.
      const mirrors = (yield* store
        .listByProjectKey({ projectKey: key, limit: THREAD_TASK_PROJECT_LIMIT })
        .pipe(Effect.catch(unavailable))).filter(
        (row) => row.workerEnvironmentId !== null && !live.has(row.workerEnvironmentId),
      );
      for (const mirror of mirrors) {
        const peer = mirror.workerEnvironmentId!;
        if (!coverage.some((entry) => entry.environmentId === peer)) {
          coverage.push({
            environmentId: peer,
            state: "unreachable",
            tasks: 0,
            truncated: false,
            error: "No connected T3 app reaches this environment.",
          });
        }
        entries.push({
          workerEnvironmentId: peer,
          ownerEnvironmentId: local.environmentId,
          source: "mirror",
          view: yield* view(mirror),
        });
      }
      const owners = new Map<string, ThreadTaskBoard["owners"][number]>();
      for (const { ownerEnvironmentId, ...entry } of entries) {
        const ownerKey = `${ownerEnvironmentId}:${entry.view.task.ownerThreadId}`;
        const owner = owners.get(ownerKey) ?? {
          ownerEnvironmentId,
          ownerThreadId: entry.view.task.ownerThreadId,
          tasks: [],
        };
        owners.set(ownerKey, { ...owner, tasks: [...owner.tasks, entry] });
      }
      return {
        projectKey: key,
        generatedAt: yield* nowIso,
        coverage,
        owners: [...owners.values()],
      } satisfies ThreadTaskBoard;
    },
  );

  /** An answered question no longer blocks the INPUT its worker reported for it. */
  const onQuestionAnswered = (workerThreadId: ThreadId, requestId: RuntimeRequestId) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const task = yield* getTask(workerThreadId);
        if (task === undefined || task.settlement.state === "settled") return;
        if (task.status !== "INPUT" || task.questionRequestId !== requestId) return;
        yield* put({
          ...task,
          status: "WAITING",
          needs: null,
          questionRequestId: null,
          waitingOn: { kind: "run" },
          revision: task.revision + 1,
          acceptance: null,
          updatedAt: yield* nowIso,
          updatedBy: "server",
        });
      }),
    );

  const reevaluatePendingSettlements = store.listUnfinished().pipe(
    Effect.flatMap((tasks) =>
      Effect.forEach(
        tasks.filter((task) => task.settlement.state === "pending"),
        (task) => evaluateSettlement(task.workerThreadId),
        { discard: true },
      ),
    ),
  );

  // Runs for every committed orchestration event, so it stays untraced; the settlement work it
  // starts has its own spans.
  const handle = Effect.fnUntraced(
    function* (stored: OrchestrationV2StoredEvent) {
      const event = stored.event;
      if (event.type === "thread.metadata-updated") {
        yield* followParent(event.threadId);
      } else if (event.type === "run.updated" && TERMINAL_RUN_STATUSES.has(event.payload.status)) {
        yield* evaluateSettlement(event.threadId);
        yield* reevaluatePendingSettlements;
        yield* reevaluateSettleRequests;
      } else if (
        event.type === "runtime-request.updated" &&
        event.payload.kind === "user_input" &&
        event.payload.status !== "pending"
      ) {
        yield* onQuestionAnswered(event.threadId, event.payload.id);
      }
    },
    (effect, stored) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("thread task reaction failed", {
              threadId: stored.event.threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );

  const worker = yield* makeDrainableWorker(handle);
  const seenSequence = yield* TxRef.make(-1);

  const recover: ThreadTaskService["Service"]["recover"] = Effect.gen(function* () {
    const tasks = yield* store.listVisible({ threadId: null, afterCursor: 0 });
    for (const task of tasks) {
      if (task.wake !== null) yield* put({ ...task, wake: null });
    }
    const links = yield* projections.getThreadParentLinks();
    // Scan every thread, including owners whose child was deleted or reparented.
    yield* Effect.forEach(links, (link) => clearQueuedWakes(link.threadId), { discard: true });
    // Tasks whose worker moved while an older server ran follow its parent now.
    const parentOf = new Map(
      links.map((link) => [
        link.threadId,
        link.parentEnvironmentId === null ? link.parentThreadId : null,
      ]),
    );
    for (const task of tasks) {
      if (
        task.ownerEnvironmentId === null &&
        parentOf.has(task.workerThreadId) &&
        parentOf.get(task.workerThreadId) !== task.ownerThreadId
      ) {
        yield* followParent(task.workerThreadId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("thread task could not follow its parent", {
              workerThreadId: task.workerThreadId,
              error,
            }),
          ),
        );
      }
    }
    // Adopt named children launched before tasks existed for readable task state.
    for (const link of links) {
      if (
        link.parentThreadId !== null &&
        link.parentRelationship !== "subagent" &&
        link.profileId != null
      ) {
        yield* ensureTask(link.threadId);
      }
    }
    yield* reevaluatePendingSettlements;
    yield* reevaluateSettleRequests;
    yield* retryPendingDeliveries;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("thread task recovery failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const start: ThreadTaskService["Service"]["start"] = Effect.fn("ThreadTaskService.start")(
    function* () {
      if (transport !== undefined) {
        yield* forkParked(
          Stream.runForEach(transport.connected, () => retryPendingDeliveries).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("thread task delivery retry stream failed", { cause }),
            ),
          ),
        );
      }
      const after = yield* eventSink.latestSequence().pipe(Effect.orDie);
      yield* TxRef.set(seenSequence, after).pipe(Effect.tx);
      yield* forkParked(
        Stream.runForEach(eventSink.stream({ afterSequence: after }), (stored) =>
          (stored.event.type === "run.updated" ||
          stored.event.type === "runtime-request.updated" ||
          stored.event.type === "thread.metadata-updated"
            ? worker.enqueue(stored)
            : Effect.void
          ).pipe(Effect.andThen(TxRef.set(seenSequence, stored.sequence).pipe(Effect.tx))),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("thread task event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  const drain: ThreadTaskService["Service"]["drain"] = Effect.gen(function* () {
    const target = yield* eventSink.latestSequence().pipe(Effect.orDie);
    yield* TxRef.get(seenSequence).pipe(
      Effect.tap((seen) => (seen < target ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );
    yield* worker.drain;
    yield* syncs.drain;
  });

  return ThreadTaskService.of({
    assign,
    assignLaunchedChild,
    remoteAssign,
    remoteDeliver,
    remoteOwnerAction,
    projectSnapshot,
    board,
    read,
    update,
    watch,
    settleAfterTurn,
    authorizeMessage,
    recover,
    start,
    drain,
  });
});

export const layer = Layer.effect(ThreadTaskService, make).pipe(
  Layer.provide(ThreadTaskStore.layer),
);
