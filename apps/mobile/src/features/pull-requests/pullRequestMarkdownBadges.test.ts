import { describe, expect, it } from "vite-plus/test";
import { markdownTaskMarkerOffset, setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskList";
import { parseMarkdownDocument } from "../../lib/markdownDocument";
import { inlinePullRequestBadges, pullRequestMarkdownSegments } from "./pullRequestMarkdownBadges";

describe("pull request badge rendering", () => {
  it("keeps the priority and title visible without a leading block-image reservation", () => {
    const source =
      "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Check the return before recording the print**\n\nThe review details follow.";
    const result = inlinePullRequestBadges(source);
    expect(result).toBe(
      "**P1  Check the return before recording the print**\n\nThe review details follow.",
    );
    expect(parseMarkdownDocument(result).children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "strong", children: [{ type: "text" }] }],
    });
  });

  it("keeps media comparisons grouped when another image triggers badge normalization", () => {
    const segments = pullRequestMarkdownSegments(
      "![P1 Badge](https://img.shields.io/badge/P1-orange)\n\n" +
        "<table><tr><th>Before</th><th>After</th></tr><tr><td>\n\nhttps://drop.example.com/before.mp4\n\n</td><td>\n\nhttps://drop.example.com/after.mp4\n\n</td></tr></table>",
    );
    expect(segments[0]).toMatchObject({ kind: "markdown", text: "P1" });
    expect(segments[1]).toMatchObject({
      kind: "table",
      rows: [
        [
          { segments: [{ kind: "markdown", text: "Before" }] },
          { segments: [{ kind: "markdown", text: "After" }] },
        ],
        [
          { segments: [{ kind: "attachment", url: "https://drop.example.com/before.mp4" }] },
          { segments: [{ kind: "attachment", url: "https://drop.example.com/after.mp4" }] },
        ],
      ],
    });
  });

  it("keeps real screenshots while replacing HTML and reference-style status badges", () => {
    const windowsLink = String.raw`[Source](C:\work\src\file.ts)` + "\n\n";
    const result = inlinePullRequestBadges(
      windowsLink +
        '<img src="https://www.gstatic.com/codereviewagent/high-priority.svg" alt="High priority">\n\n![Build][status]\n\n![Before](https://cursor.com/artifacts/before.png)\n\n[status]: https://img.shields.io/badge/build-passing-green',
    );
    expect(result).toContain(windowsLink + "High priority\n\nBuild");
    expect(result).toContain("![Before](https://cursor.com/artifacts/before.png)");
    expect(result).not.toContain("![Build][status]");
  });

  it("does not rewrite badge syntax inside code examples", () => {
    const source =
      "`![P1 Badge](https://img.shields.io/badge/P1-orange)`\n\n```md\n![Build](https://img.shields.io/badge/build-passing)\n```";
    expect(inlinePullRequestBadges(source)).toBe(source);
  });

  it("maps task taps back through badge and HTML replacements to the original body", () => {
    for (const badge of [
      "![Build](https://img.shields.io/badge/build-passing)",
      '<img src="https://www.gstatic.com/codereviewagent/high-priority.svg" alt="High priority">',
      "**<sub>![P1 Badge](https://img.shields.io/badge/P1-orange)</sub>**",
    ]) {
      const source = `${badge}\n\n- [ ] First\n- [ ] Second`;
      const segment = pullRequestMarkdownSegments(source)[0]!;
      if (segment.kind !== "markdown") throw new Error("Expected markdown");
      const offset = markdownTaskMarkerOffset(segment.text, 1, "Second", true)!;
      const originalOffset =
        segment.sourceOffset +
        ("sourceOffsetAt" in segment ? segment.sourceOffsetAt(offset)! : offset);
      expect(setMarkdownTaskChecked(source, originalOffset, true)).toBe(
        source.replace("[ ] Second", "[x] Second"),
      );
    }
  });

  it("keeps status text literal rather than introducing Markdown formatting", () => {
    expect(inlinePullRequestBadges("![Build_*](https://img.shields.io/badge/build-passing)")).toBe(
      "Build\\_\\*",
    );
  });
});
