import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  authSnapshotFromCopilotSdk,
  buildCopilotClientOptions,
  capabilitiesFromCopilotModel,
  normalizeCopilotRuntimeEnvironment,
  resolveBundledCopilotCliPath,
} from "./copilotRuntime.ts";

function assertStdioConnection(
  connection: ReturnType<typeof buildCopilotClientOptions>["connection"],
) {
  assert.equal(connection?.kind, "stdio");
  return connection;
}

const POSIX_SHELL_FALLBACKS = ["/bin/bash", "/usr/bin/bash", "/bin/sh"] as const;

describe("buildCopilotClientOptions", () => {
  it("leaves POSIX PATH hydration to the shared server environment setup", () => {
    const env = normalizeCopilotRuntimeEnvironment({ PATH: "/custom/bin:/bin" }, "darwin");

    assert.equal(env.PATH, "/custom/bin:/bin");
  });

  describe("capabilitiesFromCopilotModel", () => {
    it("adds a context tier selector for long-context Copilot models", () => {
      const capabilities = capabilitiesFromCopilotModel({
        capabilities: {
          supports: { vision: false, reasoningEffort: true },
          limits: { max_prompt_tokens: 922_000, max_context_window_tokens: 1_050_000 },
        },
        billing: {
          tokenPrices: {
            contextMax: 272_000,
            longContext: { contextMax: 922_000 },
          },
        },
        supportedReasoningEfforts: ["none", "low", "medium", "high"],
        defaultReasoningEffort: "medium",
      });

      assert.deepStrictEqual(capabilities.optionDescriptors, [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "none", label: "None" },
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
          currentValue: "medium",
        },
        {
          id: "contextTier",
          label: "Context Window",
          type: "select",
          options: [
            { id: "default", label: "Default (272K tokens)" },
            { id: "long_context", label: "Long Context (1.05M tokens)" },
          ],
          currentValue: "default",
        },
      ]);
    });

    it("omits the context tier selector for regular-context Copilot models", () => {
      const capabilities = capabilitiesFromCopilotModel({
        capabilities: {
          supports: { vision: false, reasoningEffort: false },
          limits: { max_prompt_tokens: 272_000, max_context_window_tokens: 400_000 },
        },
        billing: {
          tokenPrices: {
            contextMax: 272_000,
          },
        },
      });

      assert.deepStrictEqual(capabilities.optionDescriptors, []);
    });
  });

  it("hydrates a missing POSIX SHELL for Copilot shell spawning", () => {
    const env = normalizeCopilotRuntimeEnvironment({}, "darwin");

    assert.ok(POSIX_SHELL_FALLBACKS.some((shell) => shell === env.SHELL));
  });

  it("replaces POSIX SHELL values that the Copilot CLI rejects", () => {
    const fallbackShell = normalizeCopilotRuntimeEnvironment({}, "darwin").SHELL;
    const relativeShellEnv = normalizeCopilotRuntimeEnvironment({ SHELL: "bash" }, "darwin");
    const shellWithWhitespaceEnv = normalizeCopilotRuntimeEnvironment(
      { SHELL: "/bin/bash --noprofile" },
      "darwin",
    );

    assert.equal(relativeShellEnv.SHELL, fallbackShell);
    assert.equal(shellWithWhitespaceEnv.SHELL, fallbackShell);
  });

  it("preserves valid POSIX SHELL paths", () => {
    const validShell = normalizeCopilotRuntimeEnvironment({}, "darwin").SHELL;
    assert.ok(validShell);

    const env = normalizeCopilotRuntimeEnvironment({ SHELL: validShell }, "darwin");

    assert.equal(env.SHELL, validShell);
  });

  it("forces the Copilot POSIX shell spawn backend to avoid node-pty failures", () => {
    const env = normalizeCopilotRuntimeEnvironment({}, "darwin");

    assert.equal(env.COPILOT_FEATURE_FLAGS, "SHELL_SPAWN_BACKEND");
    assert.equal(env.COPILOT_EXP_COPILOT_CLI_SHELL_SPAWN_BACKEND, "true");
  });

  it("preserves existing Copilot feature flags while enabling the shell spawn backend", () => {
    const env = normalizeCopilotRuntimeEnvironment(
      { COPILOT_FEATURE_FLAGS: "FOCUSED_TOOLS, SHELL_SPAWN_BACKEND, MCP_APPS" },
      "darwin",
    );

    assert.equal(env.COPILOT_FEATURE_FLAGS, "FOCUSED_TOOLS,SHELL_SPAWN_BACKEND,MCP_APPS");
  });

  it("does not apply POSIX shell normalization on Windows", () => {
    const env = normalizeCopilotRuntimeEnvironment({ SHELL: "bash" }, "win32");

    assert.equal(env.SHELL, "bash");
    assert.equal(env.COPILOT_FEATURE_FLAGS, undefined);
    assert.equal(env.COPILOT_EXP_COPILOT_CLI_SHELL_SPAWN_BACKEND, undefined);
  });

  it("strips inherited COPILOT_CLI_PATH and uses the local Copilot CLI shim by default", () => {
    const options = buildCopilotClientOptions({
      settings: {
        enabled: true,
        binaryPath: "",
        serverUrl: "",
        customModels: [],
      },
      cwd: "/tmp/project",
      baseDirectory: "/tmp/t3-copilot-home",
      env: {
        PATH: "/usr/bin",
        COPILOT_CLI_PATH: "/opt/homebrew/bin/copilot",
        GITHUB_TOKEN: "github-token",
      },
      logLevel: "error",
    });

    const connection = assertStdioConnection(options.connection);
    assert.ok(connection.path?.includes("node_modules/.bin/copilot"));
    assert.equal(options.workingDirectory, "/tmp/project");
    assert.equal(options.baseDirectory, "/tmp/t3-copilot-home");
    assert.equal(options.logLevel, "error");
    assert.equal(options.mode, "copilot-cli");
    assert.equal(options.env?.COPILOT_CLI_PATH, undefined);
    assert.equal(options.env?.GITHUB_TOKEN, "github-token");
    assert.equal(options.env?.PATH, "/usr/bin");
  });

  it("resolves the bundled Copilot CLI shim without relying on PATH", () => {
    const cliPath = resolveBundledCopilotCliPath({
      cwd: "/tmp/project",
      env: { PATH: "/usr/bin" },
    });

    assert.ok(cliPath?.includes("node_modules/.bin/copilot"));
  });

  it("prefers the configured binary path over any inherited CLI path override", () => {
    const configuredBinaryPath = process.execPath;

    const options = buildCopilotClientOptions({
      settings: {
        enabled: true,
        binaryPath: configuredBinaryPath,
        serverUrl: "",
        customModels: [],
      },
      env: {
        COPILOT_CLI_PATH: "/opt/homebrew/bin/copilot",
      },
    });

    const connection = assertStdioConnection(options.connection);
    assert.equal(connection.path, configuredBinaryPath);
    assert.equal(options.env?.COPILOT_CLI_PATH, undefined);
  });

  it("omits the generic signed-in user prefix from authenticated Copilot labels", () => {
    const snapshot = authSnapshotFromCopilotSdk({
      isAuthenticated: true,
      authType: "user",
      host: "https://github.com",
      statusMessage: "octocat",
      login: "octocat",
    });

    assert.equal(snapshot.auth.status, "authenticated");
    assert.equal(snapshot.auth.type, "user");
    assert.equal(snapshot.auth.label, "@octocat - github.com");
  });

  it("prefers the richer authenticated status message when it differs from the raw login", () => {
    const snapshot = authSnapshotFromCopilotSdk({
      isAuthenticated: true,
      authType: "gh-cli",
      host: "https://github.com",
      statusMessage: "zortos293 (via gh)",
      login: "zortos293",
    });

    assert.equal(snapshot.auth.status, "authenticated");
    assert.equal(snapshot.auth.type, "gh-cli");
    assert.equal(snapshot.auth.label, "zortos293 (via gh)");
  });
});
