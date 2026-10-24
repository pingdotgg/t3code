import { describe, expect, it } from "vite-plus/test";

import { splitAssistantInsights } from "./assistantInsights.ts";

const rule = "─".repeat(20);

function fenced(body: string, wrap = ""): string {
  return [`${wrap}★ Insight ${rule}${wrap}`, body, `${wrap}${rule}${wrap}`].join("\n");
}

describe("splitAssistantInsights", () => {
  it("returns ordinary text, including a bare insight label, unchanged", () => {
    for (const text of ["A normal\nmarkdown paragraph", "★ Insight is a useful label.\r\n─────"]) {
      expect(splitAssistantInsights(text)).toEqual([{ kind: "markdown", text }]);
    }
  });

  it("extracts plain and backtick-wrapped fences into a title and body", () => {
    for (const wrap of ["", "`"]) {
      const text = [
        "Before.",
        "",
        fenced("First observation.\nSecond **observation**.", wrap),
        "",
        "After.",
      ].join("\n");
      expect(splitAssistantInsights(text)).toEqual([
        { kind: "markdown", text: "Before." },
        {
          kind: "insight",
          title: "Insight",
          body: "First observation.\nSecond **observation**.",
        },
        { kind: "markdown", text: "After." },
      ]);
    }
  });

  it("keeps fenced examples literal and still splits a real insight", () => {
    for (const marker of ["```", "~~~"]) {
      const example = [marker + "text", "★ Insight " + rule, "literal", rule, marker].join("\n");
      const text = [fenced("- Use stable keys."), "", example].join("\n");
      expect(splitAssistantInsights(text)).toEqual([
        { kind: "insight", title: "Insight", body: "- Use stable keys." },
        { kind: "markdown", text: example },
      ]);
      expect(splitAssistantInsights(example)).toEqual([{ kind: "markdown", text: example }]);
    }
  });

  it("splits several insights and holds an unfinished streaming body open", () => {
    const text = [fenced("One."), "Between.", "★ Insight " + rule, "Second"].join("\n");
    expect(splitAssistantInsights(text)).toEqual([
      { kind: "insight", title: "Insight", body: "One." },
      { kind: "markdown", text: "Between." },
      { kind: "insight", title: "Insight", body: "Second" },
    ]);
  });

  it("does not end an insight on a dash line inside its code sample", () => {
    const body = ["```", rule, "```", "After the sample."].join("\n");
    expect(splitAssistantInsights(fenced(body))).toEqual([
      { kind: "insight", title: "Insight", body },
    ]);
  });

  it("closes only on a delimiter indented like the opening fence", () => {
    const text = ["  ★ Insight " + rule, "  First.", rule, "  Second.", "  " + rule, "After."].join(
      "\n",
    );
    expect(splitAssistantInsights(text)).toEqual([
      { kind: "insight", title: "Insight", body: "First.\n" + rule + "\nSecond." },
      { kind: "markdown", text: "After." },
    ]);
  });

  it("leaves an indented code-block insight literal", () => {
    for (const indent of ["    ", "\t"]) {
      const sample = [`${indent}★ Insight ${rule}`, `${indent}literal`, `${indent}${rule}`].join(
        "\n",
      );
      expect(splitAssistantInsights(`${sample}\n\n${fenced("Real.")}`)).toEqual([
        { kind: "markdown", text: sample },
        { kind: "insight", title: "Insight", body: "Real." },
      ]);
    }
  });

  it("copies link reference definitions onto every split segment", () => {
    const definition = "[src]: https://example.com";
    const text = ["[Open][src]", "", fenced("Also [Open][src]."), "", definition].join("\n");
    expect(splitAssistantInsights(text)).toEqual([
      { kind: "markdown", text: `${definition}\n\n[Open][src]` },
      { kind: "insight", title: "Insight", body: `${definition}\n\nAlso [Open][src].` },
      { kind: "markdown", text: `${definition}\n\n${definition}` },
    ]);
    const fencedDefinition = [
      "[Open][src]",
      "",
      fenced("Body."),
      "",
      "```",
      definition,
      "```",
    ].join("\n");
    expect(splitAssistantInsights(fencedDefinition)[0]).toEqual({
      kind: "markdown",
      text: "[Open][src]",
    });
  });

  it.each(["\r\n", "\r"])("treats %j line endings like newlines", (lineEnding) => {
    const lines = ["★ Insight " + rule, "First.", rule, "After."];
    expect(splitAssistantInsights(lines.join(lineEnding))).toEqual(
      splitAssistantInsights(lines.join("\n")),
    );
  });
});
