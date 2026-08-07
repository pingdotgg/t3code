// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { ServerConfig } from "../config.ts";
import { OpenClawRuntime, OpenClawRuntimeLive } from "./openclawRuntime.ts";
import { startMockOpenClawGateway } from "./testUtils/openclawMockGateway.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockGatewayPath = NodePath.join(__dirname, "../../scripts/openclaw-mock-gateway.ts");
const mockCommand = process.execPath;

async function makeMockGatewayWrapper(extraEnv?: Record<string, string>): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "openclaw-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-openclaw.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockCommand)} ${JSON.stringify(mockGatewayPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const openClawRuntimeTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-openclaw-runtime-test-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  // Close the runtime's own requirements so the merged layer graph is complete.
  Layer.provideMerge(OpenClawRuntimeLive.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer)))),
);

const makeRuntime = () => Effect.service(OpenClawRuntime);

describe("OpenClawRuntime", () => {
  it.live("connects to an external gateway and completes the handshake", () =>
    Effect.gen(function* () {
      const mock = yield* Effect.promise(() => startMockOpenClawGateway({ token: "secret-token" }));
      const runtime = yield* makeRuntime();
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* runtime.connectToOpenClawGateway({
            binaryPath: "openclaw",
            gatewayUrl: mock.url,
            gatewayToken: "secret-token",
          });
          assert.equal(connection.external, true);
          assert.equal(connection.hello.serverVersion, "2026.8.1");
          assert.equal(connection.hello.protocol, 4);
          assert.include(connection.hello.scopes, "operator.approvals");

          const models = yield* connection.request("models.list", {});
          assert.ok(models && typeof models === "object");
          yield* connection.close;
          return connection.hello.serverVersion;
        }),
      );
      assert.equal(result, "2026.8.1");
      yield* Effect.promise(() => mock.close());
    }).pipe(Effect.provide(openClawRuntimeTestLayer)),
  );

  it.live("rejects an external gateway on token mismatch", () =>
    Effect.gen(function* () {
      const mock = yield* Effect.promise(() => startMockOpenClawGateway({ token: "right-token" }));
      const runtime = yield* makeRuntime();
      const error = yield* Effect.flip(
        Effect.scoped(
          runtime.connectToOpenClawGateway({
            binaryPath: "openclaw",
            gatewayUrl: mock.url,
            gatewayToken: "wrong-token",
          }),
        ),
      );
      assert.equal(error._tag, "OpenClawRuntimeError");
      assert.include(error.detail, "token");
      yield* Effect.promise(() => mock.close());
    }).pipe(Effect.provide(openClawRuntimeTestLayer)),
  );

  it.live("spawns a gateway process and waits for protocol readiness", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockGatewayWrapper());
      const runtime = yield* makeRuntime();
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* runtime.connectToOpenClawGateway({
            binaryPath: wrapperPath,
            timeoutMs: 15_000,
          });
          assert.equal(connection.external, false);
          assert.equal(connection.hello.serverVersion, "2026.8.1-mock");
          assert.ok(connection.gatewayToken, "spawned gateway carries a generated token");
          const echo = yield* connection.request("models.list", {});
          assert.ok(echo && typeof echo === "object");
          yield* connection.close;
          return connection.url;
        }),
      );
      assert.ok(result.startsWith("ws://127.0.0.1:"));
    }).pipe(Effect.provide(openClawRuntimeTestLayer)),
  );

  it.live("fails cleanly when the gateway is unreachable", () =>
    Effect.gen(function* () {
      const mock = yield* Effect.promise(() => startMockOpenClawGateway());
      const url = mock.url;
      yield* Effect.promise(() => mock.close());
      const runtime = yield* makeRuntime();
      const error = yield* Effect.flip(
        Effect.scoped(
          runtime.connectToOpenClawGateway({
            binaryPath: "openclaw",
            gatewayUrl: url,
            timeoutMs: 2_000,
          }),
        ),
      );
      assert.equal(error._tag, "OpenClawRuntimeError");
    }).pipe(Effect.provide(openClawRuntimeTestLayer)),
  );

  it.live("runOpenClawCommand collects stdout and exit code", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime();
      const result = yield* runtime.runOpenClawCommand({
        binaryPath: "sh",
        args: ["-c", "echo hello-mock"],
      });
      assert.equal(result.code, 0);
      assert.include(result.stdout, "hello-mock");
    }).pipe(Effect.provide(openClawRuntimeTestLayer)),
  );
});
