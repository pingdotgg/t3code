/**
 * Aether workspace attach + WS transport (build item 5).
 *
 * Three layers, composed by `runAetherAgentStream`:
 *   1. `resolveTaskWorkspace` — poll `GET /tasks/{id}` branching on the
 *      DISCRIMINATED status. Every variant is handled explicitly and none
 *      falls through to "keep polling": `processing` proceeds (run_context is
 *      non-null by construction), `queued` backs off and repolls,
 *      null-context `awaiting_input` is TERMINAL durable-only (a STABLE
 *      state — every queued message was cancelled before workspace
 *      assignment, and nothing creates a workspace until the next /respond,
 *      which is exactly when the active path re-attaches), `errored` fails
 *      loudly with the task's error payload, and the unknown-status carrier
 *      fails loudly (never treated as pending).
 *   2. `connectForTransport` — `POST /workspaces/{id}/connect` with
 *      `start=false` (passive). The connecting variant and the transitional
 *      409 retry after `retry_after_ms`; the startable / not_connectable
 *      409s mean the workspace is not running — durable-only mode, NEVER a
 *      VM boot just to view a thread (`start=true` is reserved for
 *      user-initiated turns, T6).
 *   3. The socket loop — wss upgrade with the API key, agent-channel
 *      subscribe, loose frame parsing (unknown kinds logged once per kind
 *      and dropped, server error-channel frames surfaced via
 *      `onFrameDropped`; the socket is never killed by a frame), a
 *      user-activity keep-alive hook for the T6 turn engine, and a reconnect
 *      ladder with capped exponential backoff that re-runs the FULL attach
 *      (statuses change while detached) and triggers durable delta
 *      reconciliation via `onConnected` on every (re)connect. An attach that
 *      never reaches subscribe (open failure, or a transport-class REST
 *      error once connected before) fires `onConnectRetry` so the caller
 *      surfaces the degradation and drives the REST backstop while the
 *      ladder keeps retrying.
 *
 * The returned effect runs until the workspace becomes durable-only or the
 * owning scope interrupts it (session stop); the socket is closed by a
 * finalizer either way (OpenCodeAdapter startEventPump pattern).
 *
 * @module provider/Layers/aether/workspaceSocket
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import type { AetherRestClient, AetherRestError } from "./restClient.ts";
import type { AetherTask } from "./restSchemas.ts";
import { parseAetherAgentFrame, type AetherAgentEvent } from "./wireEvents.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The task errored (possibly before workspace assignment) — attach must fail loudly, never poll forever. */
export class AetherTaskErroredError extends Schema.TaggedErrorClass<AetherTaskErroredError>()(
  "AetherTaskErroredError",
  {
    taskId: Schema.String,
    error: Schema.String,
    completedAt: Schema.String,
  },
) {
  override get message(): string {
    return `Aether task '${this.taskId}' errored: ${this.error}`;
  }
}

/** The forward-compat unknown-status carrier — never treated as pending. */
export class AetherTaskUnknownStatusError extends Schema.TaggedErrorClass<AetherTaskUnknownStatusError>()(
  "AetherTaskUnknownStatusError",
  {
    taskId: Schema.String,
    rawStatus: Schema.String,
  },
) {
  override get message(): string {
    return `Aether task '${this.taskId}' reports an unrecognized status '${this.rawStatus}'; refusing to guess whether it is attachable.`;
  }
}

/** The connect handshake never produced a transport within the retry budget. */
export class AetherWorkspaceConnectTimeoutError extends Schema.TaggedErrorClass<AetherWorkspaceConnectTimeoutError>()(
  "AetherWorkspaceConnectTimeoutError",
  {
    workspaceId: Schema.String,
    attempts: Schema.Number,
  },
) {
  override get message(): string {
    return `Aether workspace '${this.workspaceId}' stayed in the connecting state after ${this.attempts} attempts.`;
  }
}

/** The WebSocket upgrade did not reach the open state. */
export class AetherSocketOpenError extends Schema.TaggedErrorClass<AetherSocketOpenError>()(
  "AetherSocketOpenError",
  {
    url: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Aether workspace socket failed to open: ${this.detail}`;
  }
}

export type AetherAttachError =
  | AetherTaskErroredError
  | AetherTaskUnknownStatusError
  | AetherWorkspaceConnectTimeoutError
  | AetherRestError;

// ---------------------------------------------------------------------------
// WebSocket seam (injectable for tests; defaults to the Node global)
// ---------------------------------------------------------------------------

export interface AetherWebSocketLike {
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type AetherWebSocketFactory = (url: string) => AetherWebSocketLike;

const defaultWebSocketFactory: AetherWebSocketFactory = (url) =>
  // Node >= 22 ships a spec-compliant global WebSocket (undici).
  new WebSocket(url) as unknown as AetherWebSocketLike;

/**
 * Build the wss URL from the API origin + the connect transport's
 * `websocket_path`, carrying the API key as `?token=`.
 *
 * Auth-form choice: auth.go's `ExtractTokenFromRequest` accepts three forms
 * (Authorization header, `Sec-WebSocket-Protocol: bearer, <key>`, and
 * `?token=`). The query form is the one Aether's own first-party clients use
 * for exactly this socket (packages/workspace-client/src/websocket-url.ts),
 * so it is the proven path; the subprotocol form is no more confidential
 * (the key leaves the process either way, TLS covers both) and depends on
 * the server echoing a subprotocol back for undici to keep the connection.
 */
export function aetherWorkspaceSocketUrl(
  apiBaseUrl: string,
  websocketPath: string,
  apiKey: string,
): string {
  if (!websocketPath.startsWith("/") || websocketPath.startsWith("//")) {
    throw new Error(
      `Workspace websocket path must be a same-origin absolute path: ${websocketPath}`,
    );
  }
  if (websocketPath.includes("?") || websocketPath.includes("#")) {
    throw new Error(`Workspace websocket path must carry no query or fragment: ${websocketPath}`);
  }
  const base = apiBaseUrl.replace(/\/+$/, "");
  const schemeEnd = base.indexOf("://");
  const scheme = schemeEnd === -1 ? "" : base.slice(0, schemeEnd).toLowerCase();
  const rest = base.slice(schemeEnd + "://".length);
  let wsScheme: string;
  if (scheme === "https") {
    wsScheme = "wss://";
  } else if (scheme === "http") {
    wsScheme = "ws://";
  } else {
    throw new Error(`Unsupported API base URL scheme for the workspace websocket: ${apiBaseUrl}`);
  }
  if (rest.length === 0 || rest.startsWith("/")) {
    throw new Error(`API base URL has no host: ${apiBaseUrl}`);
  }
  return `${wsScheme}${rest}${websocketPath}?token=${encodeURIComponent(apiKey)}`;
}

// ---------------------------------------------------------------------------
// Timing knobs (injectable so tests never sleep real time)
// ---------------------------------------------------------------------------

export interface AetherStreamTiming {
  /** First task-poll backoff step; doubles up to pollMaxMs. */
  readonly pollInitialMs: number;
  readonly pollMaxMs: number;
  /** First reconnect backoff step; doubles up to reconnectMaxMs. */
  readonly reconnectInitialMs: number;
  readonly reconnectMaxMs: number;
  /** Budget for one WebSocket open handshake. */
  readonly openTimeoutMs: number;
  /** Cap on consecutive connecting/transitional answers before failing loudly. */
  readonly connectMaxAttempts: number;
  /** Fallback wait when the server sends no retry_after_ms. */
  readonly connectDefaultRetryMs: number;
}

const DEFAULT_TIMING: AetherStreamTiming = {
  pollInitialMs: 500,
  pollMaxMs: 10_000,
  reconnectInitialMs: 1_000,
  reconnectMaxMs: 30_000,
  openTimeoutMs: 15_000,
  connectMaxAttempts: 60,
  connectDefaultRetryMs: 1_000,
};

const backoffMs = (initialMs: number, maxMs: number, attempt: number): number =>
  Math.min(maxMs, initialMs * 2 ** Math.min(attempt, 30));

// ---------------------------------------------------------------------------
// 1. Task → workspace resolution
// ---------------------------------------------------------------------------

export type AetherTaskWorkspaceResolution =
  /** The task has an execution context — connect against this workspace. */
  | { readonly _tag: "workspace"; readonly workspaceId: string; readonly task: AetherTask }
  /**
   * Null-context awaiting_input: STABLE, not transient. Zero further polls —
   * reattach rides the next /respond (spec resolved note 19).
   */
  | { readonly _tag: "parked"; readonly task: AetherTask };

export const resolveTaskWorkspace = Effect.fn("resolveTaskWorkspace")(function* (options: {
  readonly getTask: AetherRestClient["getTask"];
  readonly taskId: string;
  readonly timing?: Partial<AetherStreamTiming>;
}): Effect.fn.Return<
  AetherTaskWorkspaceResolution,
  AetherTaskErroredError | AetherTaskUnknownStatusError | AetherRestError
> {
  const timing = { ...DEFAULT_TIMING, ...options.timing };
  for (let attempt = 0; ; attempt++) {
    const task = yield* options.getTask(options.taskId);
    switch (task.status) {
      case "processing":
        // run_context is non-null by construction on this variant.
        return { _tag: "workspace", workspaceId: task.run_context.workspace_id, task } as const;
      case "queued":
        // Assignment is coming (a message is queued); poll with backoff.
        // A queued task that already reports a run_context is still not
        // attachable-for-processing — wait for the dispatcher to flip it.
        yield* Effect.sleep(
          Duration.millis(backoffMs(timing.pollInitialMs, timing.pollMaxMs, attempt)),
        );
        continue;
      case "awaiting_input":
        if (task.run_context === null) {
          return { _tag: "parked", task } as const;
        }
        // Parked on input but a workspace exists (it may be suspended) —
        // the passive connect decides live vs durable-only.
        return { _tag: "workspace", workspaceId: task.run_context.workspace_id, task } as const;
      case "errored":
        return yield* new AetherTaskErroredError({
          taskId: options.taskId,
          error: task.error,
          completedAt: task.completed_at,
        });
      case "unknown-status":
        return yield* new AetherTaskUnknownStatusError({
          taskId: options.taskId,
          rawStatus: task.rawStatus,
        });
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Connect → transport
// ---------------------------------------------------------------------------

export type AetherTransportResolution =
  | {
      readonly _tag: "transport";
      readonly websocketPath: string;
      readonly previewToken: string;
    }
  /** Not running and this attach may not start it — durable-only mode. */
  | { readonly _tag: "unavailable"; readonly reason: string };

export const connectForTransport = Effect.fn("connectForTransport")(function* (options: {
  readonly connectWorkspace: AetherRestClient["connectWorkspace"];
  readonly workspaceId: string;
  /** `true` ONLY on a user-initiated turn (T6); passive attach is `false`. */
  readonly start: boolean;
  readonly timing?: Partial<AetherStreamTiming>;
}): Effect.fn.Return<
  AetherTransportResolution,
  AetherWorkspaceConnectTimeoutError | AetherRestError
> {
  const timing = { ...DEFAULT_TIMING, ...options.timing };
  for (let attempt = 1; attempt <= timing.connectMaxAttempts; attempt++) {
    const outcome = yield* options.connectWorkspace(options.workspaceId, { start: options.start });
    switch (outcome.state) {
      case "running":
        return {
          _tag: "transport",
          websocketPath: outcome.transport.websocket_path,
          previewToken: outcome.transport.preview_token,
        } as const;
      case "connecting":
        yield* Effect.sleep(Duration.millis(outcome.retry_after_ms));
        continue;
      case "conflict":
        switch (outcome.conflict.kind) {
          case "transitional":
            // A lifecycle operation is settling; the same request answers
            // differently once it finishes.
            yield* Effect.sleep(Duration.millis(outcome.conflict.retry_after_ms));
            continue;
          case "startable":
            // A start WOULD start a VM — exactly what a passive attach must
            // never do (viewing never boots a workspace).
            return {
              _tag: "unavailable",
              reason: `workspace is not running (startable): ${outcome.conflict.error}`,
            } as const;
          case "not_connectable":
            return {
              _tag: "unavailable",
              reason: `workspace is ${outcome.conflict.display_state}: ${outcome.conflict.error}`,
            } as const;
        }
    }
  }
  return yield* new AetherWorkspaceConnectTimeoutError({
    workspaceId: options.workspaceId,
    attempts: timing.connectMaxAttempts,
  });
});

// ---------------------------------------------------------------------------
// 3. Socket loop
// ---------------------------------------------------------------------------

/** Live-connection handle handed to `onConnected`. */
export interface AetherAgentConnection {
  /**
   * Send one `user_activity` keep-alive ping. The T6 turn engine drives this
   * (throttled to ACTIVITY_PING_THROTTLE_MS) while a turn is active so the
   * VM's interactive idle hold stays alive; nothing calls it yet.
   */
  readonly sendUserActivity: () => Effect.Effect<void>;
}

export interface AetherAgentStreamOptions {
  readonly restClient: Pick<AetherRestClient, "getTask" | "connectWorkspace">;
  readonly apiBaseUrl: string;
  readonly apiKey: string;
  readonly taskId: string;
  readonly webSocketFactory?: AetherWebSocketFactory;
  readonly timing?: Partial<AetherStreamTiming>;
  /**
   * Fires after every successful attach+subscribe, BEFORE live frames are
   * handled — drive the conversation/delta reconciliation from the resume
   * cursor here (the ONLY recovery for live-only turn.* events missed while
   * detached).
   */
  readonly onConnected: (connection: AetherAgentConnection) => Effect.Effect<void>;
  /** One parsed agent event. */
  readonly onEvent: (event: AetherAgentEvent) => Effect.Effect<void>;
  /**
   * A dropped frame (unknown kind, malformed known kind, or a server
   * error-channel frame). Called once per distinct key per stream — the
   * caller logs / warns; the socket lives on.
   */
  readonly onFrameDropped: (problem: {
    readonly key: string;
    readonly detail: string;
  }) => Effect.Effect<void>;
  /**
   * One (re)connect attempt failed before reaching subscribe: the WS open
   * failed, or (after the stream has connected at least once) a
   * transport-class REST error hit the re-attach. The loop keeps retrying
   * with backoff; while it does, THIS callback is the only beat on which the
   * caller can surface the degradation and advance the transcript from the
   * durable feed (spec §3.11 REST-delta-only degrade — `onConnected`, the
   * normal reconcile trigger, never fires while opens keep failing).
   */
  readonly onConnectRetry: (failure: {
    /** Consecutive failed attempts since the last successful subscribe. */
    readonly consecutiveFailures: number;
    readonly detail: string;
  }) => Effect.Effect<void>;
  /**
   * The stream settled into durable-only mode (parked task or not-running
   * workspace). Terminal for this attach: the next sendTurn re-attaches.
   */
  readonly onDurableOnly: (reason: string) => Effect.Effect<void>;
}

type SocketSignal =
  | { readonly _tag: "message"; readonly data: string }
  | { readonly _tag: "closed"; readonly code: number; readonly reason: string };

// Outbound client messages, encoded through the schema JSON codec (the wire
// twins are AgentSubscribeMessageSchema / UserActivityMessageSchema in
// aether's workspace-protocol).
const encodeSubscribeMessage = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      channel: Schema.Literal("agent"),
      type: Schema.Literal("subscribe"),
      taskId: Schema.String,
    }),
  ),
);
const encodeUserActivityMessage = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      channel: Schema.Literal("activity"),
      type: Schema.Literal("user_activity"),
    }),
  ),
);

const openSocket = (
  factory: AetherWebSocketFactory,
  url: string,
  openTimeoutMs: number,
): Effect.Effect<
  { readonly socket: AetherWebSocketLike; readonly signals: Queue.Queue<SocketSignal> },
  AetherSocketOpenError
> =>
  Effect.gen(function* () {
    const socket = factory(url);
    const signals = yield* Queue.unbounded<SocketSignal>();
    // Listeners registered before the open await so no frame can slip
    // between open and subscription. offerUnsafe: listener callbacks are
    // synchronous, and an unbounded queue cannot reject.
    socket.addEventListener("message", (event) => {
      Queue.offerUnsafe(signals, {
        _tag: "message",
        data: typeof event.data === "string" ? event.data : String(event.data),
      });
    });
    socket.addEventListener("close", (event) => {
      Queue.offerUnsafe(signals, {
        _tag: "closed",
        code: event.code ?? 0,
        reason: event.reason ?? "",
      });
    });

    const awaitOpen = Effect.callback<void, AetherSocketOpenError>((resume) => {
      let settled = false;
      const settle = (effect: Effect.Effect<void, AetherSocketOpenError>) => {
        if (!settled) {
          settled = true;
          resume(effect);
        }
      };
      socket.addEventListener("open", () => settle(Effect.void));
      socket.addEventListener("error", () =>
        settle(
          Effect.fail(new AetherSocketOpenError({ url, detail: "socket errored before opening" })),
        ),
      );
      socket.addEventListener("close", (event) =>
        settle(
          Effect.fail(
            new AetherSocketOpenError({
              url,
              detail: `socket closed before opening (code ${event.code ?? 0})`,
            }),
          ),
        ),
      );
    });
    yield* awaitOpen.pipe(
      Effect.timeout(Duration.millis(openTimeoutMs)),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new AetherSocketOpenError({ url, detail: `open timed out after ${openTimeoutMs}ms` }),
        ),
      ),
      // EVERY pre-open exit must close the raw socket itself: the
      // acquireRelease finalizer only registers after open succeeds, and the
      // reconnect ladder retries open failures indefinitely — an upgrade
      // error/close/timeout that skipped this close would leak one socket
      // per attempt. close() is idempotent, so overlap with the close
      // listener is harmless.
      Effect.tapError(() => Effect.sync(() => socket.close())),
      Effect.onInterrupt(() => Effect.sync(() => socket.close())),
    );

    return { socket, signals };
  });

/**
 * The full attach → subscribe → pump → reconnect loop. Runs until
 * durable-only mode or interruption (session scope close). Typed failures
 * (task errored, unknown status, connect budget exhausted, REST auth/…)
 * propagate — the caller decides how to surface them.
 */
export const runAetherAgentStream = Effect.fn("runAetherAgentStream")(function* (
  options: AetherAgentStreamOptions,
): Effect.fn.Return<void, AetherAttachError> {
  const timing = { ...DEFAULT_TIMING, ...options.timing };
  const factory = options.webSocketFactory ?? defaultWebSocketFactory;
  const droppedKeys = new Set<string>();
  let reconnectAttempt = 0;
  let consecutiveFailures = 0;
  let everConnected = false;

  while (true) {
    // Re-resolve the FULL attach every iteration: task status and workspace
    // state both change while detached, and a stale workspace id would
    // reconnect to a torn-down VM.
    const attach = Effect.gen(function* () {
      const resolution = yield* resolveTaskWorkspace({
        getTask: options.restClient.getTask,
        taskId: options.taskId,
        timing,
      });
      if (resolution._tag === "parked") {
        return { _tag: "parked" } as const;
      }
      const transport = yield* connectForTransport({
        connectWorkspace: options.restClient.connectWorkspace,
        workspaceId: resolution.workspaceId,
        start: false,
        timing,
      });
      if (transport._tag === "unavailable") {
        return { _tag: "unavailable", reason: transport.reason } as const;
      }
      return { _tag: "transport", websocketPath: transport.websocketPath } as const;
    });

    // Once the stream has subscribed at least once, a transport-class REST
    // failure during re-attach (network blip, 5xx — often the very outage
    // that dropped the socket) re-enters the backoff ladder instead of
    // killing the pump for the rest of the session. Everything else (auth,
    // 404, task errored, unknown status, connect budget) still fails loudly,
    // and the FIRST attach fails loudly on any error so a misconfiguration
    // surfaces immediately at startSession.
    const attached = yield* everConnected
      ? attach.pipe(
          Effect.catchTag("AetherApiTransportError", (error) =>
            Effect.succeed({ _tag: "retry", detail: error.message } as const),
          ),
        )
      : attach;

    if (attached._tag === "parked") {
      yield* options.onDurableOnly(
        "task is awaiting input with no workspace (all queued messages were cancelled); the next response re-attaches",
      );
      return;
    }
    if (attached._tag === "unavailable") {
      yield* options.onDurableOnly(attached.reason);
      return;
    }

    const pumped =
      attached._tag === "retry"
        ? attached
        : yield* Effect.scoped(
            Effect.gen(function* () {
              const url = aetherWorkspaceSocketUrl(
                options.apiBaseUrl,
                attached.websocketPath,
                options.apiKey,
              );
              const opened = yield* Effect.acquireRelease(
                openSocket(factory, url, timing.openTimeoutMs),
                ({ socket }) => Effect.sync(() => socket.close()),
              );
              opened.socket.send(
                encodeSubscribeMessage({
                  channel: "agent",
                  type: "subscribe",
                  taskId: options.taskId,
                }),
              );
              reconnectAttempt = 0;
              consecutiveFailures = 0;
              everConnected = true;
              yield* options.onConnected({
                sendUserActivity: () =>
                  Effect.sync(() =>
                    opened.socket.send(
                      encodeUserActivityMessage({ channel: "activity", type: "user_activity" }),
                    ),
                  ),
              });

              while (true) {
                const signal = yield* Queue.take(opened.signals);
                if (signal._tag === "closed") {
                  return signal;
                }
                const parsed = parseAetherAgentFrame(signal.data);
                switch (parsed._tag) {
                  case "event": {
                    // The socket is workspace-scoped and frames carry their
                    // own task id: a stale frame after reconnect (or a future
                    // multiplexing change) must never be stamped with this
                    // session's task and pollute the thread.
                    if (parsed.event.taskId !== options.taskId) {
                      const key = `cross-task:${parsed.event.taskId}`;
                      if (!droppedKeys.has(key)) {
                        droppedKeys.add(key);
                        yield* options.onFrameDropped({
                          key,
                          detail: `Dropped a frame for task '${parsed.event.taskId}' on the socket subscribed to '${options.taskId}'.`,
                        });
                      }
                      break;
                    }
                    yield* options.onEvent(parsed.event);
                    break;
                  }
                  case "ignored":
                    // Another channel multiplexed on the same socket — not ours.
                    break;
                  case "server-error": {
                    // The workspace-service reporting its own failure (e.g.
                    // strict-parse rejection of our subscribe under protocol
                    // skew) — without this a rejected subscribe leaves a
                    // connected-but-mute socket with zero diagnostics.
                    const key = `server-error:${parsed.detail}`;
                    if (!droppedKeys.has(key)) {
                      droppedKeys.add(key);
                      yield* options.onFrameDropped({
                        key,
                        detail: `Aether workspace server reported an error over the socket: ${parsed.detail}`,
                      });
                    }
                    break;
                  }
                  case "unknown-kind": {
                    const key = `unknown-kind:${parsed.kind}`;
                    if (!droppedKeys.has(key)) {
                      droppedKeys.add(key);
                      yield* options.onFrameDropped({
                        key,
                        detail: `Unknown Aether agent event kind '${parsed.kind}' — frame dropped (logged once per kind).`,
                      });
                    }
                    break;
                  }
                  case "malformed": {
                    const key = `malformed:${parsed.kind ?? "envelope"}`;
                    if (!droppedKeys.has(key)) {
                      droppedKeys.add(key);
                      yield* options.onFrameDropped({ key, detail: parsed.detail });
                    }
                    break;
                  }
                }
              }
            }),
          ).pipe(
            // An open failure is a reconnect case, not a stream failure: the
            // workspace may have suspended between connect and upgrade.
            Effect.catchTag("AetherSocketOpenError", (error) =>
              Effect.succeed({ _tag: "retry", detail: error.detail } as const),
            ),
          );

    if (pumped._tag === "retry") {
      // The attach never reached subscribe — onConnected (the reconcile
      // trigger) did not fire, so surface the degradation and let the caller
      // run the durable backstop from here. The loop keeps retrying forever
      // by design: REST-delta-only operation is the mandated degrade (§3.11);
      // exactly-once session.exited after an exhausted budget is build item 13.
      consecutiveFailures++;
      yield* Effect.logWarning("aether.socket.connect-failed", {
        taskId: options.taskId,
        consecutiveFailures,
        detail: pumped.detail,
      });
      yield* options.onConnectRetry({ consecutiveFailures, detail: pumped.detail });
    } else {
      yield* Effect.logInfo("aether.socket.closed", {
        taskId: options.taskId,
        code: pumped.code,
        reason: pumped.reason,
      });
    }
    reconnectAttempt++;
    yield* Effect.sleep(
      Duration.millis(
        backoffMs(timing.reconnectInitialMs, timing.reconnectMaxMs, reconnectAttempt - 1),
      ),
    );
  }
});
