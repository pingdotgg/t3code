// @effect-diagnostics nodeBuiltinImport:off -- verifies real child streams and process-tree ownership.
import * as NodeNet from "node:net";
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

  it.live("waits for tree cleanup when disposing a running child", () =>
    Effect.promise(async () => {
      const pool = makePool();
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
      const job = pool.start({
        command: process.execPath,
        args: [
          "-e",
          `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',windowsHide:true}); process.stdin.resume();`,
        ],
        env: process.env,
        shell: false,
      });
      try {
        await job.started;
        await connected.promise;
        await job.dispose();
        await disconnected.promise;
      } finally {
        for (const socket of sockets) socket.destroy();
        await job.dispose();
        await pool.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }),
  );
});
