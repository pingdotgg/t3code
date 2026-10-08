import {
  ProviderDriverKind,
  ProviderInstanceId,
  type McpServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectSkillRows,
  listMcpServerRows,
  mcpServerDraftFrom,
  mcpServerFromDraft,
  parseArgs,
  parseMcpServerJson,
  formatArgs,
} from "./toolsSettings.logic";

const provider = (
  instanceId: string,
  skills: ServerProvider["skills"],
  extra: Partial<ServerProvider> = {},
): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(instanceId),
    enabled: true,
    skills,
    ...extra,
  }) as ServerProvider;

describe("collectSkillRows", () => {
  it("merges one skill across providers and folders, grouped by its most specific location", () => {
    const rows = collectSkillRows(
      [
        provider("claudeAgent", [
          {
            name: "frontend-design",
            path: "/home/me/.claude/skills/frontend-design/SKILL.md",
            scope: "user",
            enabled: true,
          },
        ]),
        provider("codex", [
          {
            name: "frontend-design",
            path: "/home/me/.agents/skills/frontend-design/SKILL.md",
            scope: "user",
            enabled: true,
          },
          {
            name: "test-t3-app",
            path: "/work/t3/.agents/skills/test-t3-app/SKILL.md",
            scope: "repo",
            enabled: true,
          },
        ]),
        provider("cursor", [], { enabled: false }),
      ],
      null,
    );
    expect(
      rows.map((row) => [row.name, row.group, row.paths.length, row.providers.length]),
    ).toEqual([
      ["test-t3-app", "project", 1, 1],
      ["frontend-design", "personal", 2, 2],
    ]);
  });

  it("shows a skill as switched off by the provider only when every provider has it off", () => {
    const skill = (enabled: boolean) => ({
      name: "grill-me",
      path: "/home/me/.agents/skills/grill-me/SKILL.md",
      scope: "user",
      enabled,
    });
    expect(
      collectSkillRows([provider("a", [skill(false)]), provider("b", [skill(true)])], null)[0]
        ?.disabledByProvider,
    ).toBe(false);
    expect(collectSkillRows([provider("a", [skill(false)])], null)[0]?.disabledByProvider).toBe(
      true,
    );
  });
});

describe("listMcpServerRows", () => {
  const linear: McpServerConfig = {
    enabled: true,
    transport: { type: "http", url: "https://mcp.linear.app/mcp", headers: [] },
  };

  it("marks project servers, replacements and switched inherited servers", () => {
    const rows = listMcpServerRows({
      environment: { linear, sentry: linear },
      project: {
        linear: { enabled: true, transport: linear.transport },
        sentry: { enabled: false },
        gone: { enabled: false },
      },
    });
    expect(
      rows.map((row) => [row.name, row.origin, row.replacesEnvironment, row.config.enabled]),
    ).toEqual([
      ["linear", "project", true, true],
      ["sentry", "project-switch", false, false],
    ]);
  });
});

describe("MCP server drafts", () => {
  it("reads the JSON snippets vendors publish", () => {
    expect(
      parseMcpServerJson(
        JSON.stringify({
          mcpServers: {
            Supabase: {
              command: "npx",
              args: ["-y", "@supabase/mcp-server-supabase", "--project-ref=abc"],
              env: { SUPABASE_ACCESS_TOKEN: "sbp_123" },
            },
          },
        }),
      ),
    ).toMatchObject({
      name: "supabase",
      type: "stdio",
      command: "npx",
      args: "-y @supabase/mcp-server-supabase --project-ref=abc",
      env: [{ name: "SUPABASE_ACCESS_TOKEN", value: "sbp_123", sensitive: true }],
    });
    expect(
      parseMcpServerJson('{ "linear": { "url": "https://mcp.linear.app/mcp" } }'),
    ).toMatchObject({ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" });
    // OpenCode's command array.
    expect(
      parseMcpServerJson('{ "type": "local", "command": ["bunx", "my-mcp", "--flag"] }'),
    ).toMatchObject({ type: "stdio", command: "bunx", args: "my-mcp --flag" });
    expect(parseMcpServerJson("not json")).toBeNull();
    expect(parseMcpServerJson('{ "theme": "dark" }')).toBeNull();
  });

  it("round-trips quoted arguments", () => {
    const args = ["--dir", "/Users/me/My Projects", 'say "hi"', ""];
    expect(parseArgs(formatArgs(args))).toEqual(args);
  });

  it("keeps a stored secret when the user leaves its value empty", () => {
    const draft = mcpServerDraftFrom("linear", {
      enabled: true,
      transport: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: [{ name: "Authorization", value: "", sensitive: true, valueRedacted: true }],
      },
    });
    const result = mcpServerFromDraft(draft, new Set());
    expect(result).toEqual({
      ok: true,
      name: "linear",
      transport: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: [{ name: "Authorization", value: "", sensitive: true, valueRedacted: true }],
      },
    });
  });

  it("rejects T3's own name, duplicates and missing commands", () => {
    const base = {
      ...mcpServerDraftFrom("x", {
        enabled: true,
        transport: { type: "stdio", command: "npx", args: [], env: [] },
      }),
    };
    expect(mcpServerFromDraft({ ...base, name: "t3-code" }, new Set())).toMatchObject({
      ok: false,
      field: "name",
    });
    expect(mcpServerFromDraft({ ...base, name: "linear" }, new Set(["linear"]))).toMatchObject({
      ok: false,
      field: "name",
    });
    expect(mcpServerFromDraft({ ...base, name: "ok", command: " " }, new Set())).toMatchObject({
      ok: false,
      field: "command",
    });
  });
});
