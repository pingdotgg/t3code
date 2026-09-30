/**
 * OpenCodeDriver — `ProviderDriver` for the OpenCode runtime.
 *
 * Mirrors the Codex / Claude drivers: a plain value whose `create()`
 * bundles `snapshot` / `adapter` / `textGeneration` closures over the
 * per-instance `OpenCodeSettings`.
 *
 * Two instances with different `serverUrl`s therefore talk to independent
 * OpenCode servers; when no `serverUrl` is set, the adapter + text-generation
 * shares spin up their own scoped child processes, and those child
 * processes are released when the registry scope closes.
 *
 * @module provider/Drivers/OpenCodeDriver
 */
import { OpenCodeSettings, ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as OpenCodeAdapterV2 from "../../orchestration-v2/Adapters/OpenCodeAdapterV2.ts";
import * as OpenCode2AdapterV2 from "../../orchestration-v2/Adapters/OpenCode2AdapterV2.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { readOpenCodeGoUsageLimits } from "../Layers/openCodeUsageLimits.ts";
import {
  checkOpenCodeProviderStatus,
  loadOpenCode2Workspace,
  makeOpenCode2ModelLoader,
  makePendingOpenCodeProvider,
  openCode2CommandsToServerProviderSlashCommands,
  openCode2SkillsToServerProviderSkills,
  openCodeSkillsToServerProviderSkills,
  openCodeCommandsToServerProviderSlashCommands,
} from "../Layers/OpenCodeProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import {
  makeOpenCodeRuntimeProbe,
  probeOpenCodeRuntime,
  type ProbedOpenCode,
} from "../opencodeVersionProbe.ts";
import * as OpenCodeServerOwner from "../OpenCodeServerOwner.ts";
import * as OpenCode2Client from "../opencode2/OpenCode2Client.ts";
import * as OpenCode2Server from "../opencode2/OpenCode2Server.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("opencode");

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "opencode-ai",
  nativeUpdate: {
    args: ["upgrade"],
    isCommandPath: isOpenCodeNativeCommandPath,
  },
});

export const OPENCODE_2_TEXT_GENERATION_UNSUPPORTED =
  "T3 Code cannot generate text with OpenCode 2 yet.";

type OpenCodeRuntimeProbe = Effect.Success<
  ReturnType<typeof makeOpenCodeRuntimeProbe<OpenCodeRuntime.OpenCodeRuntimeError>>
>;

/** Runs `v2` for a 2.x instance and `v1` otherwise; a failed probe keeps 1.x, whose checks report it. */
function byOpenCodeRuntime<A, E, R, PE>(
  probed: Effect.Effect<ProbedOpenCode | undefined, PE>,
  paths: { readonly v1: Effect.Effect<A, E, R>; readonly v2: Effect.Effect<A, E, R> },
): Effect.Effect<A, E, R> {
  return probed.pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.flatMap((result) => (result?.generation === "v2" ? paths.v2 : paths.v1)),
  );
}

/**
 * Routes each adapter call to the runtime the instance's probe detected. Capability and selection
 * reads are hot, so they use the last successful probe (1.x before one lands) and never wait on a
 * slow server. Opening a session waits for a probe, so each server is spoken to in its own protocol.
 */
function selectOpenCodeRuntimeAdapter(input: {
  readonly probe: OpenCodeRuntimeProbe;
  readonly v1: ProviderAdapterV2Shape;
  readonly v2: ProviderAdapterV2Shape;
}): ProviderAdapterV2Shape {
  const pick = <PE>(probed: Effect.Effect<ProbedOpenCode | undefined, PE>) =>
    byOpenCodeRuntime(probed, { v1: Effect.succeed(input.v1), v2: Effect.succeed(input.v2) });
  const hot = pick(Effect.map(input.probe.lastSuccess, Option.getOrUndefined));
  return {
    instanceId: input.v1.instanceId,
    driver: DRIVER_KIND,
    getCapabilities: () => Effect.flatMap(hot, (adapter) => adapter.getCapabilities()),
    planSelectionTransition: (transition) =>
      Effect.flatMap(hot, (adapter) => adapter.planSelectionTransition(transition)),
    openSession: (session) =>
      Effect.flatMap(pick(input.probe.get), (adapter) => adapter.openSession(session)),
  };
}

/** Text generation starts or connects to a 1.x server per call, so a 2.x is refused first. */
function selectOpenCodeRuntimeTextGeneration(
  probe: OpenCodeRuntimeProbe,
  v1: TextGeneration["Service"],
): TextGeneration["Service"] {
  const refuse = (operation: string) =>
    Effect.fail(
      new TextGenerationError({ operation, detail: OPENCODE_2_TEXT_GENERATION_UNSUPPORTED }),
    );
  return {
    generateCommitMessage: (input) =>
      byOpenCodeRuntime(probe.get, {
        v1: v1.generateCommitMessage(input),
        v2: refuse("generateCommitMessage"),
      }),
    generatePrContent: (input) =>
      byOpenCodeRuntime(probe.get, {
        v1: v1.generatePrContent(input),
        v2: refuse("generatePrContent"),
      }),
    generateBranchName: (input) =>
      byOpenCodeRuntime(probe.get, {
        v1: v1.generateBranchName(input),
        v2: refuse("generateBranchName"),
      }),
    generateThreadTitle: (input) =>
      byOpenCodeRuntime(probe.get, {
        v1: v1.generateThreadTitle(input),
        v2: refuse("generateThreadTitle"),
      }),
  };
}

export type OpenCodeDriverEnv =
  | OpenCodeAdapterV2.OpenCodeAdapterV2DriverEnv
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | OpenCodeRuntime.OpenCodeRuntime
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService;

export const OpenCodeDriver: ProviderDriver<OpenCodeSettings, OpenCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenCode",
    supportsMultipleInstances: true,
  },
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => decodeOpenCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies OpenCodeSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        ),
      );

      const runtimeProbe = yield* makeOpenCodeRuntimeProbe(
        probeOpenCodeRuntime(effectiveConfig, processEnv).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
        ),
      );
      const openCodeV1Adapter = yield* OpenCodeAdapterV2.OpenCodeAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build OpenCode orchestration adapter.",
              cause,
            }),
        ),
      );
      // One OpenCode 2 server per instance, spawned on first use or reached at `serverUrl`.
      const openCode2Server = yield* OpenCode2Server.make({
        binaryPath: effectiveConfig.binaryPath,
        serverUrl: effectiveConfig.serverUrl,
        serverPassword: effectiveConfig.serverPassword,
        directory: serverConfig.cwd,
        environment: processEnv,
      }).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
        Effect.provideService(
          OpenCode2Client.OpenCode2Client,
          yield* OpenCode2Client.make.pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
          ),
        ),
      );
      const orchestrationAdapter = selectOpenCodeRuntimeAdapter({
        probe: runtimeProbe,
        v1: openCodeV1Adapter,
        v2: yield* OpenCode2AdapterV2.make(instanceId).pipe(
          Effect.provideService(OpenCode2Server.OpenCode2Server, openCode2Server),
        ),
      });
      const loadOpenCode2Models = yield* makeOpenCode2ModelLoader(
        openCode2Server.withConnection((connection) =>
          connection.client.model.list({ location: { directory: serverConfig.cwd } }).pipe(
            Effect.map((models) => models.data),
            Effect.mapError(
              (cause) =>
                new OpenCodeRuntime.OpenCodeRuntimeError({
                  operation: "model.list",
                  detail: "The OpenCode server could not list its models.",
                  cause,
                }),
            ),
          ),
        ),
      );
      // A 2.x server lists skills and commands per directory, so one server
      // answers every workspace. Its event stream says when a directory it had
      // not served yet finished scanning.
      const listOpenCode2Workspace = (cwd: string) =>
        openCode2Server.withConnection(({ client, events }) =>
          Effect.gen(function* () {
            const location = { directory: cwd };
            const scanned = yield* Deferred.make<void>();
            const pending = new Set(["command.updated", "skill.updated"]);
            const stream = yield* events.pipe(Effect.option);
            if (stream._tag === "Some") {
              yield* stream.value.pipe(
                Stream.runForEach((event) =>
                  "location" in event &&
                  event.location?.directory === cwd &&
                  pending.delete(event.type) &&
                  pending.size === 0
                    ? Deferred.succeed(scanned, undefined)
                    : Effect.void,
                ),
                Effect.ignore,
                Effect.forkScoped,
              );
            }
            return yield* loadOpenCode2Workspace(
              Effect.all(
                {
                  skills: client.skill.list({ location }).pipe(Effect.map((list) => list.data)),
                  commands: client.command.list({ location }).pipe(Effect.map((list) => list.data)),
                },
                { concurrency: "unbounded" },
              ),
              Deferred.await(scanned),
            );
          }).pipe(Effect.scoped),
        );
      const serverOwner = yield* OpenCodeServerOwner.make({
        binaryPath: effectiveConfig.binaryPath,
        directory: serverConfig.cwd,
        ...(effectiveConfig.serverPassword
          ? { serverPassword: effectiveConfig.serverPassword }
          : {}),
        environment: processEnv,
      });
      const textGeneration = selectOpenCodeRuntimeTextGeneration(
        runtimeProbe,
        yield* makeOpenCodeTextGeneration(effectiveConfig).pipe(
          Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
        ),
      );

      const checkProvider = Effect.all(
        {
          provider: checkOpenCodeProviderStatus(
            effectiveConfig,
            serverConfig.cwd,
            runtimeProbe.refresh,
            loadOpenCode2Models,
          ),
          usageLimits: readOpenCodeGoUsageLimits({
            enabled: effectiveConfig.enabled,
            serverUrl: effectiveConfig.serverUrl,
            environment: processEnv,
          }),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(({ provider, usageLimits }) => ({ ...provider, usageLimits })),
        Effect.map(stampIdentity),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
      );
      // NOTE: the local branch intentionally uses the shared SDK server
      // instead of `opencode debug skill` (loadSkillsFromCli). The CLI writes
      // its full JSON inventory to stdout, but the Bun-compiled binary does
      // not flush more than one 64KB pipe buffer to a non-TTY stdout, so the
      // piped output arrives truncated and unparseable — which degrades to an
      // empty skill list and poisons the workspace snapshot the `$` picker
      // reads. The SDK `app.skills` endpoint honors the per-request directory
      // and returns complete results regardless of size.
      const loadWorkspaceInventory = (
        client: Parameters<typeof OpenCodeRuntime.loadOpenCodeCommands>[0],
      ) =>
        Effect.all(
          {
            skills: openCodeRuntime.loadOpenCodeSkills(client),
            commands: OpenCodeRuntime.loadOpenCodeCommands(client).pipe(
              Effect.timeout("10 seconds"),
              Effect.orElseSucceed(() => []),
            ),
          },
          { concurrency: "unbounded" },
        );
      const loadWorkspaceForCwd = (cwd: string) =>
        effectiveConfig.serverUrl.trim().length > 0
          ? Effect.scoped(
              Effect.gen(function* () {
                const server = yield* openCodeRuntime.connectToOpenCodeServer({
                  binaryPath: effectiveConfig.binaryPath,
                  directory: cwd,
                  serverUrl: effectiveConfig.serverUrl,
                  ...(effectiveConfig.serverPassword
                    ? { serverPassword: effectiveConfig.serverPassword }
                    : {}),
                  environment: processEnv,
                });
                const client = openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl: server.url,
                  directory: cwd,
                  ...(effectiveConfig.serverPassword
                    ? { serverPassword: effectiveConfig.serverPassword }
                    : {}),
                });
                return yield* loadWorkspaceInventory(client);
              }),
            )
          : serverOwner.withServer((server) =>
              loadWorkspaceInventory(
                openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl: server.url,
                  directory: cwd,
                  ...(server.serverPassword !== undefined
                    ? { serverPassword: server.serverPassword }
                    : {}),
                }),
              ),
            );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OpenCodeSettings>>(
        {
          resolveMaintenance,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          checkProviderOnSettingsChange: () => false,
          refreshOnInterval: false,
          initialSnapshot: (settings) =>
            makePendingOpenCodeProvider(settings.provider).pipe(Effect.map(stampIdentity)),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
            resolveMaintenance().pipe(
              Effect.flatMap((maintenanceCapabilities) =>
                enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                  enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                }),
              ),
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
            ),
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenCode snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd: (cwd) =>
          !effectiveConfig.enabled
            ? snapshot.getSnapshot
            : byOpenCodeRuntime(runtimeProbe.get, {
                v2: Effect.all([
                  snapshot.getSnapshot,
                  listOpenCode2Workspace(cwd).pipe(
                    Effect.timeout("20 seconds"),
                    Effect.mapError(
                      (cause) =>
                        new ProviderDriverError({
                          driver: DRIVER_KIND,
                          instanceId,
                          detail: `Failed to list OpenCode commands and skills for '${cwd}'`,
                          cause,
                        }),
                    ),
                  ),
                ]).pipe(
                  Effect.map(([machineSnapshot, { skills, commands }]) => ({
                    ...machineSnapshot,
                    skills: openCode2SkillsToServerProviderSkills(skills),
                    slashCommands: openCode2CommandsToServerProviderSlashCommands(commands),
                  })),
                ),
                v1: Effect.all([
                  snapshot.getSnapshot,
                  loadWorkspaceForCwd(cwd).pipe(Effect.timeout("20 seconds")),
                ]).pipe(
                  Effect.map(([machineSnapshot, { skills, commands }]) => ({
                    ...machineSnapshot,
                    skills: openCodeSkillsToServerProviderSkills(skills),
                    slashCommands: openCodeCommandsToServerProviderSlashCommands(commands),
                  })),
                  Effect.mapError(
                    (cause) =>
                      new ProviderDriverError({
                        driver: DRIVER_KIND,
                        instanceId,
                        detail: `Failed to probe OpenCode commands and skills for '${cwd}'`,
                        cause,
                      }),
                  ),
                ),
              }),
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
