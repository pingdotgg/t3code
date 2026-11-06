import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as VibeError from "./errors.ts";

/**
 * vibe-app-server speaks JSON-RPC 2.0 over stdio, one compact JSON message per
 * line (newline-delimited), with camelCase fields (pydantic `to_camel` aliases).
 */

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly error: {
    readonly code: string | number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export const isJsonRpcRequest = (message: JsonRpcMessage): message is JsonRpcRequest =>
  "method" in message && "id" in message;

export const isJsonRpcNotification = (message: JsonRpcMessage): message is JsonRpcNotification =>
  "method" in message && !("id" in message);

export const isJsonRpcSuccess = (message: JsonRpcMessage): message is JsonRpcSuccess =>
  "result" in message;

export const isJsonRpcFailure = (message: JsonRpcMessage): message is JsonRpcFailure =>
  "error" in message;

export interface VibeAppServerProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly method?: string | undefined;
  readonly raw: string;
}

export interface VibeAppServerProtocolOptions {
  readonly stdio: Stdio.Stdio;
  readonly onRequest?: (
    request: JsonRpcRequest,
  ) => Effect.Effect<unknown, VibeError.VibeAppServerError>;
  readonly onNotification?: (
    notification: JsonRpcNotification,
  ) => Effect.Effect<void, VibeError.VibeAppServerError>;
  readonly onTermination?: (error: VibeError.VibeAppServerError) => Effect.Effect<void>;
  readonly terminationError?: Effect.Effect<VibeError.VibeAppServerError>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: VibeAppServerProtocolLogEvent) => Effect.Effect<void, never>;
}

export interface VibeAppServerProtocol {
  readonly request: (
    method: string,
    params?: unknown,
  ) => Effect.Effect<unknown, VibeError.VibeAppServerError>;
  readonly notify: (
    method: string,
    params?: unknown,
  ) => Effect.Effect<void, VibeError.VibeAppServerError>;
  readonly respond: (
    id: number | string,
    result: unknown,
  ) => Effect.Effect<void, VibeError.VibeAppServerError>;
  readonly respondError: (
    id: number | string,
    code: string | number,
    message: string,
    data?: unknown,
  ) => Effect.Effect<void, VibeError.VibeAppServerError>;
  readonly incomingRequests: Stream.Stream<JsonRpcRequest, VibeError.VibeAppServerError>;
  readonly incomingNotifications: Stream.Stream<JsonRpcNotification, VibeError.VibeAppServerError>;
  readonly awaitTermination: Effect.Effect<never, VibeError.VibeAppServerError>;
}

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isRequestError = Schema.is(VibeError.VibeAppServerRequestError);

export const parseJsonRpcLine = (line: string): JsonRpcMessage | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as JsonRpcMessage;
  } catch {
    return undefined;
  }
};

export const makeVibeAppServerProtocol = Effect.fn("@t3tools/vibe-app-server/protocol.make")(
  function* (
    options: VibeAppServerProtocolOptions,
  ): Effect.fn.Return<VibeAppServerProtocol, never, Scope.Scope> {
    const pending = new Map<
      string | number,
      Deferred.Deferred<unknown, VibeError.VibeAppServerRequestError>
    >();
    const requestPubSub = yield* PubSub.unbounded<JsonRpcRequest>();
    const notificationPubSub = yield* PubSub.unbounded<JsonRpcNotification>();
    const outgoing = yield* Queue.unbounded<string>();
    const termination = yield* Deferred.make<never, VibeError.VibeAppServerError>();
    let nextId = 1;

    const log = (direction: "incoming" | "outgoing", raw: string, method?: string) => {
      const enabled = direction === "incoming" ? options.logIncoming : options.logOutgoing;
      if (!enabled || !options.logger) return Effect.void;
      return options.logger({ direction, method, raw });
    };

    const enqueueOutgoing = (
      message: Record<string, unknown>,
    ): Effect.Effect<void, VibeError.VibeAppServerError> =>
      Effect.flatMap(encodeJson(message), (raw) =>
        Effect.andThen(
          log(
            "outgoing",
            raw,
            typeof message["method"] === "string" ? message["method"] : undefined,
          ),
          Queue.offer(outgoing, `${raw}\n`),
        ),
      ).pipe(
        Effect.asVoid,
        Effect.mapError(
          (error) =>
            new VibeError.VibeAppServerProtocolError({
              detail: `Failed to encode outgoing message: ${error.message}`,
              cause: error,
            }),
        ),
      );

    const failTermination = (error: VibeError.VibeAppServerError) =>
      Effect.andThen(
        Effect.forEach(
          [...pending.entries()],
          ([id, deferred]) =>
            Deferred.fail(
              deferred,
              new VibeError.VibeAppServerRequestError({
                method: "",
                code: "terminated",
                detail: error.message,
              }),
            ).pipe(Effect.asVoid, Effect.andThen(Effect.sync(() => pending.delete(id)))),
          { discard: true },
        ),
        Effect.andThen(
          Deferred.fail(termination, error),
          options.onTermination ? options.onTermination(error) : Effect.void,
        ),
      );

    const dispatch = (
      message: JsonRpcMessage,
    ): Effect.Effect<void, VibeError.VibeAppServerError> => {
      if (isJsonRpcSuccess(message) || isJsonRpcFailure(message)) {
        const deferred = pending.get(message.id);
        if (deferred === undefined) return Effect.void;
        pending.delete(message.id);
        return isJsonRpcSuccess(message)
          ? Effect.asVoid(Deferred.succeed(deferred, message.result))
          : Effect.asVoid(
              Deferred.fail(
                deferred,
                new VibeError.VibeAppServerRequestError({
                  method: "",
                  code: String(message.error.code),
                  detail: message.error.message,
                  ...(message.error.data !== undefined ? { data: message.error.data } : {}),
                }),
              ),
            );
      }
      if (isJsonRpcRequest(message)) {
        const answer: Effect.Effect<Record<string, unknown>> =
          options.onRequest === undefined
            ? Effect.succeed({
                error: { code: "method_not_found", message: `Method not found: ${message.method}` },
              })
            : options.onRequest(message).pipe(
                Effect.map((result) => ({ result })),
                Effect.catchCause((cause) => {
                  const squashed: unknown = Cause.squash(cause);
                  const error = isRequestError(squashed) ? squashed : undefined;
                  return Effect.succeed({
                    error: {
                      code: error !== undefined ? String(error.code) : "internal_error",
                      message: error !== undefined ? error.detail : String(squashed),
                    },
                  });
                }),
              );
        return Effect.asVoid(
          Effect.andThen(
            Effect.asVoid(PubSub.publish(requestPubSub, message)),
            Effect.flatMap(answer, (response) =>
              "result" in response
                ? enqueueOutgoing({ jsonrpc: "2.0", id: message.id, result: response.result })
                : enqueueOutgoing({ jsonrpc: "2.0", id: message.id, error: response.error }),
            ),
          ),
        );
      }
      if (isJsonRpcNotification(message)) {
        return Effect.asVoid(
          Effect.andThen(
            Effect.asVoid(PubSub.publish(notificationPubSub, message)),
            options.onNotification === undefined
              ? Effect.void
              : Effect.ignore(options.onNotification(message)),
          ),
        );
      }
      return Effect.void;
    };

    // Partial lines survive chunk boundaries: remainder lives outside the per-chunk callback.
    let remainder = "";
    yield* options.stdio.stdin.pipe(
      Stream.decodeText(),
      Stream.runForEach(
        Effect.fnUntraced(function* (chunk) {
          let start = 0;
          while (start < chunk.length) {
            const newline = chunk.indexOf("\n", start);
            const fragment = chunk.slice(start, newline === -1 ? chunk.length : newline);
            remainder += fragment;
            if (newline === -1) break;
            const line = remainder.replace(/\r$/, "");
            remainder = "";
            start = newline + 1;
            if (line.trim().length === 0) continue;
            yield* log("incoming", line);
            const message = parseJsonRpcLine(line);
            if (message !== undefined) {
              yield* Effect.catchCause(dispatch(message), (cause) =>
                Effect.logWarning("vibe-app-server dispatch failed", { cause }),
              );
            }
          }
        }),
      ),
      Effect.onExit((exit) =>
        options.terminationError !== undefined
          ? Effect.flatMap(options.terminationError, failTermination)
          : failTermination(
              new VibeError.VibeAppServerProtocolError({
                detail:
                  exit._tag === "Failure"
                    ? "vibe-app-server stdio failed"
                    : "vibe-app-server stdio ended",
                ...(exit._tag === "Failure" ? { cause: exit.cause } : {}),
              }),
            ),
      ),
      Effect.forkScoped,
    );

    yield* Stream.fromQueue(outgoing).pipe(
      Stream.run(options.stdio.stdout()),
      Effect.onExit((exit) =>
        exit._tag === "Failure"
          ? failTermination(
              new VibeError.VibeAppServerProtocolError({
                detail: "vibe-app-server stdin write failed",
                cause: exit.cause,
              }),
            )
          : Effect.void,
      ),
      Effect.forkScoped,
    );

    const request = Effect.fn("@t3tools/vibe-app-server/protocol.request")(function* (
      method: string,
      params?: unknown,
    ) {
      const id = nextId++;
      const deferred = yield* Deferred.make<unknown, VibeError.VibeAppServerRequestError>();
      pending.set(id, deferred);
      yield* enqueueOutgoing({
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });
      // Race the response against termination so a dead server cannot suspend callers forever.
      const result = yield* Effect.mapError(
        Effect.raceFirst(
          Deferred.await(deferred),
          Deferred.await(termination).pipe(
            Effect.mapError(
              (error) =>
                new VibeError.VibeAppServerRequestError({
                  method,
                  code: "terminated",
                  detail: error.message,
                }),
            ),
          ),
        ),
        (error) =>
          error.method.length === 0
            ? new VibeError.VibeAppServerRequestError({
                method,
                code: error.code,
                detail: error.detail,
                ...(error.data !== undefined ? { data: error.data } : {}),
              })
            : error,
      );
      pending.delete(id);
      return result;
    });

    const notify = (method: string, params?: unknown) =>
      enqueueOutgoing({
        jsonrpc: "2.0",
        method,
        ...(params !== undefined ? { params } : {}),
      });

    const respond = (id: number | string, result: unknown) =>
      enqueueOutgoing({ jsonrpc: "2.0", id, result });

    const respondError = (
      id: number | string,
      code: string | number,
      message: string,
      data?: unknown,
    ) =>
      enqueueOutgoing({
        jsonrpc: "2.0",
        id,
        error: { code, message, ...(data !== undefined ? { data } : {}) },
      });

    return {
      request,
      notify,
      respond,
      respondError,
      incomingRequests: Stream.fromPubSub(requestPubSub),
      incomingNotifications: Stream.fromPubSub(notificationPubSub),
      awaitTermination: Deferred.await(termination),
    };
  },
);
