import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as NodeNet from "node:net";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { Config } from "../workerd/Config.ts";
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
  for (const mode of ["single", "multiple", "override"] as const) {
    it.effect.skipIf(process.platform === "win32")(
      `fails on port conflict (${mode})`,
      () =>
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
            .serve(
              {
                sockets: [
                  {
                    name: "test",
                    address:
                      mode === "override" ? "localhost:0" : `localhost:${port}`,
                    service: { name: "test" },
                  },
                  ...(mode === "multiple"
                    ? [
                        {
                          name: "other",
                          address: "localhost:0",
                          service: { name: "test" },
                        },
                      ]
                    : []),
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
              },
              mode === "override"
                ? { "socket-addr": `test=localhost:${port}` }
                : undefined,
            )
            .pipe(Effect.flip);
          assert.equal(error._tag, "ConfigError");
          expect(error.subtag).toBe("AddressInUse");
          assert(Predicate.hasProperty(error.detail, "stderr"));
          expect(error.detail.stderr).toMatch(/Address already in use/);
          assert(Predicate.hasProperty(error.detail, "configuredAddresses"));
          expect(error.detail.configuredAddresses).toEqual([
            `localhost:${port}`,
            ...(mode === "multiple" ? ["localhost:0"] : []),
          ]);
          expect(error.message).toContain(`${port}`);
        }),
    );
  }

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

describe("parseV8Flags", () => {
  it("splits on whitespace and drops empty entries", () => {
    expect(
      Workerd.parseV8Flags("  --expose-gc \n --max-old-space-size=4096  "),
    ).toEqual(["--expose-gc", "--max-old-space-size=4096"]);
  });

  it("yields no flags when the variable is unset or blank", () => {
    expect(Workerd.parseV8Flags(undefined)).toEqual([]);
    expect(Workerd.parseV8Flags("")).toEqual([]);
    expect(Workerd.parseV8Flags("   ")).toEqual([]);
  });
});

/**
 * `--expose-gc` is observable from inside the isolate: `globalThis.gc` only
 * exists when V8 started with the flag, so the response tells whether the
 * flags reached the process.
 */
const serveGcProbe = (config: Pick<Config, "v8Flags"> = {}) =>
  Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;
    const ports = yield* workerd.serve({
      ...config,
      sockets: [
        { name: "http", address: "127.0.0.1:0", service: { name: "test" } },
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
                  "export default { fetch: () => new Response(typeof globalThis.gc) };",
              },
            ],
          },
        },
      ],
    });
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${ports.http}/`, {
        signal: AbortSignal.timeout(10_000),
      }),
    );
    return yield* Effect.promise(() => response.text());
  });

layer(services)("v8Flags", (it) => {
  beforeEach(() => vi.stubEnv(Workerd.V8_FLAGS_ENV, undefined));
  afterEach(() => vi.unstubAllEnvs());
  it.effect(
    "starts workerd without extra V8 flags by default",
    () =>
      Effect.gen(function* () {
        expect(yield* serveGcProbe()).toBe("undefined");
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "passes the config's v8Flags to workerd",
    () =>
      Effect.gen(function* () {
        expect(yield* serveGcProbe({ v8Flags: ["--expose-gc"] })).toBe(
          "function",
        );
      }),
    { timeout: 30_000 },
  );

  it.effect(
    `passes the flags in ${Workerd.V8_FLAGS_ENV} to workerd`,
    () =>
      Effect.gen(function* () {
        vi.stubEnv(Workerd.V8_FLAGS_ENV, "--expose-gc");
        expect(yield* serveGcProbe()).toBe("function");
      }),
    { timeout: 30_000 },
  );

  for (const [configFlag, envFlag, expected] of [
    ["--expose-gc", "--no-expose-gc", "function"],
    ["--no-expose-gc", "--expose-gc", "undefined"],
  ]) {
    it.effect(
      `prefers config flag ${configFlag} over environment flag ${envFlag}`,
      () =>
        Effect.gen(function* () {
          vi.stubEnv(Workerd.V8_FLAGS_ENV, envFlag);
          expect(yield* serveGcProbe({ v8Flags: [configFlag] })).toBe(expected);
        }),
      { timeout: 30_000 },
    );
  }
});
