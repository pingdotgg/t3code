import { describe, expect, it } from "@effect/vitest";

import { openUiGuide, openUiPage, openUiProblems } from "./openUi.ts";

const card = (...lines: ReadonlyArray<string>) => lines.join("\n");

describe("OpenUI programs", () => {
  it("accepts the example the guide teaches", () => {
    const example = openUiGuide.slice(
      openUiGuide.indexOf("root = Card([header"),
      openUiGuide.indexOf("\n\nComponents:"),
    );
    expect(example).toContain("jobs = Table(");
    expect(openUiProblems(example)).toEqual([]);
  });

  it("does not offer components that need an answer from the reader", () => {
    expect(openUiGuide).not.toMatch(/\b(?:Form|Buttons?|FollowUpBlock|EditableTable)\b/);
    expect(openUiProblems(card("root = Card([go])", 'go = Buttons([Button("Go")])'))).toContain(
      "go: Buttons is not an available component.",
    );
  });

  it("refuses cited sources, whose icons the renderer fetches from Google", () => {
    const program = card(
      'root = Card([note], [{title: "A", sourceName: "B", url: "https://example.com"}])',
      'note = TextContent("a [1]")',
    );
    expect(openUiProblems(program).join(" ")).toContain("excess dropped");
  });

  it.each([
    ["a missing definition", "root = Card([chart])", "Used but never defined: chart."],
    [
      "an unused definition",
      card('root = Card([TextContent("a")])', 'extra = TextContent("b")'),
      "Defined but not reachable from root: extra.",
    ],
    ["a cut-off program", 'root = Card([TextContent("a"', "The program ends in the middle"],
    ["a missing argument", "root = Card([CodeBlock()])", "CodeBlock"],
    ["plain prose", "Here is your chart.", "root = Card"],
  ])("reports %s", (_, program, expected) => {
    expect(openUiProblems(program).join(" ")).toContain(expected);
  });

  it("builds a page whose program survives the script element", () => {
    const program = String.raw`root = Card([CodeBlock("html", "</script><!-- <\/p> --> <\\!")])`;
    const page = openUiPage(program, {
      script: "/*renderer*/",
      styles: ".a{height:100dvh;max-height:50vh;width:90vw}",
    });
    const stored = /<script type="text\/openui" id="openui-program">([\s\S]*?)<\/script>/.exec(
      page,
    )![1]!;
    expect(stored).not.toMatch(/<[/!]/);
    expect(stored.replace(/<\\(\\*)([/!])/g, "<$1$2")).toBe(program);
    expect(page).toContain(".a{height:600px;max-height:300px;width:90vw}");
  });
});
