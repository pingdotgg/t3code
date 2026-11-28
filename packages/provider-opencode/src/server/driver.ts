import { resolveProviderProbeTimeoutMs } from "@t3tools/provider-core/server/snapshotProbe";
import {
  isInferenceProviderConfig,
  ProviderDriverKind,
  settingsSecretLiteral,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { OpenCodeSettings } from "../settings.ts";
import * as Cause from "effect/Cause";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as OpenCode2TextGeneration from "./v2/textGeneration.ts";
import { makeOpenCodeTextGeneration } from "./textGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as OpenCodeAdapterV2 from "./adapter.ts";
import * as OpenCode2AdapterV2 from "./v2/adapter.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderTextGenerationRuntime } from "@t3tools/provider-core/server/textGeneration";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { openCodeUsageReader, type OpenCodeUsageReaderEnv } from "./usage.ts";
import { withUsageAccess } from "@t3tools/provider-core/server/usageLimits";
import { readOpenCodeGoUsageLimits } from "./usageLimits.ts";
import { loadOpenCode2Catalog, loadOpenCode2DirectoryCatalog } from "./openCode2Catalog.ts";
import {
  checkOpenCodeProviderStatus,
  followOpenCode2Scans,
  loadOpenCode2Workspace,
  makeOpenCode2CatalogWatch,
  makeOpenCode2ModelLoader,
  makePendingOpenCodeProvider,
  openCode2CommandsToServerProviderSlashCommands,
  openCode2ProviderModels,
  openCode2SkillsToServerProviderSkills,
  openCodeSkillsToServerProviderSkills,
  openCodeCommandsToServerProviderSlashCommands,
  openCodeProviderModels,
  readSettledOpenCode2Catalog,
  withOpenCode2Catalog,
  type OpenCode2Model,
} from "./status.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import {
  makeOpenCodeRuntimeProbe,
  probeOpenCodeRuntime,
  probeOpenCodeBinary,
  type ProbedOpenCode,
} from "./versionProbe.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";
import * as OpenCode2Client from "./v2/OpenCode2Client.ts";
import * as OpenCode2Server from "./v2/OpenCode2Server.ts";
import { replaceOutdatedService } from "./v2/OpenCode2Service.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { providerProbeEnvironment } from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("opencode");

// A loopback server runs on this environment, but can outlive its CLI installation.
// Its reported version may therefore differ from the installed executable after an update.
export function isLocalOpenCodeServerUrl(serverUrl: string): boolean {
  const url = URL.parse(serverUrl.trim());
  if (url?.protocol !== "http:" && url?.protocol !== "https:") return false;
  return (
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname)
  );
}

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

function openCodeNativeHome(commandPath: string): string | null {
  const slashed = commandPath.replaceAll("\\", "/");
  const match = /\/\.opencode\/bin\/opencode(?:\.exe)?$/i.exec(slashed);
  if (!match) return null;
  return match.index === 0 ? "/" : slashed.slice(0, match.index);
}

/** Update only within the installed package generation; 2.x converts the shared database in place. */
export const openCodeUpdateFor = (generation: ProbedOpenCode["generation"]) =>
  makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: generation === "v2" ? "@opencode/cli" : "opencode-ai",
    nativeUpdate: {
      // `isOpenCodeNativeCommandPath` is the curl installer's own binary. Name the
      // method so OpenCode does not have to infer it from `process.execPath`, which
      // fails when the binary is launched through a wrapper or shim.
      args: ["upgrade", "--method", "curl"],
      isCommandPath: isOpenCodeNativeCommandPath,
      requiresCommandPath: true,
      // The curl installer writes to `$HOME/.opencode/bin`, so point HOME at the install it replaces.
      env: (context) => {
        const home =
          openCodeNativeHome(context.realCommandPath) ??
          openCodeNativeHome(context.resolvedCommandPath);
        return home ? { HOME: home } : {};
      },
    },
    // mise's `opencode` follows releases into 2.x, so it would upgrade 1.x across that line.
    mise: { tool: "opencode", upgrade: generation === "v2" },
  });

type OpenCodeRuntimeProbe = Effect.Success<
  ReturnType<typeof makeOpenCodeRuntimeProbe<OpenCodeRuntime.OpenCodeRuntimeError>>
>;

function byOpenCodeRuntime<A, E, R, PE>(
  probed: Effect.Effect<ProbedOpenCode | undefined, PE>,
  paths: { readonly v1: Effect.Effect<A, E, R>; readonly v2: Effect.Effect<A, E, R> },
): Effect.Effect<A, E, R> {
  return probed.pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.flatMap((result) => (result?.generation === "v2" ? paths.v2 : paths.v1)),
  );
}

// An unread catalog keeps what the registry found before rather than the machine catalog.
function workspaceModelsFor(
  machineModels: ReadonlyArray<ServerProviderModel>,
  cwdModels: Option.Option<ReadonlyArray<ServerProviderModel>>,
) {
  if (Option.isNone(cwdModels)) return { workspaceModelsPending: true };
  return Equal.equals(cwdModels.value, machineModels)
    ? {}
    : { models: cwdModels.value, workspaceModels: cwdModels.value };
}

// Hot reads use the last successful probe; session opens await it to select the correct protocol.
function selectOpenCodeRuntimeAdapter(input: {
  readonly probe: OpenCodeRuntimeProbe;
  readonly resolve: Effect.Effect<ProbedOpenCode, OpenCodeRuntime.OpenCodeRuntimeError>;
  readonly v1: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly v2: ProviderAdapter.ProviderAdapterV2["Service"];
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  const pick = <PE>(probed: Effect.Effect<ProbedOpenCode | undefined, PE>) =>
    byOpenCodeRuntime(probed, { v1: Effect.succeed(input.v1), v2: Effect.succeed(input.v2) });
  const hot = pick(Effect.map(input.probe.lastSuccess, Option.getOrUndefined));
  return {
    instanceId: input.v1.instanceId,
    driver: DRIVER_KIND,
    getCapabilities: Effect.fn("OpenCodeDriver.getCapabilities")(function* () {
      const probed = Option.getOrUndefined(yield* input.probe.lastSuccess);
      const adapter = yield* pick(Effect.succeed(probed));
      const capabilities = yield* adapter.getCapabilities();
      return {
        ...capabilities,
        turns: {
          ...capabilities.turns,
          supportsNativeGoals:
            capabilities.turns.supportsNativeGoals ??
            (probed?.generation === "v2" && compareSemverVersions(probed.version, "2.2.5") >= 0),
        },
      };
    }),
    planSelectionTransition: (transition) =>
      Effect.flatMap(hot, (adapter) => adapter.planSelectionTransition(transition)),
    openSession: (session) =>
      Effect.flatMap(pick(input.resolve), (adapter) => adapter.openSession(session)),
  };
}

function selectOpenCodeRuntimeTextGeneration(
  resolve: Effect.Effect<ProbedOpenCode, OpenCodeRuntime.OpenCodeRuntimeError>,
  v1: ProviderTextGenerationRuntime,
  v2: ProviderTextGenerationRuntime,
): ProviderTextGenerationRuntime {
  return {
    supportedOperations: v1.supportedOperations.filter((operation) =>
      v2.supportedOperations.includes(operation),
    ),
    generateCommitMessage: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.generateCommitMessage(input),
        v2: v2.generateCommitMessage(input),
      }),
    generatePrContent: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.generatePrContent(input),
        v2: v2.generatePrContent(input),
      }),
    generateBranchName: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.generateBranchName(input),
        v2: v2.generateBranchName(input),
      }),
    generateThreadTitle: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.generateThreadTitle(input),
        v2: v2.generateThreadTitle(input),
      }),
    generateReviewGuide: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.generateReviewGuide(input),
        v2: v2.generateReviewGuide(input),
      }),
    generateKnowledgeCandidates: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.generateKnowledgeCandidates(input),
        v2: v2.generateKnowledgeCandidates(input),
      }),
    generateConversationSummary: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.generateConversationSummary(input),
        v2: v2.generateConversationSummary(input),
      }),
    generateModelEvaluation: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.generateModelEvaluation(input),
        v2: v2.generateModelEvaluation(input),
      }),
    generateTranscriptionPostProcessing: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.generateTranscriptionPostProcessing(input),
        v2: v2.generateTranscriptionPostProcessing(input),
      }),
    curateProjectMemory: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.curateProjectMemory(input),
        v2: v2.curateProjectMemory(input),
      }),
    checkFactStanding: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.checkFactStanding(input),
        v2: v2.checkFactStanding(input),
      }),
  };
}

export type OpenCodeDriverEnv =
  | OpenCodeAdapterV2.OpenCodeAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Digest.Digest
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | OpenCodeRuntime.OpenCodeRuntime
  | Path.Path;

export const OpenCodeDriver: ProviderDriver<
  OpenCodeSettings,
  OpenCodeDriverEnv,
  OpenCodeUsageReaderEnv
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenCode",
    supportsMultipleInstances: true,
  },
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => decodeOpenCodeSettings({}),
  usage: openCodeUsageReader,
  create: Effect.fn("OpencodeDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    usageAccess = Effect.succeed(false),
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
    const agentScope = yield* AgentScope;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const digest = yield* Digest.Digest;
    const host = yield* ProviderHost.ProviderHost;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
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
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
      // The instance registry has already read a referenced password from its secret provider.
      serverPassword: settingsSecretLiteral(config.serverPassword),
    } satisfies OpenCodeSettings;
    const probeRuntime = (probeEnv: NodeJS.ProcessEnv) =>
      probeOpenCodeRuntime(effectiveConfig, probeEnv).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
      );
    const runtimeProbe = yield* makeOpenCodeRuntimeProbe(
      probeRuntime(providerProbeEnvironment(processEnv)),
    );
    // A mise shim cannot install OpenCode offline; a session or text generation the user started
    // may, so without a cached result it probes once online and caches what mise installed.
    const resolveRuntime =
      effectiveConfig.serverUrl.trim().length > 0
        ? runtimeProbe.get
        : runtimeProbe.lastSuccess.pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () => probeRuntime(processEnv).pipe(Effect.tap(runtimeProbe.record)),
              }),
            ),
          );
    const noUpdate = makeManualOnlyProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: null,
    });
    const maintenanceFor = (probed: typeof runtimeProbe.get) =>
      probed.pipe(
        Effect.map((result) => result.generation),
        Effect.option,
        Effect.flatMap((generation) =>
          Option.isNone(generation)
            ? Effect.succeed(noUpdate)
            : resolveProviderMaintenanceCapabilitiesEffect(openCodeUpdateFor(generation.value), {
                binaryPath: effectiveConfig.binaryPath,
                env: processEnv,
                npmCacheDir: pathService.join(host.paths.providerStatusCacheDir, "npm"),
              }),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      );
    const cachedMaintenance = yield* makeCachedProviderMaintenanceResolution(
      maintenanceFor(
        isLocalOpenCodeServerUrl(effectiveConfig.serverUrl)
          ? probeOpenCodeBinary(
              effectiveConfig.binaryPath,
              providerProbeEnvironment(processEnv),
            ).pipe(
              Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
              Effect.catch(() => runtimeProbe.get),
            )
          : runtimeProbe.get,
      ),
    );
    const resolveMaintenance = (options?: { readonly fresh?: boolean }) =>
      !effectiveConfig.enabled
        ? Effect.succeed(noUpdate)
        : options?.fresh === true
          ? runtimeProbe.refresh.pipe(
              Effect.ignore,
              Effect.andThen(cachedMaintenance({ fresh: true })),
            )
          : cachedMaintenance();
    const openCodeV1Adapter = yield* OpenCodeAdapterV2.OpenCodeAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config: effectiveConfig,
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
    const openCode2Client = yield* OpenCode2Client.make.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    const openCode2Server = yield* OpenCode2Server.make({
      binaryPath: effectiveConfig.binaryPath,
      serverUrl: effectiveConfig.serverUrl,
      serverPassword: effectiveConfig.serverPassword,
      directory: host.paths.cwd,
      environment: processEnv,
    }).pipe(
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
      Effect.provideService(OpenCode2Client.OpenCode2Client, openCode2Client),
    );
    const inferenceCatalog =
      isInferenceProviderConfig(config) &&
      config.inferenceEnabled &&
      environment.some(({ name }) => name === "T3_INFERENCE_KEY")
        ? config.inferenceModels
        : undefined;
    const orchestrationAdapter = selectOpenCodeRuntimeAdapter({
      probe: runtimeProbe,
      resolve: resolveRuntime,
      v1: openCodeV1Adapter,
      v2: yield* OpenCode2AdapterV2.make(instanceId).pipe(
        Effect.provideService(OpenCode2Server.OpenCode2Server, openCode2Server),
      ),
    });
    const catalogWatch = yield* makeOpenCode2CatalogWatch(processEnv);
    // An external server may not have the host's cwd; without a location it uses its own default.
    const machineDirectory = (connection: OpenCode2Server.OpenCode2Connection) =>
      connection.external ? undefined : host.paths.cwd;
    const followMachineCatalog = (connection: OpenCode2Server.OpenCode2Connection) =>
      catalogWatch.follow(
        connection.url,
        connection.events,
        loadOpenCode2DirectoryCatalog(connection.client, machineDirectory(connection)),
      );
    // Locations whose scan T3 saw end on the current server; a scan is announced only once.
    let scans = { url: "", scanned: new Set<string>() };
    // Skills that appear after a location's scan, such as a new SKILL.md or an MCP server's skills,
    // are announced by another skill.updated.
    const skillRescans = yield* Queue.unbounded<string, Cause.Done>();
    yield* Effect.addFinalizer(() => Queue.end(skillRescans));
    const skillUpdates = new Map<string, number>();
    // Locations T3 has listed, by the cwd the registry asked for.
    const listed = new Map<string, string>();
    const driverScope = yield* Effect.scope;
    // A configured server keeps one connection, so a dropped event stream is resubscribed on read.
    let following:
      | { readonly url: string; readonly subscribed: Deferred.Deferred<void> }
      | undefined;
    const followScans = Effect.fn("OpenCodeDriver.followScans")(function* (
      connection: OpenCode2Server.OpenCode2Connection,
    ) {
      if (following?.url === connection.url) return yield* Deferred.await(following.subscribed);
      const current = { url: connection.url, subscribed: yield* Deferred.make<void>() };
      following = current;
      const stopFollowing = Effect.sync(() => {
        if (following === current) following = undefined;
      }).pipe(Effect.andThen(Deferred.succeed(current.subscribed, undefined)));
      // Resubscribing to the same server keeps the scans it already announced.
      if (scans.url !== connection.url) scans = { url: connection.url, scanned: new Set() };
      const { scanned } = scans;
      const noteSkillUpdate = (event: {
        readonly type: string;
        readonly location?: { readonly directory?: string } | undefined;
      }) => {
        const directory = event.location?.directory;
        // The skill.updated that ends a scan is covered by the read that waits for that scan.
        if (
          event.type !== "skill.updated" ||
          directory === undefined ||
          !(scanned.has(directory) || listed.has(directory))
        ) {
          return Effect.void;
        }
        skillUpdates.set(directory, (skillUpdates.get(directory) ?? 0) + 1);
        const cwd = listed.get(directory);
        return cwd === undefined ? Effect.void : Queue.offer(skillRescans, cwd);
      };
      // Subscribe before the caller reads: OpenCode sends no events from before a subscription.
      const scope = yield* Scope.fork(driverScope);
      const release = stopFollowing.pipe(Effect.andThen(Scope.close(scope, Exit.void)));
      const events = yield* connection.events.pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.option,
        Effect.onInterrupt(() => release),
      );
      if (events._tag === "None") return yield* release;
      yield* Deferred.succeed(current.subscribed, undefined);
      yield* Effect.forkIn(
        followOpenCode2Scans(events.value.pipe(Stream.tap(noteSkillUpdate)), (directory) =>
          Effect.sync(() => scanned.add(directory)),
        ).pipe(Effect.ensuring(release)),
        driverScope,
      );
    });
    // A session or text generation can start the server too, and reads no catalog when it does.
    yield* Stream.runForEach(openCode2Server.connections, (connection) =>
      followScans(connection).pipe(Effect.andThen(followMachineCatalog(connection))),
    ).pipe(Effect.forkScoped);
    const loadOpenCode2Models = yield* makeOpenCode2ModelLoader(
      openCode2Server.withConnection((connection) =>
        followMachineCatalog(connection).pipe(
          Effect.andThen(loadOpenCode2Catalog(connection.client, machineDirectory(connection))),
        ),
      ),
      processEnv,
    );
    const listOpenCode2Workspace = (cwd: string) =>
      openCode2Server.withConnection((connection) =>
        Effect.gen(function* () {
          const { client, events, url } = connection;
          const [, stream] = yield* Effect.all(
            [followScans(connection), events.pipe(Effect.option)],
            {
              concurrency: "unbounded",
            },
          );
          // OpenCode names a location by its resolved path (no trailing slash or `..`).
          const directory = pathService.resolve(cwd);
          const location = { directory };
          if (scans.url !== url) scans = { url, scanned: new Set() };
          const { scanned: seen } = scans;
          const scanned = yield* Deferred.make<void>();
          if (stream._tag === "Some") {
            yield* followOpenCode2Scans(stream.value, (scannedDirectory) =>
              scannedDirectory === directory
                ? Deferred.succeed(scanned, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ).pipe(Effect.forkScoped);
          }
          const wasListed = listed.has(directory);
          let skillUpdatesBeforeRead = 0;
          const workspace = yield* loadOpenCode2Workspace(
            Effect.sync(() => {
              skillUpdatesBeforeRead = skillUpdates.get(directory) ?? 0;
            }).pipe(
              Effect.andThen(
                Effect.all(
                  {
                    skills: client.skill.list({ location }).pipe(Effect.map((list) => list.data)),
                    commands: client.command
                      .list({ location })
                      .pipe(Effect.map((list) => list.data)),
                  },
                  { concurrency: "unbounded" },
                ),
              ),
            ),
            Deferred.await(scanned),
            // Without events no scan can be awaited, so trust the first read as before.
            stream._tag === "None" || seen.has(directory),
            processEnv,
          );
          // A location loaded before T3 watched never announces its scan; wait for it only once.
          seen.add(directory);
          listed.set(directory, cwd);
          // The listener rescans a listed location itself; a first read may miss what it announced.
          if (!wasListed && (skillUpdates.get(directory) ?? 0) !== skillUpdatesBeforeRead) {
            yield* Queue.offer(skillRescans, cwd);
          }
          return workspace;
        }).pipe(Effect.scoped),
      );
    const serverOwner = yield* OpenCodeServerOwner.make({
      binaryPath: effectiveConfig.binaryPath,
      directory: host.paths.cwd,
      ...(effectiveConfig.serverPassword ? { serverPassword: effectiveConfig.serverPassword } : {}),
      environment: processEnv,
    });
    const textGeneration = selectOpenCodeRuntimeTextGeneration(
      resolveRuntime,
      yield* makeOpenCodeTextGeneration(effectiveConfig, {
        environment: processEnv,
        directory: host.paths.cwd,
      }).pipe(Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner)),
      yield* OpenCode2TextGeneration.make({
        binaryPath: effectiveConfig.binaryPath,
        serverUrl: effectiveConfig.serverUrl,
        environment: processEnv,
        directory: host.paths.cwd,
      }).pipe(
        Effect.provideService(OpenCode2Server.OpenCode2Server, openCode2Server),
        Effect.provideService(OpenCode2Client.OpenCode2Client, openCode2Client),
      ),
    );

    // Reads OpenCode's auth.json and credential table for the Go key.
    const legacyUsageLimits = withUsageAccess(
      usageAccess,
      readOpenCodeGoUsageLimits({
        enabled: effectiveConfig.enabled,
        serverUrl: effectiveConfig.serverUrl,
        environment: processEnv,
      }),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(Digest.Digest, digest),
    );
    let unsupportedUsageVersion: string | undefined;
    const checkUsageLimits = Effect.gen(function* () {
      if (!effectiveConfig.enabled) return yield* legacyUsageLimits;
      const runtime = yield* runtimeProbe.get;
      if (runtime.generation === "v1" || runtime.version === unsupportedUsageVersion)
        return yield* legacyUsageLimits;
      const limits = yield* openCode2Server.withConnection((connection) =>
        connection.usageLimits(machineDirectory(connection)),
      );
      if (limits === undefined) unsupportedUsageVersion = runtime.version;
      if (limits !== undefined && limits.unavailable?.reason !== "unsupported") return limits;
      // Without a Console workspace the server reports nothing, but a local Go key still has usage.
      const legacy = yield* legacyUsageLimits;
      return limits !== undefined && legacy.unavailable?.reason === "unsupported" ? limits : legacy;
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catch(() =>
        Effect.map(DateTime.now, (now) => ({
          checkedAt: DateTime.formatIso(now),
          windows: [],
          unavailable: {
            reason: "probeFailed" as const,
            message: "OpenCode could not read workspace usage.",
          },
        })),
      ),
    );
    const checkProvider = Effect.all(
      {
        // A configured loopback server reports its running version. Probe the local
        // CLI separately so a completed npm update is not mistaken for a failure
        // while that independently managed server still runs the previous binary.
        installedVersion:
          effectiveConfig.enabled && isLocalOpenCodeServerUrl(effectiveConfig.serverUrl)
            ? probeOpenCodeBinary(
                effectiveConfig.binaryPath,
                providerProbeEnvironment(processEnv),
              ).pipe(
                Effect.map((probed) => probed.version),
                Effect.orElseSucceed(() => undefined),
              )
            : Effect.void,
        provider: checkOpenCodeProviderStatus(
          effectiveConfig,
          host.paths.cwd,
          runtimeProbe.refresh,
          loadOpenCode2Models,
          processEnv,
          host.compatibility,
        ).pipe(
          Effect.annotateLogs({ providerInstanceId: instanceId }),
          Effect.annotateSpans({ providerInstanceId: instanceId }),
        ),
        usageLimits: checkUsageLimits,
      },
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(({ provider, usageLimits, installedVersion }) => ({
        ...provider,
        usageLimits,
        ...(installedVersion === undefined ? {} : { installedVersion }),
      })),
      Effect.map(stampIdentity),
      Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
    );
    // The CLI writes its full JSON inventory to stdout, but the Bun-compiled binary does not
    // flush more than one 64KB pipe buffer to a non-TTY stdout, so the piped output arrives
    // truncated and unparseable — which degrades to an empty skill list and poisons the workspace
    // snapshot the `$` picker reads.
    const loadWorkspaceInventory = (
      client: Parameters<typeof OpenCodeRuntime.loadOpenCodeCommands>[0],
    ) =>
      Effect.all(
        {
          skills: openCodeRuntime.loadOpenCodeSkills(client),
          commandInventory: OpenCodeRuntime.loadOpenCodeCommands(client).pipe(
            Effect.timeoutOption(resolveProviderProbeTimeoutMs("opencode", 10_000, processEnv)),
            Effect.map((commands) => ({
              commands: Option.getOrElse(commands, () => []),
              slashCommandsPending: Option.isNone(commands),
            })),
            // SDK errors leave command discovery to the provider's health.
            Effect.orElseSucceed(() => ({
              commands: [],
              slashCommandsPending: undefined,
            })),
          ),
          // A project's opencode.jsonc can define its own providers.
          models: OpenCodeRuntime.loadOpenCodeProviderCatalog(client).pipe(
            Effect.timeoutOption("10 seconds"),
            Effect.map(
              Option.flatMapNullishOr((catalog) =>
                openCodeProviderModels(effectiveConfig, catalog),
              ),
            ),
            Effect.orElseSucceed(() => Option.none<ReadonlyArray<ServerProviderModel>>()),
          ),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(({ skills, commandInventory, models }) => ({
          skills,
          models,
          ...commandInventory,
        })),
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

    const serverUrl = effectiveConfig.serverUrl.trim();
    const afterUpdate =
      serverUrl.length > 0
        ? replaceOutdatedService({
            binaryPath: effectiveConfig.binaryPath,
            serverUrl,
            environment: processEnv,
          }).pipe(
            Effect.ensuring(openCode2Server.forget),
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: "Failed to replace the OpenCode service after an update.",
                  cause,
                }),
            ),
            Effect.provideService(AgentScope, agentScope),
            Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, pathService),
          )
        : Effect.void;

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OpenCodeSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      checkProviderOnSettingsChange: () => false,
      // A failed or still-loading catalog must recover without a manual
      // refresh. Healthy instances need no recurring server starts.
      refreshOnInterval: (snapshot) =>
        snapshot.enabled &&
        snapshot.installed &&
        snapshot.status !== "ready" &&
        snapshot.auth.status === "unknown",
      initialSnapshot: (settings) =>
        makePendingOpenCodeProvider(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
      checkUsageLimits,
      recoverUsageOnInterval: true,
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) => {
        let enriched = snapshot;
        let catalog: ReadonlyArray<OpenCode2Model> | undefined;
        // Each publication replaces the whole snapshot, so both sources publish their combination.
        const publishing = Semaphore.makeUnsafe(1);
        const publish = publishing.withPermit(
          Effect.suspend(() =>
            publishSnapshot(
              catalog === undefined
                ? enriched
                : withOpenCode2Catalog(enriched, effectiveConfig, catalog),
            ),
          ),
        );
        return Effect.all(
          [
            resolveMaintenance().pipe(
              Effect.flatMap((maintenanceCapabilities) =>
                enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                  enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                }),
              ),
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
              Effect.flatMap((enrichedSnapshot) => {
                enriched = enrichedSnapshot;
                return publish;
              }),
            ),
            Stream.runForEach(catalogWatch.changes, (listed) => {
              catalog = listed;
              return publish;
            }),
          ],
          { concurrency: "unbounded", discard: true },
        );
      },
    }).pipe(
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
      ...(inferenceCatalog === undefined || openCode2Server.retire === undefined
        ? {}
        : { inferenceCatalog, retireInferenceCatalog: openCode2Server.retire }),
      snapshot,
      // A scan never installs OpenCode: without an offline probe result it fails and keeps the
      // last inventory rather than guessing 1.x.
      snapshotForCwd: (cwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : runtimeProbe.get.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail: `Failed to probe OpenCode for '${cwd}'`,
                    cause,
                  }),
              ),
              Effect.flatMap((probed) =>
                byOpenCodeRuntime(Effect.succeed(probed), {
                  v2: Effect.all(
                    [
                      snapshot.getSnapshot,
                      // A project's opencode.jsonc can define its own providers.
                      openCode2Server
                        .withConnection(({ client, events, url }) => {
                          const read = loadOpenCode2DirectoryCatalog(client, cwd);
                          return readSettledOpenCode2Catalog(read, processEnv).pipe(
                            Effect.tap((settled) =>
                              catalogWatch.follow(url, events, read, {
                                cwd,
                                ...Option.match(settled, {
                                  onNone: () => ({}),
                                  onSome: (catalog) => ({ settled: catalog }),
                                }),
                              }),
                            ),
                          );
                        })
                        .pipe(
                          Effect.orElseSucceed(() => Option.none<ReadonlyArray<OpenCode2Model>>()),
                          Effect.map(
                            Option.map((catalog) =>
                              openCode2ProviderModels(effectiveConfig, catalog),
                            ),
                          ),
                        ),
                      listOpenCode2Workspace(cwd).pipe(
                        // Leaves room for the reads around the scan wait, which uses the same override.
                        Effect.timeout(
                          2 * resolveProviderProbeTimeoutMs("opencode", 10_000, processEnv),
                        ),
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
                    ],
                    { concurrency: "unbounded" },
                  ).pipe(
                    Effect.map(([machineSnapshot, cwdModels, { skills, commands }]) => ({
                      ...machineSnapshot,
                      ...workspaceModelsFor(machineSnapshot.models, cwdModels),
                      skills: openCode2SkillsToServerProviderSkills(skills),
                      slashCommands: openCode2CommandsToServerProviderSlashCommands(commands),
                      // A finished scan lists at least the built-ins. None means it
                      // timed out, so the registry decides from the provider's health.
                      slashCommandsPending: commands.length > 0 ? false : undefined,
                    })),
                  ),
                  v1: Effect.all([
                    snapshot.getSnapshot,
                    loadWorkspaceForCwd(cwd).pipe(
                      // Leaves room for connection setup before the command fallback below.
                      Effect.timeout(
                        2 * resolveProviderProbeTimeoutMs("opencode", 10_000, processEnv),
                      ),
                    ),
                  ]).pipe(
                    Effect.map(
                      ([machineSnapshot, { skills, models, commands, slashCommandsPending }]) => ({
                        ...machineSnapshot,
                        ...workspaceModelsFor(machineSnapshot.models, models),
                        skills: openCodeSkillsToServerProviderSkills(skills),
                        slashCommands: openCodeCommandsToServerProviderSlashCommands(commands),
                        slashCommandsPending,
                      }),
                    ),
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
              ),
            ),
      workspaceRescans: Stream.merge(catalogWatch.rescans, Stream.fromQueue(skillRescans)),
      invalidateCaches: openCode2Server.forget,
      afterUpdate,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
