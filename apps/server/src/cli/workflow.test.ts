import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { workflowCommand } from "./workflow.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  return {
    ...actual,
    layerRuntime: Layer.mock(actual.EnvironmentAuth)({
      issueMcpClientSession: () =>
        Effect.map(DateTime.now, (expiresAt) => ({
          sessionId: AuthSessionId.make("test-session"),
          token: "synthetic-token",
          expiresAt,
        })),
      revokeSession: () => Effect.succeed(true),
    }),
  };
});

/** Runs `t3 workflow <args>` against a live-looking server whose t3_workflow is `call`. */
const runCli = (
  args: ReadonlyArray<string>,
  call: McpBridge.McpToolSession["call"] = () => Effect.die("no tool call expected"),
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-cli-" });
    yield* persistServerRuntimeState({
      path: path.join(baseDir, "userdata", "server-runtime.json"),
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: 3_773,
      }),
    });
    const calls: Array<Readonly<Record<string, unknown>>> = [];
    using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
      Effect.succeed({
        call: (tool, input) => {
          calls.push(input);
          return call(tool, input);
        },
      }),
    );
    const error = yield* Command.runWith(workflowCommand, { version: "0.0.0" })([
      ...args,
      "--base-dir",
      baseDir,
    ]).pipe(
      Effect.flip,
      Effect.orElseSucceed(() => undefined),
    );
    return { error, calls, errors: yield* TestConsole.errorLines };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
      ),
    ),
  );

it.effect("reports what the server refused instead of calling it unreachable", () =>
  Effect.gen(function* () {
    const refused = yield* runCli(["start", "review", "--key", " "], () =>
      Effect.fail(
        new McpBridge.AcpMcpBridgeError({
          message: "T3 Code MCP tools/call failed.",
          rpcError: {
            code: -32602,
            message: 'Expected a non-blank string\n  at ["idempotencyKey"]',
          },
        }),
      ),
    );
    assert.strictEqual(refused.error?._tag, "ThreadToolFailedError");
    assert.strictEqual(
      refused.error?.message,
      'The server refused the arguments: Expected a non-blank string at ["idempotencyKey"]',
    );

    const unreachable = yield* runCli(["start", "review", "--key", "pr-1"], () =>
      Effect.fail(new McpBridge.AcpMcpBridgeError({ message: "fetch failed" })),
    );
    assert.strictEqual(unreachable.error?._tag, "ThreadServerUnreachableError");
  }),
);
