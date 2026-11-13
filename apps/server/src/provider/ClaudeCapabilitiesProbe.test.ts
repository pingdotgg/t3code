// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  type ClaudeHookSlashCommandsByCwd,
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

// regression: #17418 a mod registers its commands in a SessionStart hook, which hookless scans skip
it.effect("lists hook-registered commands from one hook-running probe per folder", () =>
  Effect.gen(function* () {
    const hookProbeCwds: Array<string | undefined> = [];
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      const hookless =
        (options?.settings as { readonly disableAllHooks?: boolean } | undefined)
          ?.disableAllHooks === true;
      if (!hookless) hookProbeCwds.push(options?.cwd);
      return {
        initializationResult: async () => ({
          commands: [
            { name: "review", description: "Review changes", argumentHint: "" },
            ...(hookless ? [] : [{ name: "handoffs", description: "Handoffs", argumentHint: "" }]),
          ],
        }),
      } as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped();
    const settings = yield* decodeClaudeSettings({ binaryPath: "claude" });
    const environment = {
      PATH: (yield* HostProcess.Environment).PATH,
      CLAUDE_CONFIG_DIR: yield* fileSystem.makeTempDirectoryScoped(),
    };
    const byCwd = yield* Ref.make<ClaudeHookSlashCommandsByCwd>(new Map());
    const scan = (discover: boolean, scanCwd = cwd) =>
      probeClaudeWorkspaceSnapshot(
        settings,
        { skills: [], slashCommands: [] } as unknown as ServerProvider,
        scanCwd,
        environment,
        { byCwd, discover },
      ).pipe(Effect.map((snapshot) => snapshot.slashCommands.map((command) => command.name)));

    // A caller that may not run hooks neither runs them nor remembers their absence.
    assert.deepEqual(yield* scan(false), ["compact", "review"]);
    assert.deepEqual(hookProbeCwds, []);
    assert.deepEqual(yield* scan(true), ["compact", "review", "handoffs"]);
    // Later scans, a read-only caller's included, reuse the answer without running hooks again.
    assert.deepEqual(yield* scan(true), ["compact", "review", "handoffs"]);
    assert.deepEqual(yield* scan(false), ["compact", "review", "handoffs"]);
    assert.deepEqual(hookProbeCwds, [cwd]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
