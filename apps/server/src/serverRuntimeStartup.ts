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
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
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
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const { threadCount, projectCount } = yield* Effect.all({
    projects: projects.snapshot,
    threads: threads.getShellSnapshot(),
  }).pipe(
    Effect.map(({ projects: projectSnapshot, threads: shellSnapshot }) => ({
      projectCount: projectSnapshot.projects.length,
      threadCount: shellSnapshot.threads.length + shellSnapshot.archivedThreads.length,
    })),
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather V2 startup counts for telemetry", {
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

interface AutoBootstrapWelcomeTargets {
  readonly bootstrapProjectId?: ProjectId;
  readonly bootstrapThreadId?: ThreadId;
}

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
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const path = yield* Path.Path;

  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;

  if (serverConfig.autoBootstrapProjectFromCwd) {
    const defaultModelSelection = getAutoBootstrapDefaultModelSelection();
    const { project } = yield* projects.bootstrap({
      commandId: CommandId.make(yield* randomUUID),
      projectId: ProjectId.make(yield* randomUUID),
      title: path.basename(serverConfig.cwd) || "project",
      workspaceRoot: serverConfig.cwd,
      defaultModelSelection,
    });
    const shell = yield* threads.getShellSnapshot();
    const existingThread = shell.threads.find(
      (thread) =>
        thread.projectId === project.id && thread.lineage.relationshipToParent !== "subagent",
    );
    if (existingThread === undefined) {
      const launched = yield* threadLaunch.launch({
        commandId: CommandId.make(yield* randomUUID),
        projectId: project.id,
        title: "New thread",
        modelSelection: project.defaultModelSelection ?? defaultModelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        workspaceStrategy: { type: "root" },
        createdBy: "system",
        creationSource: "server",
      });
      bootstrapProjectId = project.id;
      bootstrapThreadId = launched.threadId;
    } else {
      bootstrapProjectId = project.id;
      bootstrapThreadId = existingThread.id;
    }
  }

  return {
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
  } satisfies AutoBootstrapWelcomeTargets;
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

export function runOrderedV2StartupPhases<
  Verification extends { readonly valid: boolean },
  RebuildVerification extends { readonly valid: boolean },
  Recovery,
  Bootstrap,
  VerifyError,
  RebuildError,
  RecoveryError,
  WorkerError,
  BootstrapError,
  VerifyContext,
  RebuildContext,
  RecoveryContext,
  WorkerContext,
  BootstrapContext,
>(input: {
  readonly verify: Effect.Effect<Verification, VerifyError, VerifyContext>;
  readonly rebuild: Effect.Effect<RebuildVerification, RebuildError, RebuildContext>;
  readonly recover: Effect.Effect<Recovery, RecoveryError, RecoveryContext>;
  readonly startEffectWorker: Effect.Effect<void, WorkerError, WorkerContext>;
  readonly autoBootstrap: Effect.Effect<Bootstrap, BootstrapError, BootstrapContext>;
}) {
  return Effect.gen(function* () {
    const verification = yield* input.verify;
    if (!verification.valid) {
      const rebuilt = yield* input.rebuild;
      if (!rebuilt.valid) {
        return yield* Effect.die(
          new Error("V2 orchestration projection rebuild did not produce a valid projection."),
        );
      }
    }
    const recovery = yield* input.recover;
    yield* input.startEffectWorker;
    const bootstrap = yield* input.autoBootstrap;
    return { recovery, bootstrap } as const;
  });
}

export const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const keybindings = yield* Keybindings.Keybindings;
  const projectionMaintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  const providerRuntimeRecovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;

  const commandGate = yield* makeCommandGate;
  const httpListening = yield* Deferred.make<void>();
  const effectWorkerFiber = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* commandGate.failCommandReady(
        new ServerRuntimeStartupError({
          mode: serverConfig.mode,
          host: serverConfig.host ?? null,
          port: serverConfig.port,
          cause: "Server runtime is shutting down.",
        }),
      );
      const workerFiber = yield* Ref.getAndSet(effectWorkerFiber, null);
      if (workerFiber !== null) {
        yield* Fiber.interrupt(workerFiber).pipe(Effect.ignore);
      }
      yield* providerSessions.shutdown;
      const reconciliation = yield* providerRuntimeRecovery.reconcile("shutdown");
      yield* Effect.logInfo("V2 orchestration shutdown reconciliation completed", reconciliation);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("V2 orchestration shutdown reconciliation failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );

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

    const welcomeBase = yield* resolveWelcomeBase;
    const environment = yield* serverEnvironment.getDescriptor;
    const { recovery, bootstrap: bootstrapTargets } = yield* runOrderedV2StartupPhases({
      verify: runStartupPhase(
        "orchestration-v2.projections.verify",
        projectionMaintenance.verify.pipe(
          Effect.tap((verification) =>
            verification.valid
              ? Effect.void
              : Effect.logWarning(
                  "V2 orchestration projection metadata or structure is invalid; rebuilding",
                  {
                    expectedSequence: verification.expectedSequence,
                    projectionSequence: verification.projectionSequence,
                    schemaVersion: verification.schemaVersion,
                    missingThreadCount: verification.missingThreadIds.length,
                    unexpectedThreadCount: verification.unexpectedThreadIds.length,
                    unreadableThreadCount: verification.unreadableThreadIds.length,
                  },
                ),
          ),
        ),
      ),
      rebuild: runStartupPhase(
        "orchestration-v2.projections.rebuild",
        projectionMaintenance.rebuild,
      ),
      recover: runStartupPhase("orchestration-v2.recovery", providerRuntimeRecovery.recover),
      startEffectWorker: runStartupPhase(
        "orchestration-v2.effect-worker.start",
        Effect.gen(function* () {
          const workerFiber = yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
          yield* Ref.set(effectWorkerFiber, workerFiber);
          yield* agentAwarenessRelay.start();
        }),
      ),
      autoBootstrap: (serverConfig.autoBootstrapProjectFromCwd
        ? runStartupPhase(
            "welcome.autobootstrap",
            resolveAutoBootstrapWelcomeTargets.pipe(Effect.provideService(Crypto.Crypto, crypto)),
          )
        : Effect.succeed({})
      ).pipe(Effect.map((targets): AutoBootstrapWelcomeTargets => targets)),
    });
    yield* Effect.logInfo("V2 orchestration recovery completed", recovery);

    yield* Effect.logDebug("Accepting commands");
    yield* commandGate.signalCommandReady;

    yield* Effect.logDebug("startup phase: publishing welcome event", {
      environmentId: environment.environmentId,
      cwd: welcomeBase.cwd,
      projectName: welcomeBase.projectName,
      bootstrapProjectId: bootstrapTargets.bootstrapProjectId,
      bootstrapThreadId: bootstrapTargets.bootstrapThreadId,
    });
    yield* runStartupPhase(
      "welcome.publish",
      lifecycleEvents.publish({
        version: 1,
        type: "welcome",
        payload: {
          environment,
          ...welcomeBase,
          ...bootstrapTargets,
        },
      }),
    );
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
        yield* Effect.logError("server runtime startup failed", {
          cause: Cause.pretty(startupExit.cause),
        });
        yield* commandGate.failCommandReady(error);
        return;
      }

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
    markHttpListening: Deferred.succeed(httpListening, undefined),
    enqueueCommand: commandGate.enqueueCommand,
  } satisfies ServerRuntimeStartup["Service"];
});

export const layer = Layer.effect(ServerRuntimeStartup, make);
