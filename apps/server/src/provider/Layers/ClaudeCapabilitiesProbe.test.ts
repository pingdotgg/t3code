// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { ClaudeSettings } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES,
  probeClaudeCapabilities,
} from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it("isolates Claude capability probes without dropping workspace setting sources", () => {
  const abortController = new AbortController();
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController,
    environment: {
      HOME: "/home/user",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
      FORCE_CODE_TERMINAL: "1",
    },
    cwd: "/workspace/project",
  });

  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.cwd, "/workspace/project");
  assert.deepEqual(options.settingSources, [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES]);
  assert.deepEqual(options.settings, { disableAllHooks: true });
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.pathToClaudeCodeExecutable, "/usr/bin/claude");
  assert.equal(options.abortController, abortController);
  assert.equal(options.env?.HOME, "/home/user");
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.equal(options.env?.FORCE_CODE_TERMINAL, undefined);
  assert.equal(options.env?.CLAUDE_CODE_AUTO_CONNECT_IDE, "0");
  assert.equal(options.env?.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL, "1");
});

it("omits probe settings entirely when hook suppression is disabled", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    suppressHooks: false,
  });

  // Not `{ disableAllHooks: false }`: the SDK serializes any settings object it
  // is handed into a `--settings <json>` argument, so the key has to be absent
  // for the argument to disappear.
  assert.equal("settings" in options, false);
  assert.deepEqual(options.settingSources, [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES]);
  assert.deepEqual(options.mcpServers, {});
});

it.layer(NodeServices.layer)("Claude capability probe SDK boundary", (it) => {
  it.effect("serializes strict no-MCP options and still resolves account capabilities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-sdk-" });
      const executablePath = path.join(tempDir, "fake-claude.mjs");
      const invocationPath = path.join(tempDir, "invocation.json");
      // The probe aborts the SDK without awaiting the child's exit, and on
      // Windows a directory that is still some process's cwd cannot be
      // removed. Keep the workspace outside the scoped directory and let it
      // go with a retrying removal once the child has gone.
      const workspaceCwd = yield* fs.makeTempDirectory({ prefix: "t3-claude-probe-cwd-" });
      // Node's own retry rather than an Effect schedule: it.effect runs on a
      // TestClock, so a scheduled retry would wait for time nobody advances.
      // If the child still holds the directory after that, an empty temp
      // directory is left behind rather than failing the test for it.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          NodeFSP.rm(workspaceCwd, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 250,
          }).catch(() => undefined),
        ),
      );

      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
          'import { createInterface } from "node:readline";',
          "const args = process.argv.slice(2);",
          'const mcpConfigIndex = args.indexOf("--mcp-config");',
          "const rawMcpConfig = mcpConfigIndex >= 0 ? args[mcpConfigIndex + 1] : undefined;",
          "let mcpConfig;",
          "if (rawMcpConfig) {",
          '  const contents = existsSync(rawMcpConfig) ? readFileSync(rawMcpConfig, "utf8") : rawMcpConfig;',
          "  try { mcpConfig = JSON.parse(contents); } catch { mcpConfig = contents; }",
          "}",
          "writeFileSync(process.env.T3_PROBE_INVOCATION_PATH, JSON.stringify({",
          "  args,",
          "  cwd: process.cwd(),",
          "  connectorEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,",
          "  mcpConfig,",
          "}));",
          "const lines = createInterface({ input: process.stdin });",
          'lines.on("line", (line) => {',
          "  const message = JSON.parse(line);",
          '  if (message.type !== "control_request") return;',
          "  const reply = (response) => process.stdout.write(JSON.stringify({",
          '    type: "control_response",',
          '    response: { subtype: "success", request_id: message.request_id, response },',
          '  }) + "\\n");',
          '  if (message.request?.subtype === "initialize") {',
          "    reply({",
          '      commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],',
          "      agents: [],",
          '      output_style: "default",',
          '      available_output_styles: ["default"],',
          "      models: [],",
          '      account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
          "    });",
          "  }",
          "  // The probe follows initialize with get_usage on the same process.",
          '  if (message.request?.subtype === "get_usage") {',
          "    reply({",
          "      session: {},",
          '      subscription_type: "pro",',
          "      rate_limits_available: true,",
          '      rate_limits: { five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" } },',
          "      behaviors: null,",
          "    });",
          "  }",
          "});",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      const capabilities = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: executablePath }),
        {
          ...process.env,
          T3_PROBE_INVOCATION_PATH: invocationPath,
          ENABLE_CLAUDEAI_MCP_SERVERS: "true",
        },
        workspaceCwd,
      );

      assert.deepEqual(capabilities, {
        email: "dev@example.com",
        subscriptionType: "pro",
        tokenSource: "oauth",
        apiProvider: undefined,
        slashCommands: [
          {
            name: "review",
            description: "Review changes",
            input: { hint: "[path]" },
          },
        ],
        usage: {
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" } },
        },
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const invocation = JSON.parse(yield* fs.readFileString(invocationPath)) as {
        readonly args: ReadonlyArray<string>;
        readonly cwd: string;
        readonly connectorEnv: string;
        readonly mcpConfig: unknown;
      };
      assert.equal(invocation.cwd, yield* fs.realPath(workspaceCwd));
      assert.equal(invocation.connectorEnv, "false");
      assert.equal(invocation.args.includes("--strict-mcp-config"), true);
      assert.equal(invocation.args.includes("--mcp-config"), false);
      assert.equal(invocation.mcpConfig, undefined);

      assert.equal(invocation.args.includes("--setting-sources=user,project,local"), true);

      const settingsFlagIndex = invocation.args.indexOf("--settings");
      assert.notEqual(settingsFlagIndex, -1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const flagSettings = JSON.parse(invocation.args[settingsFlagIndex + 1] ?? "{}") as {
        readonly disableAllHooks?: boolean;
      };
      assert.equal(flagSettings.disableAllHooks, true);
    }).pipe(Effect.scoped),
  );

  it.effect("retries without hook suppression when the CLI refuses the settings argument", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-strict-" });
      const executablePath = path.join(tempDir, "strict-claude.mjs");
      const invocationLogPath = path.join(tempDir, "invocations.jsonl");
      const workspaceCwd = yield* fs.makeTempDirectory({ prefix: "t3-claude-probe-strict-cwd-" });
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          NodeFSP.rm(workspaceCwd, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 250,
          }).catch(() => undefined),
        ),
      );

      // A Claude CLI distribution that only accepts an allowlist of arguments
      // and refuses to start when it is handed one outside that list.
      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          'import { appendFileSync } from "node:fs";',
          'import { createInterface } from "node:readline";',
          "const args = process.argv.slice(2);",
          'appendFileSync(process.env.T3_PROBE_INVOCATION_LOG, JSON.stringify(args) + "\\n");',
          'if (args.includes("--settings")) {',
          '  process.stderr.write("blocked argument: --settings is not allowed\\n");',
          "  process.exit(1);",
          "}",
          "const lines = createInterface({ input: process.stdin });",
          'lines.on("line", (line) => {',
          "  const message = JSON.parse(line);",
          '  if (message.type !== "control_request") return;',
          "  const reply = (response) => process.stdout.write(JSON.stringify({",
          '    type: "control_response",',
          '    response: { subtype: "success", request_id: message.request_id, response },',
          '  }) + "\\n");',
          '  if (message.request?.subtype === "initialize") {',
          "    reply({",
          '      commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],',
          "      agents: [],",
          '      output_style: "default",',
          '      available_output_styles: ["default"],',
          "      models: [],",
          '      account: { email: "dev@example.com", apiProvider: "vertex" },',
          "    });",
          "  }",
          '  if (message.request?.subtype === "get_usage") {',
          "    reply({",
          "      session: {},",
          "      rate_limits_available: false,",
          "      rate_limits: {},",
          "      behaviors: null,",
          "    });",
          "  }",
          "});",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      const capabilities = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: executablePath }),
        { ...process.env, T3_PROBE_INVOCATION_LOG: invocationLogPath },
        workspaceCwd,
      );

      assert.equal(capabilities?.email, "dev@example.com");
      assert.equal(capabilities?.apiProvider, "vertex");
      assert.deepEqual(capabilities?.slashCommands, [
        { name: "review", description: "Review changes", input: { hint: "[path]" } },
      ]);

      const invocations = (yield* fs.readFileString(invocationLogPath))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as ReadonlyArray<string>);
      assert.equal(invocations.length, 2);
      assert.equal(invocations[0]?.includes("--settings"), true);
      assert.equal(invocations[1]?.includes("--settings"), false);
      // The retry gives up hook suppression only; every other isolation the
      // probe relies on still has to be in place.
      assert.equal(invocations[1]?.includes("--strict-mcp-config"), true);
      assert.equal(invocations[1]?.includes("--setting-sources=user,project,local"), true);
    }).pipe(Effect.scoped),
  );
});

it.effect("preserves initialized capabilities when optional usage times out", () =>
  Effect.gen(function* () {
    const usageStarted = yield* Deferred.make<void>();
    let abortSignal: AbortSignal | undefined;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      abortSignal = options?.abortController?.signal;
      return {
        initializationResult: async () => ({
          account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
          commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],
        }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
          Deferred.doneUnsafe(usageStarted, Effect.void);
          return new Promise(() => {});
        },
      } as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const probe = yield* probeClaudeCapabilities(
      decodeClaudeSettings({ binaryPath: "claude" }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(usageStarted);
    yield* TestClock.adjust("4 seconds");
    const capabilities = yield* Fiber.join(probe);
    assert.equal(capabilities?.email, "dev@example.com");
    assert.equal(capabilities?.subscriptionType, "pro");
    assert.equal(capabilities?.tokenSource, "oauth");
    assert.deepEqual(capabilities?.slashCommands, [
      { name: "review", description: "Review changes", input: { hint: "[path]" } },
    ]);
    assert.equal(capabilities?.usage, undefined);
    assert.equal(abortSignal?.aborted, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not retry the probe when initialization times out", () =>
  Effect.gen(function* () {
    const queryStarted = yield* Deferred.make<void>();
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(() => {
      Deferred.doneUnsafe(queryStarted, Effect.void);
      return {
        initializationResult: () => new Promise(() => {}),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}),
      } as unknown as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const probe = yield* probeClaudeCapabilities(
      decodeClaudeSettings({ binaryPath: "claude" }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(queryStarted);
    yield* TestClock.adjust("25 seconds");
    const capabilities = yield* Fiber.join(probe);

    assert.equal(capabilities, undefined);
    // A slow CLI is not an unwilling one. Retrying here would double the
    // worst-case duration of a check that runs every few minutes.
    assert.equal(query.mock.calls.length, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
