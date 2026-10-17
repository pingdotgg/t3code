import {
  CommandId,
  type EnvironmentId,
  NodeId,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpThreadTimelineItem,
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2Subagent,
  type ProjectId,
  type ProviderInstanceId,
  ProviderDriverKind,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Tool from "effect/ai/Tool";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import {
  resolveInteractionMode,
  resolveRuntimeMode,
  runtimeModeRank,
  taskPrompt,
} from "../mcp/delegatedTaskModes.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../serverActivation.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";

/** How long one follow of a remote task waits on its thread there before checking again. */
const FOLLOW_WAIT_MS = 10 * 60 * 1_000;
/** A linked environment that stops answering is retried, backing off to this. */
const FOLLOW_MAX_BACKOFF = Duration.minutes(5);
const backoff = Schedule.exponential(Duration.seconds(2)).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, FOLLOW_MAX_BACKOFF)),
  ),
);

type ThreadScope = McpInvocationContext.McpThreadInvocationScope;

/**
 * `delegate_task` to a linked environment. The task's child is an ordinary
 * thread there, launched through the link; the parent here records the task
 * like a local one, without a child thread, and a follower completes it when
 * the thread there ends, so the parent wakes as it would for a local child.
 */
export class RemoteDelegation extends Context.Service<
  RemoteDelegation,
  {
    readonly delegate: (
      scope: ThreadScope,
      input: OrchestratorMcpDelegateTaskInput & {
        readonly target: NonNullable<OrchestratorMcpDelegateTaskInput["target"]> & {
          readonly environmentId: EnvironmentId;
        };
      },
    ) => Effect.Effect<{ readonly taskId: NodeId }, OrchestratorMcpFailure>;
    /**
     * Stops the task's thread there, then completes it here as cancelled. A
     * task that already has its result keeps it; its thread there is still
     * stopped, as cancelling a local task stops follow-up work on its child.
     */
    readonly cancel: (
      scope: ThreadScope,
      task: OrchestrationV2Subagent,
      input: {
        readonly reason?: string | undefined;
        readonly clientRequestId?: string | undefined;
      },
    ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
    /**
     * Follows every open remote task until it ends, including after a
     * restart, and a finished one again when a Stop here owes it a stop there.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/peer/RemoteDelegation") {}

/**
 * Refusals that following again cannot change: the link was revoked, expired
 * or forgotten, or the thread or run there is gone. Anything else (the other
 * machine asleep, a dropped route) is worth retrying.
 */
/** The other side refused because the thread there runs above this caller's modes. */
const isModeRefusal = (error: OrchestratorMcpFailure) =>
  error.code === "runtime_mode_escalation_denied" ||
  error.code === "interaction_mode_escalation_denied";

const isFinal = (error: OrchestratorMcpFailure) =>
  error.code === "capability_denied" ||
  error.code === "thread_not_found" ||
  error.code === "run_not_found";

const make = Effect.gen(function* () {
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const links = yield* PeerLinks.PeerLinks;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const crypto = yield* Crypto.Crypto;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  // Followers live as long as this service, so shutting down stops them.
  const followers = yield* Scope.Scope;

  /** The peer's project with this thread's repository, or the one the caller named. */
  const resolveRemoteProject = (
    scope: ThreadScope,
    environmentId: EnvironmentId,
    parentProjectId: ProjectId,
    requested: ProjectId | undefined,
  ) =>
    Effect.gen(function* () {
      if (requested !== undefined) return requested;
      const here = yield* projects.getById(parentProjectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      // The project's own identity is a one-minute cache that reads blank when
      // cold, so resolve it here, as the other side's t3_project_list does.
      const key =
        here === undefined
          ? undefined
          : (yield* repositoryIdentities.resolve(here.workspaceRoot))?.canonicalKey;
      if (key === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Pass target.projectId: this thread's project has no repository to match there.",
        });
      }
      const matches: Array<{ readonly id: ProjectId; readonly title: string }> = [];
      let cursor: number | null = 0;
      while (cursor !== null) {
        const listed: Tool.Success<typeof ProjectToolkit.tools.t3_project_list> =
          yield* forwarding.call(scope, ProjectToolkit.tools.t3_project_list, environmentId, {
            cursor,
            limit: 100,
          });
        matches.push(
          ...listed.projects.filter((project) => project.repositoryIdentity?.canonicalKey === key),
        );
        cursor = listed.nextCursor;
      }
      if (matches.length === 1) return matches[0]!.id;
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          matches.length === 0
            ? `No project there has this repository (${key}). Pass target.projectId; t3_project_list with this environmentId lists them.`
            : `Several projects there have this repository: ${matches.map((project) => `${project.title} (${project.id})`).join(", ")}. Pass target.projectId.`,
      });
    });

  const delegate: RemoteDelegation["Service"]["delegate"] = (scope, input) =>
    Effect.gen(function* () {
      const parent = yield* threads.getThreadRecords(scope.thread.threadId, ["runs"]).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "The calling thread was not found.",
            }),
        ),
      );
      const parentRun = parent.runs
        .filter(ThreadManagement.isActiveRun)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (
        parentRun === undefined ||
        parentRun.rootNodeId === null ||
        parentRun.providerInstanceId !== scope.thread.providerInstanceId
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "Delegated tasks require an active run owned by this MCP provider session.",
        });
      }
      const parentNodeId = parentRun.rootNodeId;
      const { target } = input;
      // A worktree there would branch from a commit this checkout has and the
      // other may not, so a remote task runs in that project's checkout.
      if (input.isolation === "worktree") {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            'A task in a linked environment runs in that project\'s checkout; isolation "worktree" is not supported there. Omit isolation, or use t3_thread_launch with environmentId and a worktree workspaceStrategy.',
        });
      }
      // The provider and model inherit as they do for a task here. Another
      // provider there has no model to inherit, so the caller names one.
      const inherited = parent.thread.modelSelection;
      const instanceId = target.providerInstanceId ?? inherited.instanceId;
      const model =
        target.model ?? (instanceId === inherited.instanceId ? inherited.model : undefined);
      if (model === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Pass target.model from orchestrator_capabilities with this environmentId.",
        });
      }
      const options =
        target.options ??
        (instanceId === inherited.instanceId && model === inherited.model
          ? inherited.options
          : undefined);
      // Explicit modes are checked against this thread. Inherited modes are
      // resolved below against the link before storing the launch intent.
      const runtimeMode =
        input.runtimeMode === undefined || input.runtimeMode === "inherit"
          ? undefined
          : yield* resolveRuntimeMode(parent.thread.runtimeMode, input.runtimeMode);
      const interactionMode =
        input.interactionMode === undefined || input.interactionMode === "inherit"
          ? undefined
          : yield* resolveInteractionMode(parent.thread.interactionMode, input.interactionMode);
      const projectId = yield* resolveRemoteProject(
        scope,
        target.environmentId,
        parent.thread.projectId,
        target.projectId,
      );
      // One key for the launch there and the record here, so a retry finds both.
      // Both are scoped to the provider session, as every key a caller passes is:
      // the forwarder scopes the launch's, and the record's names it.
      const key = input.clientRequestId ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      const task = taskPrompt(input);
      const link = yield* links.get(target.environmentId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
      );
      if (link === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The destination is no longer linked here.",
        });
      }
      // Keep the original inherited modes across recovery, even if the parent
      // is later raised. Forwarding still checks the current parent's limits.
      const linkRuntimeMode =
        link?.access === "read-only"
          ? "approval-required"
          : (link?.access ?? parent.thread.runtimeMode);
      const inheritedRuntimeMode =
        runtimeModeRank(linkRuntimeMode) < runtimeModeRank(parent.thread.runtimeMode)
          ? linkRuntimeMode
          : parent.thread.runtimeMode;
      const commandId = CommandId.make(
        `command:mcp:${encodeURIComponent(scope.requestNamespace)}:remote-delegate:${encodeURIComponent(key)}`,
      );
      const launch = {
        requestNamespace: scope.requestNamespace,
        clientRequestId: `delegate:${scope.thread.threadId}:${key}`,
        linkIdentity: link.launchIdentity,
        projectId,
        title: input.title ?? parent.thread.title,
        modelSelection: { instanceId, model, ...(options === undefined ? {} : { options }) },
        runtimeMode: runtimeMode ?? inheritedRuntimeMode,
        interactionMode: interactionMode ?? parent.thread.interactionMode,
        delegatedFrom: {
          environmentId: hereId,
          threadId: parent.thread.id,
          title: parent.thread.title,
        },
      };
      const remoteChild: OrchestrationV2RemoteTaskChild = {
        environmentId: target.environmentId,
        label: link?.label ?? target.environmentId,
        launch,
      };
      const recorded = yield* threads
        .dispatch({
          type: "delegated_task.remote.request",
          commandId,
          parentThreadId: scope.thread.threadId,
          parentRunId: parentRun.id,
          parentNodeId,
          task,
          ...(input.title === undefined ? {} : { title: input.title }),
          // The driver runs there; this side only labels the task with it.
          driver: ProviderDriverKind.make("remote"),
          modelSelection: launch.modelSelection,
          remoteChild,
          completionWake: input.mode === "wait" ? "settled_only" : "always",
        })
        .pipe(
          // The cause goes to the log; the caller learns only that recording failed.
          Effect.tapError((cause) =>
            Effect.logWarning("remote-delegation.record-failed", {
              parentThreadId: scope.thread.threadId,
              cause,
            }),
          ),
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "Unable to record the delegated task.",
              }),
          ),
        );
      const taskEvent = recorded.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      );
      const taskId =
        taskEvent?.event.type === "subagent.updated"
          ? taskEvent.event.payload.id
          : // A replayed request recorded the task the first time.
            yield* threads.getThreadRecords(scope.thread.threadId, ["subagents"]).pipe(
              Effect.map(
                ({ subagents }) =>
                  subagents.find(
                    (task) =>
                      task.remoteChild?.launch?.requestNamespace === launch.requestNamespace &&
                      task.remoteChild.launch.clientRequestId === launch.clientRequestId,
                  )?.id,
              ),
              Effect.orElseSucceed(() => undefined),
            );
      if (taskId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The delegated task was not recorded.",
        });
      }
      yield* launchPending(scope.thread.threadId, taskId).pipe(
        Effect.ensuring(followOne(scope.thread.threadId, taskId).pipe(Effect.forkIn(followers))),
      );
      return { taskId };
    });

  /**
   * Completes `task` here with its thread there's final state. Each attempt
   * is its own command, so one that failed never blocks the next. A report
   * refused because the task already has its result (from a cancel, a Stop
   * or an earlier report) is done. `stoppedThere` records that nothing is
   * left to stop there, also on a task that already has its result.
   */
  const complete = (
    parentThreadId: ThreadId,
    taskId: NodeId,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    result: string,
    stoppedThere: "ran-out" | "stopped" | undefined,
    stopCount?: number,
    launchError?: string,
  ) =>
    Effect.gen(function* () {
      const attempt = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      yield* threads
        .dispatch({
          type: "delegated_task.remote.complete",
          commandId: CommandId.make(`command:remote-task-complete:${taskId}:${attempt}`),
          parentThreadId,
          taskId,
          status,
          result,
          ...(stoppedThere === undefined ? {} : { stoppedThere }),
          ...(launchError === undefined ? {} : { launchError }),
          ...(stopCount === undefined ? {} : { stopCount }),
        })
        .pipe(
          Effect.catch((error) =>
            threads
              .getThreadRecords(parentThreadId, ["subagents"])
              .pipe(
                Effect.flatMap(({ subagents }) =>
                  subagents.find((task) => task.id === taskId)?.result != null
                    ? Effect.void
                    : Effect.fail(error),
                ),
              ),
          ),
        );
    });

  /** Replays the stored launch identity; a different follower namespace would launch another child. */
  const launchPending = (parentThreadId: ThreadId, taskId: NodeId) =>
    Effect.gen(function* () {
      let records = yield* threads.getThreadRecords(parentThreadId, ["subagents"]);
      let task = records.subagents.find((candidate) => candidate.id === taskId);
      if (task?.remoteChild === undefined || task.remoteChild.threadId !== undefined) return;
      if (task.result !== null && task.remoteChild.stoppedThere === true) return;
      const launch = task.remoteChild.launch;
      if (launch === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The pending remote task has no launch inputs.",
        });
      }
      if (task.remoteChild.launchStarted !== true) {
        // The parent's dispatch lock orders this against Stop/cancel. Once committed,
        // acceptance is uncertain until the same key returns a destination receipt.
        if (task.result !== null) {
          yield* complete(
            parentThreadId,
            taskId,
            terminalStatus(task.status),
            task.result,
            "stopped",
            task.remoteChild.stopCount,
          );
          return;
        }
        yield* threads
          .dispatch({
            type: "delegated_task.remote.launch",
            commandId: CommandId.make(`command:remote-task-launch:${taskId}`),
            parentThreadId,
            taskId,
          })
          .pipe(
            Effect.catch((error) =>
              threads
                .getThreadRecords(parentThreadId, ["subagents"])
                .pipe(
                  Effect.flatMap(({ subagents }) =>
                    subagents.find((candidate) => candidate.id === taskId)?.result != null
                      ? Effect.void
                      : Effect.fail(error),
                  ),
                ),
            ),
          );
        records = yield* threads.getThreadRecords(parentThreadId, ["subagents"]);
        task = records.subagents.find((candidate) => candidate.id === taskId);
        if (task?.remoteChild?.launchStarted !== true) {
          if (task?.result != null)
            yield* complete(
              parentThreadId,
              taskId,
              terminalStatus(task.status),
              task.result,
              "stopped",
              task.remoteChild?.stopCount,
            );
          return;
        }
      }
      const remote = task.remoteChild;
      if (remote === undefined) return;
      const scope: ThreadScope = {
        ...followScope(
          { threadId: parentThreadId, providerInstanceId: records.thread.providerInstanceId },
          remote,
        ),
        requestNamespace: launch.requestNamespace,
      };
      const launched = yield* forwarding
        .call(
          scope,
          ProjectToolkit.tools.t3_thread_launch,
          remote.environmentId,
          {
            projectId: launch.projectId,
            title: launch.title,
            modelSelection: launch.modelSelection,
            ...(launch.runtimeMode === undefined ? {} : { runtimeMode: launch.runtimeMode }),
            ...(launch.interactionMode === undefined
              ? {}
              : { interactionMode: launch.interactionMode }),
            delegatedFrom: launch.delegatedFrom,
            message: task.prompt,
            clientRequestId: launch.clientRequestId,
          },
          { expectedLinkIdentity: launch.linkIdentity },
        )
        .pipe(
          Effect.catchTags({
            OrchestratorMcpFailure: (error) => {
              if (isFinal(error) || isModeRefusal(error) || error.code === "invalid_request") {
                const message = `${error.message} The remote launch could not be confirmed. If it was already accepted, work may still be running on ${remote.label}.`;
                return complete(
                  parentThreadId,
                  taskId,
                  "failed",
                  message,
                  "stopped",
                  remote.stopCount,
                  message,
                ).pipe(Effect.andThen(Effect.fail(error)));
              }
              return Effect.fail(error);
            },
          }),
        );
      yield* threads.dispatch({
        type: "delegated_task.remote.attach",
        commandId: CommandId.make(`command:remote-task-attach:${taskId}:${launched.threadId}`),
        parentThreadId,
        taskId,
        environmentId: remote.environmentId,
        threadId: launched.threadId,
        runId: launched.runId,
        modelSelection: launched.modelSelection,
      });
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "OrchestratorMcpFailure"
          ? error
          : new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Unable to reconcile the remote task's launch.",
            }),
      ),
    );

  /**
   * How this environment reaches a task's thread there: as the parent
   * thread, under one namespace per parent, so a stop sent again after a
   * restart or a dropped route is recorded there once.
   */
  const followScope = (
    parent: { readonly threadId: ThreadId; readonly providerInstanceId: ProviderInstanceId },
    remote: OrchestrationV2RemoteTaskChild,
  ): ThreadScope => ({
    environmentId: hereId,
    requestNamespace: `remote-task:${parent.threadId}`,
    thread: {
      threadId: parent.threadId,
      providerSessionId: `remote-task:${remote.threadId}`,
      providerInstanceId: parent.providerInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });

  /**
   * Stops the task's thread there as its Stop button does: its running turn,
   * its queued messages, its pull request watches and the tasks it delegated.
   * The thread there is the task's own, so whatever runs on it is stopped.
   * `key` names the stop: the follower sends one, each cancel its own, and
   * each is recorded there once however often it is sent.
   */
  const stopThere = (
    scope: ThreadScope,
    remote: OrchestrationV2RemoteTaskChild & { readonly threadId: ThreadId },
    key: string,
    reason?: string,
  ) =>
    forwarding
      .interruptThread(scope, remote.environmentId, {
        threadId: remote.threadId,
        stop: true,
        ...(reason === undefined ? {} : { reason }),
        clientRequestId: `${key}:${remote.threadId}`,
      })
      .pipe(Effect.asVoid);

  /**
   * The last reply `runId` gave on the task's thread there, which is its
   * result, read whole however long it is. A failed run prefers its error
   * from the activity view over an earlier reply, without taking another run's.
   */
  const lastReply = (
    scope: ThreadScope,
    remote: OrchestrationV2RemoteTaskChild & { readonly threadId: ThreadId },
    runId: RunId | null,
    failed = false,
  ) =>
    Effect.gen(function* () {
      let reply: OrchestratorMcpThreadTimelineItem | undefined;
      let error: OrchestratorMcpThreadTimelineItem | undefined;
      let afterPosition: number | undefined;
      while (true) {
        const read = yield* forwarding.readThread(scope, remote.environmentId, {
          threadId: remote.threadId,
          view: failed ? "activity" : "messages",
          limit: 100,
          ...(afterPosition === undefined ? {} : { afterPosition }),
        });
        reply =
          read.items.findLast(
            (item) => item.type === "assistant_message" && (runId === null || item.runId === runId),
          ) ?? reply;
        if (failed) {
          error =
            read.items.findLast(
              (item) => item.type === "error" && (runId === null || item.runId === runId),
            ) ?? error;
        }
        if (!read.hasMore || read.nextPosition === null) break;
        afterPosition = read.nextPosition;
      }
      reply = error ?? reply;
      if (reply === undefined) return undefined;
      let text = reply.text ?? "";
      let textOffset = reply.textTruncated ? (reply.nextTextOffset ?? null) : null;
      while (textOffset !== null) {
        const rest = yield* forwarding.readThread(scope, remote.environmentId, {
          threadId: remote.threadId,
          itemId: reply.itemId,
          textOffset,
          maxCharsPerItem: 50_000,
        });
        const part = rest.items[0];
        if (part === undefined) break;
        text += part.text ?? "";
        textOffset = part.textTruncated ? (part.nextTextOffset ?? null) : null;
      }
      return text;
    });

  /**
   * Why following a task can never succeed, if that is what `error` means.
   * The far side's message already says what was refused and what to do; a
   * link forgotten here only reads as a bad request, so it is named.
   */
  const finalReason = (parentThreadId: ThreadId, taskId: NodeId, error: OrchestratorMcpFailure) =>
    Effect.gen(function* () {
      if (isFinal(error)) return error.message;
      if (error.code !== "invalid_request") return undefined;
      const { subagents } = yield* threads.getThreadRecords(parentThreadId, ["subagents"]);
      const environmentId = subagents.find((task) => task.id === taskId)?.remoteChild
        ?.environmentId;
      if (environmentId === undefined) return error.message;
      const link = yield* links.get(environmentId);
      return Option.isSome(link) ? undefined : error.message;
    }).pipe(Effect.orElseSucceed(() => undefined));

  /** A task's thread there that ended without a reply. */
  const noReply = "(The thread in the linked environment ended without a reply.)";

  /**
   * Waits on the task's thread there until its run ends, then completes the
   * task here, and stops it there if it ended here first. A revoked, expired
   * or forgotten link, or a thread or run gone there, fails the task and
   * leaves nothing to stop; anything else (the other machine asleep, a
   * dropped route) is retried, backing off. Completing is retried the same way.
   */
  const follow = (parentThreadId: ThreadId, taskId: NodeId): Effect.Effect<void> =>
    followOnce(parentThreadId, taskId).pipe(
      // `false` means it is still running there: follow again straight away.
      Effect.repeat({ while: (done) => !done }),
      Effect.catchTags({
        OrchestratorMcpFailure: (error) =>
          Effect.gen(function* () {
            const reason = yield* finalReason(parentThreadId, taskId, error);
            if (reason === undefined) return yield* error;
            // Gone there, or no link to reach it by: nothing left to stop there.
            const { subagents } = yield* threads.getThreadRecords(parentThreadId, ["subagents"]);
            const stopCount = subagents.find((task) => task.id === taskId)?.remoteChild?.stopCount;
            yield* complete(parentThreadId, taskId, "failed", reason, "stopped", stopCount);
          }),
      }),
      Effect.retry(backoff),
      Effect.ignoreCause({ log: true }),
    );

  /**
   * One wait on the task's thread there; true once the task here is done.
   * A task completed here first (cancelled, or its parent stopped) is
   * stopped there, and done once that stop is recorded here.
   */
  const followOnce = (parentThreadId: ThreadId, taskId: NodeId) =>
    Effect.gen(function* () {
      yield* launchPending(parentThreadId, taskId);
      const sequence = yield* threads.getThreadEventSequence(parentThreadId);
      const records = yield* threads.getThreadRecords(parentThreadId, ["subagents"]);
      const task = records.subagents.find((candidate) => candidate.id === taskId);
      if (task?.remoteChild === undefined) return true;
      if (task.remoteChild.threadId === undefined) return task.result !== null;
      const remote = { ...task.remoteChild, threadId: task.remoteChild.threadId };
      const scope = followScope(
        { threadId: parentThreadId, providerInstanceId: records.thread.providerInstanceId },
        remote,
      );
      // Ended here, maybe while this follower backed off from an unreachable
      // machine or before a restart: it still has to be stopped there. So
      // does one its parent here was stopped after, for what followed there.
      if (task.result !== null) {
        if (
          remote.stoppedThere === false ||
          ((task.status === "cancelled" || task.status === "interrupted") &&
            remote.stoppedThere !== true)
        ) {
          const key = remote.stopCount === undefined ? "stop" : `stop-${remote.stopCount}`;
          yield* stopThere(scope, remote, key).pipe(
            // Its thread there now runs above what this side may touch, say
            // because the parent here was lowered since; no retry changes that.
            Effect.catchIf(isModeRefusal, (error) =>
              Effect.logWarning("A linked environment refused to stop a delegated task", {
                taskId,
                reason: error.message,
              }),
            ),
          );
          yield* complete(
            parentThreadId,
            taskId,
            terminalStatus(task.status),
            task.result,
            "stopped",
            remote.stopCount,
          );
          return yield* settled(parentThreadId, taskId);
        }
        return true;
      }
      const endedHere = threads
        .streamStoredEventsFrom({
          threadId: parentThreadId,
          afterSequence: sequence,
          eventType: "subagent.updated",
        })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === taskId &&
              stored.event.payload.result !== null,
          ),
          Stream.runHead,
          Effect.flatMap((ended) =>
            Option.isSome(ended) ? Effect.succeed({ endedHere: true } as const) : Effect.never,
          ),
        );
      const waited = yield* forwarding
        .waitForThread(scope, remote.environmentId, {
          threadId: remote.threadId,
          ...(remote.runId === undefined ? {} : { runId: remote.runId }),
          timeoutMs: FOLLOW_WAIT_MS,
          // A thread there whose run ended may still be waiting on its own
          // tasks to wake it for the answer, which a task here waits for too.
          // An older peer ignores this and reports the run alone.
          untilDelegatedWorkSettled: true,
        })
        .pipe(Effect.raceFirst(endedHere));
      // The next look reads the result and stops it there.
      if ("endedHere" in waited) return false;
      if (waited.timedOut) return false;
      // A task recorded without its run waits on the thread's latest; a
      // thread there with none has nothing left to wait for.
      if (waited.runId === null) {
        const reply = yield* lastReply(scope, remote, null);
        yield* complete(
          parentThreadId,
          taskId,
          reply === undefined ? "failed" : "completed",
          reply ?? "The thread in the linked environment has no run to follow.",
          "ran-out",
        );
        return yield* settled(parentThreadId, taskId);
      }
      if (!isTerminal(waited.status)) return false;
      const resultRun = waited.resultRun ?? {
        runId: remote.runId ?? waited.runId,
        status: waited.status,
      };
      const result = yield* lastReply(
        scope,
        remote,
        resultRun.runId,
        resultRun.status === "failed",
      );
      yield* complete(
        parentThreadId,
        taskId,
        terminalStatus(resultRun.status),
        result ?? noReply,
        "ran-out",
      );
      return yield* settled(parentThreadId, taskId);
    });

  /**
   * Whether the task is done here after the follower reported its run ran
   * out there. A cancel or Stop that landed while the reply was read keeps
   * its result, and still owes a stop there for what may follow the run;
   * the next look sends it.
   */
  const settled = (parentThreadId: ThreadId, taskId: NodeId) =>
    threads
      .getThreadRecords(parentThreadId, ["subagents"])
      .pipe(
        Effect.map(
          ({ subagents }) =>
            subagents.find((task) => task.id === taskId)?.remoteChild?.stoppedThere === true,
        ),
      );

  const following = new Map<NodeId, { again: boolean }>();

  /**
   * `follow`, at most once per task. Asked again while it runs, say by a
   * Stop here on a task that already has its result, it looks once more
   * before it ends, so that stop is not missed.
   */
  const followOne = (parentThreadId: ThreadId, taskId: NodeId) =>
    Effect.suspend(() => {
      const running = following.get(taskId);
      if (running !== undefined) {
        running.again = true;
        return Effect.void;
      }
      const state = { again: false };
      following.set(taskId, state);
      return follow(parentThreadId, taskId).pipe(
        // Checked and released in one step, so a request between them is never lost.
        Effect.repeat({
          while: () => {
            if (state.again) {
              state.again = false;
              return true;
            }
            following.delete(taskId);
            return false;
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (following.get(taskId) === state) following.delete(taskId);
          }),
        ),
      );
    });

  const cancel: RemoteDelegation["Service"]["cancel"] = (scope, task, input) =>
    Effect.gen(function* () {
      const remote = task.remoteChild;
      if (remote === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "task_not_found",
          message: `Delegated task ${task.id} is not remote.`,
        });
      }
      const { reason } = input;
      if (remote.threadId === undefined) {
        if (task.result === null) {
          // The snapshot may race a committed launch marker. Reconciliation decides
          // whether nothing was sent or an accepted launch still owes a stop.
          yield* complete(
            task.threadId,
            task.id,
            "cancelled",
            reason ?? "Cancelled.",
            undefined,
          ).pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: `Unable to record the cancellation: ${error.message}`,
                }),
            ),
          );
        }
        yield* follow(task.threadId, task.id).pipe(Effect.forkIn(followers));
        return { taskId: task.id, status: "cancel_requested" } as const;
      }
      const attached = { ...remote, threadId: remote.threadId };
      const there = followScope(scope.thread, attached);
      // A later cancel stops what started there since; a retry of this one, nothing new.
      const key = `cancel:${encodeURIComponent(scope.requestNamespace)}:${
        input.clientRequestId ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie))
      }`;
      if (task.result !== null) {
        // Best effort: the result stands whether or not the stop gets there.
        yield* stopThere(there, attached, key, reason).pipe(
          Effect.andThen(
            complete(
              task.threadId,
              task.id,
              terminalStatus(task.status),
              task.result,
              "stopped",
              remote.stopCount,
            ),
          ),
          Effect.ignoreCause({ log: true }),
        );
        return {
          taskId: task.id,
          status:
            task.status === "completed" || task.status === "failed" || task.status === "interrupted"
              ? task.status
              : "cancelled",
        } satisfies OrchestratorMcpTaskCancelResult;
      }
      // A link that is gone or a machine that is down still cancels the task
      // here; its follower keeps trying to stop it there, across restarts.
      const unstopped = yield* stopThere(there, attached, key, reason).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
      const cancelled = reason === undefined ? "Cancelled." : `Cancelled: ${reason}`;
      yield* complete(
        task.threadId,
        task.id,
        "cancelled",
        unstopped === undefined
          ? cancelled
          : `${cancelled} It could not be stopped in ${remote.label} and may still run there: ${unstopped}`,
        unstopped === undefined ? "stopped" : undefined,
        remote.stopCount,
      ).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("remote-delegation.cancel-record-failed", { taskId: task.id, cause }),
        ),
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Unable to record the cancellation.",
            }),
        ),
      );
      return {
        taskId: task.id,
        status: "cancel_requested",
      } satisfies OrchestratorMcpTaskCancelResult;
    });

  const start: RemoteDelegation["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        // A finished task's follower has ended, so a Stop here that owes its
        // thread there a stop starts it again. Started before the scan below;
        // a Stop that slips between the two stays owed for the next start.
        yield* Stream.runForEach(threads.streamDomainEvents, (event) =>
          event.type === "subagent.updated" && event.payload.remoteChild?.stoppedThere === false
            ? followOne(event.threadId, event.payload.id).pipe(Effect.forkIn(followers))
            : Effect.void,
        ).pipe(
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(followers, { startImmediately: true }),
        );
        const open = yield* projections.getOpenRemoteDelegatedTasks;
        yield* Effect.forEach(
          open,
          ({ parentThreadId, taskId }) => followOne(parentThreadId, taskId),
          {
            concurrency: "unbounded",
            discard: true,
          },
        );
      }).pipe(Effect.ignoreCause({ log: true })),
    );

  return RemoteDelegation.of({ delegate, cancel, start });
});

const isTerminal = (status: string) =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted" ||
  status === "rolled_back";

const terminalStatus = (status: string): "completed" | "failed" | "cancelled" | "interrupted" =>
  status === "completed" || status === "failed" || status === "interrupted" ? status : "cancelled";

export const layer = Layer.effect(RemoteDelegation, make);
