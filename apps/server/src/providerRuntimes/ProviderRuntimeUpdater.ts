// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import {
  ProviderInstanceId,
  ProviderRuntimeError,
  ProviderRuntimeSettings,
  ManagedProviderRuntime,
  ProviderRuntimeLogEntry,
  type ProviderInstanceConfig,
  type ProviderRuntimeSettingsPatch,
  type ProviderRuntimeStatus,
  type ServerProvider,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../config.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as ProviderMaintenanceRunner from "../provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  claudePlatformKey,
  isClaudeVersion,
  planRuntimeUpdate,
  type ManagedDriver,
} from "./runtimePlan.ts";

const CLAUDE_RELEASES = "https://downloads.claude.ai/claude-code-releases";
const CHECK_INTERVAL = Duration.hours(6);
const FIRST_CHECK_DELAY = Duration.seconds(90);
const MAX_LOG = 50;

const StoredState = Schema.Struct({
  settings: ProviderRuntimeSettings,
  managed: Schema.Array(ManagedProviderRuntime).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  log: Schema.Array(ProviderRuntimeLogEntry).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  lastCheckedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
type StoredState = typeof StoredState.Type;
const decodeState = Schema.decodeEffect(fromLenientJson(StoredState));
const decodeStateSync = Schema.decodeSync(StoredState);
const encodeState = Schema.encodeEffect(Schema.fromJsonString(StoredState));
const ClaudeManifest = Schema.Struct({
  platforms: Schema.Record(
    Schema.String,
    Schema.Struct({ binary: Schema.String, checksum: Schema.String, size: Schema.Number }),
  ),
});
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(ClaudeManifest));
const isRuntimeError = Schema.is(ProviderRuntimeError);

const runtimeError = (message: string) => new ProviderRuntimeError({ message });

export class ProviderRuntimeUpdater extends Context.Service<
  ProviderRuntimeUpdater,
  {
    readonly status: Effect.Effect<ProviderRuntimeStatus>;
    readonly updateSettings: (
      patch: ProviderRuntimeSettingsPatch,
    ) => Effect.Effect<ProviderRuntimeStatus, ProviderRuntimeError>;
    readonly checkNow: Effect.Effect<ProviderRuntimeStatus, ProviderRuntimeError>;
    readonly restore: (
      instanceId: string,
    ) => Effect.Effect<ProviderRuntimeStatus, ProviderRuntimeError>;
  }
>()("t3/providerRuntimes/ProviderRuntimeUpdater") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const maintenance = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
  const codex = yield* CodexInstallation.CodexInstallation;
  const statePath = path.join(config.stateDir, "provider-runtimes.json");
  const claudeRoot = path.join(config.baseDir, "tools", "claude");
  const lock = yield* Semaphore.make(1);
  const checking = yield* Ref.make(false);

  const readState = fs.readFileString(statePath).pipe(
    Effect.flatMap(decodeState),
    Effect.orElseSucceed(() => decodeStateSync({ settings: {} })),
  );
  const writeState = (state: StoredState) =>
    encodeState(state).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: statePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => runtimeError("Could not save provider update settings.")),
    );
  const statusOf = (state: StoredState): Effect.Effect<ProviderRuntimeStatus> =>
    Ref.get(checking).pipe(Effect.map((busy) => ({ ...state, checking: busy })));
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const appendLog = (state: StoredState, entry: Omit<ProviderRuntimeLogEntry, "at">) =>
    now.pipe(
      Effect.map((at) => ({ ...state, log: [{ ...entry, at }, ...state.log].slice(0, MAX_LOG) })),
    );

  const runVersion = (executable: string) =>
    spawner
      .string(ChildProcess.make(executable, ["--version"], { stdin: "ignore", stderr: "ignore" }))
      .pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.map((output) => output.trim()),
      );

  const musl = fs.exists("/lib/ld-musl-x86_64.so.1").pipe(Effect.orElseSucceed(() => false));

  /** Downloads Claude Code's official native build, verified against its release manifest. */
  const installClaude = Effect.gen(function* () {
    const key = claudePlatformKey({ platform, arch, musl: platform === "linux" && (yield* musl) });
    if (key === null)
      return yield* runtimeError(`Claude Code has no build for ${platform}-${arch}.`);
    const fetchText = (url: string) =>
      http.execute(HttpClientRequest.get(url)).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
        Effect.scoped,
      );
    const version = (yield* fetchText(`${CLAUDE_RELEASES}/latest`)).trim();
    if (!isClaudeVersion(version))
      return yield* runtimeError("Claude Code's release service did not answer.");
    const manifest = yield* fetchText(`${CLAUDE_RELEASES}/${version}/manifest.json`).pipe(
      Effect.flatMap(decodeManifest),
    );
    const entry = manifest.platforms[key];
    if (entry === undefined)
      return yield* runtimeError(`Claude Code ${version} has no ${key} build.`);
    const dir = path.join(claudeRoot, version);
    const executable = path.join(dir, entry.binary);
    if (!(yield* fs.exists(executable).pipe(Effect.orElseSucceed(() => false)))) {
      yield* fs.makeDirectory(dir, { recursive: true });
      const partial = `${executable}.partial`;
      const hash = NodeCrypto.createHash("sha256");
      yield* http
        .execute(HttpClientRequest.get(`${CLAUDE_RELEASES}/${version}/${key}/${entry.binary}`))
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) =>
            response.stream.pipe(
              Stream.tap((chunk) => Effect.sync(() => hash.update(chunk))),
              Stream.run(fs.sink(partial)),
            ),
          ),
          Effect.scoped,
          Effect.timeout(Duration.minutes(30)),
        );
      if (hash.digest("hex") !== entry.checksum) {
        yield* fs.remove(partial).pipe(Effect.ignore);
        return yield* runtimeError(
          "The Claude Code download failed its checksum. Nothing changed.",
        );
      }
      yield* fs.chmod(partial, 0o755);
      yield* fs.rename(partial, executable);
    }
    const reported = yield* runVersion(executable);
    if (!reported.includes(version)) {
      return yield* runtimeError(
        `The downloaded Claude Code did not start (reported "${reported}").`,
      );
    }
    return { version, executablePath: executable };
  }).pipe(
    Effect.mapError((error) =>
      isRuntimeError(error) ? error : runtimeError("Could not install Claude Code."),
    ),
  );

  /** Codex's managed runtime is the release upstream tested, updated when a newer compatible one ships. */
  const installCodex = Effect.gen(function* () {
    yield* codex.checkForUpdate;
    yield* codex.start;
    yield* codex.changes.pipe(
      Stream.filter((state) => ["succeeded", "failed", "cancelled", "idle"].includes(state.phase)),
      Stream.runHead,
      Effect.timeout(Duration.minutes(15)),
    );
    const executable = yield* codex.resolve();
    if (executable.source !== "managed") {
      return yield* runtimeError("A compatible Codex CLI on PATH is already in use.");
    }
    return { version: executable.version, executablePath: executable.executablePath };
  }).pipe(
    Effect.mapError((error) =>
      isRuntimeError(error) ? error : runtimeError("Could not install the Codex runtime."),
    ),
  );

  const installFor = (driver: ManagedDriver) =>
    driver === "claudeAgent" ? installClaude : installCodex;

  const instanceConfig = (
    instances: Readonly<Record<string, ProviderInstanceConfig>>,
    id: string,
  ) => (Object.hasOwn(instances, id) ? instances[id] : undefined);

  const pointInstanceAt = Effect.fn("ProviderRuntimeUpdater.pointInstanceAt")(function* (
    provider: ServerProvider,
    binaryPath: string,
    managed: boolean,
  ) {
    const current = yield* settingsService.getSettings;
    const existing = instanceConfig(current.providerInstances, provider.instanceId);
    const baseConfig = (existing?.config ?? {}) as Record<string, unknown>;
    const { binaryPath: _previous, ...rest } = baseConfig;
    const environment = (existing?.environment ?? []).filter(
      (variable) => variable.name !== "DISABLE_AUTOUPDATER",
    );
    yield* settingsService.updateProviderInstance({
      operation: "upsert",
      instanceId: ProviderInstanceId.make(provider.instanceId),
      instance: {
        ...(existing ?? { driver: provider.driver }),
        // Claude's own updater would replace the managed binary behind Continuum's back.
        environment:
          managed && provider.driver === "claudeAgent"
            ? [...environment, { name: "DISABLE_AUTOUPDATER", value: "1", sensitive: false }]
            : environment,
        config: binaryPath === "" ? rest : { ...rest, binaryPath },
      },
    });
    yield* registry.refreshInstance(ProviderInstanceId.make(provider.instanceId));
  });

  const checkOnce = Effect.gen(function* () {
    let state = yield* readState;
    const providers = yield* registry.getProviders;
    const current = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => runtimeError("Could not read provider settings.")),
    );
    for (const provider of providers) {
      const configured = instanceConfig(current.providerInstances, provider.instanceId)?.config as
        | { readonly binaryPath?: unknown }
        | undefined;
      const binaryPath = typeof configured?.binaryPath === "string" ? configured.binaryPath : "";
      const managed = state.managed.find((entry) => entry.instanceId === provider.instanceId);
      const plan = planRuntimeUpdate({ provider, binaryPath, managed, settings: state.settings });
      if (plan.kind === "none") continue;
      const label = provider.displayName ?? provider.driver;
      if (plan.kind === "in-place-update") {
        const result = yield* maintenance
          .updateProvider({
            provider: provider.driver,
            instanceId: ProviderInstanceId.make(provider.instanceId),
          })
          .pipe(Effect.result);
        state = yield* appendLog(state, {
          instanceId: provider.instanceId,
          action: "in-place-update",
          ok: result._tag === "Success",
          message:
            result._tag === "Success"
              ? `Updated ${label} with its installer.`
              : `Could not update ${label}: ${result.failure.message}`,
        });
        continue;
      }
      const installed = yield* installFor(plan.driver).pipe(Effect.result);
      if (installed._tag === "Failure") {
        state = yield* appendLog(state, {
          instanceId: provider.instanceId,
          action: "skipped",
          ok: false,
          message: installed.failure.message,
        });
        continue;
      }
      if (managed?.executablePath === installed.success.executablePath) continue;
      yield* pointInstanceAt(provider, installed.success.executablePath, true).pipe(
        Effect.mapError(() => runtimeError("Could not update the provider settings.")),
      );
      const record = {
        instanceId: provider.instanceId,
        driver: provider.driver,
        version: installed.success.version,
        executablePath: installed.success.executablePath,
        previousBinaryPath: managed?.previousBinaryPath ?? binaryPath,
        updatedAt: yield* now,
      };
      state = yield* appendLog(
        {
          ...state,
          managed: [
            ...state.managed.filter((entry) => entry.instanceId !== provider.instanceId),
            record,
          ],
        },
        {
          instanceId: provider.instanceId,
          action: managed ? "managed-update" : "managed-install",
          ok: true,
          message: `${label} now runs ${provider.driver === "codex" ? "Codex" : "Claude Code"} ${record.version}, kept up to date by Continuum. Its sign-in and sessions are unchanged.`,
        },
      );
    }
    state = { ...state, lastCheckedAt: yield* now };
    yield* writeState(state);
    return state;
  });

  const checkNow = lock.withPermits(1)(
    Ref.set(checking, true).pipe(
      Effect.andThen(checkOnce),
      Effect.ensuring(Ref.set(checking, false)),
      Effect.flatMap(statusOf),
    ),
  );

  const updateSettings = (patch: ProviderRuntimeSettingsPatch) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* readState;
        const next = { ...state, settings: { ...state.settings, ...patch } };
        yield* writeState(next);
        return yield* statusOf(next);
      }),
    );

  const restore = (instanceId: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        let state = yield* readState;
        const managed = state.managed.find((entry) => entry.instanceId === instanceId);
        if (managed === undefined)
          return yield* runtimeError("That provider uses its own CLI already.");
        const provider = (yield* registry.getProviders).find(
          (entry) => entry.instanceId === instanceId,
        );
        if (provider !== undefined) {
          yield* pointInstanceAt(provider, managed.previousBinaryPath, false).pipe(
            Effect.mapError(() => runtimeError("Could not update the provider settings.")),
          );
        }
        state = yield* appendLog(
          { ...state, managed: state.managed.filter((entry) => entry.instanceId !== instanceId) },
          {
            instanceId,
            action: "restore",
            ok: true,
            message: "Switched back to the CLI installed on this computer.",
          },
        );
        yield* writeState(state);
        return yield* statusOf(state);
      }),
    );

  // Checks shortly after startup, once providers have been probed, then periodically.
  yield* checkNow.pipe(
    Effect.ignoreCause({ log: true }),
    Effect.delay(FIRST_CHECK_DELAY),
    Effect.andThen(Effect.sleep(CHECK_INTERVAL)),
    Effect.forever,
    Effect.forkScoped,
  );

  return ProviderRuntimeUpdater.of({
    status: readState.pipe(Effect.flatMap(statusOf)),
    updateSettings,
    checkNow,
    restore,
  });
});

export const layer = Layer.effect(ProviderRuntimeUpdater, make);
