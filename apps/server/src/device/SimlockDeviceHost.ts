/**
 * Alpha: devices leased from a Simlock gateway the user runs. Opening a device
 * takes a lease through the gateway's agent-device front, so agents drive it
 * with the same session; closing it returns the device to the pool, wiped.
 * A lease left by a server that crashed ends one TTL after its last renewal.
 */
import {
  DeviceBootError,
  type DeviceHostSummary,
  DeviceHostUnavailableError,
  DeviceOperationError,
  type DevicePlatform,
  type DevicePlatformAvailability,
  type SimlockDeviceHostConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { truncate } from "@t3tools/shared/String";
import type { NodeRuntimeUnavailableError } from "@t3tools/shared/nodeRuntime";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { writeAgentDeviceConfig } from "./AgentDeviceTarget.ts";
import * as DeviceHost from "./DeviceHost.ts";

const CATALOG_TTL_MS = 60_000;
const REQUEST_TIMEOUT = Duration.seconds(15);
// The gateway queues a lease request for up to five minutes when every device is busy.
const OPEN_TIMEOUT = Duration.minutes(7);
const COMMAND_TIMEOUT = Duration.minutes(2);
// Renewal keeps a watched but idle device; a lease this server stops renewing ends after LEASE_TTL.
const RENEW_INTERVAL = Duration.minutes(2);
const LEASE_TTL_MS = 10 * 60_000;
const STREAM_PATH = /^\/vendor\/serve-sim\/helper\/([^/]+)\/stream\.avcc$/;
const INPUT_PATH = "/vendor/serve-sim/helper/ws";

const Catalog = Schema.Struct({
  platforms: Schema.Array(
    Schema.Struct({
      platform: Schema.String,
      modelRuntimes: Schema.Record(Schema.String, Schema.Array(Schema.String)),
      modelClasses: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      modelWorkers: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
    }),
  ),
});
const decodeCatalog = Schema.decodeUnknownEffect(Catalog);
const decodeSessionRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ leaseId: Schema.String })),
);
const CliFailure = Schema.Struct({
  error: Schema.Struct({
    message: Schema.String,
    hint: Schema.optional(Schema.String),
    logPath: Schema.optional(Schema.String),
    // An open bag; `line` holds the daemon's raw response when agent-device could not parse it.
    details: Schema.optional(Schema.Unknown),
  }),
});
const responseLine = (details: unknown) =>
  typeof details === "object" &&
  details !== null &&
  "line" in details &&
  typeof details.line === "string"
    ? details.line
    : undefined;
const decodeCliFailure = Schema.decodeUnknownOption(Schema.fromJsonString(CliFailure));
const describeCliFailure = ({ error }: typeof CliFailure.Type) => {
  const line = responseLine(error.details);
  return [
    error.message,
    error.hint,
    line ? `The daemon answered: ${truncate(line, 300)}` : undefined,
    error.logPath ? `Log: ${error.logPath}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
};

interface Lease {
  readonly leaseId: string;
  readonly platform: DevicePlatform;
  readonly name: string;
  readonly version: string;
  readonly session: string;
  readonly dir: string;
  readonly configPath: string;
  readonly installDirectory: string;
}

const catalogId = (platform: DevicePlatform, model: string) => `simlock:${platform}:${model}`;
const parseCatalogId = (id: string) => {
  const match = /^simlock:(ios|android):(.+)$/.exec(id);
  return match ? { platform: match[1] as DevicePlatform, model: match[2]! } : null;
};
const platformVersion = (platform: DevicePlatform, runtime: string | undefined) =>
  `${platform === "ios" ? "iOS" : "Android"}${runtime ? ` ${runtime}` : ""}`;

const AGENT_DEVICE_PATH = "/v1/agent-device";
const sameOrigin = (left: string, right: string) => {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
};

/**
 * The gateway and token this machine's agent-device uses, from agent-device's own remote-daemon
 * variables, which Simlock tells its clients to set. Null unless they point at a Simlock gateway.
 */
export const machineSimlockToken = (environment: NodeJS.ProcessEnv) => {
  const base = environment.AGENT_DEVICE_DAEMON_BASE_URL?.trim().replace(/\/+$/, "");
  const agentToken = environment.AGENT_DEVICE_DAEMON_AUTH_TOKEN?.trim();
  if (!base?.endsWith(AGENT_DEVICE_PATH) || !agentToken) return null;
  const gatewayUrl = base.slice(0, -AGENT_DEVICE_PATH.length);
  return URL.canParse(gatewayUrl) ? { gatewayUrl, agentToken } : null;
};

/**
 * The saved token, else this machine's agent-device token; each only for the gateway it belongs to,
 * so a URL being edited never receives either.
 */
export const resolveSimlockToken = (
  gatewayUrl: string,
  saved: { readonly gatewayUrl: string; readonly agentToken: string } | undefined,
  environment: NodeJS.ProcessEnv,
) => {
  if (saved?.agentToken && sameOrigin(saved.gatewayUrl, gatewayUrl))
    return { agentToken: saved.agentToken, source: "settings" as const };
  const machine = machineSimlockToken(environment);
  return machine && sameOrigin(machine.gatewayUrl, gatewayUrl)
    ? { agentToken: machine.agentToken, source: "env" as const }
    : null;
};

/** What went wrong talking to a gateway, without the gateway's own text. */
export const describeGatewayFailure = (cause: unknown, gatewayUrl: string, tokenOwner: string) => {
  if (Cause.isTimeoutError(cause)) return `Could not reach the Simlock gateway at ${gatewayUrl}.`;
  if (!HttpClientError.isHttpClientError(cause))
    return `The Simlock gateway at ${gatewayUrl} sent an answer T3 could not read.`;
  if (cause.reason._tag === "StatusCodeError") {
    const status = cause.reason.response.status;
    return status === 401 || status === 403
      ? `The Simlock gateway refused the agent token for ${tokenOwner}.`
      : `The Simlock gateway at ${gatewayUrl} answered HTTP ${status}.`;
  }
  return cause.reason._tag === "TransportError"
    ? `Could not reach the Simlock gateway at ${gatewayUrl}.`
    : `The Simlock gateway at ${gatewayUrl} sent an answer T3 could not read.`;
};

const decodeIdentity = Schema.decodeUnknownEffect(
  Schema.Struct({ name: Schema.String, role: Schema.String }),
);

/** Who the gateway says a token is, via GET /v1/identity. */
export const simlockIdentity = Effect.fn("SimlockDeviceHost.identity")(function* (
  gatewayUrl: string,
  agentToken: string,
) {
  const http = yield* HttpClient.HttpClient;
  return yield* http
    .execute(
      HttpClientRequest.get(`${gatewayUrl.replace(/\/$/, "")}/v1/identity`).pipe(
        HttpClientRequest.bearerToken(agentToken),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeIdentity),
      Effect.scoped,
      Effect.timeout(REQUEST_TIMEOUT),
    );
});

/** T3's own agent-device CLI, installed on first use. */
export type AgentDeviceCli = Effect.Effect<
  { readonly nodePath: string; readonly entryPath: string },
  DeviceHost.DeviceHostError | NodeRuntimeUnavailableError
>;

export const make = Effect.fn("SimlockDeviceHost.make")(function* (
  config: SimlockDeviceHostConfig,
  agentDeviceCli: AgentDeviceCli,
) {
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const server = yield* ServerConfig.ServerConfig;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const environment = yield* HostProcess.Environment;
  const hostId = config.id;
  const gateway = config.gatewayUrl.replace(/\/$/, "");
  const agentToken = resolveSimlockToken(config.gatewayUrl, config, environment)?.agentToken ?? "";
  const agentDeviceUrl = `${gateway}/v1/agent-device`;
  const hostDir = path.join(server.stateDir, "device", "simlock", hostId);
  const leases = new Map<string, Lease>();
  let starting = 0;
  // Bumped by every stop, so an open that finishes after one returns its lease instead of keeping it.
  let stops = 0;
  const slotLock = yield* Semaphore.make(1);
  const keepAlive = yield* FiberMap.make<string>();
  let catalog: {
    readonly at: number;
    readonly devices: ReadonlyArray<DeviceHost.HostDevice>;
  } | null = null;
  // The last answer from the gateway; empty until it gives one.
  let platforms: ReadonlyArray<DevicePlatformAvailability> = [];
  let ready: DeviceHost.DeviceHostReady | null = null;
  let cli: { readonly nodePath: string; readonly entryPath: string } | null = null;

  const unavailable = (reason: string, cause?: unknown) =>
    new DeviceHostUnavailableError({
      hostId,
      hostLabel: config.label,
      reason,
      ...(cause === undefined ? {} : { cause }),
    });

  const request = (
    method: "GET" | "POST" | "DELETE",
    route: string,
    body?: Readonly<Record<string, unknown>>,
  ) =>
    http
      .execute(
        (method === "GET"
          ? HttpClientRequest.get(`${gateway}${route}`)
          : method === "POST"
            ? HttpClientRequest.post(`${gateway}${route}`).pipe(
                HttpClientRequest.bodyJsonUnsafe(body ?? {}),
              )
            : HttpClientRequest.delete(`${gateway}${route}`)
        ).pipe(HttpClientRequest.bearerToken(agentToken)),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.scoped,
        Effect.timeout(REQUEST_TIMEOUT),
      );

  const agentEnvironment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries({
      ...environment,
      ELECTRON_RUN_AS_NODE: "1",
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    }).filter(
      ([name]) =>
        !/^AGENT_DEVICE_(DAEMON_BASE_URL|DAEMON_AUTH_TOKEN|CONFIG|STATE_DIR|SESSION)$/.test(name),
    ),
  );

  /** Runs T3's own agent-device CLI against the lease's session; its failure message is the reason. */
  const agentDevice = Effect.fn("SimlockDeviceHost.agentDevice")(function* (
    lease: Pick<Lease, "session" | "configPath">,
    args: ReadonlyArray<string>,
    options: { readonly cwd?: string; readonly timeout?: Duration.Input } = {},
  ) {
    if (!cli) return yield* unavailable(`${config.label} is not ready.`);
    const result = yield* runner
      .run({
        command: cli.nodePath,
        args: [
          cli.entryPath,
          ...args,
          "--session",
          lease.session,
          "--config",
          lease.configPath,
          "--json",
        ],
        env: agentEnvironment,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        timeout: options.timeout ?? COMMAND_TIMEOUT,
      })
      .pipe(Effect.mapError((cause) => unavailable("agent-device could not run.", cause)));
    if (result.code !== 0) {
      const failure = decodeCliFailure(result.stdout);
      return yield* unavailable(
        Option.match(failure, {
          onNone: () => `agent-device ${args[0]} failed (exit code ${result.code ?? "none"}).`,
          onSome: describeCliFailure,
        }),
      );
    }
    return result.stdout;
  });

  const fetchCatalog = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (catalog && now - catalog.at < CATALOG_TTL_MS) return catalog.devices;
    if (!agentToken) {
      return yield* unavailable(`Add an agent token for ${config.label} in Settings.`);
    }
    const decoded = yield* request("GET", "/v1/catalog").pipe(
      Effect.flatMap(decodeCatalog),
      Effect.mapError((cause) =>
        unavailable(describeGatewayFailure(cause, gateway, config.label), cause),
      ),
    );
    const byPlatform = decoded.platforms.map((entry) => {
      if (entry.platform !== "ios" && entry.platform !== "android") return null;
      const platform: DevicePlatform = entry.platform;
      return Object.entries(entry.modelRuntimes).flatMap(([model, runtimes]) => {
        const kind = entry.modelClasses?.[model];
        const workers = entry.modelWorkers?.[model];
        if (runtimes.length === 0 || (workers !== undefined && workers.length === 0)) return [];
        if (kind !== undefined && kind !== "phone" && kind !== "tablet") return [];
        return [
          {
            id: catalogId(platform, model),
            platform,
            name: model,
            version: platformVersion(platform, runtimes.at(-1)),
            booted: false,
            physical: false,
          } satisfies DeviceHost.HostDevice,
        ];
      });
    });
    const devices = byPlatform.flatMap((entry) => entry ?? []);
    // A platform with nothing to offer is usually its workers reconnecting; caching that would
    // hide it for the TTL, so only a catalog with devices on every platform is kept.
    catalog =
      devices.length > 0 && byPlatform.every((entry) => entry === null || entry.length > 0)
        ? { at: now, devices }
        : null;
    return devices;
  });

  const loadCatalog = fetchCatalog.pipe(
    Effect.tap((devices) =>
      Effect.sync(() => {
        platforms = (["ios", "android"] as const).map((platform) =>
          devices.some((device) => device.platform === platform)
            ? { platform, available: true }
            : {
                platform,
                available: false,
                reason: `The pool has no ${platform === "ios" ? "iOS" : "Android"} devices.`,
              },
        );
      }),
    ),
    Effect.tapError((error) =>
      Effect.sync(() => {
        platforms = (["ios", "android"] as const).map((platform) => ({
          platform,
          available: false,
          reason: error.reason,
        }));
      }),
    ),
  );

  const forget = (lease: Lease) =>
    Effect.suspend(() => {
      leases.delete(lease.leaseId);
      return fs.remove(lease.dir, { recursive: true, force: true }).pipe(Effect.ignore);
    });

  /** Ends the lease through its session, or over HTTP when the session is gone. */
  const release = Effect.fn("SimlockDeviceHost.release")(function* (lease: Lease) {
    yield* agentDevice(lease, ["close"]).pipe(
      Effect.catch(() => request("DELETE", `/v1/leases/${encodeURIComponent(lease.leaseId)}`)),
      Effect.tapError((cause) =>
        Effect.logWarning("Could not release Simlock lease", { leaseId: lease.leaseId, cause }),
      ),
      Effect.ignore,
    );
    yield* forget(lease);
  });

  /** Renews until the lease ends on its own or reaches its maximum age, then releases it. */
  const renewLoop = Effect.fn("SimlockDeviceHost.renewLoop")(function* (lease: Lease) {
    const deadline =
      (yield* Clock.currentTimeMillis) +
      Duration.toMillis(Duration.minutes(config.maxLeaseMinutes));
    while (true) {
      const left = deadline - (yield* Clock.currentTimeMillis);
      yield* Effect.sleep(Duration.millis(Math.min(left, Duration.toMillis(RENEW_INTERVAL))));
      if ((yield* Clock.currentTimeMillis) >= deadline) break;
      const renewed = yield* request(
        "POST",
        `/v1/leases/${encodeURIComponent(lease.leaseId)}/renew`,
        { ttlMs: LEASE_TTL_MS },
      ).pipe(Effect.result);
      if (renewed._tag === "Success") continue;
      const error = renewed.failure;
      // Simlock ended it (lease_lost, an agent's close, or its TTL): stop listing it.
      if (
        error._tag === "HttpClientError" &&
        error.reason._tag === "StatusCodeError" &&
        error.reason.response.status === 404
      ) {
        return yield* forget(lease);
      }
      yield* Effect.logWarning("Could not renew Simlock lease", { leaseId: lease.leaseId, error });
    }
    yield* Effect.logInfo("Releasing Simlock lease at its maximum age", {
      leaseId: lease.leaseId,
    });
    yield* release(lease);
  });

  const reserveSlot = slotLock.withPermit(
    Effect.suspend(() => {
      if (leases.size + starting >= config.maxLeases) {
        return Effect.fail(
          unavailable(
            `${config.label} is limited to ${config.maxLeases} ${config.maxLeases === 1 ? "device" : "devices"} at once. Close one in the Device panel first.`,
          ),
        );
      }
      starting++;
      return Effect.void;
    }),
  );

  const openLease = Effect.fn("SimlockDeviceHost.openLease")(function* (
    device: DeviceHost.HostDevice,
    context: DeviceHost.DeviceOpenContext | undefined,
  ) {
    const target = parseCatalogId(device.id);
    if (!target) {
      const reason = "This Simlock device is no longer leased. Open it again from the list.";
      return yield* new DeviceBootError({
        hostId,
        deviceId: device.id,
        reason: "launch_failed",
        diagnostics: reason,
        cause: new Error(reason),
      });
    }
    const suffix = (yield* Random.nextIntBetween(0, 0xffffff)).toString(16).padStart(6, "0");
    const session = `t3-${suffix}`;
    const dir = path.join(hostDir, suffix);
    const configPath = path.join(dir, "agent-device.json");
    yield* writeAgentDeviceConfig(configPath, {
      baseUrl: agentDeviceUrl,
      token: agentToken,
      stateDir: dir,
    }).pipe(
      Effect.provide(services),
      Effect.mapError((cause) => unavailable("Could not write the agent-device config.", cause)),
    );
    // agent-device ties installs to the directory that opened the session.
    const installDirectory = context?.workspaceRoot
      ? yield* fs.realPath(context.workspaceRoot).pipe(Effect.orElseSucceed(() => dir))
      : dir;
    const pending = { session, configPath };
    const stopsAtOpen = stops;
    return yield* Effect.gen(function* () {
      yield* agentDevice(pending, ["connect", "proxy", "--daemon-base-url", agentDeviceUrl]);
      yield* agentDevice(
        pending,
        ["open", "--platform", target.platform, "--device", target.model],
        { cwd: installDirectory, timeout: OPEN_TIMEOUT },
      );
      const record = yield* fs
        .readFileString(path.join(dir, "remote-connections", `${session}.json`))
        .pipe(
          Effect.flatMap(decodeSessionRecord),
          Effect.mapError((cause) => unavailable("agent-device recorded no Simlock lease.", cause)),
        );
      const opened: Lease = {
        leaseId: record.leaseId,
        platform: target.platform,
        name: target.model,
        version: device.version,
        session,
        dir,
        configPath,
        installDirectory,
      };
      if (stops !== stopsAtOpen)
        return yield* unavailable("Device support stopped while the device was opening.");
      leases.set(opened.leaseId, opened);
      yield* FiberMap.run(keepAlive, opened.leaseId, renewLoop(opened));
      return opened.leaseId;
    }).pipe(
      // A failed or interrupted open may still hold a lease: close the session either way.
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Effect.void
          : agentDevice(pending, ["close"]).pipe(
              Effect.ignore,
              Effect.andThen(fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore)),
            ),
      ),
      Effect.mapError((error) =>
        error._tag === "DeviceHostUnavailableError"
          ? new DeviceBootError({
              hostId,
              deviceId: device.id,
              reason: "launch_failed",
              diagnostics: truncate(error.reason, 1_997),
              cause: new Error(error.reason),
            })
          : error,
      ),
    );
  });

  const leaseFor = (deviceId: string) => Option.fromNullishOr(leases.get(deviceId));
  const operationError = (operation: string) => (cause: unknown) =>
    new DeviceOperationError({ operation, reason: "request_failed", cause });

  const screenshotLease = Effect.fn("SimlockDeviceHost.screenshot")(
    function* (lease: Lease) {
      const file = path.join(
        lease.dir,
        `screenshot-${(yield* Random.nextIntBetween(0, 0xffffff)).toString(16)}.png`,
      );
      yield* agentDevice(lease, ["screenshot", file]);
      return yield* fs
        .readFile(file)
        .pipe(Effect.ensuring(fs.remove(file, { force: true }).pipe(Effect.ignore)));
    },
    Effect.mapError(operationError("screenshot")),
  );

  const devices: DeviceHost.DeviceOperations = {
    list: loadCatalog.pipe(
      Effect.mapError(operationError("list")),
      Effect.map((available) => ({
        devices: [
          ...available,
          ...[...leases.values()].map((lease): DeviceHost.HostDevice => ({
            id: lease.leaseId,
            platform: lease.platform,
            name: lease.name,
            version: lease.version,
            booted: true,
            physical: false,
          })),
        ],
        detail: undefined,
      })),
    ),
    boot: (device, context) =>
      leases.has(device.id)
        ? Effect.succeed(device.id)
        : Effect.acquireUseRelease(
            reserveSlot,
            () => openLease(device, context),
            () => Effect.sync(() => void starting--),
          ),
    attach: () => Effect.void,
    shutdown: (device) =>
      Option.match(leaseFor(device.id), {
        onNone: () => Effect.void,
        onSome: (lease) =>
          FiberMap.remove(keepAlive, lease.leaseId).pipe(Effect.andThen(release(lease))),
      }),
    screenshot: (device) =>
      Option.match(leaseFor(device.id), {
        onNone: () =>
          Effect.fail(operationError("screenshot")(new Error("The Simlock lease has ended"))),
        onSome: screenshotLease,
      }),
    agentEndpoint: (deviceId) =>
      Option.match(leaseFor(deviceId), {
        onNone: () => Effect.fail(unavailable("This Simlock lease has ended.")),
        onSome: (lease) =>
          Effect.succeed({
            baseUrl: agentDeviceUrl,
            token: agentToken,
            agentDeviceId: null,
            session: lease.session,
            stateDir: lease.dir,
            installDirectory: lease.installDirectory,
          }),
      }),
    endsDevices: true,
  };

  /**
   * The client speaks serve-sim to every Simlock lease: its AVCC stream and its input
   * socket map to the lease's own stream and input routes, which take the agent token.
   */
  const upstream: NonNullable<DeviceHost.DeviceHostReady["upstream"]> = (hubPath, search) =>
    Effect.sync(() => {
      const stream = STREAM_PATH.exec(hubPath);
      let deviceId: string | null;
      try {
        deviceId = stream
          ? decodeURIComponent(stream[1]!)
          : hubPath === INPUT_PATH
            ? search.get("device")
            : null;
      } catch {
        return null;
      }
      const lease = deviceId === null ? undefined : leases.get(deviceId);
      if (!lease) return null;
      return {
        url: `${gateway}/v1/leases/${encodeURIComponent(lease.leaseId)}/${stream ? "stream" : "input"}`,
        headers: { authorization: `Bearer ${agentToken}` },
        protocols: [],
      };
    });

  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = Effect.fn(
    "SimlockDeviceHost.ensureReady",
  )(function* (onPhase) {
    if (ready) return ready;
    // A missing token or unreachable gateway does not stop readiness: listing
    // and opening devices say what is wrong instead.
    yield* onPhase("installing");
    cli = yield* agentDeviceCli;
    const { nodePath } = cli;
    ready = {
      nodePath,
      hub: { origin: gateway },
      devices,
      upstream,
      // Simlock relays only simctl, adb, and devicectl, and only to a lease's owner.
      run: () =>
        Effect.succeed({
          stdout: "",
          stderr: "Simlock devices cannot run host commands.",
          code: 127,
        }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
    };
    return ready;
  });

  const stopAll = Effect.gen(function* () {
    stops++;
    yield* FiberMap.clear(keepAlive);
    yield* Effect.forEach([...leases.values()], release, { discard: true, concurrency: 4 });
  }).pipe(Effect.ignore);
  yield* Effect.addFinalizer(() => stopAll);

  const platformAvailability = (platform: DevicePlatform) =>
    loadCatalog.pipe(
      Effect.ignore,
      Effect.map(
        (): DevicePlatformAvailability =>
          platforms.find((candidate) => candidate.platform === platform) ?? {
            platform,
            available: false,
          },
      ),
    );

  const summary: Effect.Effect<DeviceHostSummary> = Effect.sync(() => ({
    id: hostId,
    label: config.label,
    kind: "simlock" as const,
    platforms,
    hubInstalled: true,
    agentDeviceInstalled: true,
  }));

  return DeviceHost.DeviceHost.of({
    id: hostId,
    label: config.label,
    summary,
    platformAvailability,
    ensureReady,
    ensureAgentReady: Effect.fn("SimlockDeviceHost.ensureAgentReady")(function* (onPhase) {
      return { ...(yield* ensureReady(onPhase)), agentDevice: null };
    }),
    current: Effect.sync(() => ready),
    stopAgent: Effect.void,
    stop: stopAll,
  });
});
