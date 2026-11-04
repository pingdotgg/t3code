import { describe, expect, it } from "vite-plus/test";

import { extractFigmaRows } from "./MentionIndexFigmaSyncer.ts";
import { extractJiraRows } from "./MentionIndexJiraSyncer.ts";
import { parseMentionMcpServers, pickMentionMcpServer } from "./MentionIndexMcpClient.ts";

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
});
