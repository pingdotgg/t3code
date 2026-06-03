import type * as cf from "@cloudflare/workers-types";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import { pipe } from "effect/Function";
import * as Latch from "effect/Latch";
import * as Scope from "effect/Scope";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  HttpClientError,
  TransportError,
} from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";

export type SocketAddress = cf.SocketAddress;

export type SocketOptions = cf.SocketOptions;

export interface Fetcher {
  fetch(
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError>;
  fetch(
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError>;

  connect(
    address: SocketAddress | string,
    options?: SocketOptions,
  ): Socket.Socket;
}

export const toCloudflareFetcher = Effect.fnUntraced(function* (
  fetcher: Fetcher,
) {
  const context = yield* Effect.context();
  return {
    fetch: (input, init) =>
      fetcher
        .fetch(
          HttpServerRequest.fromWeb(
            new Request(input as any, init as any) as any as Request,
          ),
        )
        .pipe(
          Effect.map(
            (response) =>
              HttpServerResponse.toWeb(response, {
                context,
              }) as any as cf.Response,
          ),
          Effect.provideContext(context),
          Effect.runPromise,
        ),
    connect() {
      // TODO
      throw new Error("toCloudflareFetcher does not support connect()");
    },
  } satisfies cf.Fetcher;
});

export const fromCloudflareFetcher = (fetcher: cf.Fetcher): Fetcher => {
  const fetch = (request: Request) =>
    Effect.promise((signal) =>
      fetcher.fetch(request as any as cf.Request, {
        signal: signal as cf.AbortSignal,
      }),
    );

  return {
    connect: (address, options) =>
      fromCloudflareSocket(fetcher.connect(address, options)),
    fetch: (
      request:
        | HttpClientRequest.HttpClientRequest
        | HttpServerRequest.HttpServerRequest,
    ): any =>
      HttpClientRequest.isHttpClientRequest(request)
        ? pipe(
            HttpServerRequest.toWeb(
              HttpServerRequest.fromClientRequest(request),
            ),
            Effect.flatMap(fetch),
            Effect.map((response) =>
              HttpClientResponse.fromWeb(request, response as any as Response),
            ),
            Effect.catch((error) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(error.message, {
                    status:
                      error._tag === "InternalError"
                        ? 500
                        : error._tag === "RequestParseError"
                          ? 400
                          : 404,
                  }),
                ),
              ),
            ),
          )
        : pipe(
            HttpServerRequest.toWeb(request),
            Effect.flatMap(fetch),
            Effect.map((response) => {
              if ((response as any).status === 101) {
                return HttpServerResponse.setBody(
                  HttpServerResponse.empty({ status: 101 }),
                  HttpBody.raw(response),
                );
              }
              return HttpServerResponse.fromWeb(response as any as Response);
            }),
          ),
  };
};

/**
 * Adapt anything that exposes a server-shaped `fetch` (e.g. a Durable Object
 * stub, a Worker service binding) into an Effect `HttpClient`. Lets HttpApi
 * clients address bindings without a base URL via `transformClient`.
 */
export const toHttpClient = (fetcher: {
  fetch: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError>;
}) =>
  HttpClient.make((request) => {
    return fetcher.fetch(HttpServerRequest.fromClientRequest(request)).pipe(
      Effect.map((response) => {
        return HttpClientResponse.fromWeb(
          request,
          HttpServerResponse.toWeb(response),
        );
      }),
      Effect.mapError(
        (cause) =>
          new HttpClientError({
            reason: new TransportError({
              request,
              cause,
              description: "Fetcher-backed HttpClient request failed",
            }),
          }),
      ),
    );
  });

export const fromCloudflareSocket = (cfSocket: cf.Socket): Socket.Socket => {
  const latch = Latch.makeUnsafe(false);
  let currentFiberSet: FiberSet.FiberSet<any, any> | undefined;
  let writerRef: WritableStreamDefaultWriter<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const closeError = (code: number, closeReason?: string) =>
    new Socket.SocketError({
      reason: new Socket.SocketCloseError({ code, closeReason }),
    });

  const runRaw = <_, E, R>(
    handler: (_: string | Uint8Array) => Effect.Effect<_, E, R> | void,
    opts?: { readonly onOpen?: Effect.Effect<void> | undefined },
  ): Effect.Effect<void, Socket.SocketError | E, R> =>
    Effect.scopedWith(
      Effect.fnUntraced(function* (scope) {
        // Cloudflare exposes connection establishment as a promise rather than an
        // event emitter, so we normalize that into the same SocketOpenError shape
        // Effect uses for the official adapters.
        yield* Effect.tryPromise({
          try: () => cfSocket.opened,
          catch: (cause) =>
            new Socket.SocketError({
              reason: new Socket.SocketOpenError({
                kind: "Unknown",
                cause,
              }),
            }),
        });

        const reader = cfSocket.readable.getReader();
        // Mirror `fromTransformStream`: the reader is scoped to a single `runRaw`
        // invocation and is always cancelled when that scope closes.
        yield* Scope.addFinalizer(
          scope,
          Effect.promise(() => reader.cancel()),
        );

        const fiberSet = yield* FiberSet.make<
          any,
          E | Socket.SocketError
        >().pipe(Scope.provide(scope));
        const runFork = yield* FiberSet.runtime(fiberSet)<R>();

        // Keep the remote-close watcher inside the FiberSet instead of attaching a
        // raw `.then(...)` callback. That matches Effect's pattern of keeping all
        // background work scoped and lets `FiberSet.join` observe close outcomes.
        yield* Effect.tryPromise({
          try: async () => {
            await cfSocket.closed;
            throw closeError(1000);
          },
          catch: (cause) =>
            Socket.isSocketError(cause) ? cause : closeError(1006),
        }).pipe(FiberSet.run(fiberSet));

        // The read loop itself follows `fromTransformStream`: fork the loop into
        // the FiberSet so handler effects can run concurrently while `join`
        // remains the single completion point for the socket session.
        yield* Effect.tryPromise({
          try: async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                throw closeError(1000);
              }
              const result = handler(value);
              if (Effect.isEffect(result)) {
                runFork(result);
              }
            }
          },
          catch: (cause) =>
            Socket.isSocketError(cause)
              ? cause
              : new Socket.SocketError({
                  reason: new Socket.SocketReadError({ cause }),
                }),
        }).pipe(FiberSet.run(fiberSet));

        currentFiberSet = fiberSet;
        // Writers are gated on the latch exactly like the official adapters so a
        // caller cannot send data before the read side has been fully installed.
        latch.openUnsafe();
        if (opts?.onOpen) yield* opts.onOpen;

        return yield* Effect.catchFilter(
          FiberSet.join(fiberSet),
          Socket.SocketCloseError.filterClean(
            (code) => code === 1000 || code === 1006,
          ),
          () => Effect.void,
        );
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          latch.closeUnsafe();
          currentFiberSet = undefined;
        }),
      ),
    );

  const run = <_, E, R>(
    handler: (_: Uint8Array) => Effect.Effect<_, E, R> | void,
    opts?: { readonly onOpen?: Effect.Effect<void> | undefined },
  ): Effect.Effect<void, Socket.SocketError | E, R> =>
    runRaw(
      (data) =>
        typeof data === "string"
          ? handler(encoder.encode(data))
          : handler(data),
      opts,
    );

  const decoder = new TextDecoder();
  const runString = <_, E, R>(
    handler: (_: string) => Effect.Effect<_, E, R> | void,
    opts?: { readonly onOpen?: Effect.Effect<void> | undefined },
  ): Effect.Effect<void, Socket.SocketError | E, R> =>
    runRaw(
      (data) =>
        typeof data === "string"
          ? handler(data)
          : handler(decoder.decode(data)),
      opts,
    );

  const write = (
    chunk: Uint8Array | string | Socket.CloseEvent,
  ): Effect.Effect<void, Socket.SocketError> =>
    latch.whenOpen(
      Effect.suspend(() => {
        if (Socket.isCloseEvent(chunk)) {
          // `fromTransformStream` signals a local close by completing the
          // FiberSet's deferred rather than trying to force stream semantics that
          // don't exist. We do the same here so `runRaw` unwinds through `join`.
          return Deferred.fail(
            currentFiberSet!.deferred,
            closeError(chunk.code, chunk.reason),
          );
        }
        if (!writerRef) {
          writerRef = cfSocket.writable.getWriter();
        }
        const data = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
        return Effect.tryPromise({
          try: () => writerRef!.write(data),
          catch: (cause) =>
            new Socket.SocketError({
              reason: new Socket.SocketWriteError({ cause }),
            }),
        });
      }),
    );

  const writer = Effect.acquireRelease(Effect.succeed(write), () =>
    // Treat writer shutdown as best-effort cleanup. Cloudflare may already have
    // closed the writable side by the time the scope releases.
    Effect.promise(async () => {
      if (writerRef) {
        await writerRef.close().catch(() => {});
      }
    }),
  );

  return Socket.Socket.of({
    [Socket.TypeId]: Socket.TypeId,
    run,
    runRaw,
    runString,
    writer,
  });
};
