import { describe, expect, it } from "vite-plus/test";

import { codexMcpAppTools } from "./codexMcpAppTools.ts";

function tool(name: string, connectorId = "connector_jira", linkId = "link_work") {
  return {
    name: `atlassian.${name}`,
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
    _meta: {
      connector_id: connectorId,
      link_id: linkId,
      _codex_apps: { resource_uri: `/${connectorId}/${linkId}/${name}` },
    },
  };
}

describe("codexMcpAppTools", () => {
  it("exposes the original names used by Jira widgets without changing provider names or hints", () => {
    const source = tool("getJiraIssue");
    const lookup = tool("getJiraIssueTypeMetaWithFields");
    expect(codexMcpAppTools([source, lookup], source.name)).toEqual([
      { ...source, appToolName: "getJiraIssue" },
      { ...lookup, appToolName: "getJiraIssueTypeMetaWithFields" },
    ]);
  });

  it("does not alias tools from another connector or connected account", () => {
    const source = tool("getJiraIssue");
    const otherApp = tool("search", "connector_other");
    const otherAccount = tool("search", "connector_jira", "link_personal");
    expect(codexMcpAppTools([source, otherApp, otherAccount], source.name)).toEqual([
      { ...source, appToolName: "getJiraIssue" },
      otherApp,
      otherAccount,
    ]);
  });

  it("leaves ordinary MCP tools and unknown source tools unchanged", () => {
    const ordinary = { name: "get_weather" };
    const tools = [ordinary, tool("getJiraIssue")];
    expect(codexMcpAppTools(tools, ordinary.name)).toEqual(tools);
    expect(codexMcpAppTools(tools, "missing")).toEqual(tools);
  });

  it("does not infer app tool names from missing or inconsistent resource metadata", () => {
    const source = tool("getJiraIssue");
    const lookup = tool("search");
    const malformed = [
      { ...lookup, _meta: {} },
      { ...lookup, _meta: { ...lookup._meta, link_id: null } },
      ...[
        "/connector_other/link_work/search",
        "/connector_jira/link_personal/search",
        "/connector_jira/link_work/",
        "/connector_jira/link_work/search/extra",
      ].map((uri) => ({
        ...lookup,
        _meta: { ...lookup._meta, _codex_apps: { resource_uri: uri } },
      })),
    ];
    expect(codexMcpAppTools([source, ...malformed], source.name)).toEqual([
      { ...source, appToolName: "getJiraIssue" },
      ...malformed,
    ]);
  });
});
