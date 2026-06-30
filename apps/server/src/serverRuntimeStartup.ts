import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
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
import * as Schedule from "effect/Schedule";
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
import * as ProviderSessionReaper from "./provider/Services/ProviderSessionReaper.ts";
import { WorkflowBoardNotificationDispatcher } from "./workflow/Services/WorkflowBoardNotificationDispatcher.ts";
import { WorkflowSourceSyncer } from "./workflow/Services/WorkflowSourceSyncer.ts";
import { WorkflowOutboundDispatcher } from "./workflow/Services/WorkflowOutboundDispatcher.ts";
import { WorkflowGitHubPoller } from "./workflow/Services/WorkflowGitHubPoller.ts";
import { WorkflowRecovery } from "./workflow/Services/WorkflowRecovery.ts";
import { WorkflowTerminalRetentionSweeper } from "./workflow/Services/WorkflowTerminalRetentionSweeper.ts";
import { WorkflowWebhook } from "./workflow/Services/WorkflowWebhook.ts";
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
    stage: Schema.optional(Schema.Literals(["command-readiness", "workflow-recovery"])),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.stage === "workflow-recovery") {
      return "Workflow recovery failed; mutating workflow RPCs are gated until restart.";
    }
    return "Server runtime startup failed before command readiness.";
  }
}

export interface ServerRuntimeStartupShape {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  // Workflow-specific readiness: resolves only after workflow recovery SUCCEEDS,
  // and fails if recovery (or startup) failed. Mutating workflow RPCs await this in
  // addition to command readiness so a failed recovery surfaces as a retryable error
  // rather than mutating a half-recovered projection. Kept separate from command
  // readiness so a workflow-recovery failure does NOT block core orchestration.
  readonly awaitWorkflowReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly markHttpListening: Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

export class ServerRuntimeStartup extends Context.Service<
  ServerRuntimeStartup,
  ServerRuntimeStartupShape
>()("t3/serverRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

interface CommandGate {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly awaitWorkflowReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalWorkflowReady: Effect.Effect<void>;
  readonly failWorkflowReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
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
  const workflowReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
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
    awaitWorkflowReady: Deferred.await(workflowReady),
    signalWorkflowReady: Deferred.succeed(workflowReady, undefined).pipe(Effect.asVoid),
    failWorkflowReady: (error) => Deferred.fail(workflowReady, error).pipe(Effect.asVoid),
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

export const launchStartupHeartbeat = recordStartupHeartbeat.pipe(
  Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
  Effect.withSpan("server.startup.heartbeat.record"),
  Effect.ignoreCause({ log: true }),
  Effect.forkScoped,
  Effect.asVoid,
);

export const getAutoBootstrapDefaultModelSelection = (): ModelSelection => ({
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

  if (serverConfig.autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const existingProject = yield* projectionReadModelQuery.getActiveProjectByWorkspaceRoot(
        serverConfig.cwd,
      );
      let nextProjectId: ProjectId;
      let nextProjectDefaultModelSelection: ModelSelection;

      if (Option.isNone(existingProject)) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        nextProjectId = ProjectId.make(yield* randomUUID);
        const bootstrapProjectTitle = path.basename(serverConfig.cwd) || "project";
        nextProjectDefaultModelSelection = getAutoBootstrapDefaultModelSelection();
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* randomUUID),
          projectId: nextProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: serverConfig.cwd,
          defaultModelSelection: nextProjectDefaultModelSelection,
          createdAt,
        });
      } else {
        nextProjectId = existingProject.value.id;
        nextProjectDefaultModelSelection =
          existingProject.value.defaultModelSelection ?? getAutoBootstrapDefaultModelSelection();
      }

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
          modelSelection: nextProjectDefaultModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = createdThreadId;
      } else {
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = existingThreadId.value;
      }
    });
  }

  return {
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
  } as const;
});

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

export const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const keybindings = yield* Keybindings.Keybindings;
  const orchestrationReactor = yield* OrchestrationReactor.OrchestrationReactor;
  const providerSessionReaper = yield* ProviderSessionReaper.ProviderSessionReaper;
  const workflowTerminalRetentionSweeper = yield* WorkflowTerminalRetentionSweeper;
  const workflowWebhook = yield* WorkflowWebhook;
  const workflowGitHubPoller = yield* WorkflowGitHubPoller;
  const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const workflowRecovery = yield* WorkflowRecovery;
  const workflowBoardNotificationDispatcher = yield* WorkflowBoardNotificationDispatcher;
  const workflowSourceSyncer = yield* WorkflowSourceSyncer;
  const workflowOutboundDispatcher = yield* WorkflowOutboundDispatcher;
  const crypto = yield* Crypto.Crypto;

  const commandGate = yield* makeCommandGate;
  const httpListening = yield* Deferred.make<void>();
  const reactorScope = yield* Scope.make("sequential");

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
        Effect.forkScoped,
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
        Effect.forkScoped,
      ),
    );

    yield* Effect.logDebug("startup phase: starting orchestration reactors");
    yield* runStartupPhase(
      "reactors.start",
      Effect.gen(function* () {
        yield* orchestrationReactor.start().pipe(Scope.provide(reactorScope));
        yield* providerSessionReaper.start().pipe(Scope.provide(reactorScope));
        yield* workflowTerminalRetentionSweeper.start().pipe(Scope.provide(reactorScope));
        // Periodic prune of stale webhook dedup rows (migration 033's
        // workflow_webhook_delivery) so the table cannot grow unbounded.
        yield* workflowWebhook.start().pipe(Scope.provide(reactorScope));
      }),
    );

    yield* Effect.logDebug("startup phase: recovering workflow runtime");
    // Recovery is non-fatal for the rest of startup (the server must still
    // boot), but we capture whether it SUCCEEDED so we can gate the board
    // notification dispatcher on it below.
    const recovered = yield* runStartupPhase(
      "workflow.recover",
      workflowRecovery.recover().pipe(
        Effect.retry(Schedule.exponential("500 millis").pipe(Schedule.both(Schedule.recurs(3)))),
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("workflow recovery failed during startup", {
            cause,
          }).pipe(Effect.as(false)),
        ),
      ),
    );

    // Publish workflow-recovery readiness so the WS gate can fail mutating
    // workflow RPCs with a retryable error when recovery failed, instead of
    // letting them mutate a half-recovered projection. Recovery failure stays
    // non-fatal for the rest of startup (and does NOT block core orchestration).
    if (recovered) {
      yield* commandGate.signalWorkflowReady;
    } else {
      yield* commandGate.failWorkflowReady(
        new ServerRuntimeStartupError({
          mode: serverConfig.mode,
          host: serverConfig.host ?? null,
          port: serverConfig.port,
          stage: "workflow-recovery",
          // cause is omitted: recovery logged its own warning; no Cause to attach here
        }),
      );
    }

    // Start the board notification dispatcher AFTER recovery SUCCEEDS:
    // recovery may write outbox rows / fix projections that the dispatcher then
    // drains, so starting before (or after a failed) recovery risks draining a
    // half-recovered state — wrongly superseding a needed notification or
    // publishing stale content.
    if (recovered) {
      yield* Effect.logDebug("startup phase: starting workflow board notification dispatcher");
      yield* runStartupPhase(
        "workflow.board-notifications.start",
        workflowBoardNotificationDispatcher.start().pipe(Scope.provide(reactorScope)),
      );
    } else {
      yield* Effect.logWarning(
        "skipping board-notification dispatcher start: workflow recovery failed",
      );
    }

    // Start the work-source syncer ONLY after recovery succeeds: the syncer
    // creates/admits tickets from upstream sources, so it must not run against a
    // half-recovered projection. Same recovery gate as the notification
    // dispatcher above.
    if (recovered) {
      yield* Effect.logDebug("startup phase: starting workflow source syncer");
      yield* runStartupPhase(
        "workflow.source-sync.start",
        workflowSourceSyncer.start().pipe(Scope.provide(reactorScope)),
      );
    } else {
      yield* Effect.logWarning("skipping work-source syncer start: workflow recovery failed");
    }

    // Start the outbound-webhook dispatcher ONLY after recovery succeeds: the
    // dispatcher drains durable `workflow_outbound_delivery` rows and POSTs
    // them, so starting before (or after a failed) recovery risks draining a
    // half-recovered state. Same recovery gate as the notification dispatcher
    // and work-source syncer above.
    if (recovered) {
      yield* Effect.logDebug("startup phase: starting workflow outbound dispatcher");
      yield* runStartupPhase(
        "workflow.outbound.start",
        workflowOutboundDispatcher.start().pipe(Scope.provide(reactorScope)),
      );
    } else {
      yield* Effect.logWarning("skipping outbound dispatcher start: workflow recovery failed");
    }

    // Start the GitHub poller ONLY after recovery succeeds: its sweep drains
    // pending `workflow_pr_observation` rows and calls engine.ingestExternalEvent,
    // which moves tickets between lanes and starts/supersedes pipelines. Running
    // it against a half-recovered projection (stranded pipelines not yet resumed,
    // confirmed-running steps not yet settled, board WIP not yet recovered)
    // corrupts lane/pipeline state — the same hazard that gates the dispatcher and
    // syncer above. Previously this started in the pre-recovery `reactors.start`
    // phase, ungated.
    if (recovered) {
      yield* Effect.logDebug("startup phase: starting workflow github poller");
      yield* runStartupPhase(
        "workflow.github-poller.start",
        workflowGitHubPoller.start().pipe(Scope.provide(reactorScope)),
      );
    } else {
      yield* Effect.logWarning("skipping github poller start: workflow recovery failed");
    }

    const welcomeBase = yield* resolveWelcomeBase;
    const environment = yield* serverEnvironment.getDescriptor;
    yield* Effect.logDebug("startup phase: preparing welcome payload");
    yield* Effect.logDebug("startup phase: publishing welcome event", {
      environmentId: environment.environmentId,
      cwd: welcomeBase.cwd,
      projectName: welcomeBase.projectName,
    });
    yield* runStartupPhase(
      "welcome.publish",
      lifecycleEvents.publish({
        version: 1,
        type: "welcome",
        payload: {
          environment,
          ...welcomeBase,
        },
      }),
    );

    if (serverConfig.autoBootstrapProjectFromCwd) {
      yield* Effect.forkScoped(
        runStartupPhase(
          "welcome.autobootstrap",
          Effect.gen(function* () {
            const bootstrapTargets = yield* resolveAutoBootstrapWelcomeTargets.pipe(
              Effect.provideService(Crypto.Crypto, crypto),
            );
            if (!bootstrapTargets.bootstrapProjectId && !bootstrapTargets.bootstrapThreadId) {
              return;
            }

            yield* Effect.logDebug("startup phase: publishing bootstrapped welcome event", {
              environmentId: environment.environmentId,
              cwd: welcomeBase.cwd,
              projectName: welcomeBase.projectName,
              bootstrapProjectId: bootstrapTargets.bootstrapProjectId,
              bootstrapThreadId: bootstrapTargets.bootstrapThreadId,
            });
            yield* lifecycleEvents.publish({
              version: 1,
              type: "welcome",
              payload: {
                environment,
                ...welcomeBase,
                ...bootstrapTargets,
              },
            });
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("startup auto-bootstrap welcome failed", {
                cause,
              }),
            ),
          ),
        ),
      );
    }
  }).pipe(
    Effect.annotateSpans({
      "server.mode": serverConfig.mode,
      "server.port": serverConfig.port,
      "server.host": serverConfig.host ?? "default",
    }),
    Effect.withSpan("server.startup", { kind: "server", root: true }),
  );

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const startupExit = yield* Effect.exit(startup);
      if (Exit.isFailure(startupExit)) {
        const error = new ServerRuntimeStartupError({
          mode: serverConfig.mode,
          host: serverConfig.host ?? null,
          port: serverConfig.port,
          cause: startupExit.cause,
        });
        yield* Effect.logError("server runtime startup failed", { cause: startupExit.cause });
        yield* commandGate.failCommandReady(error);
        // If startup failed before reaching the recovery phase, workflowReady was
        // never settled; fail it too so the workflow gate rejects rather than hangs.
        // (No-op if recovery already signalled/failed it.)
        yield* commandGate.failWorkflowReady(error);
        return;
      }

      yield* Effect.logDebug("Accepting commands");
      yield* commandGate.signalCommandReady;
      yield* Effect.logDebug("startup phase: waiting for http listener");
      yield* runStartupPhase("http.wait", Deferred.await(httpListening));
      yield* Effect.logDebug("startup phase: publishing ready event");
      yield* runStartupPhase(
        "ready.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "ready",
          payload: {
            at: DateTime.formatIso(yield* DateTime.now),
            environment: yield* serverEnvironment.getDescriptor,
          },
        }),
      );

      yield* Effect.logDebug("startup phase: recording startup heartbeat");
      yield* launchStartupHeartbeat;
      if (serverConfig.startupPresentation === "headless") {
        yield* Effect.logDebug("startup phase: headless access info");
        const accessInfo = yield* issueHeadlessServeAccessInfo();
        yield* runStartupPhase(
          "headless.output",
          Console.log(formatHeadlessServeOutput(accessInfo)),
        );
      } else {
        yield* Effect.logDebug("startup phase: browser open check");
        const startupBrowserTarget = yield* resolveStartupBrowserTarget;
        if (serverConfig.mode !== "desktop") {
          yield* Effect.logInfo(
            "Authentication required. Open T3 Code using the pairing URL.",
          ).pipe(Effect.annotateLogs({ pairingUrl: startupBrowserTarget }));
        }
        yield* runStartupPhase("browser.open", maybeOpenBrowser(startupBrowserTarget));
      }
      yield* Effect.logDebug("startup phase: complete");
    }),
  );

  return {
    awaitCommandReady: commandGate.awaitCommandReady,
    awaitWorkflowReady: commandGate.awaitWorkflowReady,
    markHttpListening: Deferred.succeed(httpListening, undefined),
    enqueueCommand: commandGate.enqueueCommand,
  } satisfies ServerRuntimeStartupShape;
});

export const layer = Layer.effect(ServerRuntimeStartup, make);
