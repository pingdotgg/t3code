// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  probeClaudeCapabilities,
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
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

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

it.effect("probes slash commands with the instance's --settings launch arg, hooks still off", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-" });
    const settingsFile = path.join(tempDir, "work-settings.json");
    // Legacy `false` switches make the CLI drop the whole inline layer, hook switch included.
    yield* fs.writeFileString(
      settingsFile,
      JSON.stringify({
        enabledPlugins: { "work-plugin@demo-market": true },
        disableAutoMode: false,
        permissions: { allow: ["Read"], disableBypassPermissionsMode: false },
        disableAllHooks: false,
      }),
    );
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
      () =>
        ({
          initializationResult: () => Promise.resolve({ commands: [], account: {} }),
        }) as unknown as ReturnType<typeof ClaudeSdk.query>,
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));

    yield* probeClaudeCapabilities(
      yield* decodeClaudeSettings({ launchArgs: `--settings "${settingsFile}"` }),
      { HOME: tempDir },
      tempDir,
      false,
    );

    assert.deepEqual(query.mock.calls[0]?.[0].options?.settings, {
      enabledPlugins: { "work-plugin@demo-market": true },
      permissions: { allow: ["Read"] },
      disableAllHooks: true,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
