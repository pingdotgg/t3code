import { describe, expect, it } from "vite-plus/test";

import {
  extractFigmaRows,
  mcpResultIsError,
  pagesFromFigmaXml,
} from "./MentionIndexFigmaSyncer.ts";
import { extractJiraRows, resolveJiraBrowseUrl } from "./MentionIndexJiraSyncer.ts";
import {
  parseCodexMcpServers,
  parseMcpHttpResponseBody,
  parseMentionMcpServers,
  pickMentionMcpServer,
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

describe("Jira/Figma MCP payload mapping", () => {
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

  it("maps Figma metadata into file and page rows", () => {
    const rows = extractFigmaRows(
      "AbCdEf",
      {
        structuredContent: {
          name: "Checkout",
          pages: [
            { id: "1:2", name: "Desktop" },
            { id: "3:4", name: "Mobile" },
          ],
        },
      },
      100,
    );
    expect(rows.map((row) => row.itemKey)).toEqual(["AbCdEf", "AbCdEf:1:2", "AbCdEf:3:4"]);
    expect(rows[0]?.figma).toEqual({
      fileKey: "AbCdEf",
      name: "Checkout",
      url: "https://www.figma.com/design/AbCdEf",
    });
    expect(rows[1]?.url).toContain("node-id=");
  });

  it("parses page rows from get_metadata XML text", () => {
    const xml = `
      <meta name="Checkout" />
      <canvas id="0:1" name="Page 1" x="0" y="0">
        <frame id="1:2" name="Hero" />
      </canvas>
      <page id="2:3" name="Mobile" />
    `;
    expect(pagesFromFigmaXml(xml)).toEqual([
      { id: "0:1", name: "Page 1" },
      { id: "2:3", name: "Mobile" },
    ]);
    const rows = extractFigmaRows("AbCdEf", { content: [{ type: "text", text: xml }] }, 50);
    expect(rows.map((row) => row.itemKey)).toEqual(["AbCdEf", "AbCdEf:0:1", "AbCdEf:2:3"]);
  });

  it("detects MCP isError tool results", () => {
    expect(mcpResultIsError({ isError: true, content: [{ type: "text", text: "nope" }] })).toBe(
      true,
    );
    expect(mcpResultIsError({ content: [{ type: "text", text: "ok" }] })).toBe(false);
  });
});
