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
  skillAgents,
  skillAttention,
  skillAvailability,
  skillBody,
  skillRowDetails,
  splitRowsBySource,
  type SkillRow,
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
          // A repository folder that happens to be called `plugins`.
          {
            name: "release",
            path: "/work/t3/packages/plugins/.agents/skills/release/SKILL.md",
            scope: "repo",
            enabled: true,
          },
          // A plugin skill the provider reports with no scope.
          {
            name: "docs",
            path: "/home/me/.claude/plugins/cache/acme/docs/skills/docs/SKILL.md",
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
      ["release", "project", 1, 1],
      ["test-t3-app", "project", 1, 1],
      ["frontend-design", "personal", 2, 2],
      ["docs", "plugin", 1, 1],
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

describe("skill row details", () => {
  const row = (paths: ReadonlyArray<string>): SkillRow => ({
    name: "review",
    description: undefined,
    group: "personal",
    paths,
    providers: [],
    disabledByProvider: false,
  });
  const folder = (path: string, folderPath: string, hash: string, scripts = false) => ({
    path,
    folder: folderPath,
    hash,
    files: [],
    filesTruncated: false,
    scripts,
  });

  it("flags a conflict only when two folders hold different text", () => {
    const linked = new Map([
      // Claude reaches the same folder through its link.
      [
        "/h/.claude/skills/review/SKILL.md",
        folder("/h/.claude/skills/review/SKILL.md", "/h/.agents/skills/review", "a"),
      ],
      [
        "/h/.agents/skills/review/SKILL.md",
        folder("/h/.agents/skills/review/SKILL.md", "/h/.agents/skills/review", "a"),
      ],
    ]);
    expect(skillRowDetails(row([...linked.keys()]), linked).conflict).toBe(false);

    const copies = new Map([
      [
        "/h/.claude/skills/review/SKILL.md",
        folder("/h/.claude/skills/review/SKILL.md", "/h/.claude/skills/review", "a"),
      ],
      [
        "/p/.agents/skills/review/SKILL.md",
        folder("/p/.agents/skills/review/SKILL.md", "/p/.agents/skills/review", "b", true),
      ],
    ]);
    const details = skillRowDetails(row([...copies.keys()]), copies);
    expect(details.conflict).toBe(true);
    expect(details.scripts).toBe(true);
  });

  it("knows nothing about a row whose folders weren't inspected", () => {
    expect(skillRowDetails(row(["/x/SKILL.md"]), new Map())).toEqual({
      folder: null,
      copies: [],
      scripts: false,
      conflict: false,
      installed: null,
    });
  });

  it("splits rows by source, unsourced first, then by source name", () => {
    const rows = [
      { name: "tdd", source: "mattpocock/skills" },
      { name: "mine", source: null },
      { name: "deploy", source: "acme/tools" },
      { name: "grill-me", source: "mattpocock/skills" },
    ];
    expect(
      splitRowsBySource(rows, (entry) => entry.source).map((group) => [
        group.source,
        group.rows.map((entry) => entry.name),
      ]),
    ).toEqual([
      [null, ["mine"]],
      ["acme/tools", ["deploy"]],
      ["mattpocock/skills", ["tdd", "grill-me"]],
    ]);
  });
});

describe("skill availability and attention", () => {
  const agents = skillAgents([
    provider("claudeAgent", [], { displayName: "Claude" }),
    provider("codex", [], { displayName: "Codex" }),
    provider("cursor", [], { displayName: "Cursor", enabled: false }),
  ]);
  const ref = (instanceId: string) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(instanceId),
    displayName: instanceId,
  });
  const row = (group: SkillRow["group"], providers: ReadonlyArray<string>): SkillRow => ({
    name: "review",
    description: undefined,
    group,
    paths: [],
    providers: providers.map(ref),
    disabledByProvider: false,
  });
  const noDetails = skillRowDetails(row("personal", []), new Map());

  it("counts only enabled agents, and says when every one loads a skill", () => {
    expect(agents.map((agent) => agent.displayName)).toEqual(["Claude", "Codex"]);
    expect(skillAvailability(row("personal", ["claudeAgent", "codex"]), agents).everyone).toBe(
      true,
    );
    const partial = skillAvailability(row("personal", ["codex"]), agents);
    expect([partial.everyone, partial.missing.map((agent) => agent.displayName)]).toEqual([
      false,
      ["Claude"],
    ]);
  });

  it("flags a skill some agents miss, but not a plugin or built-in one", () => {
    expect(skillAttention(row("personal", ["codex"]), noDetails, agents)?.detail).toBe(
      "Not available to Claude.",
    );
    expect(skillAttention(row("plugin", ["codex"]), noDetails, agents)).toBeNull();
    expect(skillAttention(row("system", ["codex"]), noDetails, agents)).toBeNull();
    expect(skillAttention(row("project", ["claudeAgent", "codex"]), noDetails, agents)).toBeNull();
  });

  it("strips SKILL.md's header for the rendered view", () => {
    expect(skillBody("---\nname: review\n---\n\n# Review\nBody")).toBe("# Review\nBody");
    expect(skillBody("# No header")).toBe("# No header");
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

  it("tells the server where a renamed server's stored secret lives", () => {
    const draft = mcpServerDraftFrom("linear", {
      enabled: true,
      transport: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: [{ name: "Authorization", value: "", sensitive: true, valueRedacted: true }],
      },
    });
    const renamed = {
      ...draft,
      name: "linear-work",
      headers: draft.headers.map((header) => ({ ...header, name: "X-Api-Key" })),
    };
    const result = mcpServerFromDraft(renamed, new Set(), "linear");
    expect(result.ok && result.transport.type === "http" && result.transport.headers).toEqual([
      {
        name: "X-Api-Key",
        value: "",
        sensitive: true,
        valueRedacted: true,
        storedAs: { server: "linear", variable: "Authorization" },
      },
    ]);
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
