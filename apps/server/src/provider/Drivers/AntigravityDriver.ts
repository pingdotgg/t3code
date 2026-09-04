import { withAgentDeviceEnvironment } from "../../mcp/McpProviderSession.ts";
import { AntigravitySettings, ProviderDriverKind, ProviderSetupError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { AcpError } from "effect-acp/errors";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  isAntigravityTextGenerationAvailable,
  makeAntigravityTextGeneration,
} from "../../textGeneration/AntigravityTextGeneration.ts";
import { makeAntigravityAuth, type AntigravityAuth } from "../AntigravityAuth.ts";
import { AntigravityInstallation } from "../AntigravityInstallation.ts";
import {
  antigravityAuthConfigIssue,
  antigravityAuthLabel,
  antigravityAuthUsesBrowser,
  buildAntigravityAcpSpawnInput,
  isAntigravitySignInRequiredError,
  prepareAntigravityProfile,
  resolveAntigravityProfileDirectory,
  resolveAntigravityRuntimeTempDirectory,
  type AntigravityAuthConfig,
} from "../antigravityAuthSupport.ts";
import {
  makeAntigravityAcpRuntime,
  type AntigravityAcpRuntimeInput,
} from "../acp/AntigravityAcpSupport.ts";
import type { AcpSessionRuntime, AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  removeAntigravityRuntimeTempDirs,
  removeAntigravitySessionFiles,
} from "../acp/AntigravitySessionFiles.ts";
import { IdAllocatorV2 } from "../../orchestration-v2/IdAllocator.ts";
import { ProviderContinuationRequests } from "../../orchestration-v2/ProviderContinuationRequests.ts";
import { makeAntigravityAdapterV2 } from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeAntigravityProvider } from "../Layers/AntigravityProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { discoverAntigravitySkills, resolveAntigravityUserHome } from "./AntigravitySkills.ts";

const DRIVER = ProviderDriverKind.make("antigravity");
const decodeSettings = Schema.decodeSync(AntigravitySettings);
const isNodeRuntimeUnavailableError = Schema.is(NodeRuntimeUnavailableError);

export type AntigravityDriverEnv =
  | AntigravityInstallation
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocatorV2
  | ModelManifest.ModelManifest
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/** Each instance owns its Google profile. Executable releases are shared by the environment. */
export const AntigravityDriver: ProviderDriver<AntigravitySettings, AntigravityDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const installation = yield* AntigravityInstallation;
      const loggers = yield* ProviderEventLoggers;
      const modelManifest = yield* ModelManifest.ModelManifest;
      const idAllocator = yield* IdAllocatorV2;
      const continuationRequests = yield* ProviderContinuationRequests;
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
      const profileDirectory = resolveAntigravityProfileDirectory(
        serverConfig.stateDir,
        instanceId,
      );
      // No process of this instance exists yet, so every runtime temp
      // directory left under the profile is an orphan from a killed server.
      yield* removeAntigravityRuntimeTempDirs(
        resolveAntigravityRuntimeTempDirectory(profileDirectory),
      ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
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
      // Google returns every model the account can use, including older
      // Gemini generations. The manifest names the current ones so the picker
      // folds the rest under its legacy section, as it does for Codex.
      const classifyModels = (draft: ServerProviderDraft) =>
        modelManifest.current.pipe(
          Effect.map((manifest) =>
            stampIdentity(ModelManifest.applyModelManifest(draft, manifest, DRIVER)),
          ),
        );

      const makeRuntime = Effect.fn("AntigravityDriver.makeRuntime")(function* (
        input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
      ): Effect.fn.Return<
        AcpSessionRuntime["Service"],
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
        started: AcpSessionRuntimeStartResult,
        runtime: Pick<AcpSessionRuntime["Service"], "getEvents" | "drainEvents">,
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
        yield* modelManifest.refreshInBackground;
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
      const defaultModel = modelManifest.current.pipe(
        Effect.map((manifest) => ModelManifest.manifestDefaultModel(manifest, DRIVER)),
      );
      const orchestrationAdapter = makeAntigravityAdapterV2({
        instanceId,
        crypto,
        fileSystem,
        path,
        idAllocator,
        serverConfig,
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
