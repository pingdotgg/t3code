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
 * Resolve the task's workspace, connect (booting the VM if idle — `start:true`,
 * matching a user-initiated interactive attach), open the socket, and create
 * one PTY session. The returned handle writes/resizes the session; the caller's
 * Scope owns teardown (best-effort close message, then socket close).
 */
export const openAetherTerminalConnection = (
  options: AetherTerminalConnectionOptions,
): Effect.Effect<CloudTerminalConnection, AetherTerminalConnectError, Scope.Scope> =>
  Effect.gen(function* () {
    const timing = { ...DEFAULT_TIMING, ...options.timing };

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
    const factory = options.webSocketFactory ?? defaultWebSocketFactory;

    const { socket, signals } = yield* Effect.acquireRelease(
      openSocket(factory, url, timing.openTimeoutMs),
      ({ socket }) => Effect.sync(() => socket.close()),
    );

    // Best-effort explicit teardown BEFORE the socket close finalizer (LIFO):
    // ends the VM-side PTY promptly instead of relying only on socket close.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        socket.send(
          encodeTerminalClose({ channel: "terminal", type: "close", sessionId: options.sessionId }),
        );
      }).pipe(Effect.ignore),
    );

    socket.send(
      encodeTerminalCreate({ channel: "terminal", type: "create", sessionId: options.sessionId }),
    );
    // The VM PTY is created at a default 80x24; apply the requested size up
    // front so the first command's output wraps correctly, without waiting for
    // the UI to emit a resize.
    socket.send(
      encodeTerminalResize({
        channel: "terminal",
        type: "resize",
        sessionId: options.sessionId,
        cols: options.cols,
        rows: options.rows,
      }),
    );

    // Drain the socket signal queue, dispatching only this session's frames.
    // Returns (fiber ends) on the first close — the Scope closes the socket.
    const pump: Effect.Effect<void> = Queue.take(signals).pipe(
      Effect.flatMap((signal) => {
        if (signal._tag === "closed") {
          return Effect.sync(() => options.onClosed(`socket closed (code ${signal.code})`));
        }
        const frame = parseTerminalServerFrame(signal.data);
        if (frame._tag === "output" && frame.sessionId === options.sessionId) {
          return Effect.sync(() => options.onOutput(frame.data)).pipe(Effect.flatMap(() => pump));
        }
        if (frame._tag === "close" && frame.sessionId === options.sessionId) {
          return Effect.sync(() => options.onClosed("shell exited"));
        }
        return pump;
      }),
    );
    yield* Effect.forkScoped(pump);

    // Heartbeat the interactive idle lease so the VM stays alive while the
    // terminal tab is open. Scoped: stops when the connection is torn down.
    const heartbeat = Effect.sleep(ACTIVITY_PING_INTERVAL).pipe(
      Effect.andThen(
        Effect.sync(() => {
          socket.send(encodeUserActivity({ channel: "activity", type: "user_activity" }));
        }).pipe(Effect.ignore),
      ),
      Effect.forever,
    );
    yield* Effect.forkScoped(heartbeat);

    const send = (payload: string, operation: "input" | "resize") =>
      Effect.try({
        try: () => socket.send(payload),
        catch: (cause) => new CloudTerminalWriteError({ detail: `${operation}: ${String(cause)}` }),
      });

    const connection: CloudTerminalConnection = {
      write: (data) =>
        send(
          encodeTerminalInput({
            channel: "terminal",
            type: "input",
            sessionId: options.sessionId,
            data,
          }),
          "input",
        ),
      resize: (cols, rows) =>
        send(
          encodeTerminalResize({
            channel: "terminal",
            type: "resize",
            sessionId: options.sessionId,
            cols,
            rows,
          }),
          "resize",
        ),
    };
    return connection;
  });
