// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  probeClaudeWorkspaceSnapshot,
} from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

it("drops strict MCP mode, and only that, next to an administrator's managed-mcp.json", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    managedMcpConfig: true,
    platform: "linux",
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

const platform = HostProcess.Platform.defaultValue();
// Never aborted; the probe CLI here exits on its own.
const probeAbort = new AbortController();

it.effect.skipIf(platform === "win32")(
  "starts the probe CLI in its workspace through the shell trampoline",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const options = buildClaudeCapabilitiesProbeQueryOptions({
        executablePath: "claude",
        abortController: probeAbort,
        environment: {},
        cwd: directory,
        managedMcpConfig: false,
        platform,
      });
      const child = options.spawnClaudeCodeProcess!({
        command: "pwd",
        args: ["-P"],
        cwd: directory,
        env: { PATH: process.env.PATH },
        signal: probeAbort.signal,
      });
      const output = yield* Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            let text = "";
            child.stdout.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
            child.once("exit", () => resolve(text));
          }),
      );
      assert.equal(output, `${directory}\n`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a deleted worktree's scan as finished, not pending", () =>
  Effect.gen(function* () {
    const snapshot = yield* probeClaudeWorkspaceSnapshot(
      yield* decodeClaudeSettings({}),
      { skills: [], slashCommands: [] } as unknown as ServerProvider,
      "/nonexistent/t3-deleted-worktree",
      { HOME: "/nonexistent/t3-home" },
    );
    assert.strictEqual(snapshot.slashCommandsPending, false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
