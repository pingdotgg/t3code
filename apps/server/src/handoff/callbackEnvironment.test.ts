import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { makeHandoffCallbackEnvironment } from "./callbackEnvironment.ts";

const mcpSessionConfig = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  endpoint: "http://127.0.0.1:3284/mcp",
  authorizationHeader: "Bearer secret-token",
};

it("builds the callback env from the session's MCP credential", () => {
  const environment = makeHandoffCallbackEnvironment(mcpSessionConfig, {
    cliShimPath: "/repo/apps/server/claude-plugin/bin/d",
  });

  assert.equal(environment.T3_SERVER_ORIGIN, "http://127.0.0.1:3284");
  assert.equal(environment.T3_SERVER_TOKEN, "secret-token");
  assert.equal(environment.T3_THREAD_ID, "thread-1");
  assert.equal(environment.T3_CLI, "/repo/apps/server/claude-plugin/bin/d");
});

it("omits T3_CLI when no shim path is available", () => {
  const environment = makeHandoffCallbackEnvironment(mcpSessionConfig);
  assert.equal(environment.T3_CLI, undefined);
  assert.equal(environment.T3_SERVER_ORIGIN, "http://127.0.0.1:3284");
});

it("injects the CLI entry and the runtime that can read it", () => {
  const environment = makeHandoffCallbackEnvironment(mcpSessionConfig, {
    cliShimPath: "/app.asar.unpacked/apps/server/dist/claude-plugin/bin/t3",
    cliEntryPath: "/app.asar/apps/server/dist/bin.mjs",
    cliRuntimePath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
  });

  assert.equal(environment.T3_CLI_ENTRY, "/app.asar/apps/server/dist/bin.mjs");
  assert.equal(environment.T3_CLI_RUNTIME, "/Applications/T3 Code.app/Contents/MacOS/T3 Code");
});

it("omits the runtime when there is no entry to read with it", () => {
  const environment = makeHandoffCallbackEnvironment(mcpSessionConfig, {
    cliRuntimePath: "/usr/bin/node",
  });

  assert.equal(environment.T3_CLI_ENTRY, undefined);
  assert.equal(environment.T3_CLI_RUNTIME, undefined);
});
