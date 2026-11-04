import {
  createRoutedGatewayPort,
  GATEWAY_SCOPE_VALUES,
  type GatewayPortRelay,
  type GatewayScope,
} from "@t3tools/client-runtime/gateway";
import { GatewayError, type GatewayToolContext } from "@t3tools/mcp-gateway";
import { runGatewayTool } from "@t3tools/mcp-gateway/catalog";
import {
  EnvironmentId,
  McpGatewayRelayThread,
  McpGatewayRelayThreadList,
  MessageId,
  ModelSelection,
  OrchestratorMcpFailure,
  type OrchestratorMcpRemoteThreadReadResult,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadWaitInput,
  type OrchestratorMcpThreadWaitResult,
  ProjectId,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DispatchModeLimit } from "../../orchestration-v2/DispatchModeLimit.ts";
import { isTerminalRunStatus } from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTaskService from "../../threadTask/ThreadTaskService.ts";
import { McpGatewayBroker } from "../McpGatewayBroker.ts";
import type { McpInvocationScope } from "../McpInvocationContext.ts";
import { clampWaitTimeoutMs } from "../OrchestratorMcpService.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "../delegatedTaskModes.ts";
import { newCommandId } from "../threadAccess.ts";
import { LocalGatewayPort } from "./LocalGatewayPort.ts";

// Agents in a thread act with every scope on their own machine; other machines apply the
// grants the user set on the T3 app relaying the call.
const LOCAL_GRANTS = [...GATEWAY_SCOPE_VALUES];
const isScope = (scope: string): scope is GatewayScope =>
  (GATEWAY_SCOPE_VALUES as ReadonlyArray<string>).includes(scope);

/**
 * The gateway tool context for this server's agents: this environment in process, every other
 * one through a connected T3 app. Undefined on servers without the in-process port.
 */
export const gatewayToolContext = Effect.gen(function* () {
  const local = Option.getOrUndefined(yield* Effect.serviceOption(LocalGatewayPort));
  if (local === undefined) return undefined;
  const broker = Option.getOrUndefined(yield* Effect.serviceOption(McpGatewayBroker));
  // The tool catalog is promise-based; its relayed calls still run under this server's services.
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const relay: GatewayPortRelay | undefined = broker && {
    invoke: (method, args, environmentIds) =>
      runPromise(broker.forward(method, args, environmentIds)),
  };
  const grants = (): Record<string, ReadonlyArray<GatewayScope>> => {
    const relayed = Object.entries(broker?.grants() ?? {}).map(
      ([environmentId, scopes]) => [environmentId, scopes.filter(isScope)] as const,
    );
    return { ...Object.fromEntries(relayed), [local.environmentId]: LOCAL_GRANTS };
  };
  const context: GatewayToolContext = {
    port: createRoutedGatewayPort(local.environmentId, local.port, () =>
      broker?.available() === true ? relay : undefined,
    ),
    grants,
  };
  return { environmentId: local.environmentId, context, grants };
});

export type Gateway = NonNullable<Effect.Success<typeof gatewayToolContext>>;

/** Another environment that this call acts on, reached through a connected T3 app. */
export interface RemoteEnvironment {
  readonly gateway: Gateway;
  readonly environmentId: EnvironmentId;
  readonly caller: { readonly environmentId: string; readonly threadId: string } | undefined;
}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/**
 * The environment an `environmentId` names, or undefined for this one. An environment no
 * connected app grants is refused here, before anything runs, so a call never falls back to
 * this environment.
 */
export const resolveEnvironment = Effect.fn("remoteThreads.resolveEnvironment")(function* (
  gateway: Gateway | undefined,
  scope: McpInvocationScope,
  environmentId: EnvironmentId | undefined,
): Effect.fn.Return<RemoteEnvironment | undefined, OrchestratorMcpFailure> {
  if (environmentId === undefined || environmentId === scope.environmentId) return undefined;
  if (gateway === undefined || environmentId === gateway.environmentId) {
    return yield* invalid(
      `Environment ${environmentId} is not this environment (${scope.environmentId}), and this server reaches no other. Omit environmentId to act here.`,
    );
  }
  const grants = gateway.grants();
  if (grants[environmentId] === undefined) {
    const environments = yield* Effect.promise(() =>
      gateway.context.port.listEnvironments().catch(() => []),
    );
    const reachable = environments
      .filter((environment) => grants[environment.environmentId] !== undefined)
      .map((environment) =>
        environment.environmentId === scope.environmentId
          ? `${environment.environmentId} (${environment.label}, this environment)`
          : `${environment.environmentId} (${environment.label})`,
      );
    return yield* invalid(
      `Environment ${environmentId} is unknown or not connected to this chat. Reachable environments: ${
        reachable.length === 0 ? `${scope.environmentId} (this environment)` : reachable.join(", ")
      }. To reach another machine, open T3 Code on a device connected to it and grant it T3 Agents access.`,
    );
  }
  return {
    gateway,
    environmentId,
    caller:
      scope.thread === undefined
        ? undefined
        : { environmentId: scope.environmentId, threadId: scope.thread.threadId },
  };
});

const gatewayFailure = (environmentId: EnvironmentId, error: unknown) => {
  const message = `${error instanceof Error ? error.message : String(error)} (environment ${environmentId})`;
  if (!(error instanceof GatewayError))
    return new OrchestratorMcpFailure({ code: "orchestration_error", message });
  switch (error.code) {
    case "unknown_environment":
    case "invalid_input":
      return new OrchestratorMcpFailure({ code: "invalid_request", message });
    case "scope_required":
      return new OrchestratorMcpFailure({ code: "capability_denied", message });
    case "thread_not_found":
      return new OrchestratorMcpFailure({ code: "thread_not_found", message });
    default:
      return new OrchestratorMcpFailure({ code: "orchestration_error", message });
  }
};

/** Runs one gateway tool on the remote environment as the calling chat. */
const callRemote = (remote: RemoteEnvironment, name: string, args: Record<string, unknown>) =>
  Effect.promise(() =>
    runGatewayTool(
      remote.gateway.context,
      name,
      { ...args, environmentId: remote.environmentId },
      { caller: remote.caller },
    ),
  ).pipe(
    Effect.flatMap((run) =>
      run.ok
        ? Effect.succeed(run.value)
        : Effect.fail(gatewayFailure(remote.environmentId, run.error)),
    ),
  );

const decodeRemoteThread = Schema.decodeUnknownEffect(McpGatewayRelayThread);

const getRemoteThread = (remote: RemoteEnvironment, threadId: ThreadId) =>
  callRemote(remote, "t3_get_thread", { threadId }).pipe(
    Effect.flatMap((value) =>
      decodeRemoteThread(value).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: `Environment ${remote.environmentId} returned thread ${threadId} in a shape this server cannot read.`,
            }),
        ),
      ),
    ),
  );

const DEFAULT_READ_LIMIT = 50;
const DEFAULT_RUN_LIMIT = 10;
const DEFAULT_MAX_CHARS = 20_000;

/** Messages only: the relaying app reports a thread's messages, runs and state, not its timeline. */
export const readThread = Effect.fn("remoteThreads.readThread")(function* (
  remote: RemoteEnvironment,
  input: OrchestratorMcpThreadReadInput,
): Effect.fn.Return<OrchestratorMcpRemoteThreadReadResult, OrchestratorMcpFailure> {
  if (input.view === "activity") {
    return yield* invalid(
      `view:"activity" reads only threads on this environment; thread ${input.threadId} is on ${remote.environmentId}. Omit view to read its messages.`,
    );
  }
  const thread = yield* getRemoteThread(remote, input.threadId);
  const maxChars = input.maxCharsPerItem ?? DEFAULT_MAX_CHARS;
  const messages = thread.messages
    .map((message, position) => ({ message, position }))
    .filter(({ message }) => message.role === "user" || message.role === "assistant");
  const item = (
    { message, position }: (typeof messages)[number],
    offset: number,
  ): OrchestratorMcpRemoteThreadReadResult["items"][number] => {
    const end = offset + maxChars;
    const textTruncated = offset > 0 || end < message.text.length;
    return {
      position,
      messageId: message.id,
      runId: message.runId ?? null,
      type: message.role === "user" ? "user_message" : "assistant_message",
      text: message.text.slice(offset, end),
      textTruncated,
      ...(textTruncated ? { nextTextOffset: end < message.text.length ? end : null } : {}),
      updatedAt: message.updatedAt ?? null,
    };
  };
  let items: OrchestratorMcpRemoteThreadReadResult["items"];
  let hasMore: boolean;
  if (input.itemId !== undefined) {
    // Messages stand in for timeline items here, so an itemId names a message.
    const itemId: string = input.itemId;
    const found = messages.find(({ message }) => message.id === itemId);
    if (found === undefined) {
      return yield* invalid(`Thread ${input.threadId} has no message ${input.itemId}.`);
    }
    items = [item(found, input.textOffset ?? 0)];
    hasMore = false;
  } else {
    const afterPosition = input.afterPosition ?? -1;
    const limit = input.limit ?? DEFAULT_READ_LIMIT;
    const after = messages.filter(({ position }) => position > afterPosition);
    items = (input.tail === true ? after.slice(-limit) : after.slice(0, limit)).map((entry) =>
      item(entry, 0),
    );
    hasMore = after.length > limit;
  }
  const latestRun = thread.runs.at(-1);
  return {
    environmentId: remote.environmentId,
    thread: {
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      status: latestRun?.status ?? "idle",
      latestRunId: latestRun?.id ?? null,
      providerInstanceId: thread.modelSelection.instanceId,
      model: thread.modelSelection.model,
      runtimeMode: thread.runtimeMode ?? null,
      interactionMode: thread.interactionMode ?? null,
      parentThreadId: thread.parentThreadId ?? null,
      parentEnvironmentId: thread.parentEnvironmentId ?? null,
      profile:
        thread.profileSnapshot == null
          ? null
          : {
              profileId: thread.profileSnapshot.profileId,
              profileName: thread.profileSnapshot.profileName,
            },
      pendingRequestCount: thread.runtimeRequests?.length ?? 0,
      settled: thread.settledAt != null,
      createdAt: thread.createdAt ?? null,
      updatedAt: thread.updatedAt ?? null,
    },
    recentRuns: thread.runs
      .toReversed()
      .slice(0, input.runLimit ?? DEFAULT_RUN_LIMIT)
      .map((run) => ({
        runId: run.id,
        status: run.status,
        providerInstanceId: run.providerInstanceId,
        requestedAt: run.requestedAt ?? null,
        completedAt: run.completedAt ?? null,
      })),
    items,
    nextPosition: items.at(-1)?.position ?? null,
    hasMore,
  };
});

const FIRST_POLL = Duration.seconds(1);
const MAX_POLL = Duration.seconds(5);
const RELAY_FAILURES_TOLERATED = 3;

const decodeSummaries = Schema.decodeUnknownEffect(McpGatewayRelayThreadList);

/** Whether the environment's thread list still shows this run active: a small read per poll. */
const stillActive = (remote: RemoteEnvironment, threadId: ThreadId, runId: RunId) =>
  Effect.tryPromise(() => remote.gateway.context.port.listThreads(remote.environmentId)).pipe(
    Effect.flatMap(decodeSummaries),
    Effect.map(
      ({ items }) => items.find((summary) => summary.id === threadId)?.activeRunId === runId,
    ),
    Effect.orElseSucceed(() => false),
  );

/**
 * The relaying app answers requests but streams nothing back, so a wait on another environment
 * polls, backing off to every five seconds. Each poll reads the small thread list and fetches
 * the thread itself only once its run is no longer the active one. Without runId, a restart
 * moves the wait to the run that continues the work. A silent environment yields `unreachable`.
 */
export const waitForThread = Effect.fn("remoteThreads.waitForThread")(function* (
  remote: RemoteEnvironment,
  input: OrchestratorMcpThreadWaitInput,
): Effect.fn.Return<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure> {
  const deadline = (yield* Clock.currentTimeMillis) + clampWaitTimeoutMs(input.timeoutMs);
  let runId = input.runId;
  const result = (status: OrchestratorMcpThreadWaitResult["status"], timedOut: boolean) => ({
    environmentId: remote.environmentId,
    threadId: input.threadId,
    runId: runId ?? null,
    status,
    timedOut,
  });
  const unreachable = (
    status: OrchestratorMcpThreadWaitResult["status"],
    failure: OrchestratorMcpFailure,
  ) =>
    failure.code === "orchestration_error"
      ? Effect.succeed({ ...result(status, true), unreachable: failure.message })
      : Effect.fail(failure);
  const first = yield* getRemoteThread(remote, input.threadId).pipe(Effect.result);
  if (first._tag === "Failure") return yield* unreachable("idle", first.failure);
  let thread = first.success;
  runId ??= thread.runs.at(-1)?.id;
  if (runId === undefined) return result("idle", false);
  let delay = FIRST_POLL;
  let failures = 0;
  while (true) {
    const run = thread.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "run_not_found",
        message: `Thread ${input.threadId} on environment ${remote.environmentId} has no run ${runId}.`,
      });
    }
    const newest = thread.runs.at(-1);
    if (
      input.runId === undefined &&
      (run.status === "cancelled" || run.status === "interrupted") &&
      newest !== undefined &&
      newest.id !== run.id &&
      !isTerminalRunStatus(newest.status)
    ) {
      runId = newest.id;
      continue;
    }
    if (isTerminalRunStatus(run.status)) return result(run.status, false);
    const remaining = deadline - (yield* Clock.currentTimeMillis);
    if (remaining <= 0) return result(run.status, true);
    yield* Effect.sleep(Duration.min(delay, Duration.millis(remaining)));
    delay = Duration.min(Duration.times(delay, 2), MAX_POLL);
    if (yield* stillActive(remote, input.threadId, run.id)) continue;
    const next = yield* getRemoteThread(remote, input.threadId).pipe(Effect.result);
    if (next._tag === "Success") {
      thread = next.success;
      failures = 0;
    } else if (++failures >= RELAY_FAILURES_TOLERATED) {
      return yield* unreachable(run.status, next.failure);
    }
  }
});

/** The caller's own retry key, kept apart from every other caller's. */
const idempotencyKeyFor = (scope: McpInvocationScope, clientRequestId: string | undefined) =>
  clientRequestId === undefined
    ? newCommandId()
    : Effect.succeed(`${scope.requestNamespace}:${clientRequestId}`);

export const sendToThread = Effect.fn("remoteThreads.sendToThread")(function* (
  remote: RemoteEnvironment,
  scope: McpInvocationScope,
  input: OrchestratorMcpThreadSendInput,
) {
  if (input.mode === "steer" || input.mode === "restart") {
    return yield* invalid(
      `mode:"${input.mode}" works only on threads on this environment; on ${remote.environmentId} a message starts the thread or queues behind its current turn. Omit mode or use "queue".`,
    );
  }
  const thread = yield* getRemoteThread(remote, input.threadId);
  // Same rule as a local send: a caller cannot drive a thread with broader modes than its own.
  const limit = yield* DispatchModeLimit;
  if (limit !== undefined) {
    if (thread.runtimeMode === undefined || thread.interactionMode === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: `The T3 app relaying ${remote.environmentId} does not report thread ${input.threadId}'s modes, so this send cannot be checked against yours. Update that app, or use t3_send_message.`,
      });
    }
    yield* resolveRuntimeMode(limit.runtimeMode, thread.runtimeMode);
    yield* resolveInteractionMode(limit.interactionMode, thread.interactionMode);
  }
  const tasks = yield* Effect.serviceOption(ThreadTaskService.ThreadTaskService);
  // A managed worker may message only its own children; authorizeMessage cannot see this one.
  const ownChild =
    thread.parentThreadId === scope.thread?.threadId &&
    thread.parentEnvironmentId === scope.environmentId;
  if (scope.thread !== undefined && Option.isSome(tasks) && !ownChild) {
    yield* tasks.value
      .authorizeMessage({ senderThreadId: scope.thread.threadId, targetThreadId: null })
      .pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "capability_denied", message: error.detail }),
        ),
      );
  }
  const sent = yield* callRemote(remote, "t3_send_message", {
    threadId: input.threadId,
    text: input.message,
    idempotencyKey: yield* idempotencyKeyFor(scope, input.clientRequestId),
  });
  return {
    environmentId: remote.environmentId,
    threadId: input.threadId,
    messageId: MessageId.make(String(sent?.messageId ?? "")),
    delivery: "accepted" as const,
  };
});

/**
 * Registers a named child on another environment as a task of its parent, so the parent's
 * t3_task_read lists it, as a local launch does with assignLaunchedChild. The child keeps
 * running if this fails; the returned text says why the task is missing.
 */
export const assignRemoteChild = Effect.fn("remoteThreads.assignRemoteChild")(function* (input: {
  readonly ownerThreadId: ThreadId;
  readonly workerThreadId: ThreadId;
  readonly workerEnvironmentId: EnvironmentId;
  readonly summary: string;
}): Effect.fn.Return<string | undefined> {
  const tasks = yield* Effect.serviceOption(ThreadTaskService.ThreadTaskService);
  if (Option.isNone(tasks)) return undefined;
  return yield* tasks.value
    .assign(
      { kind: "thread", threadId: input.ownerThreadId },
      {
        threadId: input.workerThreadId,
        summary: input.summary.slice(0, 2_000),
        // A retried create returns the same child; this makes its assignment a retry too.
        clientRequestId: `launch:${input.workerThreadId}`,
      },
      input.workerEnvironmentId,
    )
    .pipe(
      Effect.as(undefined),
      Effect.catch((error) =>
        Effect.logWarning("remote child kept no task", {
          workerThreadId: input.workerThreadId,
          workerEnvironmentId: input.workerEnvironmentId,
          detail: error.detail,
        }).pipe(
          Effect.as(
            `The child is running, but it is not registered as your task, so t3_task_read will not list it until it reports: ${error.detail} Assign it with t3_task_assign and its environmentId.`,
          ),
        ),
      ),
    );
});

/** What t3_thread_launch accepts, as far as a launch on another environment needs it. */
export interface RemoteLaunchInput {
  readonly projectId?: ProjectId | undefined;
  readonly scratch?: boolean | undefined;
  readonly title: string;
  readonly profileId?: string | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly workspaceStrategy?:
    | { readonly type: "root"; readonly branch?: string | undefined }
    | { readonly type: "existing_worktree"; readonly worktreePath: string }
    | {
        readonly type: "worktree";
        readonly baseRef: string;
        readonly branch?: string | undefined;
        readonly startFromOrigin?: boolean | undefined;
      }
    | undefined;
  readonly message?: string | undefined;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
  readonly clientRequestId?: string | undefined;
}

/**
 * The relaying app creates a thread from a project, a root or new-worktree checkout and a
 * base ref; anything else a local launch offers is refused rather than dropped.
 */
const remoteWorkspace = (
  remote: RemoteEnvironment,
  strategy: RemoteLaunchInput["workspaceStrategy"],
) => {
  const elsewhere = `On another environment (${remote.environmentId})`;
  switch (strategy?.type) {
    case undefined:
      return Effect.succeed({ workspaceMode: "checkout" });
    case "root":
      return Effect.succeed({
        workspaceMode: "checkout",
        ...(strategy.branch === undefined ? {} : { baseBranch: strategy.branch }),
      });
    case "existing_worktree":
      return Effect.fail(
        invalid(
          `${elsewhere} a launch cannot bind an existing worktree. Use {type:"root"} or {type:"worktree",baseRef}.`,
        ),
      );
    case "worktree":
      return strategy.branch !== undefined || strategy.startFromOrigin === true
        ? Effect.fail(
            invalid(
              `${elsewhere} a new worktree takes only baseRef; its branch is named there and it starts from local commits. Omit branch and startFromOrigin.`,
            ),
          )
        : Effect.succeed({ workspaceMode: "worktree", baseBranch: strategy.baseRef });
  }
};

const remoteModel = Effect.fn("remoteThreads.remoteModel")(function* (
  remote: RemoteEnvironment,
  selection: ModelSelection | undefined,
) {
  if (selection === undefined) return {};
  const options = selection.options ?? [];
  const effort = options.find((option) => option.id === "reasoningEffort");
  const others = options.filter((option) => option.id !== "reasoningEffort");
  if (others.length > 0 || (effort !== undefined && typeof effort.value !== "string")) {
    return yield* invalid(
      `On another environment (${remote.environmentId}) a launch takes a model and reasoningEffort only; drop the options ${others.map((option) => option.id).join(", ")}.`,
    );
  }
  return {
    modelSelection: { instanceId: selection.instanceId, model: selection.model },
    ...(effort === undefined ? {} : { reasoningEffort: effort.value }),
  };
});

/** A t3_thread_launch on another environment: it lands there, or it fails. */
export const launchThread = Effect.fn("remoteThreads.launchThread")(function* (
  remote: RemoteEnvironment,
  scope: McpInvocationScope,
  input: RemoteLaunchInput,
  modes: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
) {
  if (input.scratch === true) {
    return yield* invalid(
      `scratch:true launches only on this environment. To launch on ${remote.environmentId}, pass the projectId of a project there; t3_list_projects with that environmentId lists them.`,
    );
  }
  if (input.projectId === undefined) {
    return yield* invalid(
      `Pass projectId: projects belong to one environment, so a launch on ${remote.environmentId} cannot inherit yours. t3_list_projects with that environmentId lists them.`,
    );
  }
  if (input.profileId !== undefined && input.runtimeMode !== undefined) {
    return yield* invalid(
      `On another environment (${remote.environmentId}) an agent runs with its own permission mode; omit runtimeMode, or launch without profileId.`,
    );
  }
  if ((input.attachments ?? []).length > 0) {
    return yield* invalid(
      `Attachments upload to this environment only; launch on ${remote.environmentId} without them and describe the files in message.`,
    );
  }
  const workspace = yield* remoteWorkspace(remote, input.workspaceStrategy);
  const model = yield* remoteModel(remote, input.modelSelection);
  const args = {
    projectId: input.projectId,
    title: input.title,
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
    ...model,
    // An agent's own modes apply on its environment; a plain thread inherits the caller's.
    runtimeMode: modes.runtimeMode,
    ...(input.interactionMode !== undefined || input.profileId === undefined
      ? { interactionMode: modes.interactionMode }
      : {}),
    ...workspace,
    // The key fixes the remote thread id, so a retry replays the first launch there.
    idempotencyKey: yield* idempotencyKeyFor(
      scope,
      input.clientRequestId === undefined ? undefined : `launch:${input.clientRequestId}`,
    ),
  };
  const created =
    input.message === undefined
      ? yield* callRemote(remote, "t3_create_thread", args)
      : yield* callRemote(remote, "t3_create_and_start_thread", { ...args, text: input.message });
  const threadId = ThreadId.make(String(created?.threadId ?? ""));
  const warnings: Array<string> = [];
  if (created?.partial === true) {
    warnings.push(
      `The thread was created, but its first message was not confirmed: ${String(created.error?.message ?? "unknown error")}. Check it with t3_thread_read and resend with t3_thread_send, both with environmentId.`,
    );
  }
  if (input.profileId !== undefined && remote.caller !== undefined) {
    const taskWarning = yield* assignRemoteChild({
      ownerThreadId: ThreadId.make(remote.caller.threadId),
      workerThreadId: threadId,
      workerEnvironmentId: remote.environmentId,
      summary: input.title,
    });
    if (taskWarning !== undefined) warnings.push(taskWarning);
  }
  const thread = Option.getOrUndefined(
    yield* getRemoteThread(remote, threadId).pipe(
      Effect.tapError((error) =>
        Effect.sync(() =>
          warnings.push(`The thread was created, but reading it back failed: ${error.message}`),
        ),
      ),
      Effect.option,
    ),
  );
  const run = input.message === undefined ? undefined : thread?.runs.at(-1);
  return {
    environmentId: remote.environmentId,
    threadId,
    projectId: thread?.projectId ?? input.projectId,
    modelSelection: thread?.modelSelection ?? null,
    runId: run?.id ?? null,
    status: run?.status ?? null,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
});
