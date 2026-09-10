import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  PI_T3_MCP_EXTENSION_FILENAME,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_PI_RUNTIME_MODE_ENV,
} from "./piT3McpExtensionSource.ts";
import {
  buildPiRpcLaunch,
  materializePiT3McpExtension,
  resolvePiLaunchArgs,
} from "./piT3McpInjection.ts";

const threadId = ThreadId.make("thread-pi-t3-mcp");

const mcpSession = {
  environmentId: EnvironmentId.make("environment-pi-t3-mcp"),
  threadId,
  providerSessionId: "mcp-session-pi",
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-pi-token",
  browserToolsAvailable: true,
};

describe("pi T3 MCP injection", () => {
  it("always adds the permission bridge and configures MCP when available", () => {
    const resolvedArgs = resolvePiLaunchArgs(
      "--extension=/home/user/.pi/agent/extensions/demo.ts --session-dir=/tmp/pi-sessions --provider=anthropic --model=claude-sonnet --tools='' --name=-review --extension-flag=kept",
    );
    assert.isTrue(resolvedArgs.ok);
    if (!resolvedArgs.ok) return;
    const launch = buildPiRpcLaunch({
      launchArgs: resolvedArgs.args,
      environment: { PATH: "/usr/bin" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      runtimeMode: "approval-required",
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--extension",
      "/home/user/.pi/agent/extensions/demo.ts",
      "--session-dir",
      "/tmp/pi-sessions",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet",
      "--tools",
      "",
      "--name",
      "-review",
      "--extension-flag=kept",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
    assert.notInclude(launch.args, "--no-extensions");
    assert.equal(launch.env[T3_MCP_URL_ENV], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[T3_MCP_BEARER_ENV], "secret-pi-token");
    assert.equal(launch.env[T3_PI_RUNTIME_MODE_ENV], "approval-required");

    const permissionOnly = buildPiRpcLaunch({
      launchArgs: [],
      environment: {
        [T3_MCP_URL_ENV]: "http://127.0.0.1:9999/stale",
        [T3_MCP_BEARER_ENV]: "stale-token",
      },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      runtimeMode: "auto-accept-edits",
    });
    assert.deepEqual(permissionOnly.args, [
      "--mode",
      "rpc",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
    assert.isFalse(permissionOnly.hasT3Mcp);
    assert.isUndefined(permissionOnly.env[T3_MCP_URL_ENV]);
    assert.isUndefined(permissionOnly.env[T3_MCP_BEARER_ENV]);
    assert.equal(permissionOnly.env[T3_PI_RUNTIME_MODE_ENV], "auto-accept-edits");
  });

  it("falls back to Pi's first supported mode for legacy auto threads", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [],
      environment: {},
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      runtimeMode: "auto",
    });

    assert.equal(launch.env[T3_PI_RUNTIME_MODE_ENV], "approval-required");
  });

  it("forces tools and user extensions off for unattended text generation", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [
        "--tools",
        "read,write",
        "--extension",
        "/home/user/.pi/agent/extensions/demo.ts",
        "--extension=./second.ts",
        "--provider",
        "anthropic",
      ],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      ephemeral: true,
      disableExtensions: true,
      disableTools: true,
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--no-session",
      "--provider",
      "anthropic",
      "--no-extensions",
      "--no-tools",
    ]);
    assert.isFalse(launch.hasT3Mcp);
    assert.deepInclude(resolvePiLaunchArgs("--mode text"), {
      ok: false,
      message: "Pi launch argument '--mode' is controlled by T3 Code and cannot be overridden.",
    });
    assert.deepInclude(resolvePiLaunchArgs("--session old.jsonl"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("prompt pi immediately"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("--plan @instructions.md"), { ok: false });
  });

  it.effect("materializes the MCP bridge with namespaced tool registration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-extensions-" });
      const mcpDest = yield* materializePiT3McpExtension(cacheDir);
      assert.isTrue(mcpDest.endsWith(PI_T3_MCP_EXTENSION_FILENAME));
      const mcpSource = yield* fs.readFileString(mcpDest);
      assert.include(mcpSource, "export default async function t3McpExtension");
      assert.include(mcpSource, "before_agent_start");
      assert.include(mcpSource, 'pi.on("tool_call"');
      assert.include(mcpSource, "Allow ${event.toolName}?");
      assert.include(mcpSource, '"mcp-protocol-version"');
      assert.include(mcpSource, '"tools/call"');
      assert.include(mcpSource, "mcp__t3-code__");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
