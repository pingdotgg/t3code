import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { expectUrlContains } from "../Utils/Http.ts";
import { requestWorker, waitUntilStable } from "../Utils/WorkerRequest.ts";
import HttpServerWorker, { readyMarker, sensitiveContext } from "./fixtures/http-server-worker.ts";
import RawResponseWorker from "./fixtures/raw-response/worker.ts";
import NoSignalWorker from "./fixtures/request-abort/no-signal-worker.ts";
import RequestAbortWorker from "./fixtures/request-abort/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const Stack = Alchemy.Stack(
  "WorkersHttpServerStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* HttpServerWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/**
 * GET `url` until it serves `status` with an empty body. Both error routes
 * respond with no body, which also distinguishes them from the workers.dev
 * placeholder page (a 404 *with* a body) during edge propagation.
 */
const getEmptyResponse = (url: string, status: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);
    const body = yield* response.text;
    if (response.status !== status || body !== "") {
      return yield* Effect.fail(
        new Error(
          `expected empty ${status} from ${url}, got ${response.status}: ${body.slice(0, 160)}`,
        ),
      );
    }
    return response;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("1500 millis"), times: 20 }));

test(
  "a Respondable defect keeps its intended response over the wire",
  Effect.gen(function* () {
    const { url } = yield* stack;
    yield* expectUrlContains(url, readyMarker);

    yield* getEmptyResponse(`${url}/missing`, 404);
  }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 180_000,
  },
);

test(
  "a failed handler responds 500 without exposing the cause",
  Effect.gen(function* () {
    const { url } = yield* stack;
    yield* expectUrlContains(url, readyMarker);

    const response = yield* getEmptyResponse(`${url}/boom`, 500);
    const wireResponse = JSON.stringify(response.headers);
    for (const sensitiveValue of sensitiveContext) {
      expect(wireResponse).not.toContain(sensitiveValue);
    }
  }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 180_000,
  },
);

// `HttpServerResponse.fromWeb` responses take Effect-level status, headers and
// cookies on GET and HEAD, bodyless responses (HEAD, 204/205/304) still close
// their request scope, and a raw 101 upgrade passes through untouched.
for (const dev of [false, true]) {
  const { test: providerTest } = Test.make({ providers: Cloudflare.providers(), dev });

  providerTest.provider(
    `web responses over HTTP (${dev ? "local" : "live"})`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const worker = yield* stack.deploy(RawResponseWorker);
        const client = yield* HttpClient.HttpClient;
        const ready = yield* client.get(`${worker.url!}/ready`).pipe(
          Effect.flatMap((response) => response.text),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 8 }),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            times: 8,
            until: (body) => body === "raw-response:ready",
          }),
        );
        expect(ready).toBe("raw-response:ready");

        for (const path of [
          "/status",
          "/native",
          "/constructed-header",
          "/explicit-status",
          "/cookie",
          "/stream",
          "/no-content",
          "/reset-content",
          "/not-modified",
        ]) {
          for (const method of ["GET", "HEAD"] as const) {
            const url = `${worker.url!}${path}`;
            // Routes can propagate after /ready starts serving.
            const { response, body } = yield* Effect.gen(function* () {
              const response = yield* method === "GET" ? client.get(url) : client.head(url);
              return { response, body: yield* response.text };
            }).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                times: 8,
                until: ({ response }) =>
                  response.status !== 404 || response.headers["x-native"] !== undefined,
              }),
            );
            const mutated = path === "/status" || path === "/stream";
            const status =
              path === "/no-content"
                ? 204
                : path === "/reset-content"
                  ? 205
                  : path === "/not-modified"
                    ? 304
                    : path === "/explicit-status"
                      ? 201
                      : mutated
                        ? 418
                        : 202;
            expect(response.status).toBe(status);
            expect(response.headers["x-native"]).toBe(
              mutated ? "effect" : path === "/constructed-header" ? "constructed" : "native",
            );
            expect(response.headers["x-remove"]).toBe(mutated ? undefined : "native");
            if (mutated) {
              expect(response.headers["x-observed-status"]).toBe("202");
              expect(response.headers["x-observed-native"]).toBe("native");
            }
            expect(Cookies.toRecord(response.cookies)).toEqual(
              path === "/cookie" ? { a: "1", b: "2", session: "abc" } : { a: "1", b: "2" },
            );
            expect(body).toBe(
              method === "HEAD" || [204, 205, 304].includes(status)
                ? ""
                : path === "/stream"
                  ? "raw-response:streamed"
                  : "raw-response:body",
            );
            const finalized = yield* client
              .get(`${worker.url!}/finalized?entry=${encodeURIComponent(`${method}:${path}`)}`)
              .pipe(
                Effect.flatMap((response) => response.text),
                Effect.repeat({
                  schedule: Schedule.spaced("1 second"),
                  times: 8,
                  until: (body) => body === "true",
                }),
              );
            expect({ request: `${method} ${path}`, finalized }).toEqual({
              request: `${method} ${path}`,
              finalized: "true",
            });
          }
        }

        yield* Effect.gen(function* () {
          const socket = yield* Socket.makeWebSocket(
            `${worker.url!.replace(/^http/, "ws")}/websocket`,
          );
          const reader = yield* socket.reader;
          const writer = yield* socket.writer;
          yield* writer.write("response-upgrade");
          expect(yield* reader.pull).toEqual(["response-upgrade"]);
        }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal));
        yield* stack.destroy();
      }),
    {
      tags: ["provider:cloudflare", "provider:cloudflare:worker", ...(dev ? ["local"] : ["live"])],
    },
  );
}

/**
 * Holds a raw HTTP/1.1 request open over `openssl s_client`. Closing the
 * scope SIGKILLs the client, so the kernel drops the connection without a TLS
 * `close_notify`, the way a client that went away does. (A `close_notify`
 * reads as an HTTP half-close, which Cloudflare keeps serving, and Bun's
 * `node:tls` sends one even from `destroy()`.)
 */
const rawRequest = (host: string, request: string) =>
  ChildProcess.make(
    "openssl",
    ["s_client", "-connect", `${host}:443`, "-servername", host, "-alpn", "http/1.1", "-quiet"],
    {
      // `-quiet` keeps the connection open after stdin ends.
      stdin: Stream.make(request).pipe(Stream.encodeText),
      stdout: "ignore",
      stderr: "ignore",
      killSignal: "SIGKILL",
    },
  );

/**
 * Deploy `worker`, send `/slow` over a raw connection, kill the client once
 * the handler has started, and return what the handler recorded within
 * `polls` seconds afterwards.
 */
const disconnectMidRequest = (worker: { url: string | undefined }, polls: number) =>
  Effect.gen(function* () {
    // `/ready` calls the journal Durable Object, whose first calls after a
    // deploy can fail with an opaque "internal error".
    yield* waitUntilStable(
      `request-abort Worker at ${worker.url}`,
      requestWorker(HttpClientRequest.get(`${worker.url!}/ready`)).pipe(
        Effect.flatMap((response) => response.text),
        Effect.map((body) => body === "request-abort:ready"),
        Effect.catch(() => Effect.succeed(false)),
      ),
      { timeout: "60 seconds" },
    );
    const id = yield* Effect.sync(() => crypto.randomUUID());
    const events = requestWorker(HttpClientRequest.get(`${worker.url!}/events?id=${id}`)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as string[]),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
    );

    const host = yield* Effect.sync(() => new URL(worker.url!).host);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* rawRequest(host, `GET /slow?id=${id} HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
        yield* events.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            times: 30,
            until: (events) => events.includes("started"),
          }),
        );
      }),
    );

    return yield* events.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        times: polls,
        until: (events) => events.some((event) => event.startsWith("released:")),
      }),
    );
  });

// A client that disconnects interrupts the handler, so its resources are
// released as an interruption instead of staying open for nobody. Live only:
// local workerd does not fire `request.signal` when the client disconnects.
test.provider(
  "a client disconnect interrupts the handler",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const worker = yield* stack.deploy(RequestAbortWorker);
      const events = yield* disconnectMidRequest(worker, 20);
      expect(events).toEqual(["started", "released:interrupt"]);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

// Without `enable_request_signal`, Cloudflare cancels the request when the
// client disconnects and the handler's finalizers never run.
test.provider(
  "without enable_request_signal a client disconnect skips the handler's release",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const worker = yield* stack.deploy(NoSignalWorker);
      const events = yield* disconnectMidRequest(worker, 10);
      expect(events).toEqual(["started"]);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
