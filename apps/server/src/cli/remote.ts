/**
 * `t3 remote tailcat <subcommand>` - manage Tailcat remote access on the
 * running T3 Code server: status, enable/disable, connection codes, and the
 * trusted device list, over the same RPC methods the UIs use (see
 * runningServer.ts for discovery and credentials).
 */
import {
  type TailcatConnectionCodeResult,
  TailcatFailureCode,
  TailcatRemoteAccessError,
  type TailcatRemoteAccessState,
  TailcatServeStatus,
  type TailcatTrustedPeer,
  TrimmedNonEmptyString,
  WS_METHODS,
  isTailcatRuntimeUnavailable,
  tailcatNodeKeyFingerprint,
} from "@t3tools/contracts";
import { TAILCAT_BINARY_OVERRIDE_ENV } from "@t3tools/tailcat/runtime";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { formatTailcatConnectionCodeLines } from "../tailcat/startupOutput.ts";
import { baseDirFlag, jsonFlag } from "./config.ts";
import {
  callRunningServer,
  codeTtlFlag,
  codeTtlInput,
  RunningServerRequestError,
  withRunningServerRpcClient,
  type WsRpcClient,
} from "./runningServer.ts";

// Enabling starts the tailcat process and waits for it to report an address;
// a cold start with a DERP handshake is a few seconds, so wait up to 30s.
const ENABLE_SETTLE_TIMEOUT = Duration.seconds(30);

const isTailcatRemoteAccessError = Schema.is(TailcatRemoteAccessError);

export class TailcatUnavailableError extends Schema.TaggedError<TailcatUnavailableError>()(
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

export class TailcatNotReadyError extends Schema.TaggedError<TailcatNotReadyError>()(
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

// A missing or incompatible binary is the one Tailcat failure the user fixes
// on their own machine, so it gets the override hint; everything else is
// already worded for them by the server.
const tailcatCliErrorFromServer = (
  error: TailcatRemoteAccessError,
): TailcatRemoteAccessError | TailcatUnavailableError =>
  isTailcatRuntimeUnavailable(error.code)
    ? new TailcatUnavailableError({ code: error.code, detail: error.message })
    : error;

const tailcatUnavailableFromState = (
  state: TailcatRemoteAccessState,
): Option.Option<TailcatUnavailableError> => {
  if (state.status !== "unavailable") {
    return Option.none();
  }
  return Option.some(
    new TailcatUnavailableError({
      code: state.lastError?.code ?? "unknown",
      detail: state.lastError?.message ?? "The Tailcat runtime is not available.",
    }),
  );
};

const call = <A, E>(operation: string, request: Effect.Effect<A, E>) =>
  callRunningServer(operation, request, isTailcatRemoteAccessError).pipe(
    Effect.mapError((cause) =>
      isTailcatRemoteAccessError(cause) ? tailcatCliErrorFromServer(cause) : cause,
    ),
  );

// The subscription replays the current state before any change.
const currentState = (client: WsRpcClient) =>
  call(
    "tailcat.subscribeRemoteAccess",
    client[WS_METHODS.tailcatSubscribeRemoteAccess]({}).pipe(Stream.runHead),
  ).pipe(
    Effect.flatMap((state) =>
      Effect.fromOption(
        state,
        () =>
          new RunningServerRequestError({
            operation: "tailcat.subscribeRemoteAccess",
            cause: "The state stream ended before reporting a state.",
          }),
      ),
    ),
  );

const runTailcatCommand = <A, E, R>(
  flags: { readonly baseDir: Option.Option<string>; readonly json?: boolean },
  run: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) =>
  withRunningServerRpcClient({
    baseDir: flags.baseDir,
    label: "t3 remote tailcat",
    quietLogs: flags.json === true,
    run,
  });

const formatRuntime = (state: TailcatRemoteAccessState): string =>
  state.runtime === null
    ? "not detected"
    : `${state.runtime.source} ${state.runtime.version} (pinned ${state.runtime.pinnedVersion}) at ${state.runtime.executablePath}`;

const formatTailcatStatus = (
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

const formatTrustedPeers = (
  peers: ReadonlyArray<TailcatTrustedPeer>,
  options: { readonly json: boolean },
): string => {
  if (options.json) {
    return JSON.stringify(
      peers.map((peer) => ({
        id: peer.id,
        label: peer.label,
        nodeKeyFingerprint: tailcatNodeKeyFingerprint(peer.nodeKey),
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
        `  node key: ${tailcatNodeKeyFingerprint(peer.nodeKey)}`,
        `  created: ${peer.createdAt}`,
        `  last seen: ${peer.lastSeenAt ?? "never"}`,
      ].join("\n"),
    )
    .join("\n\n");
};

// Same shape as the `t3 serve --tailcat` startup output, so the code reads
// the same wherever the user sees it.
const formatConnectionCode = (
  issued: TailcatConnectionCodeResult,
  options: { readonly json: boolean },
): string => {
  if (options.json) {
    return JSON.stringify(issued, null, 2);
  }
  return formatTailcatConnectionCodeLines(issued).join("\n");
};

// Right after enabling, the service still reports "disabled" until its
// reconcile debounce fires, so an enabled-but-disabled state is not settled.
const isSettledTailcatState = (state: TailcatRemoteAccessState): boolean =>
  state.status !== "starting" &&
  state.status !== "restarting" &&
  !(state.enabled && state.status === "disabled");

/** Follows the state until it settles, or returns the last state seen once the wait runs out. */
const awaitSettledTailcatState = (client: WsRpcClient, current: TailcatRemoteAccessState) =>
  client[WS_METHODS.tailcatSubscribeRemoteAccess]({}).pipe(
    Stream.takeUntil(isSettledTailcatState),
    Stream.interruptWhen(Effect.sleep(ENABLE_SETTLE_TIMEOUT)),
    Stream.runLast,
    Effect.map(Option.getOrElse(() => current)),
    Effect.mapError((cause) =>
      isTailcatRemoteAccessError(cause)
        ? tailcatCliErrorFromServer(cause)
        : new RunningServerRequestError({ operation: "tailcat.subscribeRemoteAccess", cause }),
    ),
  );

const tailcatStatusCommand = Command.make("status", {
  baseDir: baseDirFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show Tailcat remote access state on the running server."),
  Command.withHandler((flags) =>
    runTailcatCommand(flags, (client) =>
      Effect.gen(function* () {
        const state = yield* currentState(client);
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
    runTailcatCommand(flags, (client) =>
      Effect.gen(function* () {
        const enabled = yield* call(
          "tailcat.setRemoteAccessEnabled",
          client[WS_METHODS.tailcatSetRemoteAccessEnabled]({ enabled: true }),
        );
        const settled = isSettledTailcatState(enabled)
          ? enabled
          : yield* awaitSettledTailcatState(client, enabled);
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
                ENABLE_SETTLE_TIMEOUT,
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
    runTailcatCommand(flags, (client) =>
      Effect.gen(function* () {
        const state = yield* call(
          "tailcat.setRemoteAccessEnabled",
          client[WS_METHODS.tailcatSetRemoteAccessEnabled]({ enabled: false }),
        );
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
  label: Flag.String("label").pipe(
    Flag.withDescription("Optional label for the device that will redeem the code."),
    Flag.optional,
  ),
  ttl: codeTtlFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a one-time Tailcat connection code and print it as a QR code."),
  Command.withHandler((flags) =>
    runTailcatCommand(flags, (client) =>
      Effect.gen(function* () {
        const issued = yield* call(
          "tailcat.createConnectionCode",
          client[WS_METHODS.tailcatCreateConnectionCode]({
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
            ...codeTtlInput(flags.ttl),
          }),
        );
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
    runTailcatCommand(flags, (client) =>
      Effect.gen(function* () {
        const state = yield* currentState(client);
        yield* Console.log(formatTrustedPeers(state.trustedPeers, { json: flags.json }));
      }),
    ),
  ),
);

const tailcatRevokeCommand = Command.make("revoke", {
  baseDir: baseDirFlag,
  peerId: Argument.String("peer-id").pipe(
    Argument.withDescription("Trusted peer id to revoke, as listed by `peers`."),
    Argument.withSchema(TrimmedNonEmptyString),
  ),
}).pipe(
  Command.withDescription(
    "Revoke a trusted device. Its Tailcat access and the sessions it paired with end together.",
  ),
  Command.withHandler((flags) =>
    runTailcatCommand(flags, (client) =>
      Effect.gen(function* () {
        const state = yield* call(
          "tailcat.revokeTrustedPeer",
          client[WS_METHODS.tailcatRevokeTrustedPeer]({ peerId: flags.peerId }),
        );
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
