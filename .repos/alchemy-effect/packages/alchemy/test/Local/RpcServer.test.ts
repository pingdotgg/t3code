import { fileURLToPath } from "node:url";
import { assert, describe, expect, it } from "@alchemy.run/test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schedule from "effect/Schedule";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { unwrapRpcHandlers, type RpcWrapped } from "@/Local/RpcSerialization.ts";
import type { RpcProxyApi } from "@/Local/RpcServer.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { openWebSocket, waitForExit } from "./fixtures/process-effect.ts";
import type { EchoClient } from "./fixtures/rpc-echo.ts";
import { runtimes } from "./fixtures/runtimes.ts";

const FIXTURE_TS = fileURLToPath(new URL("./fixtures/rpc-server-entry.ts", import.meta.url));

const ADDRESS_RE = /<ALCHEMY_RPC_ADDRESS>(.+?)<\/ALCHEMY_RPC_ADDRESS>/;

const sampleEnv = () =>
  JSON.stringify({
    profile: null,
    envFile: null,
    alchemyContext: {
      dotAlchemy: "/tmp/.alchemy",
      updateStateStore: false,
      dev: true,
      adopt: false,
    },
    stack: { name: "test", stage: "dev" },
  });

// Concurrent at both levels: every test spawns its own isolated child
// process, and two of them deliberately wait out the sidecar's ~10s
// parent-connect self-termination. Run serially (the file default) those
// two waits alone would stack to ~20s of wall clock.
describe.concurrent("Local.RpcServer", { tags: ["local"] }, () => {
  for (const runtime of runtimes()) {
    describe.concurrent.skipIf(!runtime.available)(runtime.name, () => {
      const [bin, ...args] = runtime.argv(FIXTURE_TS);
      const launch = ChildProcess.make(bin, args, {
        env: {
          ALCHEMY_RPC_SERVER_ENVIRONMENT: sampleEnv(),
        },
        extendEnv: true,
        // We never write to the child's stdin, so close it. stdout/stderr
        // default to "pipe" which is what we want for the buffering forks
        // below.
        stdin: "ignore",
        // SIGTERM first, escalate to SIGKILL after 1s if the child hasn't
        // exited. Matches the behavior of the old hand-rolled finalizer.
        killSignal: "SIGTERM",
        forceKillAfter: "1 second",
      });

      it.live(
        "prints the RPC address marker on stdout and accepts /parent + session connections",
        () =>
          Effect.gen(function* () {
            const proc = yield* launch;
            const url = yield* proc.stdout.pipe(
              Stream.decodeText,
              Stream.run(
                Sink.fold(
                  () => "",
                  (acc) => !acc.includes("</ALCHEMY_RPC_ADDRESS>"),
                  (acc, chunk) => Effect.succeed(acc + chunk),
                ),
              ),
              Effect.timeout("5 seconds"),
              Effect.map((output) => output.match(ADDRESS_RE)?.[1]),
            );
            assert(url, `url not found in output: "${url}"`);
            expect(url).toMatch(/^ws:\/\//);
            // The sidecar listens on loopback only, under every runtime.
            expect(new URL(url).hostname).toBe("127.0.0.1");

            // Open the parent websocket inside the scope so it stays alive
            // for the duration of the RPC exchange below; closing it later
            // is exactly what triggers the child to exit.
            const parent = yield* openWebSocket(new URL("/parent", url));

            // Drive a real RPC call through a session websocket. capnweb's
            // surface is Promise-based, so we wrap exactly at the boundary
            // and let everything above and below stay in Effect.

            // TODO(sam): tsc (typescript 7) vomits here, so we cast to any.
            const stub = (newWebSocketRpcSession as any)(url) as RpcStub<RpcProxyApi>;
            const result = yield* Effect.promise(async () => {
              const provider = await stub.getProvider(
                "Test.Echo",
                new URL("./fixtures/rpc-server-entry.ts", import.meta.url).href,
              );
              const handlers = unwrapRpcHandlers(provider as any) as {
                echo: (msg: string) => Effect.Effect<string>;
              };
              return await Effect.runPromise(handlers.echo("hello"));
            });
            expect(result).toBe("echo:hello");

            // Closing the parent ws should cause the child to exit promptly.
            yield* Effect.sync(() => parent.close());
            // waitForExit fails if the child is still running after the
            // timeout, so reaching this point means the child exited.
            yield* waitForExit(proc, "5 seconds");
          }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
        { timeout: 30_000 },
      );

      it.live(
        "test release closes contexts, artifacts, and late builds without closing dev contexts",
        () =>
          Effect.gen(function* () {
            const proc = yield* launch;
            const url = yield* proc.stdout.pipe(
              Stream.decodeText,
              Stream.run(
                Sink.fold(
                  () => "",
                  (text) => !text.includes("</ALCHEMY_RPC_ADDRESS>"),
                  (text, chunk) => Effect.succeed(text + chunk),
                ),
              ),
              Effect.timeout("5 seconds"),
              Effect.map((text) => text.match(ADDRESS_RE)?.[1]),
            );
            assert(url);
            yield* openWebSocket(new URL("/parent", url));
            const connect = () =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const socket = new WebSocket(url);
                  const rpc = newWebSocketRpcSession(socket) as unknown as RpcStub<RpcProxyApi>;
                  return { socket, rpc };
                }),
                ({ socket, rpc }) =>
                  Effect.sync(() => {
                    rpc[Symbol.dispose]();
                    socket.close();
                  }),
              );
            const group = new URL("./fixtures/rpc-server-entry.ts", import.meta.url).href;
            const observer = yield* connect();
            const getEcho = (rpc: RpcStub<RpcProxyApi>, owned = false) =>
              Effect.promise(() => rpc.getProvider("Test.Echo", group, owned)).pipe(
                Effect.map(
                  (provider) =>
                    unwrapRpcHandlers(provider as any) as {
                      echo: (msg: string) => Effect.Effect<string>;
                      stats: () => Effect.Effect<{
                        active: number;
                        built: number;
                        finalized: number;
                      }>;
                      retainArtifact: () => Effect.Effect<void>;
                      artifactCount: () => Effect.Effect<number>;
                    },
                ),
              );
            const dev = yield* getEcho(observer.rpc);
            const baseline = yield* Effect.promise(() => observer.rpc.getDiagnostics()).pipe(
              Effect.map((counts) => ({ ...counts })),
            );
            expect(baseline.sessions).toBe(1);
            expect(baseline.testSessions).toBe(0);
            const initial = yield* dev.stats();

            const owned = yield* connect();
            const provider = yield* getEcho(owned.rpc, true);
            yield* provider.retainArtifact();
            const retained = yield* Effect.promise(() => observer.rpc.getDiagnostics());
            expect(retained.testSessions).toBe(1);
            expect(retained.contexts).toBe(baseline.contexts + 1);
            expect(retained.artifacts).toBe(baseline.artifacts + 1);
            yield* Effect.promise(() => owned.rpc.releaseSession());
            yield* Effect.promise(() => owned.rpc.releaseSession());
            expect((yield* provider.artifactCount().pipe(Effect.exit))._tag).toBe("Failure");
            expect(yield* Effect.promise(() => observer.rpc.getDiagnostics())).toMatchObject(
              baseline,
            );
            expect((yield* dev.stats()).finalized).toBe(initial.finalized + 1);
            const late = yield* Effect.tryPromise(() =>
              owned.rpc.getProvider("Test.Echo", group, true),
            ).pipe(Effect.exit);
            expect(late._tag).toBe("Failure");
            expect(yield* Effect.promise(() => observer.rpc.getDiagnostics())).toMatchObject(
              baseline,
            );

            const blocked = yield* connect();
            const pending = yield* Effect.tryPromise(() =>
              blocked.rpc.getProvider("Test.Echo", `${group}#blocked`, true),
            ).pipe(Effect.forkChild);
            const building = yield* Effect.promise(() => observer.rpc.getDiagnostics()).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("50 millis"),
                times: 10,
                until: (counts) => counts.building === 1,
              }),
            );
            expect(building.building).toBe(1);
            const acquired = yield* dev.stats().pipe(
              Effect.repeat({
                schedule: Schedule.spaced("50 millis"),
                times: 10,
                until: (stats) => stats.active === initial.active + 1,
              }),
            );
            expect(acquired.active).toBe(initial.active + 1);
            yield* Effect.promise(() => blocked.rpc.releaseSession());
            expect((yield* Fiber.await(pending))._tag).toBe("Failure");
            expect(yield* Effect.promise(() => observer.rpc.getDiagnostics())).toMatchObject(
              baseline,
            );
            expect((yield* dev.stats()).active).toBe(initial.active);

            // Old disconnects retire only their own test generation.
            const lost = yield* connect();
            yield* getEcho(lost.rpc, true);
            const successor = yield* connect();
            const next = yield* getEcho(successor.rpc, true);
            yield* Effect.sync(() => {
              blocked.socket.close();
              lost.socket.close();
            });
            const disconnected = yield* Effect.promise(() => observer.rpc.getDiagnostics()).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("50 millis"),
                times: 10,
                until: (counts) => counts.testSessions === 1,
              }),
            );
            expect(disconnected.testSessions).toBe(1);
            expect(yield* next.echo("successor")).toBe("echo:successor");
            yield* Effect.promise(() => successor.rpc.releaseSession());
            expect(yield* Effect.promise(() => observer.rpc.getDiagnostics())).toMatchObject(
              baseline,
            );

            // Explicit release and transport loss do not retire ordinary dev state.
            yield* Effect.promise(() => observer.rpc.releaseSession());
            yield* Effect.sync(() => observer.socket.close());
            const reconnected = yield* connect();
            const resumed = yield* getEcho(reconnected.rpc);
            expect(yield* resumed.echo("reconnected")).toBe("echo:reconnected");
            expect(yield* Effect.promise(() => reconnected.rpc.getDiagnostics())).toMatchObject(
              baseline,
            );
            expect((yield* resumed.stats()).active).toBe(initial.active);
            expect((yield* resumed.stats()).built).toBe(initial.built + 4);
          }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
        { timeout: 30_000 },
      );

      it.live(
        "test release and disconnect drain calls and streams before provider resources",
        () =>
          Effect.gen(function* () {
            const proc = yield* launch;
            const url = yield* proc.stdout.pipe(
              Stream.decodeText,
              Stream.run(
                Sink.fold(
                  () => "",
                  (text) => !text.includes("</ALCHEMY_RPC_ADDRESS>"),
                  (text, chunk) => Effect.succeed(text + chunk),
                ),
              ),
              Effect.timeout("5 seconds"),
              Effect.map((text) => text.match(ADDRESS_RE)?.[1]),
            );
            assert(url);
            yield* openWebSocket(new URL("/parent", url));
            const connect = () =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const socket = new WebSocket(url);
                  return {
                    socket,
                    rpc: newWebSocketRpcSession(socket) as unknown as RpcStub<RpcProxyApi>,
                  };
                }),
                ({ socket, rpc }) =>
                  Effect.sync(() => {
                    rpc[Symbol.dispose]();
                    socket.close();
                  }),
              );
            const group = new URL("./fixtures/rpc-server-entry.ts", import.meta.url).href;
            const getEcho = (rpc: RpcStub<RpcProxyApi>, owned = false) =>
              Effect.promise(() => rpc.getProvider("Test.Echo", group, owned)).pipe(
                Effect.map((provider) => {
                  const wire = provider as unknown as RpcWrapped<EchoClient>;
                  return {
                    wire,
                    client: unwrapRpcHandlers(wire, ["tail"]) as unknown as EchoClient,
                  };
                }),
              );
            const drainTail = (wire: RpcWrapped<EchoClient>, label: string) =>
              Effect.promise(async () => wire.tail([label])).pipe(
                Effect.flatMap((readable) =>
                  Stream.fromReadableStream({
                    evaluate: () => readable,
                    onError: (error) => error,
                  }).pipe(Stream.runDrain),
                ),
              );
            const observer = yield* connect();
            const { client: monitor } = yield* getEcho(observer.rpc);
            const baseline = yield* Effect.promise(() => observer.rpc.getDiagnostics()).pipe(
              Effect.map((counts) => ({ ...counts })),
            );

            for (const mode of ["release", "disconnect"] as const) {
              const owned = yield* connect();
              const { wire, client } = yield* getEcho(owned.rpc, true);
              const labels = [`${mode}-effect`, `${mode}-stream`];
              const call = yield* client.blockedCall(labels[0]!).pipe(Effect.forkChild);
              const stream = yield* drainTail(wire, labels[1]!).pipe(Effect.forkChild);
              for (const label of labels) {
                const started = yield* monitor.callSnapshot(label).pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("50 millis"),
                    times: 10,
                    until: (snapshot) => snapshot?.events.includes("started") === true,
                  }),
                );
                expect(started?.events).toEqual(["started"]);
              }
              if (mode === "release") {
                yield* Effect.promise(() => owned.rpc.releaseSession());
              } else {
                yield* Effect.sync(() => owned.socket.close());
              }
              for (const label of labels) {
                const snapshot = monitor.callSnapshot(label);
                const settled = yield* mode === "release"
                  ? snapshot
                  : snapshot.pipe(
                      Effect.repeat({
                        schedule: Schedule.spaced("50 millis"),
                        times: 10,
                        until: (value) => value?.events.includes("provider-finalized") === true,
                      }),
                    );
                expect(settled).toEqual({
                  events: ["started", "call-finalized:live", "provider-finalized"],
                  mutations: 0,
                  artifacts: 0,
                });
                yield* monitor.unblockCall(label);
                expect(yield* monitor.callSnapshot(label)).toEqual(settled);
              }
              expect((yield* Fiber.await(call).pipe(Effect.timeout("5 seconds")))._tag).toBe(
                "Failure",
              );
              expect((yield* Fiber.await(stream).pipe(Effect.timeout("5 seconds")))._tag).toBe(
                "Failure",
              );

              if (mode === "release") {
                expect((yield* client.blockedCall("stale-effect").pipe(Effect.exit))._tag).toBe(
                  "Failure",
                );
                expect((yield* drainTail(wire, "stale-stream").pipe(Effect.exit))._tag).toBe(
                  "Failure",
                );
                expect((yield* client.retainArtifact().pipe(Effect.exit))._tag).toBe("Failure");
                expect(yield* monitor.callSnapshot("stale-effect")).toBeUndefined();
                expect(yield* monitor.callSnapshot("stale-stream")).toBeUndefined();
                yield* Effect.promise(() => owned.rpc.releaseSession());
              }
              expect(yield* Effect.promise(() => observer.rpc.getDiagnostics())).toMatchObject(
                baseline,
              );
            }

            const transient = yield* connect();
            const { client: dev } = yield* getEcho(transient.rpc);
            const devCall = yield* dev.blockedCall("dev-call").pipe(Effect.forkChild);
            const started = yield* monitor.callSnapshot("dev-call").pipe(
              Effect.repeat({
                schedule: Schedule.spaced("50 millis"),
                times: 10,
                until: (snapshot) => snapshot?.events.includes("started") === true,
              }),
            );
            expect(started?.events).toEqual(["started"]);
            yield* Effect.promise(() => transient.rpc.releaseSession());
            yield* Effect.sync(() => transient.socket.close());
            yield* Fiber.await(devCall).pipe(Effect.timeout("5 seconds"));
            expect((yield* monitor.callSnapshot("dev-call"))?.events).toEqual(["started"]);
            yield* monitor.unblockCall("dev-call");
            const finished = yield* monitor.callSnapshot("dev-call").pipe(
              Effect.repeat({
                schedule: Schedule.spaced("50 millis"),
                times: 10,
                until: (snapshot) => snapshot?.events.includes("call-finalized:live") === true,
              }),
            );
            expect(finished?.events).toEqual(["started", "call-finalized:live"]);
            expect(finished?.mutations).toBe(1);
          }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
        { timeout: 30_000 },
      );

      it.live(
        "exits if the parent never connects within ~10s",
        () =>
          Effect.gen(function* () {
            const start = yield* Clock.currentTimeMillis;
            const proc = yield* launch;
            // Never open /parent — the server should self-terminate via the
            // connect timeout.
            yield* waitForExit(proc, "20 seconds");
            const elapsed = (yield* Clock.currentTimeMillis) - start;
            expect(elapsed).toBeLessThan(18_000);
          }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
        { timeout: 30_000 },
      );
    });
  }
});
