import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type OrchestrationProjectShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { resolveProjectAutoPull } from "@t3tools/shared/serverSettings";
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

export class ServerRuntimeStartupError extends Schema.TaggedErrorClass<ServerRuntimeStartupError>()(
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

export const recordStartupHeartbeat = Effect.gen(function* () {
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
          existingProject.value.defaultModelSelection ?? defaultModelSelection;
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
            runtimeMode: "full-access",
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
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("startup thread auto-bootstrap failed", {
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
  return yield* Effect.succeed(serverConfig.mode === "desktop" ? baseTarget : undefined).pipe(
    Effect.flatMap((target) =>
      target ? Effect.succeed(target) : serverAuth.issueStartupPairingUrl(baseTarget),
    ),
  );
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
const SERVER_UPDATE_CONTINUATION_PROMPT = "Continue where you left off.";

class ProviderSessionContinuationError extends Schema.TaggedErrorClass<ProviderSessionContinuationError>()(
  "ProviderSessionContinuationError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Could not continue thread '${this.threadId}': the provider instance is missing.`;
  }
}

export class ServerUpdateThreadContinuationError extends Schema.TaggedErrorClass<ServerUpdateThreadContinuationError>()(
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
                  [SERVER_UPDATE_CONTINUATION_KEY]: null,
                  continueAfterServerUpdatePrepared: null,
                },
              }),
          }),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  );

export const clearProviderSessionContinuationMarkers = (threadIds: ReadonlyArray<ThreadId>) =>
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
  const continueAfterRestart = yield* settings.getSettings.pipe(
    Effect.map((value) => value.continueThreadsAfterServerUpdate),
    Effect.catch((cause) =>
      Effect.logWarning("could not read restart continuation preference", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

  const liveThreadIds = new Set(
    (yield* providerService.listSessions()).map((session) => session.threadId),
  );
  const { threads } = yield* query.getCommandReadModel();
  // Provider startup can report ready before the continuation is submitted.
  // Find those markers in one read rather than querying every idle thread.
  const preparedThreadIds = new Set(
    (yield* directory.listBindings().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to read prepared provider continuations", { cause }).pipe(
          Effect.andThen(
            Effect.forEach(
              threads.filter(
                (thread) => thread.session?.status === "ready" && !liveThreadIds.has(thread.id),
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
    ))
      .filter(
        (binding) =>
          readServerUpdateContinuationTurnId(binding.runtimePayload) !== null &&
          readRuntimePayload(binding.runtimePayload).activeTurnId === null &&
          readRuntimePayload(binding.runtimePayload).continueAfterServerUpdatePrepared === true,
      )
      .map((binding) => binding.threadId),
  );
  const orphanedThreads = threads.filter(
    (thread) =>
      thread.session !== null &&
      (thread.session.status === "starting" ||
        thread.session.status === "running" ||
        thread.session.activeTurnId !== null ||
        (thread.session.status === "ready" && preparedThreadIds.has(thread.id))) &&
      !liveThreadIds.has(thread.id),
  );

  for (const thread of orphanedThreads) {
    const session = thread.session;
    if (session === null) {
      continue;
    }
    const binding = yield* directory.getBinding(thread.id).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("failed to read orphaned provider session directory binding", {
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
      (readRuntimePayload(binding.value.runtimePayload).activeTurnId == null ||
        readRuntimePayload(binding.value.runtimePayload).activeTurnId === continuationTurnId);
    const preparedWhileReady =
      session.status === "ready" &&
      session.activeTurnId === null &&
      continuationMarked &&
      Option.isSome(binding) &&
      readRuntimePayload(binding.value.runtimePayload).activeTurnId === null &&
      readRuntimePayload(binding.value.runtimePayload).continueAfterServerUpdatePrepared === true;
    // Abrupt shutdowns cannot write an update marker. Require both durable
    // records to agree on an unfinished turn before recovering one implicitly.
    const interruptedByRestart =
      continueAfterRestart &&
      session.status === "running" &&
      session.activeTurnId !== null &&
      Option.isSome(binding) &&
      binding.value.status === "running" &&
      binding.value.resumeCursor != null &&
      readRuntimePayload(binding.value.runtimePayload).activeTurnId === session.activeTurnId;
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
                ...(continuationMarkerPresent || interruptedByRestart
                  ? {
                      [SERVER_UPDATE_CONTINUATION_KEY]: null,
                      continueAfterServerUpdatePrepared: null,
                    }
                  : {}),
              },
            });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning(
                  "failed to reconcile orphaned provider session directory binding",
                  { threadId: thread.id, cause },
                ),
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
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("failed to settle orphaned provider session projection", {
                  threadId: thread.id,
                  cause,
                }),
          ),
        );
      });

    if (
      Option.isSome(binding) &&
      (continuationMarked || interruptedByRestart) &&
      (session.status === "running" || session.status === "starting" || preparedWhileReady) &&
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
            yield* providerService.sendTurn({
              threadId: thread.id,
              ...(capabilities.promptlessTurnContinuation === true
                ? { continuation: true }
                : { input: SERVER_UPDATE_CONTINUATION_PROMPT }),
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

    yield* settleAsError(ORPHANED_PROVIDER_SESSION_ERROR);
  }
}).pipe(
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.logWarning("provider session startup reconciliation failed", { cause }),
  ),
);

interface StartupOptions {
  readonly activate?: Effect.Effect<void>;
  readonly awaitAuxiliaryParked?: Effect.Effect<void>;
  readonly abort?: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
}

export const autoPullProjects = Effect.fn("autoPullProjects")(function* (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  settings: Pick<
    typeof DEFAULT_SERVER_SETTINGS,
    "defaultAutoPull" | "projectAutoPullOverrides"
  > = DEFAULT_SERVER_SETTINGS,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const workspaceRoots = [
    ...new Set(
      projects
        .filter((project) => resolveProjectAutoPull(settings, project.id, project.autoPull))
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
