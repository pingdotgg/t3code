import { unwrapRpcHandlers } from "@/Local/RpcSerialization.ts";
import type { RpcProxyApi } from "@/Local/RpcServer.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { assert, describe, expect, it } from "@effect/vitest";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { openWebSocket, waitForExit } from "./fixtures/process-effect.ts";
import { runtimes } from "./fixtures/runtimes.ts";

const FIXTURE_TS = new URL("./fixtures/rpc-server-entry.ts", import.meta.url)
  .pathname;

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

for (const runtime of runtimes()) {
  describe.skipIf(!runtime.available)(
    `Local.RpcServer (${runtime.name})`,
    () => {
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

            // Open the parent websocket inside the scope so it stays alive
            // for the duration of the RPC exchange below; closing it later
            // is exactly what triggers the child to exit.
            const parent = yield* openWebSocket(new URL("/parent", url));

            // Drive a real RPC call through a session websocket. capnweb's
            // surface is Promise-based, so we wrap exactly at the boundary
            // and let everything above and below stay in Effect.
            const stub = newWebSocketRpcSession(url) as RpcStub<RpcProxyApi>;
            const result = yield* Effect.promise(async () => {
              const provider = await stub.getProvider("Test.Echo");
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
    },
  );
}
