import {
  CommandId,
  EventId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  type ServerSettings as ServerSettingsValue,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationSession,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WORKTREE_SETUP_ACTIVITY_KIND,
  WorktreeSetupSnapshot,
  worktreeSetupActivityId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ServerConfig from "./config.ts";
import { flushCompileCache } from "./compileCache.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationReactor from "./orchestration/Services/OrchestrationReactor.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ProjectionThreadActivityRepository from "./persistence/Services/ProjectionThreadActivities.ts";
import * as ProjectionTurnRepository from "./persistence/Services/ProjectionTurns.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ProviderSessionReaper from "./provider/Services/ProviderSessionReaper.ts";
import { forkParked } from "./serverActivation.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import {
  formatHeadlessServeOutput,
  formatHostForUrl,
  isWildcardHost,
  issueHeadlessServeAccessInfo,
} from "./startupAccess.ts";

export class ServerRuntimeStartupError extends Schema.TaggedError<ServerRuntimeStartupError>()(
  "ServerRuntimeStartupError",
  {
    mode: ServerConfig.RuntimeMode,
    host: Schema.NullOr(Schema.String),
    port: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Server runtime startup failed before command readiness.";
  }
}

export class ServerRuntimeStartup extends Context.Service<
  ServerRuntimeStartup,
  {
    readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
    readonly markHttpListening: Effect.Effect<void>;
    readonly markRunningProviderSessionsForContinuation: Effect.Effect<
      ReadonlyArray<ThreadId>,
      ServerUpdateThreadContinuationError
    >;
    readonly clearProviderSessionContinuationMarkers: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<void, ServerUpdateThreadContinuationError>;
    readonly enqueueCommand: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
  }
>()("t3/serverRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

interface CommandGate {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

const settleQueuedCommand = <A, E>(deferred: Deferred.Deferred<A, E>, exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? Deferred.succeed(deferred, exit.value)
    : Deferred.failCause(deferred, exit.cause);

export const makeCommandGate = Effect.gen(function* () {
  const commandReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
  const commandQueue = yield* Queue.unbounded<QueuedCommand>();
  const commandReadinessState = yield* Ref.make<CommandReadinessState>("pending");

  const commandWorker = Effect.forever(
    Queue.take(commandQueue).pipe(Effect.flatMap((command) => command.run)),
  );
  yield* Effect.forkScoped(commandWorker);

  return {
    awaitCommandReady: Deferred.await(commandReady),
    signalCommandReady: Effect.gen(function* () {
      yield* Ref.set(commandReadinessState, "ready");
      yield* Deferred.succeed(commandReady, undefined).pipe(Effect.orDie);
    }),
    failCommandReady: (error) =>
      Effect.gen(function* () {
        yield* Ref.set(commandReadinessState, error);
        yield* Deferred.fail(commandReady, error).pipe(Effect.orDie);
      }),
    enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const readinessState = yield* Ref.get(commandReadinessState);
        if (readinessState === "ready") {
          return yield* effect;
        }
        if (readinessState !== "pending") {
          return yield* readinessState;
        }

        const result = yield* Deferred.make<A, E | ServerRuntimeStartupError>();
        yield* Queue.offer(commandQueue, {
          run: Deferred.await(commandReady).pipe(
            Effect.flatMap(() => effect),
            Effect.exit,
            Effect.flatMap((exit) => settleQueuedCommand(result, exit)),
          ),
        });
        return yield* Deferred.await(result);
      }),
  } satisfies CommandGate;
});

const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getCounts().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup projection counts for telemetry", {
        cause,
      }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

const getAutoBootstrapThreadModelSelection = (): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
});

export const resolveWelcomeBase = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const segments = serverConfig.cwd.split(/[/\\]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? "project";

  return {
    cwd: serverConfig.cwd,
    projectName,
  } as const;
});

export const resolveAutoBootstrapWelcomeTargets = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const path = yield* Path.Path;

  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;
  let bootstrapProjectCreated = false;
  let bootstrapThreadCreated = false;

  if (serverConfig.autoBootstrapProjectFromCwd) {
    const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
    const defaultModelSelection =
      settings.defaultModelSelection ?? getAutoBootstrapThreadModelSelection();
    yield* Effect.gen(function* () {
      const existingProject = yield* projectionReadModelQuery.getActiveProjectByWorkspaceRoot(
        serverConfig.cwd,
      );
      let nextProjectId: ProjectId;
      let nextThreadModelSelection: ModelSelection;

      if (Option.isNone(existingProject)) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        nextProjectId = ProjectId.make(yield* randomUUID);
        const bootstrapProjectTitle = path.basename(serverConfig.cwd) || "project";
        nextThreadModelSelection = defaultModelSelection;
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* randomUUID),
          projectId: nextProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: serverConfig.cwd,
          createdAt,
        });
        bootstrapProjectId = nextProjectId;
        bootstrapProjectCreated = true;
      } else {
        nextProjectId = existingProject.value.id;
        bootstrapProjectId = nextProjectId;
        nextThreadModelSelection =
          resolveProjectSettings(settings, nextProjectId, existingProject.value).settings
            .defaultModelSelection ?? defaultModelSelection;
      }

      yield* Effect.gen(function* () {
        const existingThreadId =
          yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);
        if (Option.isNone(existingThreadId)) {
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const createdThreadId = ThreadId.make(yield* randomUUID);
          yield* orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(yield* randomUUID),
            threadId: createdThreadId,
            projectId: nextProjectId,
            title: "New thread",
            modelSelection: nextThreadModelSelection,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: resolveProjectSettings(settings, nextProjectId).settings
              .defaultRuntimeMode,
            branch: null,
            worktreePath: null,
            createdAt,
          });
          bootstrapThreadId = createdThreadId;
          bootstrapThreadCreated = true;
        } else {
          bootstrapThreadId = existingThreadId.value;
        }
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            Effect.logWarning("startup thread auto-bootstrap failed", {
              bootstrapProjectId: nextProjectId,
              cause,
            }),
        ),
      );
    });
  }

  return {
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
    ...(bootstrapProjectId ? { bootstrapProjectCreated } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadCreated } : {}),
  } as const;
});

export const completeAutoBootstrapWelcome = <A extends object, E, R>(
  bootstrap: Effect.Effect<A, E, R>,
) =>
  bootstrap.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("startup auto-bootstrap failed", { cause }).pipe(
              Effect.as({ bootstrapStatus: "complete" as const }),
            ),
      onSuccess: (targets) =>
        Effect.succeed({
          ...targets,
          bootstrapStatus: "complete" as const,
        }),
    }),
  );

const resolveStartupBrowserTarget = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const localUrl = `http://localhost:${serverConfig.port}`;
  const bindUrl =
    serverConfig.host && !isWildcardHost(serverConfig.host)
      ? `http://${formatHostForUrl(serverConfig.host)}:${serverConfig.port}`
      : localUrl;
  const baseTarget = serverConfig.devUrl?.toString() ?? bindUrl;
  return serverConfig.mode === "desktop"
    ? baseTarget
    : yield* serverAuth.issueStartupPairingUrl(baseTarget);
});

const maybeOpenBrowser = (target: string) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    if (serverConfig.noBrowser) {
      return;
    }
    const externalLauncher = yield* ExternalLauncher.ExternalLauncher;

    yield* externalLauncher.launchBrowser(target).pipe(
      Effect.catch(() =>
        Effect.logInfo("browser auto-open unavailable", {
          hint: `Open ${target} in your browser.`,
        }),
      ),
    );
  });

const runStartupPhase = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.annotateSpans({ "startup.phase": phase }),
    Effect.withSpan(`server.startup.${phase}`),
  );

const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";
const SERVER_UPDATE_CONTINUATION_KEY = "continueAfterServerUpdate";
const SERVER_UPDATE_PENDING_MESSAGE_KEY = "continueAfterServerUpdatePendingMessageId";
const SERVER_UPDATE_SOURCE_PLAN_THREAD_KEY = "continueAfterServerUpdateSourcePlanThreadId";
const SERVER_UPDATE_SOURCE_PLAN_ID_KEY = "continueAfterServerUpdateSourcePlanId";
const SERVER_UPDATE_CONTINUATION_PROMPT = "Continue where you left off.";
const UNFINISHED_TASK_ACTIVITY_KINDS = [
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
] as const;
const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "interrupted",
  "stopped",
]);

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function taskIdOf(payload: unknown): string | null {
  const record = payloadRecord(payload);
  const taskId = record?.taskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : null;
}

function taskTitleOf(activity: {
  readonly summary: string;
  readonly payload: unknown;
}): string | null {
  const record = payloadRecord(activity.payload);
  for (const key of ["title", "summary", "detail"] as const) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  const summary = activity.summary.trim();
  return summary.length > 0 ? summary : null;
}

function isTerminalTaskActivity(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): boolean {
  if (activity.kind === "task.completed") return true;
  if (activity.kind !== "task.updated") return false;
  const status = payloadRecord(activity.payload)?.status;
  return typeof status === "string" && TERMINAL_TASK_STATUSES.has(status);
}

function unfinishedTaskLines(
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
  }>,
): Array<string> {
  const open = new Map<string, string>();
  for (const activity of activities) {
    const taskId = taskIdOf(activity.payload);
    if (taskId === null) continue;
    if (isTerminalTaskActivity(activity)) {
      open.delete(taskId);
      continue;
    }
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.updated"
    ) {
      continue;
    }
    const title = taskTitleOf(activity);
    if (title !== null) open.set(taskId, title);
  }
  return [...open.values()].slice(0, 20);
}

function continuationPrompt(tasks: ReadonlyArray<string>): string {
  if (tasks.length === 0) return SERVER_UPDATE_CONTINUATION_PROMPT;
  return `${SERVER_UPDATE_CONTINUATION_PROMPT}\n\nUnfinished tasks:\n${tasks
    .map((task) => `- ${task}`)
    .join("\n")}`;
}

const readUnfinishedTaskTitles = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const activities = yield* Effect.serviceOption(
      ProjectionThreadActivityRepository.ProjectionThreadActivityRepository,
    );
    if (Option.isNone(activities)) return [];
    const rows = yield* activities.value
      .listByThreadId({
        threadId,
        activityKinds: [...UNFINISHED_TASK_ACTIVITY_KINDS],
        limit: 200,
      })
      .pipe(Effect.orElseSucceed(() => []));
    return unfinishedTaskLines(rows);
  });

class ProviderSessionContinuationError extends Schema.TaggedError<ProviderSessionContinuationError>()(
  "ProviderSessionContinuationError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Could not continue thread '${this.threadId}': the provider instance is missing.`;
  }
}

export class ServerUpdateThreadContinuationError extends Schema.TaggedError<ServerUpdateThreadContinuationError>()(
  "ServerUpdateThreadContinuationError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not prepare running threads to continue after the update.";
  }
}

function hasServerUpdateContinuationMarker(
  runtimePayload: unknown,
): runtimePayload is Record<string, unknown> {
  return (
    runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload) &&
    SERVER_UPDATE_CONTINUATION_KEY in runtimePayload
  );
}

function readRuntimePayload(runtimePayload: unknown): Record<string, unknown> {
  return runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload)
    ? (runtimePayload as Record<string, unknown>)
    : {};
}

const isServerUpdateThreadContinuationError = Schema.is(ServerUpdateThreadContinuationError);

function readServerUpdateContinuationTurnId(runtimePayload: unknown): TurnId | null {
  if (!hasServerUpdateContinuationMarker(runtimePayload)) {
    return null;
  }
  const value = runtimePayload[SERVER_UPDATE_CONTINUATION_KEY];
  return typeof value === "string" && value.length > 0 ? TurnId.make(value) : null;
}

function readPendingContinuationMessageId(runtimePayload: unknown): MessageId | null {
  const value = readRuntimePayload(runtimePayload)[SERVER_UPDATE_PENDING_MESSAGE_KEY];
  return typeof value === "string" && value.length > 0 ? MessageId.make(value) : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readCheckpointSourcePlan(
  runtimePayload: unknown,
): { readonly threadId: ThreadId; readonly planId: string } | null {
  const payload = readRuntimePayload(runtimePayload);
  const threadId = readNonEmptyString(payload[SERVER_UPDATE_SOURCE_PLAN_THREAD_KEY]);
  const planId = readNonEmptyString(payload[SERVER_UPDATE_SOURCE_PLAN_ID_KEY]);
  return threadId !== null && planId !== null
    ? { threadId: ThreadId.make(threadId), planId }
    : null;
}

function clearedContinuationPayload(runtimePayload: unknown): Record<string, null> {
  const payload = readRuntimePayload(runtimePayload);
  return {
    [SERVER_UPDATE_CONTINUATION_KEY]: null,
    continueAfterServerUpdatePrepared: null,
    ...(SERVER_UPDATE_PENDING_MESSAGE_KEY in payload
      ? { [SERVER_UPDATE_PENDING_MESSAGE_KEY]: null }
      : {}),
    ...(SERVER_UPDATE_SOURCE_PLAN_THREAD_KEY in payload
      ? { [SERVER_UPDATE_SOURCE_PLAN_THREAD_KEY]: null }
      : {}),
    ...(SERVER_UPDATE_SOURCE_PLAN_ID_KEY in payload
      ? { [SERVER_UPDATE_SOURCE_PLAN_ID_KEY]: null }
      : {}),
  };
}

function checkpointCanResume(status: OrchestrationSession["status"]): boolean {
  return (
    status === "running" ||
    status === "starting" ||
    status === "stopped" ||
    status === "interrupted"
  );
}

const toServerUpdateThreadContinuationError = (cause: unknown) =>
  isServerUpdateThreadContinuationError(cause)
    ? cause
    : new ServerUpdateThreadContinuationError({ cause });

export const markRunningProviderSessionsForContinuation = Effect.gen(function* () {
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const { threads } = yield* query.getCommandReadModel();
  const running = threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.session?.status === "running" &&
      thread.session.activeTurnId !== null,
  );

  const marked: ThreadId[] = [];
  return yield* Effect.gen(function* () {
    for (const thread of running) {
      const activeTurnId = thread.session?.activeTurnId;
      if (activeTurnId === null || activeTurnId === undefined) {
        continue;
      }
      const binding = yield* directory.getBinding(thread.id);
      if (Option.isNone(binding)) {
        continue;
      }
      if (binding.value.resumeCursor === null || binding.value.resumeCursor === undefined) {
        continue;
      }
      yield* directory.upsert({
        ...binding.value,
        runtimePayload: {
          ...readRuntimePayload(binding.value.runtimePayload),
          [SERVER_UPDATE_CONTINUATION_KEY]: activeTurnId,
          continueAfterServerUpdatePrepared: null,
        },
      });
      marked.push(thread.id);
    }

    // A message can be saved before a provider turn exists. Keep its id on the
    // binding: shutdown deletes the pending-turn row when the session stops.
    const turns = yield* Effect.serviceOption(ProjectionTurnRepository.ProjectionTurnRepository);
    if (Option.isSome(turns)) {
      const starting = threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          thread.session?.status === "starting" &&
          thread.session.activeTurnId === null,
      );
      for (const thread of starting) {
        const session = thread.session;
        if (session === null) continue;
        const pending = yield* turns.value
          .getPendingTurnStartByThreadId({ threadId: thread.id })
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(pending)) continue;
        const binding = yield* directory
          .getBinding(thread.id)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(binding)) {
          yield* directory.upsert({
            ...binding.value,
            runtimePayload: {
              ...readRuntimePayload(binding.value.runtimePayload),
              [SERVER_UPDATE_PENDING_MESSAGE_KEY]: pending.value.messageId,
              [SERVER_UPDATE_SOURCE_PLAN_THREAD_KEY]: pending.value.sourceProposedPlanThreadId,
              [SERVER_UPDATE_SOURCE_PLAN_ID_KEY]: pending.value.sourceProposedPlanId,
            },
          });
        } else if (session.providerName !== null && session.providerInstanceId !== undefined) {
          yield* directory.upsert({
            threadId: thread.id,
            provider: ProviderDriverKind.make(session.providerName),
            providerInstanceId: session.providerInstanceId,
            runtimeMode: session.runtimeMode,
            status: "starting",
            runtimePayload: {
              activeTurnId: null,
              [SERVER_UPDATE_PENDING_MESSAGE_KEY]: pending.value.messageId,
              [SERVER_UPDATE_SOURCE_PLAN_THREAD_KEY]: pending.value.sourceProposedPlanThreadId,
              [SERVER_UPDATE_SOURCE_PLAN_ID_KEY]: pending.value.sourceProposedPlanId,
            },
          });
        } else {
          continue;
        }
        marked.push(thread.id);
      }
    }
    return marked;
  }).pipe(
    Effect.catchCause((cause) =>
      clearProviderSessionContinuationMarkers(marked).pipe(Effect.andThen(Effect.failCause(cause))),
    ),
  );
}).pipe(Effect.mapError(toServerUpdateThreadContinuationError));

const clearContinuationMarkers = (
  directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"],
  threadIds: ReadonlyArray<ThreadId>,
) =>
  Effect.forEach(
    threadIds,
    (threadId) =>
      directory.getBinding(threadId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (binding) =>
              directory.upsert({
                ...binding,
                runtimePayload: {
                  ...readRuntimePayload(binding.runtimePayload),
                  ...clearedContinuationPayload(binding.runtimePayload),
                },
              }),
          }),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  );

const clearProviderSessionContinuationMarkers = (threadIds: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    yield* clearContinuationMarkers(directory, threadIds);
  }).pipe(Effect.mapError(toServerUpdateThreadContinuationError));

export const reconcileProviderSessions = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providerService = yield* ProviderService.ProviderService;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settings = yield* ServerSettings.ServerSettingsService;
  const restartSettings = yield* settings.getSettings.pipe(
    Effect.asSome,
    Effect.catch((cause) =>
      Effect.logWarning("could not read restart continuation preference", { cause }).pipe(
        Effect.as(Option.none()),
      ),
    ),
  );
  const continueAfterRestartFor = (projectId: ProjectId) =>
    Option.isSome(restartSettings)
      ? resolveProjectSettings(restartSettings.value, projectId).settings
          .continueThreadsAfterServerUpdate
      : false;

  const liveThreadIds = new Set(
    (yield* providerService.listSessions()).map((session) => session.threadId),
  );
  const { threads } = yield* query.getCommandReadModel();
  // Provider startup can report ready before the continuation is submitted.
  // A clean quit also stops the projection before the next boot, so the
  // checkpoint lives on the binding rather than on a still-running session.
  const persistedBindings = yield* directory.listBindings().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to read prepared provider continuations", { cause }).pipe(
        Effect.andThen(
          Effect.forEach(
            threads.filter(
              (thread) =>
                !liveThreadIds.has(thread.id) &&
                (thread.session?.status === "ready" ||
                  thread.session?.status === "starting" ||
                  thread.session?.status === "running" ||
                  thread.session?.status === "stopped" ||
                  thread.session?.status === "interrupted"),
            ),
            (thread) =>
              directory.getBinding(thread.id).pipe(Effect.orElseSucceed(() => Option.none())),
          ),
        ),
        Effect.map((bindings) =>
          bindings.flatMap((binding) => (Option.isSome(binding) ? [binding.value] : [])),
        ),
      ),
    ),
  );
  const preparedThreadIds = new Set(
    persistedBindings
      .filter(
        (binding) =>
          readServerUpdateContinuationTurnId(binding.runtimePayload) !== null &&
          readRuntimePayload(binding.runtimePayload).activeTurnId === null &&
          readRuntimePayload(binding.runtimePayload).continueAfterServerUpdatePrepared === true,
      )
      .map((binding) => binding.threadId),
  );
  const pendingMessageThreadIds = new Set(
    persistedBindings
      .filter((binding) => readPendingContinuationMessageId(binding.runtimePayload) !== null)
      .map((binding) => binding.threadId),
  );
  const continuationCheckpointThreadIds = new Set(
    persistedBindings
      .filter((binding) => readServerUpdateContinuationTurnId(binding.runtimePayload) !== null)
      .map((binding) => binding.threadId),
  );
  const orphanedThreads = threads.filter(
    (thread) =>
      thread.session !== null &&
      (thread.session.status === "starting" ||
        thread.session.status === "running" ||
        thread.session.activeTurnId !== null ||
        (thread.session.status === "ready" && preparedThreadIds.has(thread.id)) ||
        pendingMessageThreadIds.has(thread.id) ||
        ((thread.session.status === "stopped" || thread.session.status === "interrupted") &&
          continuationCheckpointThreadIds.has(thread.id))) &&
      !liveThreadIds.has(thread.id),
  );

  for (const thread of orphanedThreads) {
    const session = thread.session;
    if (session === null) {
      continue;
    }
    const binding = yield* directory.getBinding(thread.id).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.logWarning("failed to read orphaned provider session directory binding", {
            threadId: thread.id,
            cause,
          }).pipe(Effect.as(Option.none())),
      ),
    );
    const continuationMarkerPresent =
      Option.isSome(binding) && hasServerUpdateContinuationMarker(binding.value.runtimePayload);
    const continuationTurnId = Option.isSome(binding)
      ? readServerUpdateContinuationTurnId(binding.value.runtimePayload)
      : null;
    const continuationMarked =
      continuationTurnId !== null &&
      (session.activeTurnId === null || continuationTurnId === session.activeTurnId) &&
      Option.isSome(binding) &&
      (session.activeTurnId !== null ||
        readRuntimePayload(binding.value.runtimePayload).activeTurnId == null ||
        readRuntimePayload(binding.value.runtimePayload).activeTurnId === continuationTurnId);
    const preparedWhileReady =
      session.status === "ready" &&
      session.activeTurnId === null &&
      continuationMarked &&
      Option.isSome(binding) &&
      readRuntimePayload(binding.value.runtimePayload).activeTurnId === null &&
      readRuntimePayload(binding.value.runtimePayload).continueAfterServerUpdatePrepared === true;
    // Runtime events advance the projection's turn, but not the directory's
    // last admitted turn. Use the projection to identify interrupted work.
    const interruptedByRestart =
      continueAfterRestartFor(thread.projectId) &&
      session.status === "running" &&
      session.activeTurnId !== null &&
      Option.isSome(binding) &&
      binding.value.status === "running" &&
      binding.value.resumeCursor != null;
    const settleAsError = (lastError: string) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          if (Option.isSome(binding)) {
            yield* directory.upsert({
              ...binding.value,
              status: "stopped",
              runtimePayload: {
                ...readRuntimePayload(binding.value.runtimePayload),
                activeTurnId: null,
                ...(continuationMarkerPresent ||
                interruptedByRestart ||
                readPendingContinuationMessageId(binding.value.runtimePayload) !== null
                  ? clearedContinuationPayload(binding.value.runtimePayload)
                  : {}),
              },
            });
          }
        }).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Effect.logWarning("failed to reconcile orphaned provider session directory binding", {
                threadId: thread.id,
                cause,
              }),
          ),
        );

        yield* Effect.gen(function* () {
          const reconciledAt = DateTime.formatIso(yield* DateTime.now);
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId: thread.id,
            session: {
              ...session,
              status: "error",
              activeTurnId: null,
              lastError,
              updatedAt: reconciledAt,
            },
            createdAt: reconciledAt,
          });
        }).pipe(
          Effect.retry({ times: 1 }),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Effect.logWarning("failed to settle orphaned provider session projection", {
                threadId: thread.id,
                cause,
              }),
          ),
        );
      });

    if (
      Option.isSome(binding) &&
      (continuationMarked || interruptedByRestart) &&
      (checkpointCanResume(session.status) || preparedWhileReady) &&
      binding.value.resumeCursor != null &&
      thread.archivedAt === null &&
      thread.deletedAt === null
    ) {
      const prepared = yield* Effect.gen(function* () {
        yield* directory.upsert({
          ...binding.value,
          status: "starting",
          runtimePayload: {
            ...readRuntimePayload(binding.value.runtimePayload),
            // Keep recovery durable if this process also exits before sending.
            [SERVER_UPDATE_CONTINUATION_KEY]: session.activeTurnId ?? continuationTurnId,
            continueAfterServerUpdatePrepared: true,
            activeTurnId: null,
          },
        });
        const resumedAt = DateTime.formatIso(yield* DateTime.now);
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          threadId: thread.id,
          session: {
            ...session,
            status: "starting",
            activeTurnId: null,
            lastError: null,
            updatedAt: resumedAt,
          },
          createdAt: resumedAt,
        });
      }).pipe(Effect.retry({ times: 1 }), Effect.exit);
      if (Exit.isFailure(prepared)) {
        if (Cause.hasInterrupts(prepared.cause)) {
          return yield* Effect.failCause(prepared.cause);
        }
        yield* Effect.logWarning("failed to prepare provider session continuation", {
          threadId: thread.id,
          cause: prepared.cause,
        });
        yield* settleAsError(ORPHANED_PROVIDER_SESSION_ERROR);
        continue;
      }

      yield* forkParked(
        Effect.gen(function* () {
          const continuation = Effect.gen(function* () {
            const providerInstanceId = binding.value.providerInstanceId;
            if (providerInstanceId === undefined) {
              return yield* new ProviderSessionContinuationError({
                threadId: thread.id,
              });
            }
            const capabilities = yield* providerService.getCapabilities(providerInstanceId);
            const unfinishedTasks =
              capabilities.promptlessTurnContinuation === true
                ? []
                : yield* readUnfinishedTaskTitles(thread.id);
            yield* providerService.sendTurn({
              threadId: thread.id,
              ...(capabilities.promptlessTurnContinuation === true
                ? { continuation: true }
                : { input: continuationPrompt(unfinishedTasks) }),
              interactionMode: thread.interactionMode,
            });
          });
          const continuationExit = yield* Effect.exit(continuation);
          if (Exit.isSuccess(continuationExit) || Cause.hasInterrupts(continuationExit.cause)) {
            if (Exit.isSuccess(continuationExit)) {
              yield* clearContinuationMarkers(directory, [thread.id]).pipe(
                Effect.uninterruptible,
                Effect.catchCause((cause) =>
                  Effect.logWarning("failed to clear completed provider session continuation", {
                    threadId: thread.id,
                    cause,
                  }),
                ),
              );
            }
            return;
          }
          yield* Effect.logWarning("failed to continue provider session after server restart", {
            threadId: thread.id,
            cause: continuationExit.cause,
          });
          yield* settleAsError(
            "Could not continue this thread after the server restart. Send a new message to continue.",
          ).pipe(Effect.ignoreCause);
        }),
      );
      continue;
    }

    // Shutdown stops the provider before the pending row can be adopted, and a
    // crash can leave that row behind. Send the saved message again instead of
    // marking the thread failed.
    const unsentMessage = yield* Effect.exit(
      Effect.gen(function* () {
        if (thread.archivedAt !== null || thread.deletedAt !== null) return false;
        const checkpointMessageId = Option.isSome(binding)
          ? readPendingContinuationMessageId(binding.value.runtimePayload)
          : null;
        // The current preference wins, including over a checkpoint written
        // while continuation was still on. Turning it off leaves the work stopped.
        if (!continueAfterRestartFor(thread.projectId)) {
          // A stopped thread is already idle. Drop the checkpoint instead of
          // turning the opt-out into a session error.
          if (
            checkpointMessageId !== null &&
            session.activeTurnId === null &&
            (session.status === "stopped" || session.status === "interrupted") &&
            Option.isSome(binding)
          ) {
            yield* directory.upsert({
              ...binding.value,
              runtimePayload: {
                ...readRuntimePayload(binding.value.runtimePayload),
                ...clearedContinuationPayload(binding.value.runtimePayload),
              },
            });
            return true;
          }
          return false;
        }
        if (
          checkpointMessageId === null &&
          session.status !== "starting" &&
          session.status !== "stopped" &&
          session.status !== "interrupted"
        ) {
          return false;
        }
        const turns = yield* Effect.serviceOption(
          ProjectionTurnRepository.ProjectionTurnRepository,
        );
        // Load the pending row even when the message id was checkpointed.
        // A crash leaves the row behind; a clean stop deletes it, so the
        // binding also stores the source plan.
        const durablePending = Option.isSome(turns)
          ? yield* turns.value
              .getPendingTurnStartByThreadId({ threadId: thread.id })
              .pipe(Effect.orElseSucceed(() => Option.none()))
          : Option.none();
        const messageId =
          checkpointMessageId ??
          (Option.isSome(durablePending) ? durablePending.value.messageId : null);
        if (messageId === null) return false;
        const loaded = yield* query
          .getTurnStartMessage({ threadId: thread.id, messageId })
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (
          Option.isNone(loaded) ||
          loaded.value.message.role !== "user" ||
          loaded.value.message.turnId !== null
        ) {
          return false;
        }
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const checkpointPlan = Option.isSome(binding)
          ? readCheckpointSourcePlan(binding.value.runtimePayload)
          : null;
        const sourcePlan =
          checkpointPlan ??
          (Option.isSome(durablePending) &&
          durablePending.value.sourceProposedPlanThreadId !== null &&
          durablePending.value.sourceProposedPlanId !== null
            ? {
                threadId: durablePending.value.sourceProposedPlanThreadId,
                planId: durablePending.value.sourceProposedPlanId,
              }
            : null);
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          threadId: thread.id,
          message: {
            messageId,
            role: "user",
            text: loaded.value.message.text,
            attachments: loaded.value.message.attachments ?? [],
            ...(loaded.value.message.context !== undefined
              ? { context: loaded.value.message.context }
              : {}),
          },
          runtimeMode: session.runtimeMode,
          interactionMode: thread.interactionMode,
          ...(sourcePlan !== null ? { sourceProposedPlan: sourcePlan } : {}),
          createdAt,
        });
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          threadId: thread.id,
          session: {
            ...session,
            status: "starting",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        return true;
      }),
    );
    if (Exit.isFailure(unsentMessage)) {
      if (Cause.hasInterrupts(unsentMessage.cause)) {
        return yield* Effect.failCause(unsentMessage.cause);
      }
      yield* Effect.logWarning("failed to resume an unsent message after server restart", {
        threadId: thread.id,
        cause: unsentMessage.cause,
      });
    } else if (unsentMessage.value) {
      continue;
    }

    yield* settleAsError(ORPHANED_PROVIDER_SESSION_ERROR);
  }
}).pipe(
  Effect.catchCauseIf(
    (cause) => !Cause.hasInterrupts(cause),
    (cause) => Effect.logWarning("provider session startup reconciliation failed", { cause }),
  ),
);

const decodeWorktreeSetupSnapshot = Schema.decodeUnknownOption(WorktreeSetupSnapshot);

/**
 * A worktree bootstrap records its setup snapshot on the thread while it runs
 * and settles it when it finishes. The bootstrap itself lives only in memory,
 * so a process exit mid-setup leaves a `running` record with nobody to finish
 * it. Before the turn started that also strands the persisted user message, so
 * the setup is marked failed and the user is told to send again. After the
 * handoff only an async setup script was still running; its stage is marked
 * failed and the setup settles as done, like any other script failure.
 */
export const reconcileWorktreeSetups = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  // The command read model carries no activity bodies; read the setup
  // records directly, live threads only.
  const recordedSetups = yield* query.listActivitiesByKind(WORKTREE_SETUP_ACTIVITY_KIND);
  const interruptedAt = DateTime.formatIso(yield* DateTime.now);

  for (const recorded of recordedSetups) {
    const snapshot = decodeWorktreeSetupSnapshot(recorded.payload);
    if (Option.isNone(snapshot) || snapshot.value.phase !== "running") continue;
    if (recorded.id !== worktreeSetupActivityId(snapshot.value.threadId)) continue;
    const threadId = snapshot.value.threadId;

    const turnStarted = snapshot.value.stages.some(
      (stage) => stage.id === "agent" && stage.status === "done",
    );
    const interrupted: WorktreeSetupSnapshot = {
      ...snapshot.value,
      phase: turnStarted ? "done" : "failed",
      endedAt: interruptedAt,
      error: turnStarted
        ? null
        : "The server restarted before the worktree setup finished. Send the message again.",
      stages: snapshot.value.stages.map((stage) =>
        stage.status === "running" || stage.status === "pending"
          ? {
              ...stage,
              status: "failed",
              endedAt: interruptedAt,
              detail: "interrupted by a server restart",
            }
          : stage,
      ),
      sequence: snapshot.value.sequence + 1,
    };
    yield* orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId,
        activity: {
          id: EventId.make(worktreeSetupActivityId(threadId)),
          tone: "error",
          kind: WORKTREE_SETUP_ACTIVITY_KIND,
          summary: turnStarted
            ? "Setup script interrupted by a server restart"
            : "Worktree setup interrupted by a server restart",
          payload: interrupted,
          turnId: null,
          createdAt: snapshot.value.startedAt,
        },
        createdAt: interruptedAt,
      })
      .pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            Effect.logWarning("failed to settle interrupted worktree setup", {
              threadId,
              cause,
            }),
        ),
      );
  }
}).pipe(
  Effect.catchCauseIf(
    (cause) => !Cause.hasInterrupts(cause),
    (cause) => Effect.logWarning("worktree setup startup reconciliation failed", { cause }),
  ),
);

interface StartupOptions {
  readonly activate?: Effect.Effect<void>;
  readonly awaitAuxiliaryParked?: Effect.Effect<void>;
  readonly abort?: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
}

export const autoPullProjects = Effect.fn("autoPullProjects")(function* (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  settings: ServerSettingsValue = DEFAULT_SERVER_SETTINGS,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const workspaceRoots = [
    ...new Set(
      projects
        .filter((project) => resolveProjectSettings(settings, project.id).settings.defaultAutoPull)
        .map((project) => project.workspaceRoot),
    ),
  ];

  yield* Effect.forEach(
    workspaceRoots,
    (cwd) =>
      Effect.gen(function* () {
        const status = yield* git.statusDetails(cwd);
        if (
          !status.isRepo ||
          !status.isDefaultBranch ||
          !status.hasUpstream ||
          status.hasWorkingTreeChanges ||
          status.aheadCount > 0
        ) {
          yield* Effect.logDebug("Skipped automatic project pull", {
            cwd,
            reason: !status.isRepo
              ? "not-a-repository"
              : !status.isDefaultBranch
                ? "not-on-default-branch"
                : !status.hasUpstream
                  ? "no-upstream"
                  : status.hasWorkingTreeChanges
                    ? "working-tree-changes"
                    : "local-commits",
          });
          return;
        }

        if (status.behindCount <= 0) return;

        const result = yield* git.pullCurrentBranch(cwd);
        yield* Effect.logDebug("Automatic project pull completed", {
          cwd,
          status: result.status,
          refName: result.refName,
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Automatic project pull failed", {
            cwd,
            cause,
          }),
        ),
      ),
    { concurrency: 4, discard: true },
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = (options?: StartupOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const keybindings = yield* Keybindings.Keybindings;
    const orchestrationReactor = yield* OrchestrationReactor.OrchestrationReactor;
    const providerSessionReaper = yield* ProviderSessionReaper.ProviderSessionReaper;
    const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const providerSessionDirectory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    const crypto = yield* Crypto.Crypto;
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;

    const commandGate = yield* makeCommandGate;
    const httpListening = yield* Deferred.make<void>();
    const reactorScope = yield* Scope.make("sequential");

    const syncAutoPullProjects = projectionSnapshotQuery.getShellSnapshot().pipe(
      Effect.flatMap((snapshot) =>
        serverSettings.getSettings.pipe(
          Effect.flatMap((settings) => autoPullProjects(snapshot.projects, settings)),
        ),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to load projects for automatic pull", { cause }),
      ),
    );

    yield* Effect.addFinalizer(() => Scope.close(reactorScope, Exit.void));

    const startup = Effect.gen(function* () {
      yield* Effect.logDebug("startup phase: starting keybindings runtime");
      yield* runStartupPhase(
        "keybindings.start",
        keybindings.start.pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to start keybindings runtime", {
              path: error.configPath,
              detail: error.detail,
              cause: error.cause,
            }),
          ),
        ),
      );

      yield* Effect.logDebug("startup phase: starting server settings runtime");
      yield* runStartupPhase(
        "settings.start",
        serverSettings.start.pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to start server settings runtime", {
              path: error.settingsPath,
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }),
          ),
        ),
      );

      yield* Effect.logDebug("startup phase: parking orchestration roots at activation");
      yield* runStartupPhase(
        "reactors.start",
        Effect.gen(function* () {
          yield* orchestrationReactor.start().pipe(Scope.provide(reactorScope));
          yield* providerSessionReaper.start().pipe(Scope.provide(reactorScope));
        }),
      );

      yield* runStartupPhase("provider-sessions.reconcile", reconcileProviderSessions);
      yield* runStartupPhase("worktree-setups.reconcile", reconcileWorktreeSetups);

      yield* Effect.logDebug("startup phase: syncing clean projects");
      yield* runStartupPhase("projects.auto-pull", syncAutoPullProjects);

      const welcomeBase = yield* resolveWelcomeBase;
      const environment = yield* serverEnvironment.getDescriptor;
      yield* Effect.logDebug("startup phase: preparing welcome payload");

      if (serverConfig.autoBootstrapProjectFromCwd) {
        yield* forkParked(
          runStartupPhase(
            "welcome.autobootstrap",
            Effect.gen(function* () {
              const bootstrapCompletion = yield* completeAutoBootstrapWelcome(
                resolveAutoBootstrapWelcomeTargets.pipe(
                  Effect.provideService(Crypto.Crypto, crypto),
                ),
              );

              yield* Effect.logDebug(
                "startup phase: publishing completed bootstrap welcome event",
                {
                  environmentId: environment.environmentId,
                  cwd: welcomeBase.cwd,
                  projectName: welcomeBase.projectName,
                  ...bootstrapCompletion,
                },
              );
              yield* lifecycleEvents.publish({
                version: 1,
                type: "welcome",
                payload: {
                  environment,
                  ...welcomeBase,
                  ...bootstrapCompletion,
                },
              });
            }).pipe(Effect.ignoreCause({ log: true })),
          ),
        );
      }

      yield* forkParked(
        Effect.gen(function* () {
          yield* Effect.logDebug("startup phase: recording startup heartbeat");
          yield* recordStartupHeartbeat.pipe(
            Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
            Effect.withSpan("server.startup.heartbeat.record"),
            Effect.ignoreCause({ log: true }),
          );
          if (serverConfig.startupPresentation === "headless") {
            const accessInfo = yield* issueHeadlessServeAccessInfo();
            yield* runStartupPhase(
              "headless.output",
              Console.log(formatHeadlessServeOutput(accessInfo)),
            );
          } else {
            const startupBrowserTarget = yield* resolveStartupBrowserTarget;
            if (serverConfig.mode !== "desktop") {
              yield* Effect.logInfo(
                "Authentication required. Open T3 Code using the pairing URL.",
              ).pipe(Effect.annotateLogs({ pairingUrl: startupBrowserTarget }));
            }
            yield* runStartupPhase("browser.open", maybeOpenBrowser(startupBrowserTarget));
          }
        }),
      );

      yield* Effect.logDebug("startup phase: waiting for http listener");
      yield* runStartupPhase("http.wait", Deferred.await(httpListening));
      yield* runStartupPhase(
        "auxiliary-roots.parked",
        options?.awaitAuxiliaryParked ?? Effect.void,
      );

      // This is the prepared boundary. Every dependency has been acquired and
      // every runtime root has confirmed that it is parked before this request.
      const updateOutcome = yield* launcher.prepareTrial;
      yield* runStartupPhase(
        "welcome.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "welcome",
          payload: {
            environment,
            ...welcomeBase,
            bootstrapStatus: serverConfig.autoBootstrapProjectFromCwd ? "pending" : "complete",
          },
        }),
      );
      yield* options?.activate ?? Effect.void;

      yield* Effect.logDebug("Accepting commands");
      yield* commandGate.signalCommandReady;
      yield* runStartupPhase(
        "ready.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "ready",
          payload: {
            at: DateTime.formatIso(yield* DateTime.now),
            environment,
            ...(updateOutcome === undefined ? {} : { updateOutcome }),
          },
        }),
      );
      yield* Effect.logDebug("startup phase: complete");
      yield* flushCompileCache;
    }).pipe(
      Effect.annotateSpans({
        "server.mode": serverConfig.mode,
        "server.port": serverConfig.port,
        "server.host": serverConfig.host ?? "default",
      }),
      Effect.withSpan("server.startup", { kind: "server", root: true }),
    );

    yield* Effect.forkScoped(
      Effect.exit(startup).pipe(
        Effect.flatMap((startupExit) => {
          if (Exit.isSuccess(startupExit)) return Effect.void;
          const error = new ServerRuntimeStartupError({
            mode: serverConfig.mode,
            host: serverConfig.host ?? null,
            port: serverConfig.port,
            cause: startupExit.cause,
          });
          return Effect.logError("server runtime startup failed", {
            cause: startupExit.cause,
          }).pipe(
            Effect.andThen(commandGate.failCommandReady(error)),
            Effect.andThen(options?.abort?.(error) ?? Effect.void),
          );
        }),
      ),
    );

    return {
      awaitCommandReady: commandGate.awaitCommandReady,
      markHttpListening: Deferred.succeed(httpListening, undefined),
      markRunningProviderSessionsForContinuation: markRunningProviderSessionsForContinuation.pipe(
        Effect.provideService(
          ProjectionSnapshotQuery.ProjectionSnapshotQuery,
          projectionSnapshotQuery,
        ),
        Effect.provideService(
          ProviderSessionDirectory.ProviderSessionDirectory,
          providerSessionDirectory,
        ),
      ),
      clearProviderSessionContinuationMarkers: (threadIds) =>
        clearProviderSessionContinuationMarkers(threadIds).pipe(
          Effect.provideService(
            ProviderSessionDirectory.ProviderSessionDirectory,
            providerSessionDirectory,
          ),
        ),
      enqueueCommand: commandGate.enqueueCommand,
    } satisfies ServerRuntimeStartup["Service"];
  });

export const layerWithOptions = (options?: StartupOptions) =>
  Layer.effect(ServerRuntimeStartup, make(options));

export const layer = layerWithOptions();
