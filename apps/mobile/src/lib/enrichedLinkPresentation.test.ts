import { describe, expect, it } from "vite-plus/test";
import type { ComposerContextId, ReviewCommentContextRecord } from "@t3tools/contracts";
import {
  enrichedContextLinkPresentation,
  enrichedLinkVariantPattern,
  enrichedSkillLinkRegex,
  ENRICHED_INLINE_FILE_LINK_REGEX,
} from "./enrichedLinkPresentation";

describe("Enriched link presentation", () => {
  it("recognizes file-shaped code without turning commands or URLs into links", () => {
    for (const path of [
      "src/app.tsx",
      "./README.md",
      "/tmp/report.md",
      "C:\\repo\\app.tsx",
      "app.tsx:12:3",
    ]) {
      expect(ENRICHED_INLINE_FILE_LINK_REGEX.test(path), path).toBe(true);
    }
    for (const text of [
      "npm run dev",
      "port:3000",
      "TODO:12",
      "example.com",
      "https://example.com/app.tsx",
      "x + y",
      "README.md",
      "/app/settings",
    ]) {
      expect(ENRICHED_INLINE_FILE_LINK_REGEX.test(text), text).toBe(false);
    }
  });

  it("only recognizes complete known skill names and escapes their punctuation", () => {
    const regex = enrichedSkillLinkRegex([{ name: "check" }, { name: "check.mobile" }]);
    expect(regex?.exec("Try $check.mobile next")?.[0]).toBe("$check.mobile");
    expect(regex?.exec("Try $check-mobile next")).toBeNull();
    expect(regex?.exec("Try $checkXmobile next")).toBeNull();
    expect(regex?.exec("prefix$check next")).toBeNull();
    expect(enrichedSkillLinkRegex([])).toBeNull();
  });
  it("matches only the complete URL, including literal regex metacharacters", () => {
    const url = "file:///workspace/app[1].tsx?line=3+4";
    const pattern = new RegExp(enrichedLinkVariantPattern(url));
    expect(pattern.test(url)).toBe(true);
    expect(pattern.test(`${url}/child`)).toBe(false);
    expect(pattern.test("file:///workspace/app1Xtsx?line=34")).toBe(false);
  });

  it("uses context identity for PR status even when labels are identical", () => {
    const record: ReviewCommentContextRecord = {
      version: 1,
      contextId: "review_1" as ComposerContextId,
      kind: "review-comment",
      label: "Review",
      sectionId: "pull-request:7",
      sectionTitle: "Review",
      filePath: "app.tsx",
      startIndex: 0,
      endIndex: 1,
      rangeLabel: "line 1",
      text: "Comment",
      diff: "",
      pullRequest: {
        number: 7,
        title: "Review",
        url: "https://github.com/example/repo/pull/7",
        headBranch: "feature",
        baseBranch: "main",
        state: "merged",
        isDraft: false,
      },
    };
    expect(
      enrichedContextLinkPresentation("t3-context://v1/review-comment/review_1", [record]),
    ).toEqual({ color: "#8a70dd", icon: "git" });
    expect(
      enrichedContextLinkPresentation("t3-context://v1/review-comment/review_2", [record]),
    ).toEqual({ color: "#8a70dd", icon: "markdown" });
  });

  it("retains recognizable presentation for unavailable and future context kinds", () => {
    expect(enrichedContextLinkPresentation("t3-context://v1/terminal/missing")).toEqual({
      color: "#009f6e",
      icon: "bash",
    });
    expect(enrichedContextLinkPresentation("t3-context://v1/skill/missing")).toEqual({
      color: "#b261be",
      icon: "mcp",
    });
    expect(enrichedContextLinkPresentation("t3-context://v1/future/missing")).toEqual({
      color: "#0090cd",
      icon: "default",
    });
    expect(enrichedContextLinkPresentation("https://example.com/terminal/missing")).toBeUndefined();
  });
});
