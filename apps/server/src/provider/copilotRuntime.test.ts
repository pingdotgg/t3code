import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { authSnapshotFromCopilotSdk, buildCopilotClientOptions } from "./copilotRuntime.ts";

describe("buildCopilotClientOptions", () => {
  it("strips inherited COPILOT_CLI_PATH so the SDK uses the bundled CLI by default", () => {
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
    assert.equal(options.env?.COPILOT_CLI_PATH, undefined);
    assert.equal(options.env?.GITHUB_TOKEN, "github-token");
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

    assert.equal(options.cliPath, configuredBinaryPath);
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
