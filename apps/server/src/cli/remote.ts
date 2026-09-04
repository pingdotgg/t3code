/**
 * `t3 remote tailcat <subcommand>` - manage Tailcat remote access on the
 * running T3 Code server: status, enable/disable, connection codes, and the
 * trusted device list.
 *
 * Discovery and credentials mirror `t3 pair`: the running server is found
 * through the runtime state it persists next to its database, and every
 * invocation mints a short-lived administrative session in that database,
 * revoked when the command finishes. Calls go over the server's HTTP API,
 * which exists for exactly this purpose; the UIs drive the same service over
 * RPC.
 */
import {
  AuthAdministrativeScopes,
  EnvironmentAuthorizationError,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type TailcatConnectionCodeResult,
  type TailcatCreateConnectionCodeInput,
  TailcatFailureCode,
  TailcatRemoteAccessError,
  type TailcatRemoteAccessState,
  TailcatServeStatus,
  type TailcatTrustedPeer,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { TAILCAT_BINARY_OVERRIDE_ENV } from "@t3tools/tailcat/runtime";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { RpcClientError } from "effect/unstable/rpc";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { renderTerminalQrCode } from "../startupAccess.ts";
import { baseDirFlag, DurationFromString } from "./config.ts";
import { type DiscoveredPairTarget, discoverPairTarget, makePairServerConfig } from "./pair.ts";

/**
 * Bound for one unary call against the running server: generous for a busy
 * disk, short enough that a wedged server does not hang the terminal.
 */
export const RUNNING_SERVER_REQUEST_TIMEOUT = Duration.seconds(10);

// Enabling starts the tailcat process and waits for it to report an address;
// a cold start with a DERP handshake is a few seconds, so poll for up to 30s.
const ENABLE_POLL_INTERVAL = Duration.millis(500);
const ENABLE_POLL_ATTEMPTS = 60;

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const isTailcatRemoteAccessError = Schema.is(TailcatRemoteAccessError);

/** Failure codes that mean the tailcat binary itself is the problem, not this server's state. */
const TAILCAT_RUNTIME_FAILURE_CODES: ReadonlySet<TailcatFailureCode> = new Set([
  "binary-missing",
  "binary-not-executable",
  "version-incompatible",
]);

/** The running server plus the administrative session minted for one CLI invocation. */
export interface RunningServerSession {
  readonly target: DiscoveredPairTarget;
  /** Origin the server listens on; HTTP and the RPC WebSocket both live here. */
  readonly origin: string;
  readonly token: string;
}

/**
 * Anything the running server answered with that is not a typed Tailcat or
 * federation failure: rejected credentials, an internal error, a transport
 * failure, or no answer at all. The cause stays attached for logs.
 */
export class RunningServerRequestError extends Schema.TaggedErrorClass<RunningServerRequestError>()(
  "RunningServerRequestError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cause = this.cause;
    if (isEnvironmentHttpCommonError(cause) || isEnvironmentAuthorizationError(cause)) {
      return `The running server rejected ${this.operation}: ${cause.message}`;
    }
    if (Cause.isTimeoutError(cause)) {
      return `The running server did not answer ${this.operation} within ${Duration.format(RUNNING_SERVER_REQUEST_TIMEOUT)}.`;
    }
    if (isRpcClientError(cause)) {
      return `Lost the connection to the running server during ${this.operation}.`;
    }
    return `Failed to call the running server (${this.operation}).`;
  }
}

export class TailcatUnavailableError extends Schema.TaggedErrorClass<TailcatUnavailableError>()(
  "TailcatUnavailableError",
  {
    code: TailcatFailureCode,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return [
      `Tailcat is unavailable on this server (${this.code}): ${this.detail}`,
      `Install tailcat and point ${TAILCAT_BINARY_OVERRIDE_ENV} at the binary, or reinstall T3 Code to restore the bundled runtime.`,
    ].join("\n");
  }
}

export class TailcatNotReadyError extends Schema.TaggedErrorClass<TailcatNotReadyError>()(
  "TailcatNotReadyError",
  {
    status: TailcatServeStatus,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Tailcat remote access did not become ready (${this.status}): ${this.detail}`;
  }
}

/**
 * Discover the running server, mint an administrative session in its database
 * and run `run` with it. The session is revoked on the way out, including on
 * interruption, so a Ctrl-C leaves nothing behind.
 */
export const withRunningServerSession = Effect.fn("remote.withRunningServerSession")(function* <
  A,
  E,
  R,
>(input: {
  readonly baseDir: Option.Option<string>;
  readonly label: string;
  /** Machine-readable output must stay parseable, so `--json` raises the log floor to Error. */
  readonly quietLogs: boolean;
  readonly run: (session: RunningServerSession) => Effect.Effect<A, E, R>;
}) {
  const cliLogLevel = yield* GlobalFlag.LogLevel;
  // Default to Warn so storage/migration chatter cannot bury the output; an
  // explicit --log-level still wins unless the output has to be JSON.
  const logLevel = input.quietLogs
    ? ("Error" as const)
    : Option.getOrElse(cliLogLevel, () => "Warn" as const);
  const target = yield* discoverPairTarget(Option.getOrUndefined(input.baseDir));
  const config = yield* makePairServerConfig({ target, logLevel });

  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* Effect.acquireUseRelease(
      environmentAuth.issueSession({ scopes: AuthAdministrativeScopes, label: input.label }),
      (issued) => input.run({ target, origin: target.state.origin, token: issued.token }),
      (issued) =>
        environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
  }).pipe(
    Effect.provide(
      EnvironmentAuth.runtimeLayer.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, logLevel)),
      ),
    ),
  );
});

type TailcatCliError =
  | TailcatRemoteAccessError
  | TailcatUnavailableError
  | RunningServerRequestError;

interface TailcatApi {
  readonly state: Effect.Effect<TailcatRemoteAccessState, TailcatCliError>;
  readonly setEnabled: (
    enabled: boolean,
  ) => Effect.Effect<TailcatRemoteAccessState, TailcatCliError>;
  readonly createConnectionCode: (
    input: TailcatCreateConnectionCodeInput,
  ) => Effect.Effect<TailcatConnectionCodeResult, TailcatCliError>;
  readonly revokeTrustedPeer: (
    peerId: string,
  ) => Effect.Effect<TailcatRemoteAccessState, TailcatCliError>;
}

// A missing or incompatible binary is the one Tailcat failure the user fixes
// on their own machine, so it gets the override hint; everything else is
// already worded for them by the server.
const tailcatCliErrorFromServer = (
  error: TailcatRemoteAccessError,
): TailcatRemoteAccessError | TailcatUnavailableError =>
  TAILCAT_RUNTIME_FAILURE_CODES.has(error.code)
    ? new TailcatUnavailableError({ code: error.code, detail: error.message })
    : error;

const tailcatUnavailableFromState = (
  state: TailcatRemoteAccessState,
): Option.Option<TailcatUnavailableError> => {
  if (state.status !== "unavailable") {
    return Option.none();
  }
  const runtimeDetail =
    state.runtime !== null && !state.runtime.compatible
      ? `tailcat ${state.runtime.version} at ${state.runtime.executablePath} is not compatible with this server (wants ${state.runtime.pinnedVersion}).`
      : "The Tailcat runtime is not available.";
  return Option.some(
    new TailcatUnavailableError({
      code: state.lastError?.code ?? "unknown",
      detail: state.lastError?.message ?? runtimeDetail,
    }),
  );
};

const makeTailcatApi = Effect.fn("remote.makeTailcatApi")(function* (
  session: RunningServerSession,
) {
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: session.origin });
  const headers = { authorization: `Bearer ${session.token}` };
  const call = <A, E>(operation: string, request: Effect.Effect<A, E>) =>
    request.pipe(
      Effect.timeout(RUNNING_SERVER_REQUEST_TIMEOUT),
      Effect.mapError((cause) =>
        isTailcatRemoteAccessError(cause)
          ? tailcatCliErrorFromServer(cause)
          : new RunningServerRequestError({ operation, cause }),
      ),
    );

  return {
    state: call("tailcat.remoteAccess", client.tailcat.remoteAccess({ headers })),
    setEnabled: (enabled) =>
      call(
        "tailcat.setRemoteAccess",
        client.tailcat.setRemoteAccess({ headers, payload: { enabled } }),
      ),
    createConnectionCode: (payload) =>
      call(
        "tailcat.createConnectionCode",
        client.tailcat.createConnectionCode({ headers, payload }),
      ),
    revokeTrustedPeer: (peerId) =>
      call(
        "tailcat.revokeTrustedPeer",
        client.tailcat.revokeTrustedPeer({ headers, payload: { peerId } }),
      ),
  } satisfies TailcatApi;
});

const runTailcatCommand = <A, E, R>(
  flags: { readonly baseDir: Option.Option<string>; readonly json?: boolean },
  run: (api: TailcatApi) => Effect.Effect<A, E, R>,
) =>
  withRunningServerSession({
    baseDir: flags.baseDir,
    label: "t3 remote tailcat",
    quietLogs: flags.json === true,
    run: (session) => Effect.flatMap(makeTailcatApi(session), run),
  }).pipe(Effect.provide(FetchHttpClient.layer));

/** Last 8 hex characters of a `nodekey:<64 hex>`: enough to tell devices apart by eye. */
export const nodeKeyFingerprint = (nodeKey: string): string => nodeKey.slice(-8);

const formatRuntime = (state: TailcatRemoteAccessState): string => {
  if (state.runtime === null) {
    return "not detected";
  }
  const compatibility = state.runtime.compatible
    ? "compatible"
    : `incompatible, wants ${state.runtime.pinnedVersion}`;
  return `${state.runtime.source} ${state.runtime.version} (${compatibility}) at ${state.runtime.executablePath}`;
};

export const formatTailcatStatus = (
  state: TailcatRemoteAccessState,
  options: { readonly json: boolean },
): string => {
  if (options.json) {
    return JSON.stringify(state, null, 2);
  }
  const lastError =
    state.lastError === null
      ? "none"
      : `${state.lastError.message} (${state.lastError.code}, ${state.lastError.at})`;
  return [
    "Tailcat remote access",
    `  Enabled: ${state.enabled ? "yes" : "no"}`,
    `  Status: ${state.status}`,
    `  Address: ${state.address ?? "none"}`,
    `  Remote port: ${state.remotePort === null ? "none" : String(state.remotePort)}`,
    `  Pairing window: ${state.pairingOpen ? "open (a connection code is active)" : "closed"}`,
    `  Runtime: ${formatRuntime(state)}`,
    `  Identity: ${state.identityFingerprint ?? "none"}`,
    `  Trusted peers: ${String(state.trustedPeers.length)}`,
    `  Last error: ${lastError}`,
  ].join("\n");
};

export const formatTrustedPeers = (
  peers: ReadonlyArray<TailcatTrustedPeer>,
  options: { readonly json: boolean },
): string => {
  if (options.json) {
    return JSON.stringify(
      peers.map((peer) => ({
        id: peer.id,
        label: peer.label,
        nodeKeyFingerprint: nodeKeyFingerprint(peer.nodeKey),
        createdAt: peer.createdAt,
        lastSeenAt: peer.lastSeenAt,
      })),
      null,
      2,
    );
  }
  if (peers.length === 0) {
    return "No trusted peers.";
  }
  return peers
    .map((peer) =>
      [
        `${peer.id} (${peer.label})`,
        `  node key: …${nodeKeyFingerprint(peer.nodeKey)}`,
        `  created: ${peer.createdAt}`,
        `  last seen: ${peer.lastSeenAt ?? "never"}`,
      ].join("\n"),
    )
    .join("\n\n");
};

// Same shape as the `t3 serve --tailcat` startup output, so the code reads
// the same wherever the user sees it.
export const formatConnectionCode = (
  issued: TailcatConnectionCodeResult,
  options: { readonly json: boolean },
): string => {
  if (options.json) {
    return JSON.stringify(issued, null, 2);
  }
  return [
    `Connection code (expires ${issued.expiresAt}, single use):`,
    issued.code,
    "",
    renderTerminalQrCode(issued.code),
    "",
    "Paste the code in T3 Code under Add Environment → Tailcat, or scan it with the mobile app.",
    "Warning: this code embeds a one-time pairing credential. Share it only with the device you are pairing.",
  ].join("\n");
};

// Right after enabling, the service still reports "disabled" until its
// reconcile debounce fires, so an enabled-but-disabled state is not settled.
const isSettledTailcatState = (state: TailcatRemoteAccessState): boolean =>
  state.status !== "starting" &&
  state.status !== "restarting" &&
  !(state.enabled && state.status === "disabled");

const awaitSettledTailcatState = (api: TailcatApi) =>
  api.state.pipe(
    Effect.repeat({
      schedule: Schedule.max([
        Schedule.spaced(ENABLE_POLL_INTERVAL),
        Schedule.recurs(ENABLE_POLL_ATTEMPTS),
      ]),
      until: isSettledTailcatState,
    }),
  );

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const tailcatStatusCommand = Command.make("status", {
  baseDir: baseDirFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show Tailcat remote access state on the running server."),
  Command.withHandler((flags) =>
    runTailcatCommand(flags, (api) =>
      Effect.gen(function* () {
        const state = yield* api.state;
        yield* Console.log(formatTailcatStatus(state, { json: flags.json }));
        const unavailable = tailcatUnavailableFromState(state);
        if (Option.isSome(unavailable)) {
          return yield* unavailable.value;
        }
      }),
    ),
  ),
);

const tailcatEnableCommand = Command.make("enable", {
  baseDir: baseDirFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Enable Tailcat remote access and wait until the listener is ready or has failed.",
  ),
  Command.withHandler((flags) =>
    runTailcatCommand(flags, (api) =>
      Effect.gen(function* () {
        const enabled = yield* api.setEnabled(true);
        const settled = isSettledTailcatState(enabled)
          ? enabled
          : yield* awaitSettledTailcatState(api);
        yield* Console.log(formatTailcatStatus(settled, { json: flags.json }));

        const unavailable = tailcatUnavailableFromState(settled);
        if (Option.isSome(unavailable)) {
          return yield* unavailable.value;
        }
        switch (settled.status) {
          case "ready":
            if (!flags.json) {
              yield* Console.log(
                "\nNext: run `t3 remote tailcat code` to pair a device through this address.",
              );
            }
            return;
          case "error":
            return yield* new TailcatNotReadyError({
              status: settled.status,
              detail: settled.lastError?.message ?? "The server reported an error.",
            });
          case "disabled":
            return yield* new TailcatNotReadyError({
              status: settled.status,
              detail: settled.enabled
                ? "The listener has not started yet; check `t3 remote tailcat status` in a moment."
                : "Remote access was disabled again before the listener came up.",
            });
          case "starting":
          case "restarting":
            return yield* new TailcatNotReadyError({
              status: settled.status,
              detail: `still ${settled.status} after ${Duration.format(
                Duration.times(ENABLE_POLL_INTERVAL, ENABLE_POLL_ATTEMPTS),
              )}; check \`t3 remote tailcat status\` in a moment.`,
            });
          case "unavailable":
            // Handled above; kept so the switch stays exhaustive.
            return;
        }
      }),
    ),
  ),
);

const tailcatDisableCommand = Command.make("disable", {
  baseDir: baseDirFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Disable Tailcat remote access on the running server."),
  Command.withHandler((flags) =>
    runTailcatCommand(flags, (api) =>
      Effect.gen(function* () {
        const state = yield* api.setEnabled(false);
        yield* Console.log(
          flags.json
            ? formatTailcatStatus(state, { json: true })
            : "Tailcat remote access is disabled. Trusted devices keep their entries and reconnect once it is enabled again.",
        );
      }),
    ),
  ),
);

const tailcatCodeCommand = Command.make("code", {
  baseDir: baseDirFlag,
  label: Flag.string("label").pipe(
    Flag.withDescription("Optional label for the device that will redeem the code."),
    Flag.optional,
  ),
  ttl: Flag.string("ttl").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription(
      "How long the code stays redeemable, for example `5m` or `1h`. Defaults to 5 minutes.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a one-time Tailcat connection code and print it as a QR code."),
  Command.withHandler((flags) =>
    runTailcatCommand(flags, (api) =>
      Effect.gen(function* () {
        const issued = yield* api.createConnectionCode({
          ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
          ...(Option.isSome(flags.ttl)
            ? { ttlSeconds: Math.max(1, Math.round(Duration.toSeconds(flags.ttl.value))) }
            : {}),
        });
        yield* Console.log(formatConnectionCode(issued, { json: flags.json }));
      }),
    ),
  ),
);

const tailcatPeersCommand = Command.make("peers", {
  baseDir: baseDirFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List the devices trusted to reach this server over Tailcat."),
  Command.withHandler((flags) =>
    runTailcatCommand(flags, (api) =>
      Effect.gen(function* () {
        const state = yield* api.state;
        yield* Console.log(formatTrustedPeers(state.trustedPeers, { json: flags.json }));
      }),
    ),
  ),
);

const tailcatRevokeCommand = Command.make("revoke", {
  baseDir: baseDirFlag,
  peerId: Argument.string("peer-id").pipe(
    Argument.withDescription("Trusted peer id to revoke, as listed by `peers`."),
    Argument.withSchema(TrimmedNonEmptyString),
  ),
}).pipe(
  Command.withDescription(
    "Revoke a trusted device. Its Tailcat access and the sessions it paired with end together.",
  ),
  Command.withHandler((flags) =>
    runTailcatCommand(flags, (api) =>
      Effect.gen(function* () {
        const state = yield* api.revokeTrustedPeer(flags.peerId);
        yield* Console.log(
          `Revoked trusted peer ${flags.peerId}. ${String(state.trustedPeers.length)} trusted peer(s) remain.`,
        );
      }),
    ),
  ),
);

const tailcatCommand = Command.make("tailcat").pipe(
  Command.withDescription("Manage Tailcat remote access on the running server."),
  Command.withSubcommands([
    tailcatStatusCommand,
    tailcatEnableCommand,
    tailcatDisableCommand,
    tailcatCodeCommand,
    tailcatPeersCommand,
    tailcatRevokeCommand,
  ]),
);

export const remoteCommand = Command.make("remote").pipe(
  Command.withDescription("Manage how remote devices reach the running T3 Code server."),
  Command.withSubcommands([tailcatCommand]),
);
