// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { acpMcpActivation, acpMcpServers } from "../orchestration-v2/Adapters/AcpAdapterV2.ts";
import {
  CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
  claudeMcpQueryOverrides,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { cursorMcpServers } from "../orchestration-v2/Adapters/CursorAdapterV2.ts";
import { clearMcpProviderSession, setMcpProviderSession } from "./McpProviderSession.ts";
import {
  openCodeT3McpConfig,
  T3_MCP_AUTHORIZATION_ENV,
  parseMcpStdioWrapperCommand,
  T3_MCP_URL_ENV,
} from "./McpStdioWrapper.ts";

const token = "Bearer adapter-wrapper-token";
const endpoint = "http://127.0.0.1:43123/mcp";

let sessionCounter = 0;

function withSession(wrapper: string | undefined, run: (threadId: ThreadId) => void): void {
  sessionCounter += 1;
  const threadId = ThreadId.make(`thread-wrapper-${sessionCounter}`);
  setMcpProviderSession({
    environmentId: EnvironmentId.make("environment-wrapper"),
    threadId,
    providerSessionId: "mcp-session-wrapper",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint,
    stdioWrapper: wrapper === undefined ? undefined : parseMcpStdioWrapperCommand(wrapper),
    authorizationHeader: token,
    browserToolsAvailable: true,
  });
  try {
    run(threadId);
  } finally {
    clearMcpProviderSession(threadId);
  }
}

describe("t3-code MCP adapters honor T3_MCP_STDIO_WRAPPER", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-adapter-"));
  const binary = NodePath.join(directory, "wrapper");
  NodeFS.writeFileSync(binary, "", { mode: 0o700 });
  const session = { endpoint, authorizationHeader: token };

  it("keeps Claude, Codex, Cursor, OpenCode, and ACP on HTTP when unset", () => {
    withSession(undefined, (threadId) => {
      const claude = claudeMcpQueryOverrides({ threadId, readOnlySandbox: false });
      assert.isUndefined(claude.mcpEnvironment);
      assert.deepEqual(claude.mcpServers, {
        "t3-code": {
          type: "http",
          url: endpoint,
          headers: { Authorization: token },
          timeout: CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
        },
      });
      const codex = codexThreadRuntimeParams({ threadId });
      assert.deepEqual(codex.config.mcp_servers, {
        "t3-code": { url: endpoint, http_headers: { Authorization: token } },
      });
      assert.deepEqual(cursorMcpServers(threadId), {
        "t3-code": { type: "http", url: endpoint, headers: { Authorization: token } },
      });
      assert.deepEqual(openCodeT3McpConfig(session), {
        type: "remote",
        url: endpoint,
        headers: { Authorization: token },
        oauth: false,
      });
      assert.deepEqual(
        acpMcpServers(threadId, { command: "/usr/bin/t3", entrypoint: undefined }) as unknown,
        [
          {
            name: "t3-code",
            command: "/usr/bin/t3",
            args: ["acp-mcp-bridge"],
            env: [
              { name: "ELECTRON_RUN_AS_NODE", value: "1" },
              { name: "T3_ACP_MCP_ENDPOINT", value: endpoint },
              { name: "T3_ACP_MCP_AUTHORIZATION", value: token },
            ],
          },
        ],
      );
    });
  });

  it("puts the credential in the wrapper environment for every stdio-capable adapter", () => {
    withSession(`${binary} --fixed`, (threadId) => {
      const expectedEnv = {
        [T3_MCP_URL_ENV]: endpoint,
        [T3_MCP_AUTHORIZATION_ENV]: token,
      };
      const claude = claudeMcpQueryOverrides({ threadId, readOnlySandbox: false });
      assert.deepEqual(claude.mcpServers?.["t3-code"], {
        type: "stdio",
        command: binary,
        args: ["--fixed"],
        env: {
          [T3_MCP_URL_ENV]: `\${${T3_MCP_URL_ENV}}`,
          [T3_MCP_AUTHORIZATION_ENV]: `\${${T3_MCP_AUTHORIZATION_ENV}}`,
        },
        timeout: CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
      });
      // The SDK serializes mcpServers onto the CLI command line, so the
      // credential must only reach the CLI through its environment.
      assert.isFalse(JSON.stringify(claude.mcpServers).includes(token));
      assert.isFalse(JSON.stringify(claude.mcpServers).includes(endpoint));
      assert.deepEqual(claude.mcpEnvironment, expectedEnv);
      const codexServer = (
        codexThreadRuntimeParams({ threadId }).config.mcp_servers as {
          readonly "t3-code": unknown;
        }
      )["t3-code"];
      assert.deepEqual(codexServer, {
        command: binary,
        args: ["--fixed"],
        env: expectedEnv,
      });
      assert.deepEqual(cursorMcpServers(threadId), {
        "t3-code": { type: "stdio", command: binary, args: ["--fixed"], env: expectedEnv },
      });
      const openCode = openCodeT3McpConfig({
        ...session,
        stdioWrapper: { command: binary, args: ["--fixed"] },
      });
      if (openCode.type !== "local") {
        assert.fail("OpenCode must launch the wrapper as a local MCP server");
      }
      assert.deepEqual(openCode, {
        type: "local",
        command: [binary, "--fixed"],
        environment: expectedEnv,
      });
      // An ACP-native descriptor would win over the wrapper for agents that
      // advertise ACP MCP, leaving them with no t3-code tools.
      assert.deepEqual(
        acpMcpActivation(threadId, { command: "/usr/bin/t3", entrypoint: "/usr/bin/t3" })
          .acpMcpServers,
        [],
      );
      const acp = acpMcpServers(threadId, { command: "/usr/bin/t3", entrypoint: "/usr/bin/t3" });
      assert.deepEqual(acp as unknown, [
        {
          name: "t3-code",
          command: binary,
          args: ["--fixed"],
          env: [
            { name: T3_MCP_URL_ENV, value: endpoint },
            { name: T3_MCP_AUTHORIZATION_ENV, value: token },
          ],
        },
      ]);
      assert.notInclude(JSON.stringify(openCode.command), "adapter-wrapper-token");
      assert.notInclude(JSON.stringify(openCode.command), endpoint);
    });
  });
});
