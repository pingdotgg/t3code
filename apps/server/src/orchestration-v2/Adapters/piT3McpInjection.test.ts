import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  PI_T3_MCP_EXTENSION_FILENAME,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
} from "./piT3McpExtensionSource.ts";
import {
  PI_T3_SUBAGENT_EXTENSION_FILENAME,
  T3_PI_CHILD_SESSION_ROOT_ENV,
} from "./piT3SubagentExtensionSource.ts";
import {
  buildPiRpcLaunch,
  discoverPiUserExtensions,
  T3_PI_MCP_EXTENSION_PATH_ENV,
  materializePiT3McpExtension,
  materializePiT3SubagentExtension,
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
  it("leaves spawn args unchanged when no MCP session exists", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: "--session-dir /tmp/pi-sessions",
      environment: { PATH: "/usr/bin" },
      mcpSession: undefined,
      extensionPath: "/tmp/pi-t3-mcp-extension.ts",
    });
    assert.isFalse(launch.hasT3Mcp);
    assert.deepEqual(launch.args, ["--mode", "rpc", "--session-dir", "/tmp/pi-sessions"]);
    assert.equal(launch.env.PATH, "/usr/bin");
    assert.isUndefined(launch.env[T3_MCP_URL_ENV]);
  });

  it("builds one deduplicated extension launch with scoped T3 credentials", () => {
    const launch = buildPiRpcLaunch({
      launchArgs:
        "--session-dir /tmp/pi-sessions --extension /opt/pi/examples/extensions/subagent/index.ts --extension /tmp/cache/pi-t3-subagent-extension.ts --extension /home/user/.pi/agent/extensions/demo.ts",
      environment: { PATH: "/usr/bin" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      subagentExtensionPath: "/tmp/cache/pi-t3-subagent-extension.ts",
      discoveredExtensionPaths: ["/home/user/.pi/agent/extensions/demo.ts"],
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--no-extensions",
      "--extension",
      "/tmp/cache/pi-t3-subagent-extension.ts",
      "--extension",
      "/home/user/.pi/agent/extensions/demo.ts",
      "--session-dir",
      "/tmp/pi-sessions",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
    assert.equal(launch.env[T3_PI_CHILD_SESSION_ROOT_ENV], "/tmp/pi-sessions/children");
    assert.equal(launch.env[T3_MCP_URL_ENV], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[T3_MCP_BEARER_ENV], "secret-pi-token");
    assert.equal(launch.env[T3_PI_MCP_EXTENSION_PATH_ENV], "/tmp/cache/pi-t3-mcp-extension.ts");
    assert.equal(
      launch.args.filter((arg) => arg === "/tmp/cache/pi-t3-subagent-extension.ts").length,
      1,
    );
  });

  it.effect("materializes both runtime extensions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-extensions-" });
      const mcpDest = yield* materializePiT3McpExtension(cacheDir);
      const subagentDest = yield* materializePiT3SubagentExtension(cacheDir);
      assert.isTrue(mcpDest.endsWith(PI_T3_MCP_EXTENSION_FILENAME));
      assert.isTrue(subagentDest.endsWith(PI_T3_SUBAGENT_EXTENSION_FILENAME));
      const mcpSource = yield* fs.readFileString(mcpDest);
      const subagentSource = yield* fs.readFileString(subagentDest);
      assert.include(mcpSource, "export default async function t3McpExtension");
      // Orchestration guidance rides the system-prompt hook, not the user
      // message, so first-turn slash commands still expand.
      assert.include(mcpSource, "before_agent_start");
      assert.include(mcpSource, '"mcp-protocol-version"');
      assert.include(mcpSource, '"tools/call"');
      assert.include(subagentSource, "export default function t3SubagentExtension");
      assert.include(subagentSource, "--session");
      assert.include(subagentSource, T3_PI_CHILD_SESSION_ROOT_ENV);
      // Children re-attach the T3 MCP extension so t3_thread_* tools survive
      // the nested spawn (T3_MCP_* env is inherited from the parent).
      assert.include(subagentSource, T3_PI_MCP_EXTENSION_PATH_ENV);
      assert.isFalse(subagentSource.includes("--no-session"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("discovers user and npm package extensions while skipping subagent overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-home-" });
      const extensionsDir = `${home}/.pi/agent/extensions`;
      const lensDir = `${home}/.pi/agent/npm/node_modules/pi-lens`;
      const authDir = `${home}/.pi/agent/npm/node_modules/@gotgenes/pi-anthropic-auth`;
      const filteredDir = `${home}/.pi/agent/npm/node_modules/filtered-extension`;
      const packageSubagentDir = `${home}/.pi/agent/npm/node_modules/pi-subagents`;
      yield* fs.makeDirectory(`${extensionsDir}/todos`, { recursive: true });
      yield* fs.makeDirectory(`${extensionsDir}/subagent`, { recursive: true });
      yield* fs.makeDirectory(`${lensDir}/src`, { recursive: true });
      yield* fs.makeDirectory(`${authDir}/src`, { recursive: true });
      yield* fs.makeDirectory(`${filteredDir}/src`, { recursive: true });
      yield* fs.makeDirectory(packageSubagentDir, { recursive: true });
      yield* fs.writeFileString(`${extensionsDir}/demo.ts`, "export default () => {}");
      yield* fs.writeFileString(`${extensionsDir}/subagent.ts`, "export default () => {}");
      yield* fs.writeFileString(`${extensionsDir}/subagent.js`, "export default () => {}");
      yield* fs.writeFileString(`${extensionsDir}/todos/index.ts`, "export default () => {}");
      yield* fs.writeFileString(`${extensionsDir}/subagent/index.ts`, "export default () => {}");
      yield* fs.writeFileString(`${lensDir}/src/index.ts`, "export default () => {}");
      yield* fs.writeFileString(`${authDir}/src/index.ts`, "export default () => {}");
      yield* fs.writeFileString(`${filteredDir}/src/index.ts`, "export default () => {}");
      yield* fs.writeFileString(`${filteredDir}/src/legacy.ts`, "export default () => {}");
      yield* fs.writeFileString(`${packageSubagentDir}/index.ts`, "export default () => {}");
      yield* fs.writeFileString(
        `${lensDir}/package.json`,
        '{ "pi": { "extensions": ["./src/index.ts"] } }',
      );
      yield* fs.writeFileString(
        `${authDir}/package.json`,
        '{ "pi": { "extensions": ["./src/index.ts"] } }',
      );
      yield* fs.writeFileString(
        `${filteredDir}/package.json`,
        '{ "pi": { "extensions": ["./src/index.ts", "./src/legacy.ts"] } }',
      );
      yield* fs.writeFileString(
        `${packageSubagentDir}/package.json`,
        '{ "pi": { "extensions": ["./index.ts"] } }',
      );
      yield* fs.writeFileString(
        `${home}/.pi/agent/settings.json`,
        `{ "packages": [
          "npm:pi-lens",
          "npm:@gotgenes/pi-anthropic-auth@1.2.3",
          { "source": "npm:filtered-extension", "extensions": ["./src/index.ts"] },
          "npm:pi-subagents",
          { "source": "npm:disabled-extension", "extensions": [] }
        ] }`,
      );
      const found = yield* discoverPiUserExtensions({
        environment: { HOME: home },
        cwd: undefined,
      });
      assert.deepEqual(found, [
        `${extensionsDir}/demo.ts`,
        `${extensionsDir}/todos/index.ts`,
        `${lensDir}/src/index.ts`,
        `${authDir}/src/index.ts`,
        `${filteredDir}/src/index.ts`,
      ]);
      yield* fs.writeFileString(
        `${home}/.pi/agent/settings.json`,
        `{ "packages": [
          { "source": "npm:filtered-extension", "autoload": false, "extensions": ["./src/index.ts"] }
        ] }`,
      );
      const autoloadDisabled = yield* discoverPiUserExtensions({
        environment: { HOME: home },
        cwd: undefined,
      });
      assert.deepEqual(autoloadDisabled, [
        `${extensionsDir}/demo.ts`,
        `${extensionsDir}/todos/index.ts`,
        `${filteredDir}/src/index.ts`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("includes project extensions only under standing project trust", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-home-" });
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-parent-" });
      const project = `${parent}/project`;
      yield* fs.makeDirectory(`${home}/.pi/agent`, { recursive: true });
      yield* fs.makeDirectory(`${project}/.pi/extensions`, { recursive: true });
      yield* fs.writeFileString(`${project}/.pi/extensions/local.ts`, "export default () => {}");
      const untrusted = yield* discoverPiUserExtensions({
        environment: { HOME: home },
        cwd: project,
      });
      assert.deepEqual(untrusted, []);
      yield* fs.writeFileString(`${home}/.pi/agent/trust.json`, `{ "${parent}": true }`);
      const trustedViaAncestor = yield* discoverPiUserExtensions({
        environment: { HOME: home },
        cwd: project,
      });
      assert.deepEqual(trustedViaAncestor, [`${project}/.pi/extensions/local.ts`]);
      yield* fs.writeFileString(
        `${home}/.pi/agent/settings.json`,
        '{ "defaultProjectTrust": "always" }',
      );
      yield* fs.writeFileString(
        `${home}/.pi/agent/trust.json`,
        `{ "${parent}": true, "${project}": false }`,
      );
      const explicitlyUntrusted = yield* discoverPiUserExtensions({
        environment: { HOME: home },
        cwd: project,
      });
      assert.deepEqual(explicitlyUntrusted, []);
      yield* fs.writeFileString(`${home}/.pi/agent/trust.json`, "{}");
      const trustedByDefault = yield* discoverPiUserExtensions({
        environment: { HOME: home },
        cwd: project,
      });
      assert.deepEqual(trustedByDefault, [`${project}/.pi/extensions/local.ts`]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
