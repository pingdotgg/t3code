// @effect-diagnostics nodeBuiltinImport:off -- verifies real child streams and process-tree ownership.
import * as NodeNet from "node:net";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { makePool } from "./windowsProcessWorker.ts";
import * as WindowsSpawn from "./WindowsSpawn.ts";

async function text(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

// quarantine: #25245 Windows process-tree termination uses taskkill.
describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")("Windows process worker", () => {
  it.live("preserves inherited, replaced and removed environment values", () =>
    Effect.gen(function* () {
      const spawn = yield* WindowsSpawn.WindowsSpawn;
      if (spawn === undefined) return expect.fail("Missing Windows spawn service");
      const environment = yield* HostProcess.Environment;
      expect(environment.NODE_ENV).toBeDefined();
      const env = { T3_WORKER_TEST: Redacted.make("child") };
      for (const [options, expected] of [
        [{}, [environment.NODE_ENV, null]],
        [{ env }, [null, "child"]],
        [{ env, extendEnv: true }, [environment.NODE_ENV, "child"]],
        [{ env: { ...env, NODE_ENV: undefined }, extendEnv: true }, [null, "child"]],
      ] as const) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawn(
              ChildProcess.make(
                process.execPath,
                [
                  "-e",
                  "process.stdout.write(JSON.stringify([process.env.NODE_ENV, process.env.T3_WORKER_TEST]))",
                ],
                options,
              ),
            );
            const stdout = yield* Stream.mkString(Stream.decodeText(child.stdout));
            expect(JSON.parse(stdout)).toEqual(expected);
            expect(yield* child.exitCode).toBe(0);
          }),
        );
      }
    }).pipe(Effect.provide(WindowsSpawn.layer.pipe(Layer.provide(NodeServices.layer)))),
  );

  it.live("preserves concurrent streams, stdin, exit status and reuse after spawn errors", () =>
    Effect.promise(async () => {
      const pool = makePool();
      const input = { command: process.execPath, args: [], env: process.env, shell: false };
      try {
        const missing = pool.start({ ...input, command: "t3-missing-executable-25245" });
        await expect(missing.started).rejects.toMatchObject({ code: "ENOENT" });
        await missing.dispose();
        await Promise.all(
          [7, 9].map(async (code) => {
            const payload = "x".repeat(2 * 1024 * 1024);
            const job = pool.start({
              ...input,
              args: [
                "-e",
                `process.stdin.pipe(process.stdout); process.stdin.once('end', () => { process.stderr.write(process.env.T3_WORKER_TEST); process.exitCode = ${code}; });`,
              ],
              env: { ...process.env, T3_WORKER_TEST: "stderr" },
            });
            try {
              const streams = await job.started;
              const output = text(streams.stdout);
              const error = text(streams.stderr);
              const writer = streams.stdin.getWriter();
              await writer.write(Buffer.from(payload));
              await writer.close();
              writer.releaseLock();
              expect(await output).toBe(payload);
              expect(await error).toBe("stderr");
              expect(await job.exit).toBe(code);
            } finally {
              await job.dispose();
            }
          }),
        );
      } finally {
        await pool.close();
      }
    }),
  );

  it.live.each(["normal", "taskkill", "child-exit"] as const)(
    "retains tree cleanup ownership when disposing a running child (%s)",
    (mode) =>
      Effect.promise(async () => {
        const connected = Promise.withResolvers<void>();
        const disconnected = Promise.withResolvers<void>();
        const sockets = new Set<import("node:net").Socket>();
        const server = NodeNet.createServer((socket) => {
          sockets.add(socket);
          socket.on("error", () => {});
          socket.once("data", () => connected.resolve());
          socket.once("close", () => {
            sockets.delete(socket);
            disconnected.resolve();
          });
        });
        server.listen(0, "127.0.0.1");
        await new Promise<void>((resolve, reject) => {
          server.once("listening", resolve);
          server.once("error", reject);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test address");
        const descendant = `const s=require('node:net').connect(${address.port},'127.0.0.1',()=>s.write('ready')); s.once('close',()=>process.exit());`;
        const fixture = new NodeWorkerThreads.Worker(
          new URL("./processCleanup.test-fixture.ts", import.meta.url),
          {
            workerData: { mode, descendant },
            execArgv: [],
          },
        );
        const cleaned = Promise.withResolvers<{ reused: boolean }>();
        const failed = Promise.withResolvers<never>();
        const fail = (error: Error) => {
          cleaned.reject(error);
          failed.reject(error);
        };
        const stopped = new Promise<number>((resolve) => {
          fixture.once("exit", (code) => {
            fail(new Error(`Cleanup fixture exited unexpectedly (${code})`));
            resolve(code);
          });
        });
        fixture.on("message", (event: { type: string; reused: boolean }) => {
          if (event.type === "cleaned") cleaned.resolve(event);
        });
        fixture.once("error", fail);
        void cleaned.promise.catch(() => {});
        void failed.promise.catch(() => {});
        const message = () => new Promise<unknown>((resolve) => fixture.once("message", resolve));
        try {
          await Promise.race([message(), failed.promise]);
          await Promise.race([connected.promise, failed.promise]);
          const disposed = message();
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker messages have no target origin.
          fixture.postMessage("dispose");
          const result = await Promise.race([disposed, failed.promise]);
          expect(result).toMatchObject({
            type: "disposed",
            settled: true,
            exited: mode === "normal",
          });
          if (mode !== "normal") {
            expect(result).toMatchObject({
              separateOwner: true,
              live: true,
              closed: mode === "child-exit",
            });
            expect(sockets.size).toBe(1);
          }
        } finally {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker messages have no target origin.
          fixture.postMessage("release");
          try {
            const result = await cleaned.promise;
            if (mode === "taskkill") expect(result.reused).toBe(true);
            expect(await stopped).toBe(0);
            await disconnected.promise;
          } finally {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await stopped;
          }
        }
      }),
  );
});
