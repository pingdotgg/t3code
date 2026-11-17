import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
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

import { makeCli } from "../binCli.ts";
import { FEEDBACK_OFF_MESSAGE, T3_CLI_COMMANDS } from "../feedback/FeedbackReport.ts";
import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { feedbackCommand } from "./feedback.ts";

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

const listedPaths = (command: Command.Command.Any, path: string): ReadonlyArray<string> => [
  path,
  ...command.subcommands.flatMap((group) =>
    group.commands
      .filter((child) => !child.unlisted)
      .flatMap((child) => listedPaths(child, `${path} ${child.name}`)),
  ),
];

it("feedback subjects name every listed t3 command", () => {
  expect([...T3_CLI_COMMANDS].sort()).toEqual(
    [...listedPaths(makeCli({ cloudEnabled: true }), "t3")].sort(),
  );
});

const hidden = (tool: string) =>
  new McpBridge.AcpMcpBridgeError({
    message: "T3 Code MCP tools/call failed.",
    rpcError: { code: -32602, message: `Tool '${tool}' not found` },
  });

it.effect("points to Labs only when the server hides the feedback tool", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-feedback-cli-" });
    const runtimeStatePath = path.join(baseDir, "userdata", "server-runtime.json");
    const runtimeState = yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 3_773,
    });
    const submit = ["--kind", "bug", "--subject", "general", "--expected", "a", "--actual", "b"];
    const cases: ReadonlyArray<{
      readonly args: ReadonlyArray<string>;
      readonly running?: false;
      readonly call?: McpBridge.McpToolSession["call"];
      readonly stderr: string;
    }> = [
      { args: submit, call: (tool) => Effect.fail(hidden(tool)), stderr: FEEDBACK_OFF_MESSAGE },
      { args: ["list"], call: (tool) => Effect.fail(hidden(tool)), stderr: FEEDBACK_OFF_MESSAGE },
      {
        args: submit,
        call: () =>
          Effect.succeed({ isError: true, content: [{ type: "text", text: "Rate limited." }] }),
        stderr: "Rate limited.",
      },
      {
        args: submit,
        call: () =>
          Effect.fail(
            new McpBridge.AcpMcpBridgeError({ message: "fetch failed: connection refused" }),
          ),
        stderr: `Could not reach the T3 Code server at ${runtimeState.origin}.`,
      },
      { args: submit, running: false, stderr: "No running T3 Code server uses" },
    ];
    for (const { args, running, call, stderr } of cases) {
      yield* running === false
        ? fs.remove(runtimeStatePath, { force: true })
        : persistServerRuntimeState({ path: runtimeStatePath, state: runtimeState });
      using _session = vi
        .spyOn(McpBridge, "mcpToolSession")
        .mockReturnValue(Effect.succeed({ call: call ?? (() => Effect.die("no call expected")) }));

      yield* Command.runWith(feedbackCommand, { version: "0.0.0" })([
        ...args,
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);

      const lines = yield* TestConsole.errorLines;
      expect(String(lines.at(-1)), args.join(" ")).toContain(stderr);
    }
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
  ),
);
