import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as NodeNet from "node:net";
import * as Workerd from "../workerd/Workerd.ts";

const services = Layer.provide(Workerd.WorkerdLive, NodeServices.layer);

layer(services)((it) => {
  it.effect("spawns a workerd process", () =>
    Effect.gen(function* () {
      const workerd = yield* Workerd.Workerd;
      const result = yield* workerd.serve({
        sockets: [
          {
            name: "test",
            address: "localhost:0",
            service: { name: "test" },
          },
        ],
        services: [
          {
            name: "test",
            worker: {
              compatibilityDate: "2026-03-10",
              modules: [
                {
                  name: "main.js",
                  esModule:
                    "export default { fetch: () => new Response('Hello, world!') };",
                },
              ],
            },
          },
        ],
      });
      expect(result).toMatchObject({
        test: expect.any(Number),
      });
    }),
  );

  it.effect("fails on invalid worker configuration", () =>
    Effect.gen(function* () {
      const workerd = yield* Workerd.Workerd;
      const error = yield* workerd
        .serve({
          sockets: [
            {
              name: "test",
              address: "localhost:0",
              service: { name: "test" },
            },
          ],
          services: [
            {
              name: "test",
              worker: {
                modules: [
                  {
                    name: "main.js",
                    esModule:
                      "export default { fetch: () => new Response('Hello, world!') };",
                  },
                ],
              },
            },
          ],
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ConfigError",
        subtag: "WorkerdUserScript",
        message: "Worker must specify compatibilityDate.",
        detail: {
          service: "test",
          stderr: "service test: Worker must specify compatibilityDate.",
        },
      });
    }),
  );

  // On Windows, workerd/kj does not enforce exclusive socket binding by
  // default, so binding a second listener to an already-used port succeeds
  // instead of failing with "Address already in use". This behavior is
  // specific to workerd on Windows and outside our control.
  it.effect.skipIf(process.platform === "win32")("fails on port conflict", () =>
    Effect.gen(function* () {
      const workerd = yield* Workerd.Workerd;
      const result = yield* workerd.serve({
        sockets: [
          {
            name: "test",
            address: "localhost:0",
            service: { name: "test" },
          },
        ],
        services: [
          {
            name: "test",
            worker: {
              compatibilityDate: "2026-03-10",
              modules: [
                {
                  name: "main.js",
                  esModule:
                    "export default { fetch: () => new Response('Hello, world!') };",
                },
              ],
            },
          },
        ],
      });
      const port = result.test;
      const error = yield* workerd
        .serve({
          sockets: [
            {
              name: "test",
              address: `localhost:${port}`,
              service: { name: "test" },
            },
          ],
          services: [
            {
              name: "test",
              worker: {
                compatibilityDate: "2026-03-10",
                modules: [
                  {
                    name: "main.js",
                    esModule:
                      "export default { fetch: () => new Response('Hello, world!') };",
                  },
                ],
              },
            },
          ],
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ConfigError");
      expect(error.subtag).toBe("AddressInUse");
      assert(Predicate.hasProperty(error.detail, "stderr"));
      // "*** Fatal uncaught kj::Exception: kj/async-io-unix.c++:945: failed: ::bind(sockfd, &addr.generic, addrlen): Address already in use; toString() = 127.0.0.1:61328\n" +
      //    "stack: 10505b7f7 10505b5db 10505a073 10277aadb 10277b2eb 10277bd2f 10277cf2f 1026f3d57 105086dff 105087127 10508599f 10508575f 1026e08db 18c753da3"
      expect(error.detail.stderr).toMatch(/Address already in use/);
      assert(Predicate.hasProperty(error.detail, "address"));
      expect(error.detail.address).toBe(`127.0.0.1:${port}`);
      expect(error.message).toContain(`127.0.0.1:${port}`);
    }),
  );

  it.effect(
    "returns a port for each named socket",
    () =>
      Effect.gen(function* () {
        const workerd = yield* Workerd.Workerd;
        const ports = yield* workerd.serve({
          sockets: [
            {
              name: "primary",
              address: "127.0.0.1:0",
              service: { name: "test" },
            },
            {
              name: "secondary",
              address: "127.0.0.1:0",
              service: { name: "test" },
            },
          ],
          services: [
            {
              name: "test",
              worker: {
                compatibilityDate: "2026-03-10",
                modules: [
                  {
                    name: "main.js",
                    esModule:
                      "export default { fetch: () => new Response('ok') };",
                  },
                ],
              },
            },
          ],
        });
        expect(ports.primary).toEqual(expect.any(Number));
        expect(ports.secondary).toEqual(expect.any(Number));
        expect(ports.primary).not.toEqual(ports.secondary);
      }),
    { timeout: 30_000 },
  );

  // Every stage of this test is individually bounded. It used to hang for
  // the full 60s test timeout on loaded ubuntu CI runners (~3 of 8 main
  // runs) because the two unbounded waits — serve's listen-message race and
  // the un-timeboxed fetch — could wedge under full-suite parallel load,
  // and a vitest timeout interrupt wedges the shared layer runtime, so both
  // retries died instantly ("All fibers interrupted without error"). With
  // per-stage bounds a load blip surfaces as a fast, typed failure naming
  // the stage, which vitest's CI retry budget can actually absorb.
  it.effect(
    "shuts down workerd when its scope closes",
    () =>
      Effect.gen(function* () {
        let port = 0;
        const sentinel = `workerd-shutdown-${yield* Random.nextInt}`;
        yield* Effect.gen(function* () {
          const workerd = yield* Workerd.Workerd;
          const ports = yield* workerd
            .serve({
              sockets: [
                {
                  name: "http",
                  address: "127.0.0.1:0",
                  service: { name: "test" },
                },
              ],
              services: [
                {
                  name: "test",
                  worker: {
                    compatibilityDate: "2026-03-10",
                    modules: [
                      {
                        name: "main.js",
                        esModule: `export default { fetch: () => new Response('${sentinel}') };`,
                      },
                    ],
                  },
                },
              ],
            })
            .pipe(Effect.timeout(20_000));
          port = ports.http;
          // Workerd has reported its listener, so connect succeeds; the
          // bound covers a slow first-request isolate compile under load.
          const response = yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${port}/`, {
              signal: AbortSignal.timeout(10_000),
            }),
          );
          expect(yield* Effect.promise(() => response.text())).toBe(sentinel);
        }).pipe(Effect.scoped);

        // Linux may immediately give this ephemeral port to another workerd
        // spawned by a concurrently-running test. Port occupancy therefore
        // cannot identify whether *this* process survived scope closure.
        // Probe the unique response instead: refusal, timeout, or a different
        // body all prove the original process is no longer serving here.
        const stopped = yield* Effect.tryPromise(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(1_000),
          });
          return (await response.text()) !== sentinel;
        }).pipe(
          Effect.catch(() => Effect.succeed(true)),
          Effect.filterOrFail(
            (stopped) => stopped,
            () => new Error("the scoped workerd is still serving requests"),
          ),
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 20 }),
        );
        assert(stopped);
      }),
    { timeout: 60_000 },
  );
  // Pins the invariant the shutdown test's de-flake relies on: a TYPED
  // failure leaves the shared layer runtime healthy, so a vitest retry gets
  // a real, working attempt. (An external timeout interrupt used to wedge
  // the runtime — "All fibers interrupted without error" — making both CI
  // retries dead-on-arrival.) Attempt 1 fails on purpose the way a bounded
  // stage fails; attempt 2 must be able to run the full serve → fetch →
  // shutdown round-trip.
  let wedgeAttempts = 0;
  it.effect(
    "a typed failure leaves the runtime healthy, so a retry gets a real attempt",
    () =>
      Effect.gen(function* () {
        wedgeAttempts += 1;
        if (wedgeAttempts === 1) {
          return yield* Effect.fail(
            new Error("simulated transient wedge (attempt 1)"),
          );
        }
        const workerd = yield* Workerd.Workerd;
        const ports = yield* workerd
          .serve({
            sockets: [
              {
                name: "http",
                address: "127.0.0.1:0",
                service: { name: "test" },
              },
            ],
            services: [
              {
                name: "test",
                worker: {
                  compatibilityDate: "2026-03-10",
                  modules: [
                    {
                      name: "main.js",
                      esModule:
                        "export default { fetch: () => new Response('retried') };",
                    },
                  ],
                },
              },
            ],
          })
          .pipe(Effect.timeout(20_000));
        const response = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${ports.http}/`, {
            signal: AbortSignal.timeout(10_000),
          }),
        );
        expect(yield* Effect.promise(() => response.text())).toBe("retried");
      }),
    { timeout: 60_000, retry: 2 },
  );
  // Pins the persistent-wedge failure mode: against a server that accepts
  // connections but never responds (the shape of the CI wedge — workerd's
  // listener was up, the first response never came), the bounded fetch
  // fails FAST with a typed TimeoutError instead of hanging until the test
  // timeout kills the fiber. The server tracks and destroys its sockets on
  // release — `server.close` alone waits for the aborted connection's
  // server-side socket and never fires its callback.
  const silentServer = Effect.acquireRelease(
    Effect.callback<{
      port: number;
      server: NodeNet.Server;
      sockets: Set<NodeNet.Socket>;
    }>((resume) => {
      const sockets = new Set<NodeNet.Socket>();
      const server = NodeNet.createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () =>
        resume(
          Effect.succeed({
            server,
            sockets,
            port: (server.address() as NodeNet.AddressInfo).port,
          }),
        ),
      );
    }),
    ({ server, sockets }) =>
      Effect.callback<void>((resume) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resume(Effect.void));
      }),
  );

  it.effect(
    "a wedged first request fails fast with a typed abort, not a hang",
    () =>
      Effect.gen(function* () {
        const silent = yield* silentServer;
        const started = Date.now();
        const exit = yield* Effect.tryPromise(() =>
          fetch(`http://127.0.0.1:${silent.port}/`, {
            signal: AbortSignal.timeout(1_000),
          }),
        ).pipe(Effect.exit);
        const elapsed = Date.now() - started;
        assert(Exit.isFailure(exit));
        expect(String(exit.cause)).toMatch(/timeout/i);
        expect(elapsed).toBeLessThan(10_000);
      }),
    { timeout: 30_000 },
  );

  it.skip("TODO: workerd shuts down after an uncatchable parent SIGKILL", () => {});
  it.effect(
    "starts many workers concurrently",
    () =>
      Effect.gen(function* () {
        const workerd = yield* Workerd.Workerd;

        const count = 50;
        const urls = yield* Effect.all(
          Array.from({ length: count }, (_, index) =>
            workerd
              .serve({
                sockets: [
                  {
                    name: "http",
                    address: "127.0.0.1:0",
                    service: { name: "test" },
                  },
                ],
                services: [
                  {
                    name: "test",
                    worker: {
                      compatibilityDate: "2026-03-10",
                      modules: [
                        {
                          name: "main.js",
                          esModule: `export default { fetch: () => new Response('${index}') };`,
                        },
                      ],
                    },
                  },
                ],
              })
              .pipe(
                Effect.map(
                  (ports) => new URL(`http://127.0.0.1:${ports.http}`),
                ),
                Effect.flatMap((url) =>
                  Effect.promise(() =>
                    fetch(new URL("/", url)).then(async (res) => ({
                      status: res.status,
                      body: await res.text(),
                    })),
                  ),
                ),
              ),
          ),
          { concurrency: "unbounded" },
        );
        urls.forEach((url, index) => {
          expect(url.status).toBe(200);
          expect(url.body).toBe(index.toString());
        });
      }),
    { timeout: 30_000 },
  );
});
