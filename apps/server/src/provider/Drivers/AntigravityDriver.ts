import { withAgentDeviceEnvironment } from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { AntigravitySettings, ProviderDriverKind, ProviderSetupError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  NodeRuntimeUnavailableError,
  nodeRuntimeUnavailableMessage,
} from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { AcpError } from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  isAntigravityTextGenerationAvailable,
  makeAntigravityTextGeneration,
} from "../../textGeneration/AntigravityTextGeneration.ts";
import { makeAntigravityAuth, type AntigravityAuth } from "../AntigravityAuth.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import * as AntigravityUsage from "./AntigravityUsage.ts";
import {
  antigravityAuthConfigIssue,
  antigravityAuthLabel,
  antigravityAuthUsesBrowser,
  buildAntigravityAcpSpawnInput,
  isAntigravitySignInRequiredError,
  prepareAntigravityProfile,
  resolveAntigravityInstanceDirectories,
  type AntigravityAuthConfig,
} from "../antigravityAuthSupport.ts";
import {
  makeAntigravityAcpRuntime,
  type AntigravityAcpRuntimeInput,
} from "../acp/AntigravityAcpSupport.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  removeAntigravityRuntimeTempDirs,
  removeAntigravitySessionFiles,
} from "../acp/AntigravitySessionFiles.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeAntigravityAdapterV2 } from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { ProviderDriverError } from "../Errors.ts";
import { makeAntigravityProvider } from "../AntigravityProvider.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { discoverAntigravitySkills, resolveAntigravityUserHome } from "./AntigravitySkills.ts";

const DRIVER = ProviderDriverKind.make("antigravity");
const decodeSettings = Schema.decodeSync(AntigravitySettings);
const isNodeRuntimeUnavailableError = Schema.is(NodeRuntimeUnavailableError);

export type AntigravityDriverEnv =
  | AntigravityInstallation.AntigravityInstallation
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

/** Each instance owns its Google profile. Executable releases are shared by the environment. */
export const AntigravityDriver: ProviderDriver<
  AntigravitySettings,
  AntigravityDriverEnv,
  AntigravityUsage.AntigravityUsage
> = {
  driverKind: DRIVER,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeSettings({}),
  usage: AntigravityUsage.antigravityUsageReader,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const host = yield* ProviderHost.ProviderHost;
      const selfInvocation = yield* resolveSelfInvocation();
      const installation = yield* AntigravityInstallation.AntigravityInstallation;
      const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const modelCatalog = yield* ModelCatalog.ModelCatalog;
      const currentCatalog = modelCatalog.current(DRIVER);
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      const settings = { ...config, enabled } satisfies AntigravitySettings;
      const auth: AntigravityAuthConfig = {
        authMethod: settings.authMethod,
        apiKey: settings.apiKey,
        gcpProject: settings.gcpProject,
        gcpLocation: settings.gcpLocation,
      };
      const authConfigIssue = antigravityAuthConfigIssue(auth);
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const userHome = resolveAntigravityUserHome(yield* HostProcessPlatform, processEnvironment);
      const directories = yield* resolveAntigravityInstanceDirectories(
        host.paths.stateDir,
        instanceId,
      ).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Could not resolve the Antigravity profile directory.",
              cause,
            }),
        ),
      );
      const profileDirectory = directories.profile;
      // No process of this instance exists yet, so every runtime temp
      // directory it owns is an orphan from a killed server. Older builds
      // unpacked inside the profile.
      for (const directory of [
        directories.runtimeTemp,
        path.join(profileDirectory, "antigravity-acp", "tmp"),
      ]) {
        yield* removeAntigravityRuntimeTempDirs(directory).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
      }
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const classifyModels = (draft: ServerProviderDraft) =>
        currentCatalog.pipe(
          Effect.map((catalog) => stampIdentity(ModelCatalog.applyModelCatalog(draft, catalog))),
        );

      const makeRuntime = Effect.fn("AntigravityDriver.makeRuntime")(function* (
        input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
      ): Effect.fn.Return<
        AcpSessionRuntime.AcpSessionRuntime["Service"],
        AcpError | ProviderSetupError,
        Scope.Scope
      > {
        if (authConfigIssue !== null) {
          return yield* new ProviderSetupError({
            instanceId,
            operation: "configure",
            detail: authConfigIssue,
          });
        }
        const executable = yield* installation
          .acquire(settings.binaryPath, processEnvironment)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSetupError({
                  instanceId,
                  operation: "resolve",
                  detail: cause.detail,
                  cause,
                }),
            ),
          );
        const profile = yield* prepareAntigravityProfile({
          profileDirectory,
          baseEnv: processEnvironment,
          auth,
          userHome,
          tempDirectory: directories.runtimeTemp,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError((cause) =>
            isNodeRuntimeUnavailableError(cause.cause)
              ? new ProviderSetupError({
                  instanceId,
                  operation: "start",
                  detail: nodeRuntimeUnavailableMessage("Antigravity sign-in"),
                  cause,
                })
              : cause,
          ),
        );
        // Each process unpacks into its own directory that dies with the
        // runtime scope, after the child is killed. A shared directory would
        // let one session's teardown delete files a sibling still reads.
        // Removal is best effort: a handle can outlive the kill on Windows,
        // and the sweep on the next driver start reclaims what is left.
        const runtimeTempDirectory = yield* Effect.acquireRelease(
          fileSystem.makeTempDirectory({ directory: profile.tempDirectory, prefix: "run-" }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSetupError({
                  instanceId,
                  operation: "start",
                  detail: "Could not create an Antigravity runtime temp directory.",
                  cause,
                }),
            ),
          ),
          (directory) =>
            fileSystem
              .remove(directory, { recursive: true, force: true })
              .pipe(
                Effect.catch(() =>
                  Effect.logWarning("Could not remove an Antigravity runtime temp directory."),
                ),
              ),
        );
        const runtime = yield* makeAntigravityAcpRuntime({
          ...input,
          authMethod: auth.authMethod,
          childProcessSpawner: spawner,
          spawn: buildAntigravityAcpSpawnInput({
            installation: executable,
            profile,
            cwd: input.cwd,
            baseEnv: withAgentDeviceEnvironment(processEnvironment, input),
            auth,
            runtimeTempDirectory,
          }),
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));
        return {
          ...runtime,
          start: () =>
            runtime
              .start()
              .pipe(
                Effect.tapError((cause): Effect.Effect<void> =>
                  input.onAuthorizationUrl === undefined && isAntigravitySignInRequiredError(cause)
                    ? provider.onAuthRequired
                    : Effect.void,
                ),
              ),
        };
      });

      const makeDisposableRuntime = Effect.fn("AntigravityDriver.makeDisposableRuntime")(function* (
        input: Pick<AntigravityAcpRuntimeInput, "onAuthorizationUrl">,
      ) {
        const cwd = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "t3-antigravity-setup-" })
          .pipe(
            Effect.mapError(
              () =>
                new ProviderSetupError({
                  instanceId,
                  operation: "start",
                  detail: "Could not create an Antigravity setup workspace.",
                }),
            ),
          );
        let sessionId: string | undefined;
        yield* Effect.addFinalizer(() =>
          removeAntigravitySessionFiles({
            profileDirectory,
            sessionId,
            cwd,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        );
        const runtime = yield* makeRuntime({
          cwd,
          clientInfo: { name: "t3-code-provider-setup", version: "0.0.0" },
          mcpServers: [],
          ...(input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {}),
        });
        return {
          ...runtime,
          start: () =>
            runtime.start().pipe(
              Effect.tap((started) =>
                Effect.sync(() => {
                  sessionId = started.sessionId;
                }),
              ),
            ),
        };
      });

      const publishCatalog = (
        started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
        runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "getEvents" | "drainEvents">,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* provider.onSessionStarted(started);
          yield* Stream.runForEach(runtime.getEvents(), (event) => {
            if (event._tag === "EventStreamBarrier") {
              return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
            }
            if (event._tag === "ConfigOptionsUpdated") {
              return provider.onConfigOptionsUpdated(event.configOptions);
            }
            return event._tag === "AvailableCommandsUpdated"
              ? provider.onAvailableCommands(event.availableCommands)
              : Effect.void;
          }).pipe(Effect.forkScoped);
          yield* runtime.drainEvents;
        }).pipe(Effect.scoped);

      const authFlow: AntigravityAuth = yield* makeAntigravityAuth({
        instanceId,
        makeRuntime: makeDisposableRuntime,
        onAuthenticated: publishCatalog,
        onSignedOut: Effect.suspend(() => provider.onSignedOut),
        usesBrowser: antigravityAuthUsesBrowser(auth.authMethod),
      });

      // Kick the TTL-gated manifest refresh alongside the health check, as
      // Codex and Claude do. Without it an environment that only runs
      // Antigravity would keep classifying against a stale disk cache.
      // The probe must not spawn. The agent is a PyInstaller one-file bundle
      // that unpacks about 1 GB per launch, and the health check runs every
      // minute. Resolving the install on disk is enough to report installed
      // and version. The response below is synthetic: only agentInfo.version
      // is read from it. Sessions and manual refreshes still spawn.
      const probe = Effect.gen(function* () {
        yield* modelCatalog.refreshInBackground;
        if (authConfigIssue !== null) {
          return yield* new ProviderSetupError({
            instanceId,
            operation: "configure",
            detail: authConfigIssue,
          });
        }
        const executable = yield* installation
          .resolve(settings.binaryPath, processEnvironment)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSetupError({
                  instanceId,
                  operation: "resolve",
                  detail: cause.detail,
                  cause,
                }),
            ),
          );
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: true, embeddedContext: true },
            sessionCapabilities: { list: {}, resume: {} },
          },
          authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
          agentInfo: {
            name: "antigravity-acp",
            title: "Google Antigravity",
            version: executable.version ?? "unknown",
          },
        };
      });

      const provider = yield* makeAntigravityProvider(settings, {
        stampIdentity: classifyModels,
        probe,
        auth: { type: auth.authMethod, label: antigravityAuthLabel(auth.authMethod) },
        supportsTextGeneration: isAntigravityTextGenerationAvailable(profileDirectory).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.orElseSucceed(() => false),
        ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Could not prepare the Antigravity provider status.",
              cause,
            }),
        ),
      );
      const defaultModel = currentCatalog.pipe(Effect.map((catalog) => catalog?.defaultChatModel));
      const orchestrationAdapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation,
        makeRuntime,
        withProcess: authFlow.withProcess,
        defaultModel,
        onSessionStarted: provider.onSessionStarted,
        onSessionEvent: (event) => {
          if (event._tag === "ConfigOptionsUpdated") {
            return provider.onConfigOptionsUpdated(event.configOptions);
          }
          return event._tag === "AvailableCommandsUpdated"
            ? provider.onAvailableCommands(event.availableCommands)
            : Effect.void;
        },
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: loggers.native,
            provider: DRIVER,
            threadId,
          }),
      });
      const textGeneration = yield* makeAntigravityTextGeneration({
        profileDirectory,
        defaultModel,
        withProcess: authFlow.withProcess,
        makeRuntime: (cwd) =>
          makeRuntime({
            cwd,
            clientInfo: { name: "t3-code-text", version: "0.0.0" },
            mcpServers: [],
          }),
      });

      const refreshModels = Effect.fn("AntigravityDriver.refreshModels")(
        function* () {
          const processScope = yield* Scope.make();
          yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
          yield* authFlow
            .withProcess(
              Scope.close(processScope, Exit.void),
              Effect.gen(function* () {
                const runtime = yield* makeDisposableRuntime({});
                const started = yield* runtime.start();
                yield* publishCatalog(started, runtime);
              }),
            )
            .pipe(Effect.provideService(Scope.Scope, processScope));
        },
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: "90 seconds",
          orElse: () =>
            Effect.fail(
              new ProviderDriverError({
                driver: DRIVER,
                instanceId,
                detail: "Antigravity model refresh timed out. Try again or check Google sign-in.",
              }),
            ),
        }),
        Effect.tapError((cause) =>
          isAntigravitySignInRequiredError(cause) ? provider.onAuthRequired : Effect.void,
        ),
        Effect.mapError((cause) =>
          cause._tag === "ProviderDriverError"
            ? cause
            : new ProviderDriverError({
                driver: DRIVER,
                instanceId,
                detail: isAntigravitySignInRequiredError(cause)
                  ? "Sign in to Antigravity in provider settings before refreshing models."
                  : cause._tag === "ProviderSetupError" &&
                      (cause.operation === "configure" || cause.operation === "start")
                    ? cause.detail
                    : "Could not refresh Antigravity models. The previous model list is unchanged.",
                cause,
              }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: provider.snapshot,
        snapshotForCwd: (cwd) =>
          !enabled
            ? provider.snapshot.getSnapshot
            : discoverAntigravitySkills({ cwd, userHome }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.flatMap((skills) => provider.snapshotForCwd(cwd, skills)),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER,
                      instanceId,
                      detail: "Could not read Antigravity workspace skills.",
                      cause,
                    }),
                ),
              ),
        orchestrationAdapter,
        textGeneration,
        auth: authFlow.controller,
        refreshModels,
      } satisfies ProviderInstance;
    }),
};
