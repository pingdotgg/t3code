import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import type { CopilotClientOptions } from "@github/copilot-sdk";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  authSnapshotFromCopilotSdk,
  buildCopilotClientOptions,
  capabilitiesFromCopilotModel,
  createCopilotClient,
  modelsFromCopilotSdk,
  normalizeCopilotRuntimeEnvironment,
  resolveBundledCopilotCliPath,
} from "./copilotRuntime.ts";

function assertStdioConnection(connection: CopilotClientOptions["connection"]) {
  NodeAssert.equal(connection?.kind, "stdio");
  return connection;
}

const POSIX_SHELL_FALLBACKS = ["/bin/bash", "/usr/bin/bash", "/bin/sh"] as const;

describe("buildCopilotClientOptions", () => {
  it("leaves POSIX PATH hydration to the shared server environment setup", () => {
    const env = normalizeCopilotRuntimeEnvironment({ PATH: "/custom/bin:/bin" }, "darwin");

    NodeAssert.equal(env.PATH, "/custom/bin:/bin");
  });

  it.effect("returns typed failures for invalid Copilot client configuration", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        createCopilotClient({
          settings: {
            enabled: true,
            binaryPath: "",
            serverUrl: "http://[::1",
            customModels: [],
          },
          platform: "darwin",
        }),
      );

      NodeAssert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause);
        NodeAssert.equal(
          (failure as { readonly _tag?: string })._tag,
          "CopilotCliPathResolutionError",
        );
      }
    }),
  );

  it("normalizes built-in Copilot SDK model slugs", () => {
    const [model] = modelsFromCopilotSdk({
      models: [
        {
          id: "4.1",
          name: "",
          capabilities: {
            supports: { vision: false, reasoningEffort: false },
            limits: { max_prompt_tokens: 272_000, max_context_window_tokens: 400_000 },
          },
          billing: {
            tokenPrices: { contextMax: 272_000 },
          },
        } as unknown as Parameters<typeof modelsFromCopilotSdk>[0]["models"][number],
      ],
      customModels: ["gpt-4.1"],
    });

    NodeAssert.equal(model?.slug, "gpt-4.1");
    NodeAssert.equal(model?.isCustom, false);
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
        supportedReasoningEfforts: ["none", "low", "medium", "high", "max"],
        defaultReasoningEffort: "medium",
      });

      NodeAssert.deepStrictEqual(capabilities.optionDescriptors, [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "none", label: "None" },
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
            { id: "max", label: "Max" },
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

      NodeAssert.deepStrictEqual(capabilities.optionDescriptors, []);
    });
  });

  it("hydrates a missing POSIX SHELL for Copilot shell spawning", () => {
    const env = normalizeCopilotRuntimeEnvironment({}, "darwin");

    NodeAssert.ok(POSIX_SHELL_FALLBACKS.some((shell) => shell === env.SHELL));
  });

  it("replaces POSIX SHELL values that the Copilot CLI rejects", () => {
    const fallbackShell = normalizeCopilotRuntimeEnvironment({}, "darwin").SHELL;
    const relativeShellEnv = normalizeCopilotRuntimeEnvironment({ SHELL: "bash" }, "darwin");
    const shellWithWhitespaceEnv = normalizeCopilotRuntimeEnvironment(
      { SHELL: "/bin/bash --noprofile" },
      "darwin",
    );

    NodeAssert.equal(relativeShellEnv.SHELL, fallbackShell);
    NodeAssert.equal(shellWithWhitespaceEnv.SHELL, fallbackShell);
  });

  it("preserves valid POSIX SHELL paths", () => {
    const validShell = normalizeCopilotRuntimeEnvironment({}, "darwin").SHELL;
    NodeAssert.ok(validShell);

    const env = normalizeCopilotRuntimeEnvironment({ SHELL: validShell }, "darwin");

    NodeAssert.equal(env.SHELL, validShell);
  });

  it("forces the Copilot POSIX shell spawn backend to avoid node-pty failures", () => {
    const env = normalizeCopilotRuntimeEnvironment({}, "darwin");

    NodeAssert.equal(env.COPILOT_FEATURE_FLAGS, "SHELL_SPAWN_BACKEND");
    NodeAssert.equal(env.COPILOT_EXP_COPILOT_CLI_SHELL_SPAWN_BACKEND, "true");
  });

  it("preserves existing Copilot feature flags while enabling the shell spawn backend", () => {
    const env = normalizeCopilotRuntimeEnvironment(
      { COPILOT_FEATURE_FLAGS: "FOCUSED_TOOLS, SHELL_SPAWN_BACKEND, MCP_APPS" },
      "darwin",
    );

    NodeAssert.equal(env.COPILOT_FEATURE_FLAGS, "FOCUSED_TOOLS,SHELL_SPAWN_BACKEND,MCP_APPS");
  });

  it("does not apply POSIX shell normalization on Windows", () => {
    const env = normalizeCopilotRuntimeEnvironment({ SHELL: "bash" }, "win32");

    NodeAssert.equal(env.SHELL, "bash");
    NodeAssert.equal(env.COPILOT_FEATURE_FLAGS, undefined);
    NodeAssert.equal(env.COPILOT_EXP_COPILOT_CLI_SHELL_SPAWN_BACKEND, undefined);
  });

  it.layer(NodeServices.layer)("Copilot CLI command resolution", (it) => {
    it.effect(
      "strips inherited COPILOT_CLI_PATH and uses the local Copilot CLI shim by default",
      () =>
        Effect.gen(function* () {
          const options = yield* buildCopilotClientOptions({
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
            platform: "darwin",
            logLevel: "error",
          });

          const connection = assertStdioConnection(options.connection);
          NodeAssert.ok(connection.path?.includes("node_modules/.bin/copilot"));
          NodeAssert.equal(options.workingDirectory, "/tmp/project");
          NodeAssert.equal(options.baseDirectory, "/tmp/t3-copilot-home");
          NodeAssert.equal(options.logLevel, "error");
          NodeAssert.equal(options.mode, "copilot-cli");
          NodeAssert.equal(options.env?.COPILOT_CLI_PATH, undefined);
          NodeAssert.equal(options.env?.GITHUB_TOKEN, "github-token");
          NodeAssert.equal(options.env?.PATH, "/usr/bin");
        }),
    );

    it.effect("resolves the bundled Copilot CLI shim without relying on PATH", () =>
      Effect.gen(function* () {
        const cliPath = yield* resolveBundledCopilotCliPath({
          cwd: "/tmp/project",
          env: { PATH: "/usr/bin" },
          platform: "darwin",
        });

        NodeAssert.ok(cliPath?.includes("node_modules/.bin/copilot"));
      }),
    );

    it.effect("prefers the configured binary path over any inherited CLI path override", () =>
      Effect.gen(function* () {
        const configuredBinaryPath = process.execPath;

        const options = yield* buildCopilotClientOptions({
          settings: {
            enabled: true,
            binaryPath: configuredBinaryPath,
            serverUrl: "",
            customModels: [],
          },
          env: {
            COPILOT_CLI_PATH: "/opt/homebrew/bin/copilot",
          },
          platform: "darwin",
        });

        const connection = assertStdioConnection(options.connection);
        NodeAssert.equal(connection.path, configuredBinaryPath);
        NodeAssert.equal(options.env?.COPILOT_CLI_PATH, undefined);
      }),
    );
  });

  it("omits the generic signed-in user prefix from authenticated Copilot labels", () => {
    const snapshot = authSnapshotFromCopilotSdk({
      isAuthenticated: true,
      authType: "user",
      host: "https://github.com",
      statusMessage: "octocat",
      login: "octocat",
    });

    NodeAssert.equal(snapshot.auth.status, "authenticated");
    NodeAssert.equal(snapshot.auth.type, "user");
    NodeAssert.equal(snapshot.auth.label, "@octocat - github.com");
  });

  it("prefers the richer authenticated status message when it differs from the raw login", () => {
    const snapshot = authSnapshotFromCopilotSdk({
      isAuthenticated: true,
      authType: "gh-cli",
      host: "https://github.com",
      statusMessage: "zortos293 (via gh)",
      login: "zortos293",
    });

    NodeAssert.equal(snapshot.auth.status, "authenticated");
    NodeAssert.equal(snapshot.auth.type, "gh-cli");
    NodeAssert.equal(snapshot.auth.label, "zortos293 (via gh)");
  });
});
