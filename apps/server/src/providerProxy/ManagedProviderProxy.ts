/** Runs CLIProxyAPI on loopback while `providerProxy.host` is `managed`, restarting it with backoff. */
import {
  providerProxyHost,
  type ProviderProxyRuntimeStatus,
  type ServerSettings as ServerSettingsSchema,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CliProxyApiBinary from "./CliProxyApiBinary.ts";
import type { ManagedProxyEndpoint } from "./effectiveProxy.ts";

const API_KEY_SECRET = "provider-proxy-managed-api-key";
const MANAGEMENT_KEY_SECRET = "provider-proxy-managed-management-key";
const PORT_SECRET = "provider-proxy-managed-port";
const LOOPBACK_HOST = "127.0.0.1";
const READY_LINE = /\bAPI server started successfully\b/u;
// An instantly failing proxy would otherwise respawn in a tight loop.
const RESTART_STABLE_UPTIME_MS = 30_000;
const RESTART_BACKOFF_BASE_MS = 1_000;
const RESTART_BACKOFF_MAX_MS = 60_000;
// A failed download is retried no sooner than this, so an offline host does not redownload in a loop.
const INSTALL_RETRY_MS = 10 * 60_000;

/** CLIProxyAPI's v8 config layout. T3 rewrites it before every start. */
export function renderCliProxyApiConfig(input: {
  readonly port: number;
  readonly apiKey: string;
  readonly managementKey: string;
  readonly authDir: string;
}): string {
  // JSON strings are valid YAML double-quoted scalars, including escaped Windows paths.
  const quote = JSON.stringify;
  return [
    "# Written by T3 Code before each start; edits are replaced.",
    "config-version: 8",
    "server:",
    `  host: ${quote(LOOPBACK_HOST)}`,
    `  port: ${input.port}`,
    "management:",
    "  allow-remote: false",
    `  secret-key: ${quote(input.managementKey)}`,
    "  disable-control-panel: true",
    "access:",
    "  api-keys:",
    `    - ${quote(input.apiKey)}`,
    "routing:",
    // A thread stays on one account, which also keeps prompt caching working.
    "  session-affinity: true",
    "oauth:",
    `  auth-dir: ${quote(input.authDir)}`,
    "",
  ].join("\n");
}

export class ManagedProviderProxy extends Context.Service<
  ManagedProviderProxy,
  {
    readonly status: Effect.Effect<ProviderProxyRuntimeStatus>;
    /** Emits the current status, then each change. */
    readonly statusChanges: Stream.Stream<ProviderProxyRuntimeStatus>;
    /** Stable across restarts; `undefined` until the host was first set to `managed`. */
    readonly endpoint: Effect.Effect<ManagedProxyEndpoint | undefined>;
    /** Emits the current endpoint, then each change. */
    readonly endpointChanges: Stream.Stream<ManagedProxyEndpoint | undefined>;
  }
>()("t3/providerProxy/ManagedProviderProxy") {
  /** No proxy process; `endpoint` stands in for one that already started. */
  static readonly layerTest = (endpoint?: ManagedProxyEndpoint) =>
    Layer.succeed(ManagedProviderProxy, {
      status: Effect.succeed<ProviderProxyRuntimeStatus>({
        status: endpoint === undefined ? "stopped" : "running",
      }),
      statusChanges: Stream.empty,
      endpoint: Effect.succeed(endpoint),
      endpointChanges: Stream.make(endpoint),
    });
}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const binary = yield* CliProxyApiBinary.CliProxyApiBinary;
  const net = yield* NetService.NetService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const dataDir = path.join(config.stateDir, "cliproxyapi");
  const authDir = path.join(dataDir, "auths");
  const configPath = path.join(dataDir, "config.yaml");

  const statusRef = yield* SubscriptionRef.make<ProviderProxyRuntimeStatus>({ status: "stopped" });
  const endpointRef = yield* SubscriptionRef.make<ManagedProxyEndpoint | undefined>(undefined);
  const setStatus = (status: ProviderProxyRuntimeStatus) => SubscriptionRef.set(statusRef, status);

  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const randomKey = (name: string) =>
    secrets
      .getOrCreateRandom(name, 32)
      .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("base64url")));
  const savedPort = secrets
    .get(PORT_SECRET)
    .pipe(
      Effect.map(Option.map((bytes) => Number(text(bytes)))),
      Effect.map(Option.filter((port) => Number.isInteger(port) && port > 0 && port < 65_536)),
    );
  const toEndpoint = (port: number, apiKey: string, managementKey: string) => ({
    url: `http://${LOOPBACK_HOST}:${port}`,
    apiKey,
    managementKey,
  });

  const loadEndpoint = Effect.gen(function* () {
    const port = yield* savedPort;
    if (Option.isNone(port)) return undefined;
    const apiKey = yield* secrets.get(API_KEY_SECRET);
    const managementKey = yield* secrets.get(MANAGEMENT_KEY_SECRET);
    if (Option.isNone(apiKey) || Option.isNone(managementKey)) return undefined;
    return toEndpoint(
      port.value,
      Buffer.from(apiKey.value).toString("base64url"),
      Buffer.from(managementKey.value).toString("base64url"),
    );
  });

  // Keeps the saved port while it is free, so proxied instances do not rebuild on every restart.
  const prepareEndpoint = Effect.fn("ManagedProviderProxy.prepareEndpoint")(function* () {
    const apiKey = yield* randomKey(API_KEY_SECRET);
    const managementKey = yield* randomKey(MANAGEMENT_KEY_SECRET);
    const saved = yield* savedPort;
    const port =
      Option.isSome(saved) && (yield* net.canListenOnHost(saved.value, LOOPBACK_HOST))
        ? saved.value
        : yield* net.reserveLoopbackPort(LOOPBACK_HOST);
    if (Option.getOrUndefined(saved) !== port) {
      yield* secrets.set(PORT_SECRET, new TextEncoder().encode(String(port)));
    }
    const endpoint = toEndpoint(port, apiKey, managementKey);
    const previous = yield* SubscriptionRef.get(endpointRef);
    if (
      previous?.url !== endpoint.url ||
      previous.apiKey !== endpoint.apiKey ||
      previous.managementKey !== endpoint.managementKey
    ) {
      yield* SubscriptionRef.set(endpointRef, endpoint);
    }
    return { port, apiKey, managementKey };
  });

  const writeConfig = Effect.fn("ManagedProviderProxy.writeConfig")(function* (input: {
    readonly port: number;
    readonly apiKey: string;
    readonly managementKey: string;
  }) {
    yield* fileSystem.makeDirectory(authDir, { recursive: true });
    yield* fileSystem.chmod(dataDir, 0o700);
    // The file holds the keys until CLIProxyAPI hashes the management key on startup.
    yield* fileSystem.writeFileString(configPath, renderCliProxyApiConfig({ ...input, authDir }), {
      mode: 0o600,
    });
    yield* fileSystem.chmod(configPath, 0o600);
  });

  const ensureBinary = Effect.gen(function* () {
    const resolved = yield* binary.resolve;
    if (resolved.status === "available") return resolved;
    if (resolved.status === "unsupported") {
      return yield* Effect.fail(
        `CLIProxyAPI has no build for ${resolved.platform}-${resolved.arch}.` as const,
      );
    }
    yield* setStatus({ status: "installing" });
    return yield* binary.install.pipe(Effect.mapError((error) => error.message));
  });

  /** One proxy process, from start to exit. Fails with a message the status can show. */
  const runOnce = Effect.fn("ManagedProviderProxy.runOnce")(function* (
    executable: CliProxyApiBinary.AvailableCliProxyApiBinary,
  ) {
    const keys = yield* prepareEndpoint();
    yield* writeConfig(keys);
    yield* setStatus({ status: "starting", version: executable.version });
    const child = yield* spawner.spawn(
      ChildProcess.make(executable.executablePath, ["-config", configPath], {
        cwd: dataDir,
        shell: false,
        detached: false,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    yield* Effect.logInfo("CLIProxyAPI started", {
      pid: Number(child.pid),
      version: executable.version,
      source: executable.source,
    });
    // Output lines are per-event work for the life of the process; keep them untraced.
    yield* child.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach(
        Effect.fnUntraced(function* (line) {
          if (READY_LINE.test(line)) {
            yield* setStatus({ status: "running", version: executable.version });
          }
          const output = line
            .replaceAll(keys.apiKey, "<redacted>")
            .replaceAll(keys.managementKey, "<redacted>");
          if (/\[(?:warn|warning|error|fatal|panic)\]/iu.test(line)) {
            yield* Effect.logWarning("CLIProxyAPI output", { output });
          } else {
            yield* Effect.logDebug("CLIProxyAPI output", { output });
          }
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const exitCode = Number(yield* child.exitCode);
    return yield* Effect.fail(`CLIProxyAPI exited with code ${exitCode}.`);
  }, Effect.scoped);

  const supervise = Effect.gen(function* () {
    let restartDelay = 0;
    while (true) {
      const executable = yield* Effect.result(ensureBinary);
      if (executable._tag === "Failure") {
        yield* setStatus({ status: "error", message: executable.failure });
        yield* Effect.logWarning("Could not prepare CLIProxyAPI", { reason: executable.failure });
        yield* Effect.sleep(INSTALL_RETRY_MS);
        continue;
      }
      const startedAt = yield* Clock.currentTimeMillis;
      const result = yield* runOnce(executable.success).pipe(
        Effect.catch((error) =>
          typeof error === "string"
            ? Effect.succeed(error)
            : Effect.logWarning("Could not start CLIProxyAPI", { cause: error }).pipe(
                Effect.as("Could not start CLIProxyAPI."),
              ),
        ),
      );
      const uptime = (yield* Clock.currentTimeMillis) - startedAt;
      restartDelay =
        uptime >= RESTART_STABLE_UPTIME_MS
          ? RESTART_BACKOFF_BASE_MS
          : Math.min(Math.max(restartDelay * 2, RESTART_BACKOFF_BASE_MS), RESTART_BACKOFF_MAX_MS);
      yield* setStatus({ status: "error", message: result });
      yield* Effect.logWarning("CLIProxyAPI stopped; restarting", { reason: result, restartDelay });
      yield* Effect.sleep(restartDelay);
    }
  });

  const supervisor = yield* FiberHandle.make<never, never>();
  const applySemaphore = yield* Semaphore.make(1);
  let appliedManaged = false;
  const apply = Effect.fn("ManagedProviderProxy.apply")(function* (managed: boolean) {
    if (managed === appliedManaged) return;
    appliedManaged = managed;
    yield* FiberHandle.clear(supervisor);
    if (!managed) {
      yield* setStatus({ status: "stopped" });
      return;
    }
    yield* FiberHandle.run(supervisor, supervise);
  }, applySemaphore.withPermits(1));

  const initialEndpoint = yield* loadEndpoint.pipe(Effect.orElseSucceed(() => undefined));
  if (initialEndpoint !== undefined) yield* SubscriptionRef.set(endpointRef, initialEndpoint);

  const isManaged = (current: ServerSettingsSchema) =>
    providerProxyHost(current.providerProxy) === "managed";
  // Subscribe before the seed read so a save in between is not lost.
  const changes = yield* settings.subscribeChanges;
  const initialManaged = yield* settings.getSettings.pipe(
    Effect.map(isManaged),
    Effect.orElseSucceed(() => false),
  );
  yield* apply(initialManaged);
  yield* changes.pipe(
    Stream.map(isManaged),
    Stream.changes,
    Stream.runForEach(apply),
    Effect.forkScoped,
  );

  return ManagedProviderProxy.of({
    status: SubscriptionRef.get(statusRef),
    statusChanges: SubscriptionRef.changes(statusRef),
    endpoint: SubscriptionRef.get(endpointRef),
    endpointChanges: SubscriptionRef.changes(endpointRef),
  });
});

export const layer = Layer.effect(ManagedProviderProxy, make);
