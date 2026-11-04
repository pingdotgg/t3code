import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import * as DurableObjectNamespace from "../bindings/DurableObjectNamespace.ts";
import * as Service from "../bindings/Service.ts";
import * as Runtime from "../Runtime.ts";
import * as Workerd from "../workerd/Workerd.ts";
import { localRuntimeLayer, makeLocalRuntimeLayer } from "./helpers/runtime.ts";

/**
 * `/crash` exhausts the isolate's heap. With a small `--max-old-space-size`
 * V8 aborts the process the way it does in a long dev session, only faster.
 */
const CRASHING_SCRIPT = `
const hog = [];
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/crash") {
      for (;;) hog.push(new Array(1_000_000).fill(url.pathname));
    }
    return env.SERVICE ? env.SERVICE.fetch(request) : new Response("hello");
  },
};
`;

const CRASHING_DURABLE_OBJECT_SCRIPT = `
import { DurableObject } from "cloudflare:workers";
const hog = [];
export class Pinger extends DurableObject {
  fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener("message", (event) => server.send(event.data));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("fetch ok");
  }
  ping() {
    return "rpc ok";
  }
}
export default {
  fetch(request) {
    if (new URL(request.url).pathname === "/crash") {
      for (;;) hog.push(new Array(1_000_000).fill("crash"));
    }
    return new Response("hello");
  },
};
`;

const DURABLE_OBJECT_CONSUMER_SCRIPT = `
export default {
  async fetch(request, env) {
    const stub = env.PINGER.get(env.PINGER.idFromName("singleton"));
    try {
      if (new URL(request.url).pathname === "/rpc") {
        return new Response(await stub.ping());
      }
      return await stub.fetch(request);
    } catch (error) {
      return new Response(String(error));
    }
  },
};
`;

const fetchText = (url: URL) =>
  Effect.tryPromise(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return await response.text();
  });

const openSocket = (url: URL) =>
  Effect.acquireRelease(
    Effect.callback<WebSocket, Error>((resume) => {
      const socket = new WebSocket(new URL(url.pathname, url.href.replace(/^http/, "ws")));
      socket.once("open", () => resume(Effect.succeed(socket)));
      socket.once("error", (error) => resume(Effect.fail(error)));
    }).pipe(Effect.timeout(10_000)),
    (socket) => Effect.sync(() => socket.terminate()),
  );

const echo = (socket: WebSocket, message: string) =>
  Effect.callback<string>((resume) => {
    socket.once("message", (data) => resume(Effect.succeed(String(data))));
    socket.send(message);
  }).pipe(Effect.timeout(5_000));

const closed = (socket: WebSocket) =>
  Effect.callback<void>((resume) => {
    if (socket.readyState === WebSocket.CLOSED) {
      return resume(Effect.void);
    }
    socket.once("close", () => resume(Effect.void));
  }).pipe(Effect.timeout(10_000));

layer(localRuntimeLayer, { excludeTestServices: true })("Runtime restart", (it) => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it.effect(
    "releases each process generation and bounds repeated crash recovery",
    () =>
      Effect.gen(function* () {
        vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
        const runtime = yield* Runtime.Runtime;
        const workerd = yield* Workerd.Workerd;
        const serve = workerd.serve;
        let active = 0;
        let started = 0;
        vi.spyOn(workerd, "serve").mockImplementation((...args) =>
          Effect.gen(function* () {
            expect(active).toBe(0);
            const ports = yield* serve(...args);
            active++;
            started++;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                active--;
              }),
            );
            return ports;
          }),
        );
        const exits: Array<Workerd.WorkerdExit> = [];
        const restarts = yield* Queue.unbounded<Workerd.WorkerdExit>();
        const url = yield* runtime.start({
          name: "restarting",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [],
          modules: [{ name: "main.js", type: "ESModule", content: CRASHING_SCRIPT }],
          onRestart: (exit) => {
            exits.push(exit);
            Queue.offerUnsafe(restarts, exit);
          },
        });
        expect(yield* fetchText(new URL("/hello", url))).toBe("hello");

        for (let crash = 1; crash <= 3; crash++) {
          yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
          const answer = yield* fetchText(new URL("/hello", url)).pipe(
            Effect.retry({
              schedule: Schedule.spaced("250 millis"),
              times: 10,
            }),
          );
          expect(answer).toBe("hello");
          // The replacement can serve HTTP before its restart callback runs.
          yield* Queue.take(restarts).pipe(Effect.timeout(10_000));
          expect(exits).toHaveLength(crash);
          expect(exits[crash - 1].stderr).toContain("JavaScript heap out of memory");
          expect(active).toBe(1);
        }
        // The fourth crash exhausts the rolling restart budget.
        yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
        yield* Effect.sleep(1_500);
        expect(started).toBe(4);
        expect(active).toBe(0);
        expect(exits).toHaveLength(3);
        expect(yield* fetchText(new URL("/hello", url)).pipe(Effect.exit)).toMatchObject({
          _tag: "Failure",
        });
      }),
    { timeout: 60_000 },
  );

  it.effect(
    "restores current service targets and keeps receiving registry updates",
    () =>
      Effect.gen(function* () {
        vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
        const runtime = yield* Runtime.Runtime;
        const parent = yield* Effect.scope;
        let providerScope = yield* Scope.fork(parent);
        const startProvider = (version: string) =>
          runtime
            .start({
              name: "restart-dependency",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [],
              modules: [
                {
                  name: "main.js",
                  type: "ESModule",
                  content: `export default { fetch: () => new Response("${version}") };`,
                },
              ],
            })
            .pipe(Scope.provide(providerScope));
        yield* startProvider("one");
        const url = yield* runtime.start({
          name: "restart-consumer",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [
            Service.local({
              binding: "SERVICE",
              scriptName: "restart-dependency",
            }),
          ],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: CRASHING_SCRIPT,
            },
          ],
        });
        const expectVersion = (version: string) =>
          fetchText(url).pipe(
            Effect.filterOrFail(
              (text) => text === version,
              () => new Error("stale service target"),
            ),
            Effect.retry({
              schedule: Schedule.spaced("250 millis"),
              times: 10,
            }),
            Effect.tap((text) => Effect.sync(() => expect(text).toBe(version))),
          );
        yield* expectVersion("one");
        yield* Scope.close(providerScope, Exit.void);
        providerScope = yield* Scope.fork(parent);
        yield* startProvider("two");
        yield* expectVersion("two");

        yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
        yield* expectVersion("two");

        yield* Scope.close(providerScope, Exit.void);
        providerScope = yield* Scope.fork(parent);
        yield* startProvider("three");
        yield* expectVersion("three");
      }),
    { timeout: 60_000 },
  );

  for (const crashBeforeClose of [false, true]) {
    it.effect(
      `does not restart after scope closure (crash: ${crashBeforeClose})`,
      () =>
        Effect.gen(function* () {
          vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
          const workerd = yield* Workerd.Workerd;
          const serve = vi.spyOn(workerd, "serve");
          const exits: Array<Workerd.WorkerdExit> = [];
          yield* Effect.gen(function* () {
            const runtime = yield* Runtime.Runtime;
            const url = yield* runtime.start({
              name: "closing",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [],
              modules: [
                {
                  name: "main.js",
                  type: "ESModule",
                  content: CRASHING_SCRIPT,
                },
              ],
              onRestart: (exit) => {
                exits.push(exit);
              },
            });
            expect(yield* fetchText(new URL("/hello", url))).toBe("hello");
            if (crashBeforeClose) {
              yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
            }
          }).pipe(Effect.scoped);
          // Give a wrongly reported exit time to arrive.
          yield* Effect.sleep(1_000);
          expect(serve).toHaveBeenCalledTimes(1);
          expect(exits).toHaveLength(0);
        }),
      { timeout: 30_000 },
    );
  }
});

// Replacement processes reach Durable Object proxies through registry updates,
// which Windows delivers by polling rather than watching.
const watcherModes = process.platform === "win32" ? [false] : [true, false];

for (const fileSystemSupportsWatcher of watcherModes) {
  layer(makeLocalRuntimeLayer({ fileSystemSupportsWatcher }), { excludeTestServices: true })(
    `Runtime restart across scripts (fileSystemSupportsWatcher: ${fileSystemSupportsWatcher})`,
    (it) => {
      afterEach(() => vi.unstubAllEnvs());
      it.effect(
        "reconnects a cross-script Durable Object to its owner's replacement process",
        () =>
          Effect.gen(function* () {
            vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
            const runtime = yield* Runtime.Runtime;
            const restarts = yield* Queue.unbounded<Workerd.WorkerdExit>();
            const owner = yield* runtime.start({
              name: "restart-durable-object-owner",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [],
              modules: [
                { name: "main.js", type: "ESModule", content: CRASHING_DURABLE_OBJECT_SCRIPT },
              ],
              durableObjectNamespaces: [
                { className: "Pinger", sql: false, uniqueKey: "restart-durable-object" },
              ],
              onRestart: (exit) => {
                Queue.offerUnsafe(restarts, exit);
              },
            });
            const consumer = yield* runtime.start({
              name: "restart-durable-object-consumer",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [
                DurableObjectNamespace.local({
                  binding: "PINGER",
                  className: "Pinger",
                  scriptName: "restart-durable-object-owner",
                  uniqueKey: "restart-durable-object",
                }),
              ],
              modules: [
                { name: "main.js", type: "ESModule", content: DURABLE_OBJECT_CONSUMER_SCRIPT },
              ],
            });
            // Calls arrive well inside the proxy's idle eviction window, so a stale
            // connection would fail every attempt.
            const expectAnswer = (path: string, answer: string) =>
              fetchText(new URL(path, consumer)).pipe(
                Effect.filterOrFail(
                  (text) => text === answer,
                  (text) => new Error(text),
                ),
                Effect.retry({
                  schedule: Schedule.spaced("250 millis"),
                  times: 10,
                }),
                Effect.tap((text) => Effect.sync(() => expect(text).toBe(answer))),
              );
            yield* expectAnswer("/rpc", "rpc ok");
            yield* expectAnswer("/fetch", "fetch ok");

            // The replacement listens on the same debug port.
            yield* fetchText(new URL("/crash", owner)).pipe(Effect.ignore);
            yield* Queue.take(restarts).pipe(Effect.timeout(10_000));
            yield* expectAnswer("/rpc", "rpc ok");
            yield* expectAnswer("/fetch", "fetch ok");
          }),
        { timeout: 60_000 },
      );

      it.effect(
        "keeps a cross-script Durable Object WebSocket open across calls and reconnects after a restart",
        () =>
          Effect.gen(function* () {
            vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
            const runtime = yield* Runtime.Runtime;
            const restarts = yield* Queue.unbounded<Workerd.WorkerdExit>();
            const owner = yield* runtime.start({
              name: "restart-websocket-owner",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [],
              modules: [
                { name: "main.js", type: "ESModule", content: CRASHING_DURABLE_OBJECT_SCRIPT },
              ],
              durableObjectNamespaces: [
                { className: "Pinger", sql: false, uniqueKey: "restart-websocket" },
              ],
              onRestart: (exit) => {
                Queue.offerUnsafe(restarts, exit);
              },
            });
            const consumer = yield* runtime.start({
              name: "restart-websocket-consumer",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [
                DurableObjectNamespace.local({
                  binding: "PINGER",
                  className: "Pinger",
                  scriptName: "restart-websocket-owner",
                  uniqueKey: "restart-websocket",
                }),
              ],
              modules: [
                { name: "main.js", type: "ESModule", content: DURABLE_OBJECT_CONSUMER_SCRIPT },
              ],
            });

            const socket = yield* openSocket(new URL("/ws", consumer)).pipe(
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 10 }),
            );
            expect(yield* echo(socket, "before")).toBe("before");
            // Other calls through the proxy share the Durable Object without
            // disturbing the open socket.
            for (let i = 0; i < 20; i++) {
              expect(yield* fetchText(new URL("/rpc", consumer))).toBe("rpc ok");
            }
            expect(yield* echo(socket, "between")).toBe("between");

            // The owner's crash ends the socket; a new one reaches the replacement.
            yield* fetchText(new URL("/crash", owner)).pipe(Effect.ignore);
            yield* closed(socket);
            yield* Queue.take(restarts).pipe(Effect.timeout(10_000));
            const replacement = yield* openSocket(new URL("/ws", consumer)).pipe(
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 10 }),
            );
            expect(yield* echo(replacement, "after")).toBe("after");
          }).pipe(Effect.scoped),
        { timeout: 60_000 },
      );
    },
  );
}
