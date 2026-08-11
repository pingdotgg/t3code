/**
 * Aether cloud terminal connection — a dedicated, tab-scoped workspace WS
 * carrying ONLY the `terminal` channel (create/input/resize/close out;
 * output/close in). It is deliberately independent of the turn engine's
 * agent-stream connection (`runAetherAgentStream`): a shell stays attached for
 * as long as the UI tab is open, a lifetime unrelated to any turn, so it owns
 * its own socket under the caller's Scope. Multiple concurrent connections per
 * workspace are fine — `POST /workspaces/{id}/connect` hands a transport to
 * every caller and the VM tracks PTY state per connection.
 *
 * The wire twins are the terminal messages in aether's workspace-protocol
 * (`packages/workspace-protocol/src/messages.ts`): create/input/resize/close
 * from the client, output/close from the server.
 *
 * @module provider/Layers/aether/terminalConnection
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type { CloudTerminalConnection } from "../../CloudTerminalConnector.ts";
import { CloudTerminalWriteError } from "../../CloudTerminalConnector.ts";
import type { AetherRestClient, AetherRestError } from "./restClient.ts";
import {
  aetherWorkspaceSocketUrl,
  connectForTransport,
  defaultWebSocketFactory,
  DEFAULT_TIMING,
  openSocket,
  resolveTaskWorkspace,
  type AetherSocketOpenError,
  type AetherStreamTiming,
  type AetherTaskErroredError,
  type AetherTaskUnknownStatusError,
  type AetherWebSocketFactory,
  type AetherWebSocketLike,
  type AetherWorkspaceConnectTimeoutError,
} from "./workspaceSocket.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The task has no attachable workspace (parked, or connect refused a boot). */
export class AetherTerminalWorkspaceUnavailableError extends Schema.TaggedErrorClass<AetherTerminalWorkspaceUnavailableError>()(
  "AetherTerminalWorkspaceUnavailableError",
  {
    taskId: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Aether cloud terminal has no workspace for task '${this.taskId}': ${this.reason}`;
  }
}

export type AetherTerminalConnectError =
  | AetherTerminalWorkspaceUnavailableError
  | AetherTaskErroredError
  | AetherTaskUnknownStatusError
  | AetherWorkspaceConnectTimeoutError
  | AetherSocketOpenError
  | AetherRestError;

// ---------------------------------------------------------------------------
// Wire (twins of aether workspace-protocol terminal messages)
// ---------------------------------------------------------------------------

const encodeTerminalCreate = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      channel: Schema.Literal("terminal"),
      type: Schema.Literal("create"),
      sessionId: Schema.String,
    }),
  ),
);
const encodeTerminalInput = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      channel: Schema.Literal("terminal"),
      type: Schema.Literal("input"),
      sessionId: Schema.String,
      data: Schema.String,
    }),
  ),
);
const encodeTerminalResize = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      channel: Schema.Literal("terminal"),
      type: Schema.Literal("resize"),
      sessionId: Schema.String,
      cols: Schema.Number,
      rows: Schema.Number,
    }),
  ),
);
const encodeTerminalClose = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      channel: Schema.Literal("terminal"),
      type: Schema.Literal("close"),
      sessionId: Schema.String,
    }),
  ),
);
// Keep-alive: the VM's interactive idle lease is only renewed by the `activity`
// channel — terminal I/O does NOT count. Without this the VM suspends ~15 min
// after connect (INTERACTIVE_INACTIVITY_TIMEOUT_MS) mid-session. Ping well
// under that window while the terminal connection is open.
const encodeUserActivity = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      channel: Schema.Literal("activity"),
      type: Schema.Literal("user_activity"),
    }),
  ),
);
const ACTIVITY_PING_INTERVAL = Duration.seconds(30);
// Give up after this many CONSECUTIVE reconnect attempts that never produced
// output (a working connection that later drops resets the counter). Bounds a
// genuinely gone workspace while surviving ordinary blips indefinitely.
const MAX_CONSECUTIVE_RECONNECTS = 6;

const reconnectDelay = (timing: AetherStreamTiming, consecutive: number): Duration.Duration =>
  Duration.millis(
    Math.min(timing.reconnectMaxMs, timing.reconnectInitialMs * 2 ** Math.min(consecutive, 20)),
  );

type TerminalServerFrame =
  | { readonly _tag: "output"; readonly sessionId: string; readonly data: string }
  | { readonly _tag: "close"; readonly sessionId: string }
  | { readonly _tag: "ignored" };

/**
 * Parse one inbound frame. Loose by design (mirrors the agent-frame parser):
 * a non-terminal channel, or a malformed terminal frame, is ignored rather
 * than killing the socket — the pump lives on.
 */
export function parseTerminalServerFrame(raw: string): TerminalServerFrame {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { _tag: "ignored" };
  }
  if (typeof json !== "object" || json === null) return { _tag: "ignored" };
  const frame = json as Record<string, unknown>;
  if (frame.channel !== "terminal") return { _tag: "ignored" };
  if (
    frame.type === "output" &&
    typeof frame.sessionId === "string" &&
    typeof frame.data === "string"
  ) {
    return { _tag: "output", sessionId: frame.sessionId, data: frame.data };
  }
  if (frame.type === "close" && typeof frame.sessionId === "string") {
    return { _tag: "close", sessionId: frame.sessionId };
  }
  return { _tag: "ignored" };
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export interface AetherTerminalConnectionOptions {
  readonly restClient: Pick<AetherRestClient, "getTask" | "connectWorkspace">;
  readonly apiBaseUrl: string;
  readonly apiKey: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  readonly webSocketFactory?: AetherWebSocketFactory;
  readonly timing?: Partial<AetherStreamTiming>;
  /** Shell bytes from the VM. */
  readonly onOutput: (data: string) => void;
  /** Fires exactly once when the shell exits or the socket drops. */
  readonly onClosed: (reason: string) => void;
}

/**
 * Open a resilient cloud-terminal connection. The FIRST attach (resolve the
 * task's workspace, connect with `start:true` to boot an idle VM, open the
 * socket, create + size the PTY) either succeeds — returning a write/resize
 * handle — or fails loudly. After that, a forked loop transparently reconnects
 * on a socket drop: because the VM reaps the PTY when the socket closes, a
 * reconnect is a FRESH shell (the client keeps its scrollback), preceded by a
 * `[reconnecting…]` marker. A shell exit (terminal `close` frame) ends the
 * connection; so does exhausting the reconnect budget. The caller's Scope owns
 * teardown — closing it interrupts the loop and the current socket.
 */
export const openAetherTerminalConnection = (
  options: AetherTerminalConnectionOptions,
): Effect.Effect<CloudTerminalConnection, AetherTerminalConnectError, Scope.Scope> =>
  Effect.gen(function* () {
    const timing = { ...DEFAULT_TIMING, ...options.timing };
    const factory = options.webSocketFactory ?? defaultWebSocketFactory;
    // The live socket, followed by write/resize. Null between attaches (during
    // a reconnect) — a plain closure var is safe: fibers here are cooperative.
    let currentSocket: AetherWebSocketLike | null = null;
    // Latest requested size, so a reconnect recreates the PTY at the size the
    // user resized to — not the stale initial dimensions.
    let currentCols = options.cols;
    let currentRows = options.rows;
    const ready = yield* Deferred.make<void, AetherTerminalConnectError>();

    const heartbeat = (socket: AetherWebSocketLike): Effect.Effect<never> =>
      Effect.sleep(ACTIVITY_PING_INTERVAL).pipe(
        Effect.andThen(
          Effect.sync(() => {
            socket.send(encodeUserActivity({ channel: "activity", type: "user_activity" }));
          }).pipe(Effect.ignore),
        ),
        Effect.forever,
      );

    // One scoped attach: setup, then pump until the socket drops or the shell
    // exits. `notifyReady` fires after setup so the handle is returned before
    // the pump blocks. `produced` reports whether any shell output arrived (a
    // productive connection resets the reconnect budget).
    const attachOnce = (notifyReady: Effect.Effect<void>) =>
      Effect.gen(function* () {
        const resolution = yield* resolveTaskWorkspace({
          getTask: options.restClient.getTask,
          taskId: options.taskId,
          ...(options.timing !== undefined ? { timing: options.timing } : {}),
        });
        if (resolution._tag === "parked") {
          return yield* new AetherTerminalWorkspaceUnavailableError({
            taskId: options.taskId,
            reason: "the task has no active workspace; run a turn first",
          });
        }
        const transport = yield* connectForTransport({
          connectWorkspace: options.restClient.connectWorkspace,
          workspaceId: resolution.workspaceId,
          start: true,
          ...(options.timing !== undefined ? { timing: options.timing } : {}),
        });
        if (transport._tag === "unavailable") {
          return yield* new AetherTerminalWorkspaceUnavailableError({
            taskId: options.taskId,
            reason: transport.reason,
          });
        }
        const url = aetherWorkspaceSocketUrl(
          options.apiBaseUrl,
          transport.websocketPath,
          options.apiKey,
        );
        const { socket, signals } = yield* Effect.acquireRelease(
          openSocket(factory, url, timing.openTimeoutMs),
          ({ socket }) => Effect.sync(() => socket.close()),
        );
        // Send an explicit terminal close before the socket close finalizer
        // (LIFO) so this attach's VM PTY is reaped promptly.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            socket.send(
              encodeTerminalClose({
                channel: "terminal",
                type: "close",
                sessionId: options.sessionId,
              }),
            );
          }).pipe(Effect.ignore),
        );
        currentSocket = socket;
        socket.send(
          encodeTerminalCreate({
            channel: "terminal",
            type: "create",
            sessionId: options.sessionId,
          }),
        );
        // The VM PTY is created at a default 80x24; apply the latest requested
        // size up front so output wraps correctly — including after a resize +
        // reconnect, when this recreates the shell.
        socket.send(
          encodeTerminalResize({
            channel: "terminal",
            type: "resize",
            sessionId: options.sessionId,
            cols: currentCols,
            rows: currentRows,
          }),
        );
        yield* Effect.forkScoped(heartbeat(socket));
        yield* notifyReady;

        let produced = false;
        const pump: Effect.Effect<"shell-exit" | "socket-drop"> = Queue.take(signals).pipe(
          Effect.flatMap((signal) => {
            if (signal._tag === "closed") {
              return Effect.succeed("socket-drop" as const);
            }
            const frame = parseTerminalServerFrame(signal.data);
            if (frame._tag === "output" && frame.sessionId === options.sessionId) {
              produced = true;
              return Effect.sync(() => options.onOutput(frame.data)).pipe(
                Effect.flatMap(() => pump),
              );
            }
            if (frame._tag === "close" && frame.sessionId === options.sessionId) {
              return Effect.succeed("shell-exit" as const);
            }
            return pump;
          }),
        );
        const outcome = yield* pump;
        return { outcome, produced } as const;
      }).pipe(Effect.ensuring(Effect.sync(() => (currentSocket = null))));

    // First attach errors propagate to `ready` (fail loudly). Once connected,
    // socket drops reconnect; connect errors during a reconnect count against
    // the budget instead of killing the terminal.
    const runLifecycle = Effect.gen(function* () {
      let consecutive = 0;
      let first = true;
      while (true) {
        const notify = first ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid) : Effect.void;
        const attach = Effect.scoped(attachOnce(notify));
        const result = first
          ? yield* attach
          : yield* attach.pipe(
              Effect.orElseSucceed(() => ({ outcome: "socket-drop" as const, produced: false })),
            );
        first = false;
        if (result.outcome === "shell-exit") {
          options.onClosed("shell exited");
          return;
        }
        consecutive = result.produced ? 0 : consecutive + 1;
        if (consecutive > MAX_CONSECUTIVE_RECONNECTS) {
          options.onClosed(`disconnected after ${consecutive} reconnect attempts`);
          return;
        }
        options.onOutput("\r\n\x1b[2m[reconnecting…]\x1b[0m\r\n");
        yield* Effect.sleep(reconnectDelay(timing, consecutive));
      }
    }).pipe(Effect.catch((error) => Deferred.fail(ready, error).pipe(Effect.asVoid)));

    yield* Effect.forkScoped(runLifecycle);
    yield* Deferred.await(ready);

    const sendCurrent = (payload: string, operation: "input" | "resize") =>
      Effect.suspend(() => {
        const socket = currentSocket;
        if (socket === null) {
          return Effect.fail(
            new CloudTerminalWriteError({ detail: `${operation}: terminal is reconnecting` }),
          );
        }
        return Effect.try({
          try: () => socket.send(payload),
          catch: (cause) =>
            new CloudTerminalWriteError({ detail: `${operation}: socket send failed`, cause }),
        });
      });

    const connection: CloudTerminalConnection = {
      write: (data) =>
        sendCurrent(
          encodeTerminalInput({
            channel: "terminal",
            type: "input",
            sessionId: options.sessionId,
            data,
          }),
          "input",
        ),
      resize: (cols, rows) =>
        Effect.suspend(() => {
          // Record the latest size even if the send fails mid-reconnect, so the
          // next attach recreates the PTY at this size.
          currentCols = cols;
          currentRows = rows;
          return sendCurrent(
            encodeTerminalResize({
              channel: "terminal",
              type: "resize",
              sessionId: options.sessionId,
              cols,
              rows,
            }),
            "resize",
          );
        }),
    };
    return connection;
  });
