import { contextReportFromUsage, parseContextReport } from "@t3tools/shared/contextReport";
import { act, useState } from "react";
import { create, type ReactTestRendererNode } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { ContextReportCard, ContextReportDisclosure } from "./ContextReportCard";

const REPORT = `## Context Usage

**Model:** claude-sonnet-5
**Tokens:** 79.5k / 200k (40%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 4.8k | 2.4% |
| Messages | 4.6k | 2.3% |
| Free space | 87.5k | 43.7% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__github__add_issue_comment | github | 81 |
| mcp__github__create_branch | github | 1.1k |
`;

function textOf(renderer: ReturnType<typeof create>): string {
  const walk = (node: ReactTestRendererNode | ReactTestRendererNode[] | null): string =>
    node === null
      ? ""
      : Array.isArray(node)
        ? node.map(walk).join("")
        : typeof node === "string"
          ? node
          : `${node.props["aria-valuenow"] === undefined ? "" : `[${node.props["aria-valuenow"]}]`}${walk(node.children)}`;
  return walk(renderer.toJSON());
}

describe("ContextReportCard", () => {
  it("shows the bar and categories, and expands a section to its rows", () => {
    const report = parseContextReport(REPORT)!;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<ContextReportCard report={report} />);
    });

    expect(textOf(renderer)).toContain("[40]");
    expect(textOf(renderer)).toContain("System prompt");
    expect(textOf(renderer)).toContain("MCP Tools");
    expect(textOf(renderer)).toContain("1.2k · 2");
    expect(textOf(renderer)).not.toContain("mcp__github__add_issue_comment");

    const section = renderer.root.findByProps({ "aria-expanded": false });
    act(() => section.props.onClick());
    expect(textOf(renderer)).toContain("mcp__github__add_issue_comment");
  });

  it("shows usage-only reports with exact counts behind collapsed sections", () => {
    const report = contextReportFromUsage(
      { usedTokens: 64_600, maxTokens: 258_400, inputTokens: 60_000, outputTokens: 4_600 },
      "gpt-6.1-sol",
    )!;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<ContextReportCard report={report} />);
    });

    expect(textOf(renderer)).toContain("[25]Used context65k25%Free space194k75%");
    expect(textOf(renderer)).toContain("Exact token counts3Reported usage2");
    expect(textOf(renderer)).not.toContain("193,800");

    const [exact, reported] = renderer.root.findAllByProps({ "aria-expanded": false });
    act(() => exact!.props.onClick());
    expect(textOf(renderer)).toContain("Used context64,600Free space193,800Context window258,400");
    act(() => reported!.props.onClick());
    expect(textOf(renderer)).toContain("CounterTokensInput60,000Output4,600");
    act(() => exact!.props.onClick());
    expect(textOf(renderer)).not.toContain("193,800");
  });

  it("renders repeated columns and rows without key warnings", () => {
    const report = parseContextReport(`## Context Usage
**Tokens:** 1k / 200k (0.5%)
### Skills
| Name | Name | Tokens |
|---|---|---|
| review | review | 40 |
| review | review | 40 |
`)!;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<ContextReportCard report={report} />);
    });
    const section = renderer.root.findByProps({ "aria-expanded": false });
    act(() => section.props.onClick());

    expect(renderer.root.findAllByType("th").map((cell) => cell.children)).toEqual([
      ["Name"],
      ["Name"],
      ["Tokens"],
    ]);
    expect(renderer.root.findAllByType("td").map((cell) => cell.children[0])).toEqual([
      "review",
      "review",
      "40",
      "review",
      "review",
      "40",
    ]);
    expect(consoleError.mock.calls.flat().join("\n")).not.toContain("same key");
    consoleError.mockRestore();
  });

  it("keeps the full report reachable from a collapsed timeline row", () => {
    const report = parseContextReport(REPORT)!;
    function Report() {
      const [expanded, setExpanded] = useState(false);
      return (
        <ContextReportDisclosure
          report={report}
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
        />
      );
    }
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<Report />);
    });

    expect(textOf(renderer)).toContain("claude-sonnet-5 · 79.5k / 200k (40%)");
    expect(textOf(renderer)).not.toContain("System prompt");

    const toggle = renderer.root.findByProps({ "aria-expanded": false });
    act(() => toggle.props.onClick());
    expect(textOf(renderer)).toContain("System prompt");
    expect(textOf(renderer)).toContain("MCP Tools");
  });
});
