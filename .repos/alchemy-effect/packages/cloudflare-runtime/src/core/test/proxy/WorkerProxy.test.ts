import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as NodeNet from "node:net";
import * as Internet from "../../globals/Internet.ts";
import * as WorkerProxy from "../../proxy/WorkerProxy.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import * as Workerd from "../../workerd/Workerd.ts";
import * as PortHelpers from "../helpers/port.ts";

const services = WorkerProxy.WorkerProxyLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(Workerd.WorkerdLive, Internet.InternetLive),
  ),
  Layer.provide(NodeServices.layer),
);

const HTTP_WORKER = `
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/echo") {
      const body = await request.text();
      return new Response("echo:" + body, {
        status: 200,
        headers: { "x-echo": "yes", "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/headers") {
      return Response.json({
        forwardedHost: request.headers.get("x-forwarded-host"),
        forwardedProto: request.headers.get("x-forwarded-proto"),
      });
    }
    return new Response("not found", { status: 404 });
  },
};
`;

const WS_WORKER = `
export default {
  fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    server.addEventListener("message", (event) => {
      server.send("echo:" + event.data);
      server.close(1000, "done");
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  },
};
`;

const serveUpstream = (esModule: string) =>
  Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;
    const ports = yield* workerd.serve({
      sockets: [
        { name: "http", address: "127.0.0.1:0", service: { name: "upstream" } },
      ],
      services: [
        {
          name: "upstream",
          worker: {
            compatibilityDate: "2026-03-10",
            modules: [{ name: "main.js", esModule }],
          },
        },
      ],
    });
    return new URL(`http://127.0.0.1:${ports.http}`);
  });

layer(services, { excludeTestServices: true })((it) => {
  it.effect(
    "proxies an HTTP request/response to the upstream worker once a target is set",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const upstream = yield* serveUpstream(HTTP_WORKER);
        const instance = yield* proxy.serve();
        yield* instance.set(upstream);

        const echo = yield* Effect.promise(() =>
          fetch(new URL("/echo", instance.url), {
            method: "POST",
            body: "hello",
          }).then(async (res) => ({
            status: res.status,
            echo: res.headers.get("x-echo"),
            body: await res.text(),
          })),
        );
        expect(echo).toEqual({ status: 200, echo: "yes", body: "echo:hello" });

        const missing = yield* Effect.promise(() =>
          fetch(new URL("/missing", instance.url)).then(async (res) => ({
            status: res.status,
            body: await res.text(),
          })),
        );
        expect(missing).toEqual({ status: 404, body: "not found" });
      }),
  );

  it.effect("handles request url with path beginning in //", () =>
    Effect.gen(function* () {
      const proxy = yield* WorkerProxy.WorkerProxy;
      const upstream = yield* serveUpstream(HTTP_WORKER);
      const instance = yield* proxy.serve();
      yield* instance.set(upstream);

      const url = new URL(instance.url);
      url.pathname = "//missing";

      const missing = yield* Effect.promise(() =>
        fetch(url).then(async (res) => ({
          status: res.status,
          body: await res.text(),
        })),
      );
      expect(missing).toEqual({ status: 404, body: "not found" });
    }),
  );

  it.effect(
    "forwards x-forwarded-host and x-forwarded-proto headers to the upstream worker",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const upstream = yield* serveUpstream(HTTP_WORKER);
        const instance = yield* proxy.serve();
        yield* instance.set(upstream);

        const headers = yield* Effect.promise(() =>
          fetch(new URL("/headers", instance.url)).then((res) => res.json()),
        );
        expect(headers).toMatchObject({
          forwardedHost: instance.url.host,
          forwardedProto: "http",
        });
      }),
  );

  it.effect(
    "re-targets requests to a new upstream after set is called again",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const first = yield* serveUpstream(
          `export default { fetch: () => new Response("first") };`,
        );
        const second = yield* serveUpstream(
          `export default { fetch: () => new Response("second") };`,
        );
        const instance = yield* proxy.serve();

        yield* instance.set(first);
        const a = yield* Effect.promise(() =>
          fetch(instance.url).then((res) => res.text()),
        );
        expect(a).toBe("first");

        yield* instance.set(second);
        const b = yield* Effect.promise(() =>
          fetch(instance.url).then((res) => res.text()),
        );
        expect(b).toBe("second");
      }),
  );

  it.effect(
    "queues a request received before the upstream is set and forwards it once ready",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const upstream = yield* serveUpstream(HTTP_WORKER);
        const instance = yield* proxy.serve();

        // Fire the request *before* any target is set. The proxy should park it
        // in its queue rather than failing.
        const pending = yield* Effect.forkChild(
          Effect.promise(() =>
            fetch(new URL("/echo", instance.url), {
              method: "POST",
              body: "queued",
            }).then(async (res) => ({
              status: res.status,
              body: await res.text(),
            })),
          ),
          { startImmediately: true },
        );

        // Give the request time to reach the proxy and be parked in the queue.
        // Uses a real timer rather than the Effect TestClock so it resolves
        // under `it.effect`.
        yield* Effect.promise(
          () => new Promise((resolve) => setTimeout(resolve, 500)),
        );

        yield* instance.set(upstream);

        const result = yield* Fiber.join(pending);
        expect(result).toEqual({ status: 200, body: "echo:queued" });
      }),
  );

  it.effect("handles many queued requests when the upstream is set", () =>
    Effect.gen(function* () {
      const proxy = yield* WorkerProxy.WorkerProxy;
      const upstream = yield* serveUpstream(HTTP_WORKER);
      const instance = yield* proxy.serve();

      // Enqueue many requests before the upstream is set, so they're queued.
      const responses = yield* Effect.all(
        Array.from({ length: 25 }, (_, i) =>
          Effect.forkChild(
            Effect.promise(() =>
              fetch(new URL("/echo", instance.url), {
                method: "POST",
                body: `queued${i}`,
              }).then(async (res) => ({
                status: res.status,
                body: await res.text(),
              })),
            ),
            { startImmediately: true },
          ),
        ),
      );

      // Wait several seconds, during which requests should be queued.
      yield* Effect.promise(
        () => new Promise((resolve) => setTimeout(resolve, 5000)),
      );

      yield* instance.set(upstream);

      const result = yield* Fiber.joinAll(responses);
      expect(result).toEqual(
        Array.from({ length: 25 }, (_, i) => ({
          status: 200,
          body: `echo:queued${i}`,
        })),
      );
    }),
  );

  it.effect(
    "retries a GET that was in flight when the upstream moved, without waiting for another request",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const instance = yield* proxy.serve();

        // A "slow" first upstream: it answers only after a delay, so the
        // proxied request is still in flight when the worker restarts.
        const slowScope = yield* Scope.make();
        const slow = yield* serveUpstream(
          `export default {
             async fetch() {
               await new Promise((resolve) => setTimeout(resolve, 1500));
               return new Response("slow");
             },
           };`,
        ).pipe(Scope.provide(slowScope));
        const fresh = yield* serveUpstream(
          `export default { fetch: () => new Response("fresh") };`,
        );

        yield* instance.set(slow);
        const pending = yield* Effect.forkChild(
          Effect.promise(() =>
            fetch(new URL("/", instance.url)).then((res) => res.text()),
          ),
          { startImmediately: true },
        );
        // Let the request reach the slow upstream…
        yield* Effect.promise(
          () => new Promise((resolve) => setTimeout(resolve, 300)),
        );
        // …then restart the worker the way the dev provider does: the new
        // target is set BEFORE the old instance is torn down, so the
        // in-flight fetch fails after the proxy already points elsewhere.
        yield* instance.set(fresh);
        yield* Scope.close(slowScope, Exit.void);

        // The in-flight GET is retryable. It must be re-driven against the
        // new target on its own — a client waiting on THIS response never
        // sends another request to kick the queue, so parking it until the
        // next PUT or request would hang the client forever (the runtime's
        // hang detector then cancels the proxy call without a response).
        const result = yield* Fiber.join(pending).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.succeed("TIMED OUT: parked in retry queue"),
          }),
        );
        expect(result).toBe("fresh");
      }),
  );

  it.effect(
    "returns immediately when the upstream fails with a non-retryable error",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const instance = yield* proxy.serve();
        const deadPort = yield* PortHelpers.find(0);

        // Point the proxy at an address with nothing listening. The fetch fails
        // with a non-retryable 502, which the per-request loop must surface
        // immediately rather than spin on retries.
        yield* instance.set(new URL(`http://127.0.0.1:${deadPort}`));

        const result = yield* Effect.promise(() =>
          fetch(new URL("/echo", instance.url), {
            method: "POST",
            body: "x",
          }).then((res) => ({
            status: res.status,
            retryAfter: res.headers.get("retry-after"),
          })),
        );
        expect(result.status).toBe(502);
        expect(result.retryAfter).toBeNull();
      }),
  );

  it.effect("proxies a websocket connection to the upstream worker", () =>
    Effect.gen(function* () {
      const proxy = yield* WorkerProxy.WorkerProxy;
      const upstream = yield* serveUpstream(WS_WORKER);
      const instance = yield* proxy.serve();
      yield* instance.set(upstream);

      const wsUrl = new URL(instance.url);
      wsUrl.protocol = "ws:";

      const result = yield* roundTrip(wsUrl, "hello");
      expect(result).toMatchObject({
        message: "echo:hello",
        closeCode: 1000,
        closeReason: "done",
      });
    }),
  );

  it.effect("uses the localhost hostname and a random port by default", () =>
    Effect.gen(function* () {
      const proxy = yield* WorkerProxy.WorkerProxy;
      const instance = yield* proxy.serve();
      expect(instance.url.hostname).toBe("localhost");
      expect(Number(instance.url.port)).toBeGreaterThan(0);
    }),
  );

  it.effect("serves on the requested port when it is available", () =>
    Effect.gen(function* () {
      const proxy = yield* WorkerProxy.WorkerProxy;
      const upstream = yield* serveUpstream(HTTP_WORKER);
      const port = yield* PortHelpers.find(0);

      const instance = yield* proxy.serve({ port });
      expect(instance.url.port).toBe(String(port));

      yield* instance.set(upstream);
      const body = yield* Effect.promise(() =>
        fetch(new URL("/echo", instance.url), {
          method: "POST",
          body: "hi",
        }).then((res) => res.text()),
      );
      expect(body).toBe("echo:hi");
    }),
  );

  it.effect(
    "falls back to the next available port when the requested port is in use",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const blocker = yield* PortHelpers.occupy(0);

        const instance = yield* proxy.serve({ port: blocker.port });
        expect(Number(instance.url.port)).toBeGreaterThan(blocker.port);
      }),
  );

  it.effect(
    "serves on the exact requested port when strictPort is set and it is free",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const port = yield* PortHelpers.find(0);

        const instance = yield* proxy.serve({ port, strictPort: true });
        expect(instance.url.port).toBe(String(port));
      }).pipe(it.flakyTest),
  );

  it.effect(
    "fails when strictPort is set and the requested port is in use",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const blocker = yield* PortHelpers.occupy(0);
        const error = yield* proxy
          .serve({ port: blocker.port, strictPort: true })
          .pipe(Effect.flip);
        assert(error instanceof ConfigError);
        expect(Workerd.isAddressInUseError(error)).toBe(true);
      }),
  );

  it.effect(
    "owns its port on the IPv6 loopback so localhost cannot be shadowed",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const upstream = yield* serveUpstream(HTTP_WORKER);
        const instance = yield* proxy.serve();
        yield* instance.set(upstream);
        const port = Number(instance.url.port);

        // `localhost` resolves to both 127.0.0.1 and ::1 (and browsers prefer
        // ::1). A proxy holding only the IPv4 half leaves `[::1]:port` free
        // for another dev server to claim, silently splitting the port's
        // traffic between two apps. The proxy must answer on both halves...
        const viaV6 = yield* Effect.promise(() =>
          fetch(`http://[::1]:${port}/echo`, {
            method: "POST",
            body: "v6",
          }).then((res) => res.text()),
        );
        expect(viaV6).toBe("echo:v6");

        // ...and a squatter's bind on the IPv6 half must fail.
        const squat = yield* Effect.callback<string>((resume) => {
          const server = NodeNet.createServer();
          server.once("error", (error) =>
            resume(
              Effect.succeed(
                typeof error === "object" && error !== null && "code" in error
                  ? String(error.code)
                  : "error",
              ),
            ),
          );
          server.listen({ port, host: "::1", exclusive: true }, () =>
            server.close(() => resume(Effect.succeed("BOUND"))),
          );
          return Effect.sync(() => server.close());
        });
        expect(squat).toBe("EADDRINUSE");
      }),
  );

  it.effect(
    "waits out a previous session's teardown instead of shifting configured ports",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;

        // Simulate a dev restart racing the old session's teardown: the old
        // session still holds the middle configured port when the new
        // session's proxies start. Without a grace window the middle worker
        // silently drifts onto a neighbor's configured port — serving the
        // wrong app on a port the user knows.
        //
        // The suite runs many port tests concurrently, so a freshly probed
        // port's neighbors may already be taken — stage the trio by
        // retrying until the "stale" listener actually binds base + 1 and
        // base + 2 probes free.
        const tryBind = (port: number) =>
          Effect.callback<NodeNet.Server | undefined>((resume) => {
            const server = NodeNet.createServer();
            server.once("error", () => resume(Effect.succeed(undefined)));
            server.listen({ port, exclusive: true }, () =>
              resume(Effect.succeed(server)),
            );
            return Effect.sync(() => server.close());
          });
        let base!: number;
        let stale!: NodeNet.Server;
        for (let attempt = 0; ; attempt++) {
          const candidate = yield* PortHelpers.find(0);
          const staleCandidate = yield* tryBind(candidate + 1);
          if (staleCandidate !== undefined) {
            const neighbor = yield* tryBind(candidate + 2);
            if (neighbor !== undefined) {
              yield* Effect.callback<void>((resume) =>
                neighbor.close(() => resume(Effect.void)),
              );
              base = candidate;
              stale = staleCandidate;
              break;
            }
            yield* Effect.callback<void>((resume) =>
              staleCandidate.close(() => resume(Effect.void)),
            );
          }
          if (attempt >= 9) {
            return yield* Effect.die(
              "could not stage a stale listener on a free port trio",
            );
          }
        }
        // The finalizer makes the close idempotent if the test fails early.
        yield* Effect.addFinalizer(() =>
          Effect.callback<void>((resume) =>
            stale.close(() => resume(Effect.void)),
          ),
        );
        // The "old session" releases the port mid-grace-window.
        yield* Effect.forkChild(
          Effect.sleep("750 millis").pipe(
            Effect.andThen(
              Effect.callback<void>((resume) =>
                stale.close(() => resume(Effect.void)),
              ),
            ),
          ),
        );

        const [a, b, c] = yield* Effect.all(
          [
            proxy.serve({ port: base }),
            proxy.serve({ port: base + 1 }),
            proxy.serve({ port: base + 2 }),
          ],
          { concurrency: "unbounded" },
        );

        expect(Number(a.url.port)).toBe(base);
        expect(Number(b.url.port)).toBe(base + 1);
        expect(Number(c.url.port)).toBe(base + 2);
      }),
  );

  it.effect("serves on a custom host when provided", () =>
    Effect.gen(function* () {
      const proxy = yield* WorkerProxy.WorkerProxy;
      const upstream = yield* serveUpstream(HTTP_WORKER);

      const instance = yield* proxy.serve({ host: "0.0.0.0" });
      expect(instance.url.hostname).toBe("0.0.0.0");

      yield* instance.set(upstream);
      const body = yield* Effect.promise(() =>
        fetch(new URL("/echo", instance.url), {
          method: "POST",
          body: "host",
        }).then((res) => res.text()),
      );
      expect(body).toBe("echo:host");
    }),
  );

  it.effect(
    "starts many proxies concurrently requesting the same port without collisions",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const basePort = yield* PortHelpers.find(0);

        // All instances request the same starting port at once. The non-strict
        // port-selection retry should hand each one a distinct, available port.
        const count = 25;
        const instances = yield* Effect.all(
          Array.from({ length: count }, () => proxy.serve({ port: basePort })),
          { concurrency: "unbounded" },
        );

        const ports = instances.map((instance) => instance.url.port);
        expect(ports.every((port) => Number(port) >= basePort)).toBe(true);
        expect(new Set(ports).size).toBe(count);
      }),
  );

  it.effect(
    "rejects controller requests with a missing or invalid authorization token",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const instance = yield* proxy.serve();
        const controllerUrl = new URL(
          "/cdn-cgi/proxy/controller",
          instance.url,
        );

        const noAuth = yield* Effect.promise(() =>
          fetch(controllerUrl, {
            method: "PUT",
            headers: { "Content-Type": "text/plain" },
            body: "http://127.0.0.1:9999",
          }).then((res) => res.status),
        );
        expect(noAuth).toBe(401);

        const badAuth = yield* Effect.promise(() =>
          fetch(controllerUrl, {
            method: "PUT",
            headers: {
              "Content-Type": "text/plain",
              Authorization: "Bearer wrong-token",
            },
            body: "http://127.0.0.1:9999",
          }).then((res) => res.status),
        );
        expect(badAuth).toBe(401);
      }),
  );
});

const roundTrip = (url: URL, payload: string) =>
  Effect.callback<{
    message: string;
    closeCode: number;
    closeReason: string;
  }>((resume) => {
    const ws = new WebSocket(url);
    let message: string | undefined;
    ws.addEventListener("open", () => {
      ws.send(payload);
    });
    ws.addEventListener("message", (event) => {
      message = String(event.data);
    });
    ws.addEventListener("close", (event) => {
      if (message === undefined) {
        resume(Effect.die(new Error("did not receive a message before close")));
      } else {
        resume(
          Effect.succeed({
            message,
            closeCode: event.code,
            closeReason: event.reason,
          }),
        );
      }
    });
    ws.addEventListener("error", () => {
      resume(Effect.die(new Error("websocket error")));
    });
    return Effect.sync(() => {
      ws.close();
    });
  });
