import { describe, expect, it } from "vite-plus/test";
import { parseMarkdownDocument } from "../../lib/markdownDocument";
import { inlinePullRequestBadges } from "./pullRequestMarkdownBadges";

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

  it("keeps real screenshots while replacing HTML and reference-style status badges", () => {
    const result = inlinePullRequestBadges(
      '<img src="https://www.gstatic.com/codereviewagent/high-priority.svg" alt="High priority">\n\n![Build][status]\n\n![Before](https://cursor.com/artifacts/before.png)\n\n[status]: https://img.shields.io/badge/build-passing-green',
    );
    expect(result).toContain("High priority\n\nBuild");
    expect(result).toContain("![Before](https://cursor.com/artifacts/before.png)");
    expect(result).not.toContain("![Build][status]");
  });

  it("does not rewrite badge syntax inside code examples", () => {
    const source =
      "`![P1 Badge](https://img.shields.io/badge/P1-orange)`\n\n```md\n![Build](https://img.shields.io/badge/build-passing)\n```";
    expect(inlinePullRequestBadges(source)).toBe(source);
  });

  it("keeps status text literal rather than introducing Markdown formatting", () => {
    expect(inlinePullRequestBadges("![Build_*](https://img.shields.io/badge/build-passing)")).toBe(
      "Build\\_\\*",
    );
  });
});
