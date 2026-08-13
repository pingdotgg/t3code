/**
 * `t3 pair` - mint a pairing token for an already-running server and print it
 * as a QR code, without restarting anything.
 *
 * Discovery reads the `server-runtime.json` a live server persists next to its
 * database, then confirms the process is actually answering by fetching its
 * public environment descriptor. Inside a linked git worktree the worktree's
 * own `.t3` is checked first (matching dev-runner precedence); otherwise the
 * shared T3 home. `--tailscale` publishes the server over Tailscale Serve
 * HTTPS and pairs through the tailnet URL instead.
 */
import {
  AuthStandardClientScopes,
  ExecutionEnvironmentDescriptor,
  PortSchema,
} from "@t3tools/contracts";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import {
  buildTailscaleHttpsBaseUrl,
  DEFAULT_TAILSCALE_SERVE_PORT,
  ensureTailscaleServe,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import {
  type PersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  buildPairingUrl,
  formatHostForUrl,
  isLoopbackHost,
  isWildcardHost,
  renderTerminalQrCode,
  resolveHeadlessConnectionString,
} from "../startupAccess.ts";
import { baseDirFlag, DurationFromString } from "./config.ts";

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";
const PAIR_PROBE_TIMEOUT = Duration.millis(2_500);
// Tailscale provisions an HTTPS certificate on the first request to a fresh
// serve mapping, which can take a few seconds.
const TAILSCALE_PROBE_ATTEMPTS = 5;
const TAILSCALE_PROBE_RETRY_DELAY = Duration.seconds(1);

export type PairStateVariant = "userdata" | "dev";

// deriveServerPaths only checks devUrl for undefined-ness when picking the
// dev-vs-userdata state directory; the value itself is not used.
const DEV_VARIANT_PLACEHOLDER_URL = new URL("http://localhost");

export class NoRunningServerError extends Schema.TaggedErrorClass<NoRunningServerError>()(
  "NoRunningServerError",
  {
    checkedStatePaths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return [
      "No running T3 Code server found.",
      ...this.checkedStatePaths.map((statePath) => `  checked ${statePath}`),
      "Start one with `npx t3 serve`, or connect this machine with T3 Connect: `npx t3 connect`.",
    ].join("\n");
  }
}

// Each tailscale failure gets its own class (same reasoning as
// scripts/lib/dev-share.ts): distinct caller-visible message, distinct remedy.
export class TailscaleUnavailableError extends Schema.TaggedErrorClass<TailscaleUnavailableError>()(
  "TailscaleUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not talk to Tailscale. Is tailscaled running? Try `tailscale status`.";
  }
}

export class MagicDnsNameMissingError extends Schema.TaggedErrorClass<MagicDnsNameMissingError>()(
  "MagicDnsNameMissingError",
  {},
) {
  override get message(): string {
    return "This machine has no MagicDNS name. Run `tailscale up` and enable MagicDNS.";
  }
}

export class ServesOtherEnvironmentError extends Schema.TaggedErrorClass<ServesOtherEnvironmentError>()(
  "ServesOtherEnvironmentError",
  { servePort: Schema.Number },
) {
  override get message(): string {
    return `Tailscale Serve on HTTPS port ${String(this.servePort)} already fronts a different T3 Code server. Pass --tailscale-serve-port to publish this one on another port.`;
  }
}

export class TailscaleServeFailedError extends Schema.TaggedErrorClass<TailscaleServeFailedError>()(
  "TailscaleServeFailedError",
  { servePort: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return `tailscale serve failed for HTTPS port ${String(this.servePort)}. Run \`tailscale serve --https=${String(this.servePort)} --bg <local-url>\` by hand to see why.`;
  }
}

export class ServePortOccupiedError extends Schema.TaggedErrorClass<ServePortOccupiedError>()(
  "ServePortOccupiedError",
  { servePort: Schema.Number },
) {
  override get message(): string {
    return `HTTPS port ${String(this.servePort)} on the tailnet already serves something that is not a T3 Code server. Pass --tailscale-serve-port to publish this one on another port.`;
  }
}

/** The URL a browser or phone should pair through, absent Tailscale. */
export const resolveDirectPairingBaseUrl = (state: PersistedServerRuntimeState): string =>
  state.devUrl ?? resolveHeadlessConnectionString(state.host, state.port);

export class DevServerNotProxiableError extends Schema.TaggedErrorClass<DevServerNotProxiableError>()(
  "DevServerNotProxiableError",
  { devUrl: Schema.String },
) {
  override get message(): string {
    return `Tailscale Serve can only proxy plain-HTTP local targets, and this dev server runs at ${this.devUrl}. Pair without --tailscale instead.`;
  }
}

const isDevServerNotProxiableError = Schema.is(DevServerNotProxiableError);

/**
 * The local endpoint Tailscale Serve should proxy to. Dev servers are
 * single-origin, so the web dev server's port is the one to publish; the
 * backend rides along behind Vite's proxy. Serve targets are always plain
 * HTTP, so an HTTPS dev URL cannot be proxied and is rejected.
 */
export const resolveTailscaleLocalTarget = (
  state: PersistedServerRuntimeState,
): { readonly localPort: number; readonly localHost?: string } | DevServerNotProxiableError => {
  if (state.devUrl !== undefined) {
    const devUrl = new URL(state.devUrl);
    if (devUrl.protocol !== "http:") {
      return new DevServerNotProxiableError({ devUrl: state.devUrl });
    }
    const localPort = devUrl.port.length > 0 ? Number.parseInt(devUrl.port, 10) : 80;
    return isLoopbackHost(devUrl.hostname)
      ? { localPort }
      : { localPort, localHost: devUrl.hostname };
  }
  // A server bound to one specific interface does not answer on loopback, so
  // the proxy has to target that interface directly.
  if (state.host !== undefined && !isWildcardHost(state.host) && !isLoopbackHost(state.host)) {
    return { localPort: state.port, localHost: formatHostForUrl(state.host) };
  }
  return { localPort: state.port };
};

export const formatPairOutput = (input: {
  readonly serverLabel: string;
  readonly origin: string;
  readonly pairingUrl: string;
  readonly token: string;
  readonly expiresAt: DateTime.Utc;
  readonly notes: ReadonlyArray<string>;
}): string =>
  [
    `Pairing with ${input.serverLabel} (${input.origin}).`,
    "",
    renderTerminalQrCode(input.pairingUrl),
    "",
    `Pairing URL: ${input.pairingUrl}`,
    `Token: ${input.token}`,
    `Expires: ${DateTime.formatIso(input.expiresAt)}`,
    ...input.notes.flatMap((note) => ["", `Note: ${note}`]),
    "",
  ].join("\n");

/**
 * Three outcomes, because they drive different decisions: a T3 descriptor
 * (pair with it), nothing answering (safe to configure Tailscale Serve), or
 * something answering that is not a T3 server (do NOT overwrite its mapping).
 */
type EnvironmentProbeResult =
  | { readonly _tag: "descriptor"; readonly descriptor: ExecutionEnvironmentDescriptor }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "not-a-t3-server" };

const probeEnvironmentDescriptor = (
  baseUrl: string,
): Effect.Effect<EnvironmentProbeResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(new URL(WELL_KNOWN_ENVIRONMENT_PATH, baseUrl).toString());
    const response = yield* client.execute(request).pipe(
      Effect.timeout(PAIR_PROBE_TIMEOUT),
      // Transport failure or timeout: nothing (reachable) is listening there.
      Effect.mapError(() => ({ _tag: "unreachable" }) as const),
    );
    // Bad-gateway family means a proxy (Tailscale Serve) answered for a
    // backend that is gone — a stale mapping, not a live occupant. Treating
    // it as unreachable lets `t3 pair --tailscale` repair its own mapping
    // after the server's port changed.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return { _tag: "unreachable" } as const;
    }
    // Anything else that answered HTTP but not with a valid descriptor is
    // some other service.
    const descriptor = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.mapError(() => ({ _tag: "not-a-t3-server" }) as const),
    );
    return { _tag: "descriptor", descriptor } as const;
  }).pipe(Effect.catch((outcome) => Effect.succeed(outcome)));

// signal 0 delivers nothing; it only reports whether the pid exists. EPERM
// means it exists but belongs to another user, which still counts as alive.
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

interface DiscoveredPairTarget {
  readonly baseDir: string;
  readonly variant: PairStateVariant;
  readonly state: PersistedServerRuntimeState;
  readonly descriptor: ExecutionEnvironmentDescriptor;
}

const discoverPairTarget = Effect.fn("pair.discoverPairTarget")(function* (
  explicitBaseDir: string | undefined,
) {
  const bases: Array<string> = [];
  if (explicitBaseDir !== undefined && explicitBaseDir.trim().length > 0) {
    bases.push(yield* resolveBaseDir(explicitBaseDir));
  } else {
    // Same precedence as dev-runner: inside a linked worktree its own `.t3`
    // outranks the shared home, so `t3 pair` in a worktree pairs with the dev
    // server under test rather than the daily-driver install.
    const worktreeHome = yield* resolveWorktreeT3Home(process.cwd());
    if (worktreeHome !== undefined) {
      bases.push(worktreeHome);
    }
    const envHome = yield* Config.string("T3CODE_HOME").pipe(Config.option);
    bases.push(yield* resolveBaseDir(Option.getOrUndefined(envHome)));
  }

  const checkedStatePaths: Array<string> = [];
  for (const baseDir of new Set(bases)) {
    for (const variant of ["userdata", "dev"] as const) {
      const derivedPaths = yield* ServerConfig.deriveServerPaths(
        baseDir,
        variant === "dev" ? DEV_VARIANT_PLACEHOLDER_URL : undefined,
        {},
      );
      const statePath = derivedPaths.serverRuntimeStatePath;
      checkedStatePaths.push(statePath);
      const state = yield* readPersistedServerRuntimeState(statePath);
      if (Option.isNone(state)) {
        continue;
      }
      // The pid check guards against a dead server's state file whose port
      // was since reused by a different server: pairing would then mint a
      // token in the old database while the QR code points at the new server.
      if (!isProcessAlive(state.value.pid)) {
        continue;
      }
      const probed = yield* probeEnvironmentDescriptor(state.value.origin);
      if (probed._tag !== "descriptor") {
        continue;
      }
      return {
        baseDir,
        variant,
        state: state.value,
        descriptor: probed.descriptor,
      } satisfies DiscoveredPairTarget;
    }
  }
  return yield* new NoRunningServerError({ checkedStatePaths });
});

/**
 * Server config pointed at the discovered server's state directory, so the
 * minted token lands in the database the running server reads from. Built by
 * hand rather than through `resolveServerConfig` to keep the dev-vs-userdata
 * choice pinned to where the runtime state was actually found, independent of
 * ambient environment variables.
 */
const makePairServerConfig = Effect.fn(function* (input: {
  readonly target: DiscoveredPairTarget;
  readonly logLevel: ServerConfig.ServerConfig["Service"]["logLevel"];
}) {
  const { baseDir, variant, state } = input.target;
  // The state-dir variant does not imply dev-ness: a worktree dev server uses
  // an explicit home and therefore lands in `userdata`. The recorded devUrl is
  // what actually marks a dev server.
  const devUrl = state.devUrl !== undefined ? new URL(state.devUrl) : undefined;
  const derivedPaths = yield* ServerConfig.deriveServerPaths(
    baseDir,
    variant === "dev" ? DEV_VARIANT_PLACEHOLDER_URL : undefined,
    {},
  );
  return ServerConfig.make({
    logLevel: input.logLevel,
    traceMinLevel: "Info",
    traceTimingEnabled: false,
    traceBatchWindowMs: 1_000,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-server",
    mode: "web",
    port: state.port,
    host: state.host,
    cwd: process.cwd(),
    baseDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl,
    devAllowedOrigins: [],
    noBrowser: true,
    startupPresentation: "headless",
    desktopBootstrapToken: undefined,
    desktopTelemetryFd: undefined,
    desktopTelemetryControlFd: undefined,
    resourceMonitorPath: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: DEFAULT_TAILSCALE_SERVE_PORT,
  });
});

const awaitEnvironmentDescriptor = Effect.fn(function* (baseUrl: string) {
  let last: EnvironmentProbeResult = { _tag: "unreachable" };
  for (let attempt = 0; attempt < TAILSCALE_PROBE_ATTEMPTS; attempt += 1) {
    last = yield* probeEnvironmentDescriptor(baseUrl);
    if (last._tag === "descriptor") {
      return last;
    }
    yield* Effect.sleep(TAILSCALE_PROBE_RETRY_DELAY);
  }
  return last;
});

const resolveTailscalePairingBase = Effect.fn("pair.resolveTailscalePairingBase")(
  function* (input: { readonly target: DiscoveredPairTarget; readonly servePort: number }) {
    const notes: Array<string> = [];
    const status = yield* readTailscaleStatus.pipe(
      Effect.mapError((cause) => new TailscaleUnavailableError({ cause })),
    );
    if (status.magicDnsName === null) {
      return yield* new MagicDnsNameMissingError();
    }
    const baseUrl = buildTailscaleHttpsBaseUrl({
      magicDnsName: status.magicDnsName,
      servePort: input.servePort,
    });

    // Only an unreachable port, or a mapping already fronting this exact
    // environment, is safe to (re)configure. Any other responder — T3 or not
    // — must not have its mapping silently replaced.
    const existing = yield* probeEnvironmentDescriptor(baseUrl);
    if (existing._tag === "descriptor") {
      if (existing.descriptor.environmentId !== input.target.descriptor.environmentId) {
        return yield* new ServesOtherEnvironmentError({ servePort: input.servePort });
      }
      // Matching environment id proves the mapping reaches this server, but
      // not through which port: for a dev server it may front the backend
      // (whose /.well-known also answers) while /pair only renders through
      // the web origin. Reuse as-is for regular servers; fall through and
      // repoint our own mapping at the web port for dev servers.
      if (input.target.state.devUrl === undefined) {
        return { baseUrl, notes };
      }
    }
    if (existing._tag === "not-a-t3-server") {
      return yield* new ServePortOccupiedError({ servePort: input.servePort });
    }

    const localTarget = resolveTailscaleLocalTarget(input.target.state);
    if (isDevServerNotProxiableError(localTarget)) {
      return yield* localTarget;
    }
    yield* ensureTailscaleServe({
      localPort: localTarget.localPort,
      servePort: input.servePort,
      ...(localTarget.localHost !== undefined ? { localHost: localTarget.localHost } : {}),
    }).pipe(
      Effect.mapError(
        (cause) => new TailscaleServeFailedError({ servePort: input.servePort, cause }),
      ),
    );
    notes.push(
      `Tailscale Serve now maps ${baseUrl} to this server and persists across restarts. Remove it with \`tailscale serve --https=${String(input.servePort)} off\`.`,
    );

    const probed = yield* awaitEnvironmentDescriptor(baseUrl);
    if (probed._tag === "descriptor") {
      if (probed.descriptor.environmentId !== input.target.descriptor.environmentId) {
        return yield* new ServesOtherEnvironmentError({ servePort: input.servePort });
      }
    } else {
      notes.push(
        "The HTTPS endpoint has not answered yet. First use can take a moment while Tailscale provisions certificates.",
      );
    }
    return { baseUrl, notes };
  },
);

const mintPairingLink = Effect.fn("pair.mintPairingLink")(function* (input: {
  readonly config: ServerConfig.ServerConfig["Service"];
  readonly ttl: Option.Option<Duration.Duration>;
  readonly label: Option.Option<string>;
}) {
  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* environmentAuth.createPairingLink({
      scopes: AuthStandardClientScopes,
      subject: "one-time-token",
      label: Option.getOrElse(input.label, () => "t3 pair"),
      ...(Option.isSome(input.ttl) ? { ttl: input.ttl.value } : {}),
    });
  }).pipe(
    Effect.provide(
      EnvironmentAuth.runtimeLayer.pipe(
        Layer.provide(ServerConfig.layer(input.config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, input.config.logLevel)),
      ),
    ),
  );
});

const ttlFlag = Flag.string("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription(
    "Token TTL, for example `5m`, `1h`, or `15 minutes`. Defaults to 5 minutes.",
  ),
  Flag.optional,
);

const labelFlag = Flag.string("label").pipe(
  Flag.withDescription("Optional label shown in the server's connections list."),
  Flag.optional,
);

const tailscaleFlag = Flag.boolean("tailscale").pipe(
  Flag.withDescription(
    "Publish the server over Tailscale Serve HTTPS and pair through the tailnet URL.",
  ),
  Flag.withDefault(false),
);

const tailscaleServePortFlag = Flag.integer("tailscale-serve-port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("HTTPS port for Tailscale Serve when --tailscale is enabled."),
  Flag.withDefault(DEFAULT_TAILSCALE_SERVE_PORT),
);

export const pairCommand = Command.make("pair", {
  baseDir: baseDirFlag,
  ttl: ttlFlag,
  label: labelFlag,
  tailscale: tailscaleFlag,
  tailscaleServePort: tailscaleServePortFlag,
}).pipe(
  Command.withDescription(
    "Mint a pairing token for a running T3 Code server and print it as a QR code.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const cliLogLevel = yield* GlobalFlag.LogLevel;
      // Default to Warn so storage/migration chatter cannot bury the QR code;
      // an explicit --log-level still wins.
      const logLevel = Option.getOrElse(cliLogLevel, () => "Warn" as const);

      const target = yield* discoverPairTarget(Option.getOrUndefined(flags.baseDir));

      const notes: Array<string> = [];
      let pairingBaseUrl: string;
      if (flags.tailscale) {
        const resolved = yield* resolveTailscalePairingBase({
          target,
          servePort: flags.tailscaleServePort,
        });
        pairingBaseUrl = resolved.baseUrl;
        notes.push(...resolved.notes);
      } else {
        pairingBaseUrl = resolveDirectPairingBaseUrl(target.state);
        if (isLoopbackHost(new URL(pairingBaseUrl).hostname)) {
          notes.push(
            "This URL is only reachable from this machine. Re-run with --tailscale, or restart the server with a reachable --host.",
          );
        }
        if (target.variant === "dev" && target.state.devUrl === undefined) {
          notes.push(
            "This dev server did not record its web URL; restart it so pairing can go through the web origin.",
          );
        }
      }

      const config = yield* makePairServerConfig({ target, logLevel });
      const issued = yield* mintPairingLink({ config, ttl: flags.ttl, label: flags.label });
      const pairingUrl = buildPairingUrl(pairingBaseUrl, issued.credential);

      yield* Console.log(
        formatPairOutput({
          serverLabel: target.descriptor.label,
          origin: target.state.origin,
          pairingUrl,
          token: issued.credential,
          expiresAt: issued.expiresAt,
          notes,
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);
