// @effect-diagnostics nodeBuiltinImport:off - launches the actual fast-path helper process.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

const bin = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const endpoint = () =>
  windowsHost
    ? `\\\\.\\pipe\\t3-code-token-test-${NodeCrypto.randomUUID()}`
    : NodePath.join(NodeOS.tmpdir(), `t3-code-token-test-${NodeCrypto.randomUUID()}.sock`);

const run = (args: ReadonlyArray<string>) =>
  Effect.promise(
    () =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [bin, "__managed-chatgpt-token", ...args],
          {
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      }),
  );

const serve = (body: string, onRequest?: (request: string) => void) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: NodeNet.Server; endpoint: string }>((resolve, reject) => {
          const address = endpoint();
          const server = NodeNet.createServer((socket) => {
            let request = "";
            socket.setEncoding("utf8");
            socket.on("data", (chunk) => {
              request += chunk;
              if (!request.includes("\n")) return;
              onRequest?.(request);
              socket.end(body);
            });
          });
          server.once("error", reject);
          server.listen(address, () => resolve({ server, endpoint: address }));
        }),
    ),
    ({ server, endpoint }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => {
              if (!windowsHost)
                void NodeFSP.unlink(endpoint)
                  .catch(() => undefined)
                  .finally(resolve);
              else resolve();
            });
          }),
      ),
  );

it.effect("fast-path helper prints only the token supplied by its scoped IPC channel", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let request = "";
      const source = yield* serve("token-from-bridge", (value) => {
        request = value;
      });
      const result = yield* run([source.endpoint]);
      assert.equal(request, "token\n");
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "token-from-bridge");
      assert.equal(result.stderr, "");
    }),
  ),
);

it.effect.each([
  { label: "empty", body: "" },
  { label: "oversized", body: "x".repeat(64 * 1024 + 1) },
])("helper rejects $label token responses", ({ body }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = yield* serve(body);
      const result = yield* run([source.endpoint]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "Could not renew managed Codex credentials.\n");
    }),
  ),
);

it.effect("helper fails closed for an unavailable IPC endpoint", () =>
  Effect.gen(function* () {
    const result = yield* run([endpoint()]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Could not renew managed Codex credentials.\n");
  }),
);

it.effect.each([[], ["one", "two"]] as const)(
  "helper rejects malformed command arguments: %j",
  (args) =>
    Effect.gen(function* () {
      const result = yield* run(args);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "Could not renew managed Codex credentials.\n");
    }),
);
