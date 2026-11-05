import { describe, expect, it } from "vite-plus/test";

import { extractFigmaFiles, extractMcpImage, extractNamedIds } from "./MentionIndexFigmaSyncer.ts";
import { extractJiraRows, resolveJiraBrowseUrl } from "./MentionIndexJiraSyncer.ts";
import {
  parseCodexMcpServers,
  parseMcpHttpResponseBody,
  parseMentionMcpServers,
  pickMentionMcpServer,
  settleStdioMcpResponseLine,
} from "./MentionIndexMcpClient.ts";

describe("MentionIndexMcpClient helpers", () => {
  it("parses Cursor mcpServers and picks jira/figma by name", () => {
    const servers = parseMentionMcpServers({
      "user-atlassian": {
        command: "npx",
        args: ["-y", "mcp-remote", "https://mcp.atlassian.com"],
      },
      "figma-dev": { url: "https://mcp.figma.com/mcp" },
      other: { command: "echo" },
    });
    expect(pickMentionMcpServer(servers, "jira")?.name).toBe("user-atlassian");
    expect(pickMentionMcpServer(servers, "figma")?.name).toBe("figma-dev");
    expect(pickMentionMcpServer(servers, "jira", "missing")).toBeNull();
    expect(pickMentionMcpServer(servers, "figma", "figma-dev")?.transport).toBe("http");
    // Named exact match that fails kind heuristics must not spawn an unrelated MCP.
    expect(pickMentionMcpServer(servers, "jira", "figma-dev")).toBeNull();
    expect(pickMentionMcpServer(servers, "figma", "other")).toBeNull();
  });

  it("preserves apostrophes inside Codex command args", () => {
    const servers = parseCodexMcpServers(`
[mcp_servers.local-jira]
command = "node"
args = ["-c", "console.log('ok')"]
`);
    expect(servers).toEqual([
      {
        transport: "stdio",
        name: "local-jira",
        command: "node",
        args: ["-c", "console.log('ok')"],
        env: {},
      },
    ]);
  });

  it("rejects stdio JSON-RPC responses with a non-object error without throwing", async () => {
    const pending = new Map<
      number,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
      }
    >();
    const result = Promise.withResolvers<unknown>();
    pending.set(1, { resolve: result.resolve, reject: result.reject });
    settleStdioMcpResponseLine('{"id":1,"error":null}', pending, "local-jira");
    await expect(result.promise).rejects.toThrow("MCP error from local-jira");
    expect(pending.size).toBe(0);
  });

  it("skips Codex servers with enabled = false and carries headers/env", () => {
    const previous = process.env.FIGMA_TOKEN;
    process.env.FIGMA_TOKEN = "secret-token";
    try {
      const servers = parseCodexMcpServers(`
[mcp_servers.disabled-jira]
command = "npx"
enabled = false

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_TOKEN"
http_headers = { "X-Region" = "us" }

[mcp_servers.figma.http_headers]
X-Figma-Region = "us-east-1"

[mcp_servers.figma.env_http_headers]
"X-Api-Key" = "FIGMA_TOKEN"

[profiles.default]
command = "should-not-leak"

[mcp_servers.local-jira]
command = "npx"
args = ["-y", "jira-mcp"]
env = { "JIRA_SITE" = "acme" }

[mcp_servers.stdio-env]
command = "uvx"
args = ["jira-mcp"]

[mcp_servers.stdio-env.env]
JIRA_SITE = "from-table"
JIRA_API_TOKEN = "secret"

[[features]]
command = "should-not-overwrite-stdio-env"
`);
      expect(servers.map((server) => server.name)).toEqual(["figma", "local-jira", "stdio-env"]);
      const figma = servers.find((server) => server.name === "figma");
      expect(figma).toMatchObject({
        transport: "http",
        url: "https://mcp.figma.com/mcp",
        headers: {
          "X-Region": "us",
          "X-Figma-Region": "us-east-1",
          "X-Api-Key": "secret-token",
          Authorization: "Bearer secret-token",
        },
      });
      const local = servers.find((server) => server.name === "local-jira");
      expect(local).toMatchObject({
        transport: "stdio",
        command: "npx",
        args: ["-y", "jira-mcp"],
        env: { JIRA_SITE: "acme" },
      });
      const stdioEnv = servers.find((server) => server.name === "stdio-env");
      expect(stdioEnv).toMatchObject({
        transport: "stdio",
        command: "uvx",
        args: ["jira-mcp"],
        env: { JIRA_SITE: "from-table", JIRA_API_TOKEN: "secret" },
      });
    } finally {
      if (previous === undefined) delete process.env.FIGMA_TOKEN;
      else process.env.FIGMA_TOKEN = previous;
    }
  });

  it("parses SSE MCP responses by Content-Type and request id", () => {
    const body = [
      "event: message",
      'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}',
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search"}]}}',
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      "",
    ].join("\n");

    expect(
      parseMcpHttpResponseBody({
        contentType: "text/event-stream; charset=utf-8",
        text: body,
        requestId: 1,
      }),
    ).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });

    expect(
      parseMcpHttpResponseBody({
        contentType: "application/json",
        text: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
        requestId: 1,
      }),
    ).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });

    // Body containing "data:" must not be treated as SSE without the content type.
    expect(
      parseMcpHttpResponseBody({
        contentType: "application/json",
        text: '{"note":"data: not sse","id":1,"result":{}}',
      }),
    ).toEqual({ note: "data: not sse", id: 1, result: {} });
  });
});

describe("Jira MCP payload mapping", () => {
  it("maps Atlassian search results into mention rows", () => {
    const rows = extractJiraRows(
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              issues: [
                {
                  key: "T3-42",
                  fields: {
                    summary: "Improve context chips",
                    status: { name: "In Progress" },
                    project: { key: "T3" },
                  },
                  url: "https://example.atlassian.net/browse/T3-42",
                },
              ],
            }),
          },
        ],
      },
      100,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: "jira",
      itemKey: "T3-42",
      label: "T3-42",
      jira: {
        key: "T3-42",
        summary: "Improve context chips",
        status: "In Progress",
        projectKey: "T3",
      },
    });
  });

  it("derives browse URLs from self and avoids inventing atlassian.net", () => {
    expect(
      resolveJiraBrowseUrl({ self: "https://acme.atlassian.net/rest/api/3/issue/10001" }, "T3-7"),
    ).toBe("https://acme.atlassian.net/browse/T3-7");
    expect(resolveJiraBrowseUrl({ key: "T3-7" }, "T3-7")).toBe("about:blank");

    const rows = extractJiraRows(
      {
        issues: [
          {
            key: "T3-7",
            fields: { summary: "No url" },
            self: "https://acme.atlassian.net/rest/api/2/issue/7",
          },
          {
            key: "T3-8",
            fields: { summary: "No self either" },
          },
        ],
      },
      1,
    );
    expect(rows[0]?.url).toBe("https://acme.atlassian.net/browse/T3-7");
    expect(rows[1]?.url).toBe("about:blank");
  });

  it("extracts MCP image content for Figma thumbnails", () => {
    expect(
      extractMcpImage({
        content: [{ type: "image", mimeType: "image/png", data: "abc123" }],
      }),
    ).toEqual({ mimeType: "image/png", dataBase64: "abc123" });
    expect(extractMcpImage({ content: [{ type: "text", text: "hi" }] })).toBeNull();
  });

  it("parses Figma team/project list payloads", () => {
    expect(
      extractNamedIds(
        {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                teams: [
                  { id: "111", name: "Acme" },
                  { id: "222", name: "Design" },
                ],
              }),
            },
          ],
        },
        ["teams", "team"],
      ),
    ).toEqual([
      { id: "111", name: "Acme" },
      { id: "222", name: "Design" },
    ]);
    expect(extractNamedIds("Marketing (333)\nProduct (444)", ["teams", "team"])).toEqual([
      { id: "333", name: "Marketing" },
      { id: "444", name: "Product" },
    ]);
  });

  it("parses Figma project file listings", () => {
    expect(
      extractFigmaFiles({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              files: [
                { key: "Abc123", name: "Home" },
                { key: "Def456", name: "Checkout", url: "https://www.figma.com/design/Def456" },
              ],
            }),
          },
        ],
      }),
    ).toEqual([
      { key: "Abc123", name: "Home" },
      { key: "Def456", name: "Checkout", url: "https://www.figma.com/design/Def456" },
    ]);
  });
});
