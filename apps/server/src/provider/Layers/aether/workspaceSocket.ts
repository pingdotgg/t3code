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
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import type { AetherRestClient, AetherRestError } from "./restClient.ts";
import type { AetherTask } from "./restSchemas.ts";
import {
  parseAetherAgentFrame,
  parseAetherFileReadResponse,
  parseAetherGitDiffResponse,
  type AetherAgentEvent,
  type AetherPortsMessage,
  type AetherFrameParseResult,
  type AetherWsFileReadSuccessResponse,
  type AetherWsGitDiffResult,
  type AetherWsRequestOutcome,
} from "./wireEvents.ts";

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
// Request-response errors (git diff / files read over the live socket)
// ---------------------------------------------------------------------------

/** The workspace never answered a correlated request within the budget. */
export class AetherWorkspaceRequestTimeoutError extends Schema.TaggedErrorClass<AetherWorkspaceRequestTimeoutError>()(
  "AetherWorkspaceRequestTimeoutError",
  {
    channel: Schema.String,
    requestType: Schema.String,
    requestId: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Aether workspace did not answer the ${this.channel} '${this.requestType}' request within ${this.timeoutMs}ms.`;
  }
}

/** The workspace answered a correlated request with success:false. */
export class AetherWorkspaceRequestFailedError extends Schema.TaggedErrorClass<AetherWorkspaceRequestFailedError>()(
  "AetherWorkspaceRequestFailedError",
  {
    channel: Schema.String,
    requestType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Aether workspace ${this.channel} '${this.requestType}' request failed: ${this.detail}`;
  }
}

/** The socket dropped (or was never open) while a request needed it. */
export class AetherWorkspaceDetachedError extends Schema.TaggedErrorClass<AetherWorkspaceDetachedError>()(
  "AetherWorkspaceDetachedError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Aether workspace socket is not attached: ${this.detail}`;
  }
}

/** A correlated response that this build cannot parse — a contract break. */
export class AetherWorkspaceResponseMalformedError extends Schema.TaggedErrorClass<AetherWorkspaceResponseMalformedError>()(
  "AetherWorkspaceResponseMalformedError",
  {
    channel: Schema.String,
    requestType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Aether workspace ${this.channel} '${this.requestType}' response did not parse: ${this.detail}`;
  }
}

export type AetherWorkspaceRequestError =
  | AetherWorkspaceRequestTimeoutError
  | AetherWorkspaceRequestFailedError
  | AetherWorkspaceDetachedError
  | AetherWorkspaceResponseMalformedError;

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

export const defaultWebSocketFactory: AetherWebSocketFactory = (url) =>
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
  /** Budget for one correlated git/files request over the live socket. */
  readonly requestTimeoutMs: number;
}

export const DEFAULT_TIMING: AetherStreamTiming = {
  pollInitialMs: 500,
  pollMaxMs: 10_000,
  reconnectInitialMs: 1_000,
  reconnectMaxMs: 30_000,
  openTimeoutMs: 15_000,
  connectMaxAttempts: 60,
  connectDefaultRetryMs: 1_000,
  requestTimeoutMs: 30_000,
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
   * from its settle-poll beat while a turn is active so the VM's interactive
   * idle hold stays alive.
   */
  readonly sendUserActivity: () => Effect.Effect<void>;
  /**
   * Request the cumulative git diff over the git channel:
   * `{channel:"git", type:"diff", requestId, mode}` → `GitDiffResult`.
   * requestId-correlated with a timeout; every failure is typed.
   */
  readonly requestGitDiff: (input: {
    readonly mode: "main" | "lastCommit";
  }) => Effect.Effect<AetherWsGitDiffResult, AetherWorkspaceRequestError>;
  /**
   * Read one workspace file over the files channel (the binary-file path of
   * the mirror sync — base64 content for isBinary diff entries).
   */
  readonly readWorkspaceFile: (
    path: string,
  ) => Effect.Effect<AetherWsFileReadSuccessResponse, AetherWorkspaceRequestError>;
  /**
   * The workspace's preview-gateway token (32-char), from the connect
   * transport — authorizes cloud port previews for every port of this
   * workspace. Used to build `{port}-{workspaceId8}-{token}.{previewDomain}`.
   */
  readonly previewToken: string;
  /** The workspace id, used as the port-preview subdomain prefix. */
  readonly workspaceId: string;
}

export interface AetherAgentStreamOptions {
  readonly restClient: Pick<AetherRestClient, "getTask" | "connectWorkspace">;
  readonly apiBaseUrl: string;
  readonly apiKey: string;
  readonly taskId: string;
  readonly webSocketFactory?: AetherWebSocketFactory;
  readonly timing?: Partial<AetherStreamTiming>;
  /**
   * Pass `start=true` to the FIRST connect attempt of this stream — the one
   * path allowed to boot a VM, reserved for a user-initiated turn (the T6
   * sendTurn attach). Consumed after one connect; every re-attach after a
   * drop is passive again (`start=false`), preserving the
   * viewing-never-starts-a-VM invariant.
   */
  readonly startOnFirstAttach?: boolean;
  /**
   * Fires after every successful attach+subscribe, BEFORE live frames are
   * handled — drive the conversation/delta reconciliation from the resume
   * cursor here (the ONLY recovery for live-only turn.* events missed while
   * detached). The reconcile may settle a turn and issue correlated
   * git/files requests on the handed connection: those resolve normally,
   * because the frame router is already draining when this runs.
   */
  readonly onConnected: (connection: AetherAgentConnection) => Effect.Effect<void>;
  /** One parsed agent event. */
  readonly onEvent: (event: AetherAgentEvent) => Effect.Effect<void>;
  /** A ports-channel notification (port opened/closed) for cloud previews. */
  readonly onPortsMessage: (message: AetherPortsMessage) => Effect.Effect<void>;
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
  /**
   * The live socket dropped (after having connected). The connection handle
   * handed to `onConnected` is dead from this moment — callers must stop
   * issuing requests on it until the next `onConnected`.
   */
  readonly onDisconnected?: () => Effect.Effect<void>;
}

export type SocketSignal =
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

export const openSocket = (
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
      Effect.catchTags({
        TimeoutError: () =>
          Effect.fail(
            new AetherSocketOpenError({ url, detail: `open timed out after ${openTimeoutMs}ms` }),
          ),
      }),
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
  // One-shot start permission (user-initiated turn). Consumed by the first
  // connect attempt whether or not it succeeds — a failed active attach must
  // not leave a VM-boot permission armed for a later passive reconnect.
  let startPermission = options.startOnFirstAttach === true;

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
      const start = startPermission;
      startPermission = false;
      const transport = yield* connectForTransport({
        connectWorkspace: options.restClient.connectWorkspace,
        workspaceId: resolution.workspaceId,
        start,
        timing,
      });
      if (transport._tag === "unavailable") {
        return { _tag: "unavailable", reason: transport.reason } as const;
      }
      return {
        _tag: "transport",
        websocketPath: transport.websocketPath,
        previewToken: transport.previewToken,
        workspaceId: resolution.workspaceId,
      } as const;
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
          Effect.catchTags({
            AetherApiTransportError: (error) =>
              Effect.succeed({ _tag: "retry", detail: error.message } as const),
          }),
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
              consecutiveFailures = 0;
              everConnected = true;

              // Correlated request-response state for this connection.
              // Every pending request fails with a typed detached error when
              // the connection scope closes (socket drop or session stop).
              const pending = new Map<
                string,
                Deferred.Deferred<unknown, AetherWorkspaceDetachedError>
              >();
              let requestCounter = 0;
              // Sticky once the socket is known dead. `WebSocket.send()`
              // SILENTLY DISCARDS data in CLOSING/CLOSED, so a non-throwing
              // send is no proof a request was delivered: without this latch a
              // request issued after the close — including one `onConnected`
              // reconciliation starts against a socket that died in the same
              // tick as `open` — waits out the full `requestTimeoutMs` before
              // the reconnect can begin.
              let detached: AetherWorkspaceDetachedError | undefined;
              const detach = (error: AetherWorkspaceDetachedError) =>
                Effect.gen(function* () {
                  detached = error;
                  for (const deferred of pending.values()) {
                    yield* Deferred.fail(deferred, error).pipe(Effect.ignore);
                  }
                  pending.clear();
                });
              const socketClosedDetached = new AetherWorkspaceDetachedError({
                detail: "the workspace socket closed with the request in flight",
              });
              yield* Effect.addFinalizer(() => detach(socketClosedDetached));

              const sendRequest = <A>(input: {
                readonly channel: "git" | "files";
                readonly requestType: string;
                readonly message: (requestId: string) => string;
                readonly parse: (frame: unknown) => AetherWsRequestOutcome<A>;
              }): Effect.Effect<A, AetherWorkspaceRequestError> =>
                Effect.gen(function* () {
                  if (detached !== undefined) {
                    return yield* detached;
                  }
                  requestCounter++;
                  const requestId = `t3-${input.channel}-${requestCounter}`;
                  const deferred = yield* Deferred.make<unknown, AetherWorkspaceDetachedError>();
                  pending.set(requestId, deferred);
                  yield* Effect.try({
                    try: () => opened.socket.send(input.message(requestId)),
                    catch: (cause) =>
                      new AetherWorkspaceDetachedError({
                        detail: `failed to send the ${input.channel} '${input.requestType}' request: ${String(cause)}`,
                      }),
                  });
                  const frame = yield* Deferred.await(deferred).pipe(
                    Effect.timeout(Duration.millis(timing.requestTimeoutMs)),
                    Effect.catchTags({
                      TimeoutError: () =>
                        new AetherWorkspaceRequestTimeoutError({
                          channel: input.channel,
                          requestType: input.requestType,
                          requestId,
                          timeoutMs: timing.requestTimeoutMs,
                        }),
                    }),
                    Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
                  );
                  const outcome = input.parse(frame);
                  switch (outcome._tag) {
                    case "success":
                      return outcome.value;
                    case "failure":
                      return yield* new AetherWorkspaceRequestFailedError({
                        channel: input.channel,
                        requestType: input.requestType,
                        detail: outcome.error,
                      });
                    case "malformed":
                      return yield* new AetherWorkspaceResponseMalformedError({
                        channel: input.channel,
                        requestType: input.requestType,
                        detail: outcome.detail,
                      });
                  }
                });

              // Frame ROUTING runs on its own fiber so request-response
              // resolution never waits behind event handling: the mirror
              // sync engine issues correlated git/files requests from INSIDE
              // `onEvent` (sync-then-settle) AND from inside `onConnected`
              // (the reconcile can settle a turn), and a single fiber doing
              // both would deadlock — the response frame would sit in the
              // signal queue behind the very handler awaiting it,
              // guaranteeing the request timeout. The router is therefore
              // forked and DRAINING before `onConnected` runs. Event ORDER is
              // preserved regardless: the router only forwards non-response
              // frames FIFO into `routed`, and nothing takes from `routed`
              // until the consumer loop below, which starts strictly after
              // `onConnected` has returned.
              const routed = yield* Queue.unbounded<
                | { readonly _tag: "closed"; readonly code: number; readonly reason: string }
                | {
                    readonly _tag: "frame";
                    readonly parsed: Exclude<
                      AetherFrameParseResult,
                      { readonly _tag: "request-response" }
                    >;
                  }
              >();
              yield* Effect.gen(function* () {
                while (true) {
                  const signal = yield* Queue.take(opened.signals);
                  if (signal._tag === "closed") {
                    // Fail every in-flight request BEFORE handing the close to
                    // the consumer: the consumer cannot reach the queued close
                    // while `onConnected`/`onEvent` is still awaiting a git or
                    // files response, so a drop would otherwise stall the
                    // disconnect — and the reconnect — for a full request
                    // timeout.
                    yield* detach(socketClosedDetached);
                    yield* Queue.offer(routed, signal);
                    return;
                  }
                  const parsed = parseAetherAgentFrame(signal.data);
                  if (parsed._tag === "request-response") {
                    const waiter = pending.get(parsed.requestId);
                    if (waiter !== undefined) {
                      pending.delete(parsed.requestId);
                      yield* Deferred.succeed(waiter, parsed.frame).pipe(Effect.ignore);
                    }
                    // No waiter: the request already timed out — drop.
                    continue;
                  }
                  yield* Queue.offer(routed, { _tag: "frame", parsed });
                }
              }).pipe(Effect.forkScoped);

              yield* options.onConnected({
                sendUserActivity: () =>
                  Effect.sync(() =>
                    opened.socket.send(
                      encodeUserActivityMessage({ channel: "activity", type: "user_activity" }),
                    ),
                  ),
                requestGitDiff: ({ mode }) =>
                  sendRequest({
                    channel: "git",
                    requestType: "diff",
                    message: (requestId) =>
                      JSON.stringify({ channel: "git", type: "diff", requestId, mode }),
                    parse: parseAetherGitDiffResponse,
                  }),
                readWorkspaceFile: (path) =>
                  sendRequest({
                    channel: "files",
                    requestType: "read",
                    message: (requestId) =>
                      JSON.stringify({ channel: "files", type: "read", requestId, path }),
                    parse: parseAetherFileReadResponse,
                  }),
                previewToken: attached.previewToken,
                workspaceId: attached.workspaceId,
              });
              // The backoff ladder resets only once the connection PROVED
              // usable. Resetting it at `open` meant a server that accepts the
              // upgrade and then immediately closes (a persistent subscribe or
              // protocol rejection) rearmed the minimum delay on every
              // iteration, so the exponential ladder never advanced and the
              // loop hot-reconnected at reconnectInitialMs forever.
              if (detached === undefined) {
                reconnectAttempt = 0;
              }

              while (true) {
                const item = yield* Queue.take(routed);
                if (item._tag === "closed") {
                  return item;
                }
                const parsed = item.parsed;
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
                  case "ports":
                    yield* options.onPortsMessage(parsed.message);
                    break;
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
            Effect.catchTags({
              AetherSocketOpenError: (error) =>
                Effect.succeed({ _tag: "retry", detail: error.detail } as const),
            }),
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
      if (options.onDisconnected !== undefined) {
        yield* options.onDisconnected();
      }
    }
    reconnectAttempt++;
    yield* Effect.sleep(
      Duration.millis(
        backoffMs(timing.reconnectInitialMs, timing.reconnectMaxMs, reconnectAttempt - 1),
      ),
    );
  }
});
