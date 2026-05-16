import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { buildCopilotClientOptions } from "./copilotRuntime.ts";

describe("buildCopilotClientOptions", () => {
  it("strips inherited COPILOT_CLI_PATH so the SDK uses the bundled CLI by default", () => {
    const inheritedSecret = "T3_COPILOT_RUNTIME_TEST_SECRET";
    process.env[inheritedSecret] = "do-not-forward";

    const options = buildCopilotClientOptions({
      settings: {
        enabled: true,
        binaryPath: "",
        serverUrl: "",
        customModels: [],
      },
      cwd: "/tmp/project",
      env: {
        PATH: "/usr/bin",
        COPILOT_CLI_PATH: "/opt/homebrew/bin/copilot",
        GITHUB_TOKEN: "github-token",
      },
      logLevel: "error",
    });

    assert.equal(options.cliPath, undefined);
    assert.equal(options.cwd, "/tmp/project");
    assert.equal(options.logLevel, "error");
    assert.equal(options.env?.[inheritedSecret], undefined);
    assert.equal(options.env?.COPILOT_CLI_PATH, undefined);
    assert.equal(options.env?.GITHUB_TOKEN, "github-token");

    delete process.env[inheritedSecret];
  });

  it("prefers the configured binary path over any inherited CLI path override", () => {
    const options = buildCopilotClientOptions({
      settings: {
        enabled: true,
        binaryPath: "/custom/copilot",
        serverUrl: "",
        customModels: [],
      },
      env: {
        COPILOT_CLI_PATH: "/opt/homebrew/bin/copilot",
      },
    });

    assert.equal(options.cliPath, "/custom/copilot");
    assert.equal(options.env?.COPILOT_CLI_PATH, undefined);
  });
});
