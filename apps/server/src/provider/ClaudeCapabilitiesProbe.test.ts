// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

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

it.effect("keeps the probe subprocess alive while gateway model discovery can finish", () =>
  Effect.gen(function* () {
    let abortSignal: AbortSignal | undefined;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      abortSignal = options?.abortController?.signal;
      return {
        initializationResult: async () => ({
          account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
          commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],
          models: [{ value: "gateway/claude-relay", displayName: "Relay", description: "" }],
        }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
          new Promise((_, reject) => reject(new Error("usage unavailable"))),
      } as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const fileSystem = yield* FileSystem.FileSystem;
    const configDir = yield* fileSystem.makeTempDirectoryScoped();
    // Claude Code also reads these from settings.json, which is where gateway users set them.
    yield* fileSystem.writeFileString(
      `${configDir}/settings.json`,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://gateway.example",
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        },
      }),
    );
    const capabilities = yield* probeClaudeCapabilities(
      yield* decodeClaudeSettings({ binaryPath: "claude" }),
      { PATH: (yield* HostProcess.Environment).PATH, CLAUDE_CONFIG_DIR: configDir },
    );
    assert.deepEqual(
      capabilities.models?.map((model) => model.value),
      ["gateway/claude-relay"],
    );
    assert.equal(abortSignal?.aborted, false);
    yield* TestClock.adjust("3 seconds");
    assert.equal(abortSignal?.aborted, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Claude Code drops the whole inline layer, hook switch included, when any key in it is invalid.
const nonPluginSettings = {
  disableAutoMode: false,
  permissions: { disableBypassPermissionsMode: false, disableAutoMode: "bogus" },
  env: { ANTHROPIC_BASE_URL: "http://example.invalid" },
  disableAllHooks: false,
};

it.effect.each([
  {
    forwarded: "only the well-formed plugin switches",
    plugins: { "work-plugin@demo-market": true, "pinned@demo-market": ["^1.0.0"] },
    expected: {
      enabledPlugins: { "work-plugin@demo-market": true, "pinned@demo-market": ["^1.0.0"] },
      disableAllHooks: true,
    },
  },
  {
    forwarded: "nothing when a plugin switch is an object",
    plugins: { "work-plugin@demo-market": true, "object@demo-market": { arbitrary: "value" } },
    expected: { disableAllHooks: true },
  },
])(
  "probes slash commands with $forwarded from --settings, hooks still off",
  ({ plugins, expected }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-" });
      const settingsFile = path.join(tempDir, "work-settings.json");
      yield* fs.writeFileString(
        settingsFile,
        JSON.stringify({ ...nonPluginSettings, enabledPlugins: plugins }),
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

      assert.deepEqual(query.mock.calls[0]?.[0].options?.settings, expected);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
