import { describe, expect, it } from "vite-plus/test";

import {
  claudeContextUsedCategories,
  formatClaudeContextHeadline,
  formatClaudeContextTokens,
  latestClaudeContextReport,
  parseClaudeContextReport,
  parseClaudeContextTokens,
} from "./claudeContextReport.ts";

const REPORT = `## Context Usage

**Model:** claude-sonnet-5
**Tokens:** 79.5k / 200k (40%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 4.8k | 2.4% |
| System tools | 29.5k | 14.7% |
| MCP tools | 31.4k | 15.7% |
| Custom agents | 485 | 0.2% |
| Memory files | 6.5k | 3.2% |
| Skills | 2.3k | 1.1% |
| Messages | 4.6k | 2.3% |
| Free space | 87.5k | 43.7% |
| Autocompact buffer | 33k | 16.5% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__context7__query-docs | context7 | 665 |
| mcp__context7__resolve-library-id | context7 | 1.1k |
| mcp__github__add_issue_comment | github | 81 |

### Custom Agents

| Agent Type | Source | Tokens |
|------------|--------|--------|
| caveman:cavecrew-builder | Plugin | 134 |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| User | /root/.claude/CLAUDE.md | 6.5k |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| adhd | User | < 20 |
| dataviz | Built-in | ~380 |
`;

describe("parseClaudeContextReport", () => {
  it("parses the real /context report", () => {
    const report = parseClaudeContextReport(REPORT);
    expect(report).toMatchObject({
      model: "claude-sonnet-5",
      usedTokens: "79.5k",
      maxTokens: "200k",
      usedPercent: 40,
      overLimit: null,
    });
    expect(report!.categories.map((category) => category.name)).toEqual([
      "System prompt",
      "System tools",
      "MCP tools",
      "Custom agents",
      "Memory files",
      "Skills",
      "Messages",
      "Free space",
      "Autocompact buffer",
    ]);
    expect(report!.categories[0]).toEqual({ name: "System prompt", tokens: "4.8k", percent: 2.4 });
    expect(claudeContextUsedCategories(report!).map((category) => category.name)).toEqual([
      "System prompt",
      "System tools",
      "MCP tools",
      "Custom agents",
      "Memory files",
      "Skills",
      "Messages",
    ]);
    expect(report!.sections.map((section) => [section.title, section.rows.length])).toEqual([
      ["MCP Tools", 3],
      ["Custom Agents", 1],
      ["Memory Files", 1],
      ["Skills", 2],
    ]);
    const tools = report!.sections[0]!;
    expect(tools.columns).toEqual(["Tool", "Server", "Tokens"]);
    expect(tools.rows[1]).toEqual(["mcp__context7__resolve-library-id", "context7", "1.1k"]);
    expect(tools.totalTokens).toBe(665 + 1_100 + 81);
    expect(report!.sections[3]!.totalTokens).toBe(20 + 380);
  });

  it("keeps a new table section with unknown columns", () => {
    const report = parseClaudeContextReport(
      `${REPORT}\n### Plugins\n\n| Plugin | Size | Notes |\n|---|---|---|\n| foo | 1.2k | new column |\n`,
    );
    expect(report!.sections.at(-1)).toEqual({
      title: "Plugins",
      columns: ["Plugin", "Size", "Notes"],
      rows: [["foo", "1.2k", "new column"]],
      totalTokens: null,
    });
  });

  it("accepts leading whitespace before the heading", () => {
    expect(parseClaudeContextReport(`\n  ${REPORT}`)).not.toBeNull();
  });

  it("reads the over-limit line", () => {
    const report = parseClaudeContextReport(
      "## Context Usage\n\n**Model:** opus  \n**Tokens:** 210k / 200k (105%)\n**Over limit:** 10k tokens over!\n",
    );
    expect(report).toMatchObject({
      overLimit: "10k tokens over!",
      usedPercent: 105,
      categories: [],
      sections: [],
    });
  });

  it.each([
    ["empty", ""],
    ["other heading", "## Something else\n\n**Tokens:** 1k / 2k (50%)"],
    ["prose before heading", `Here it is:\n${REPORT}`],
    ["heading mid-line", `Here is my ${REPORT}`],
    ["prose in preamble", REPORT.replace("**Model:**", "Note\n**Model:**")],
    ["prose after a table", `${REPORT}\nSome trailing note\n`],
    ["section without table", `${REPORT}\n### Notes\n\nfree text\n`],
    ["row width differs from header", REPORT.replace("| adhd | User | < 20 |", "| adhd | < 20 |")],
    ["escaped pipe in a cell", REPORT.replace("| adhd |", "| a\\|dhd |")],
    ["missing tokens line", REPORT.replace(/^\*\*Tokens:\*\*.*$/mu, "")],
    ["tokens without percent", REPORT.replace("(40%)", "")],
    ["non-numeric tokens", REPORT.replace("79.5k / 200k", "lots / some")],
    ["zero max tokens", REPORT.replace("79.5k / 200k", "0 / 0")],
    ["category with unreadable percent", REPORT.replace("| 4.8k | 2.4% |", "| 4.8k | n/a |")],
    [
      "duplicate category table",
      `${REPORT}\n### Estimated usage by category\n\n| A | B | C |\n|-|-|-|\n`,
    ],
  ])("returns null for %s", (_label, text) => {
    expect(parseClaudeContextReport(text)).toBeNull();
  });
});

describe("latestClaudeContextReport", () => {
  const message = (id: string, text: string, role = "assistant", streaming = false) => ({
    id,
    role,
    text,
    streaming,
  });

  it("returns the newest settled assistant report and skips the rest", () => {
    const latest = latestClaudeContextReport([
      message("m1", REPORT),
      message("m2", "plain answer"),
      message("m3", REPORT.replace("79.5k", "90k")),
      message("m4", REPORT, "reasoning"),
      message("m5", REPORT, "assistant", true),
    ]);
    expect(latest?.id).toBe("m3");
    expect(formatClaudeContextHeadline(latest!.report)).toBe("90k / 200k (40%)");
  });

  it("drops the report once the user sends another message", () => {
    expect(
      latestClaudeContextReport([message("m1", REPORT), message("m2", "next task", "user")]),
    ).toBeNull();
  });

  it("returns null without a parseable report", () => {
    expect(latestClaudeContextReport([message("m1", "## Context Usage\nbroken")])).toBeNull();
  });
});

describe("token labels", () => {
  it.each([
    ["4.8k", 4_800],
    ["1m", 1_000_000],
    ["485", 485],
    ["~120", 120],
    ["< 20", 20],
    ["1,234", 1_234],
    ["n/a", null],
    ["", null],
  ])("parses %j as %j", (label, expected) => {
    expect(parseClaudeContextTokens(label)).toBe(expected);
  });

  it.each([
    [485, "485"],
    [4_800, "4.8k"],
    [31_400, "31k"],
    [1_000_000, "1m"],
    [1_250_000, "1.3m"],
  ])("formats %d as %j", (value, expected) => {
    expect(formatClaudeContextTokens(value)).toBe(expected);
  });
});
