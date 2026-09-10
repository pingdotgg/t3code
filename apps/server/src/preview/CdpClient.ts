/**
 * A minimal Chrome DevTools Protocol client.
 *
 * Deliberately not Playwright or Puppeteer: the server needs a handful of
 * domains (Target, Page, Runtime, Input, Emulation) and neither library can be
 * added without also adding a browser download step to `npx t3`. Node's global
 * WebSocket carries the whole protocol, so this costs no dependency at all.
 *
 * Flat sessions are used throughout (`Target.attachToTarget` with
 * `flatten: true`), so one socket multiplexes every page: a command carries the
 * `sessionId` of the target it addresses, and events carry the id they came
 * from.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

export class CdpConnectionError extends Schema.TaggedError<CdpConnectionError>()(
  "CdpConnectionError",
  { endpoint: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not reach the preview browser at ${this.endpoint}.`;
  }
}

export class CdpCommandError extends Schema.TaggedError<CdpCommandError>()("CdpCommandError", {
  method: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Preview browser rejected ${this.method}: ${this.detail}`;
  }
}

export type CdpEventListener = (event: {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}) => void;

interface PendingCommand {
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: CdpCommandError) => void;
  readonly method: string;
}

export interface CdpClient {
  readonly send: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Effect.Effect<Record<string, unknown>, CdpCommandError>;
  readonly on: (listener: CdpEventListener) => () => void;
  readonly closed: Effect.Effect<void>;
}

const COMMAND_TIMEOUT_MS = 15_000;

/**
 * Opens the socket and keeps it for the lifetime of the given scope. The
 * connect step is a Deferred rather than a promise wrapper so a browser that
 * never finishes starting fails the acquiring fiber instead of hanging it.
 */
export const connect = Effect.fn("CdpClient.connect")(function* (endpoint: string) {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const opened = yield* Deferred.make<void, CdpConnectionError>();
  const closed = yield* Deferred.make<void>();
  const pending = new Map<number, PendingCommand>();
  const listeners = new Set<CdpEventListener>();
  let nextId = 0;

  const socket = yield* Effect.try({
    try: () => new WebSocket(endpoint),
    catch: (cause) => new CdpConnectionError({ endpoint, cause }),
  });

  socket.addEventListener("open", () => {
    runFork(Deferred.succeed(opened, undefined).pipe(Effect.ignore));
  });
  socket.addEventListener("error", (event) => {
    runFork(
      Deferred.fail(opened, new CdpConnectionError({ endpoint, cause: event })).pipe(Effect.ignore),
    );
  });
  socket.addEventListener("close", () => {
    for (const command of pending.values()) {
      command.reject(
        new CdpCommandError({ method: command.method, detail: "the browser disconnected" }),
      );
    }
    pending.clear();
    runFork(Deferred.succeed(closed, undefined).pipe(Effect.ignore));
    runFork(
      Deferred.fail(
        opened,
        new CdpConnectionError({ endpoint, cause: "closed before opening" }),
      ).pipe(Effect.ignore),
    );
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message["id"];
    if (typeof id === "number") {
      const command = pending.get(id);
      if (!command) return;
      pending.delete(id);
      const error = message["error"];
      if (error !== undefined && error !== null) {
        const detail =
          typeof error === "object" &&
          error !== null &&
          typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message
            : JSON.stringify(error);
        command.reject(new CdpCommandError({ method: command.method, detail }));
        return;
      }
      const result = message["result"];
      command.resolve(
        typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {},
      );
      return;
    }
    const method = message["method"];
    if (typeof method !== "string") return;
    const params = message["params"];
    const sessionId = message["sessionId"];
    for (const listener of listeners) {
      listener({
        method,
        params:
          typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {},
        ...(typeof sessionId === "string" ? { sessionId } : {}),
      });
    }
  });

  yield* Scope.addFinalizer(
    yield* Effect.scope,
    Effect.sync(() => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }),
  );

  yield* Deferred.await(opened);

  const send: CdpClient["send"] = (method, params, sessionId) =>
    Effect.callback<Record<string, unknown>, CdpCommandError>((resume) => {
      if (socket.readyState !== WebSocket.OPEN) {
        resume(
          Effect.fail(new CdpCommandError({ method, detail: "the browser is not connected" })),
        );
        return;
      }
      const id = ++nextId;
      pending.set(id, {
        method,
        resolve: (result) => resume(Effect.succeed(result)),
        reject: (error) => resume(Effect.fail(error)),
      });
      socket.send(
        // @effect-diagnostics-next-line preferSchemaOverJson:off - CDP wire frame; its shape is the protocol's, not a schema's.
        JSON.stringify({
          id,
          method,
          params: params ?? {},
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
    }).pipe(
      Effect.timeoutOption(COMMAND_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new CdpCommandError({ method, detail: "timed out" })),
          onSome: (result: Record<string, unknown>) => Effect.succeed(result),
        }),
      ),
    );

  const client: CdpClient = {
    send,
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    closed: Deferred.await(closed),
  };
  return client;
});
