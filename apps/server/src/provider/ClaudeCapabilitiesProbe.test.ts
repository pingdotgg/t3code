// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
    disableHooks: true,
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

it.effect("lists commands that Claude Code mods register in a session.start hook", () =>
  Effect.gen(function* () {
    // Claude Code registers a mod's commands only when its session.start hook runs.
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      const settings = options?.settings;
      const hooksRun = typeof settings !== "object" || settings.disableAllHooks !== true;
      return {
        initializationResult: async () => ({
          account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
          commands: [
            { name: "review", description: "Review changes", argumentHint: "" },
            ...(hooksRun
              ? [{ name: "handoffs", description: "List handoffs", argumentHint: "" }]
              : []),
          ],
          models: [],
        }),
      } as unknown as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped();
    const snapshot = yield* probeClaudeWorkspaceSnapshot(
      yield* decodeClaudeSettings({ binaryPath: "claude" }),
      { skills: [], slashCommands: [] } as unknown as ServerProvider,
      cwd,
      { PATH: (yield* HostProcess.Environment).PATH, HOME: cwd, CLAUDE_CONFIG_DIR: cwd },
    );
    assert.include(
      snapshot.slashCommands.map((command) => command.name),
      "handoffs",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("falls back to a scan without hooks when hooks keep Claude from initializing", () =>
  Effect.gen(function* () {
    const hooksDisabled: Array<boolean> = [];
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      const settings = options?.settings;
      const disabled = typeof settings === "object" && settings.disableAllHooks === true;
      hooksDisabled.push(disabled);
      return {
        initializationResult: async () => {
          if (!disabled) throw new Error("SessionStart hook timed out");
          return {
            account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
            commands: [{ name: "review", description: "Review changes", argumentHint: "" }],
            models: [],
          };
        },
      } as unknown as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped();
    const settings = yield* decodeClaudeSettings({ binaryPath: "claude" });
    const machineSnapshot = { skills: [], slashCommands: [] } as unknown as ServerProvider;
    const environment = {
      PATH: (yield* HostProcess.Environment).PATH,
      HOME: cwd,
      CLAUDE_CONFIG_DIR: cwd,
    };
    const snapshot = yield* probeClaudeWorkspaceSnapshot(
      settings,
      machineSnapshot,
      cwd,
      environment,
    );
    assert.deepEqual(hooksDisabled, [false, true]);
    assert.include(
      snapshot.slashCommands.map((command) => command.name),
      "review",
    );
    assert.strictEqual(snapshot.slashCommandsPending, false);

    // Callers without orchestration:operate never run hooks.
    hooksDisabled.length = 0;
    yield* probeClaudeWorkspaceSnapshot(settings, machineSnapshot, cwd, environment, false);
    assert.deepEqual(hooksDisabled, [true]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
