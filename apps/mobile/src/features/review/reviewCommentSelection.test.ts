import { describe, expect, it } from "vite-plus/test";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";

import { pullRequestComposerContext } from "../../lib/composerContext";

import {
  clearReviewCommentTarget,
  completeReviewCommentRange,
  formatReviewCommentContext,
  getReviewCommentSelection,
  reviewCommentSelectionScope,
  selectReviewCommentSelection,
  setReviewCommentTarget,
  startReviewCommentRange,
  parseReviewCommentMessageSegments,
  parseReviewInlineComments,
  type ReviewCommentTarget,
} from "./reviewCommentSelection";
import { setReviewSelectedSectionId } from "./reviewState";

function makeTarget(): ReviewCommentTarget {
  return {
    sectionId: "section-1",
    sectionTitle: "Working tree",
    filePath: "apps/demo/src/main.ts",
    startIndex: 0,
    endIndex: 1,
    lines: [
      {
        kind: "line",
        id: "line-1",
        change: "delete",
        oldLineNumber: 7,
        newLineNumber: null,
        content: "const retryLimit = 2;",
        additionTokenIndex: null,
        deletionTokenIndex: 0,
        comparison: null,
      },
      {
        kind: "line",
        id: "line-2",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 7,
        content: "const retryLimit = 4;",
        additionTokenIndex: 0,
        deletionTokenIndex: null,
        comparison: null,
      },
    ],
  };
}

describe("review comment serialization", () => {
  it("excludes a linked pull request chip from draft review comments", () => {
    const record = pullRequestComposerContext(
      {
        number: 42,
        title: "Fix checkout",
        url: "https://github.com/example/repo/pull/42",
        headBranch: "fix-checkout",
        baseBranch: "main",
        state: "open",
        isDraft: false,
      },
      "pr-42",
    );

    expect(
      parseReviewInlineComments(formatComposerContextReference(record), {
        version: 1,
        records: [record],
      }),
    ).toEqual([]);
  });

  it("reads an added review comment after the composer upgrades it to a context chip", () => {
    const upgraded = upgradeLegacyContextMessage(
      formatReviewCommentContext(makeTarget(), "Please keep this configurable."),
    );
    const comments = parseReviewInlineComments(upgraded.text, {
      version: 1,
      records: upgraded.records,
    });

    expect(comments).toEqual([
      {
        id: upgraded.records[0]!.contextId,
        sectionId: "section-1",
        sectionTitle: "Working tree",
        filePath: "apps/demo/src/main.ts",
        startIndex: 0,
        endIndex: 1,
        rangeLabel: "7",
        text: "Please keep this configurable.",
        diff: "@@ -7,1 +7,1 @@\n-const retryLimit = 2;\n+const retryLimit = 4;",
        fenceLanguage: "diff",
      },
    ]);
  });

  it("keeps legacy comments and counts a typed comment only while its chip is present", () => {
    const upgraded = upgradeLegacyContextMessage(
      formatReviewCommentContext(makeTarget(), "Typed comment"),
    );
    const context = { version: 1, records: upgraded.records } as const;
    const legacy = formatReviewCommentContext(makeTarget(), "Legacy comment");
    const comments = parseReviewInlineComments(
      `${legacy}\n${upgraded.text}\n${upgraded.text}`,
      context,
    );

    expect(comments.map((comment) => comment.text)).toEqual(["Legacy comment", "Typed comment"]);
    expect(parseReviewInlineComments(legacy, context).map((comment) => comment.text)).toEqual([
      "Legacy comment",
    ]);
    expect(parseReviewInlineComments("", context)).toEqual([]);
    expect(
      parseReviewInlineComments(upgraded.text.replace("/review-comment/", "/mention/"), context),
    ).toEqual([]);
  });

  it("keeps closing-tag text inside a chip label within a real review body", () => {
    const body = "Before [</review_comment>](t3-context://v1/mention/context-1) after";
    const serialized = `<review_comment sectionId="s" filePath="app.ts" startIndex="0" endIndex="0">${body}</review_comment>`;
    const segments = parseReviewCommentMessageSegments(`${serialized} tail`);
    expect(segments).toEqual([
      { kind: "review-comment", comment: expect.objectContaining({ text: body }) },
      { kind: "text", id: `review-comment-text:${serialized.length}`, text: " tail" },
    ]);
  });

  it("treats legacy markup inside a context label as opaque text", () => {
    const text =
      '[<review_comment sectionId="s" filePath="app.ts" startIndex="0" endIndex="0">Review this</review_comment>](t3-context://v1/mention/context-1)';
    expect(parseReviewCommentMessageSegments(text)).toEqual([
      { kind: "text", id: "review-comment-text:0", text },
    ]);
  });

  it("splits chat text into review comment segments", () => {
    const serialized = `Before\n${formatReviewCommentContext(makeTarget(), "Please keep this configurable.")}\nAfter`;
    const segments = parseReviewCommentMessageSegments(serialized);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual(expect.objectContaining({ kind: "text", text: "Before\n" }));
    expect(segments[1]).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          filePath: "apps/demo/src/main.ts",
          text: "Please keep this configurable.",
          diff: expect.stringContaining("+const retryLimit = 4;"),
        }),
      }),
    );
    expect(segments[2]).toEqual(expect.objectContaining({ kind: "text", text: "\nAfter" }));
  });

  it("parses source-language review comments created by the web file viewer", () => {
    const [segment] = parseReviewCommentMessageSegments(
      [
        '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
        "Clarify this.",
        "```md",
        "# Plan",
        "- Step one",
        "```",
        "</review_comment>",
      ].join("\n"),
    );

    expect(segment).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          filePath: "docs/plan.md",
          fenceLanguage: "md",
          diff: "# Plan\n- Step one",
        }),
      }),
    );
  });

  it("keeps fenced examples in comment prose separate from the context fence", () => {
    const [segment] = parseReviewCommentMessageSegments(
      [
        '<review_comment sectionId="section-1" sectionTitle="Working tree" filePath="src/app.ts" startIndex="0" endIndex="0" rangeLabel="+1">',
        "Try this:",
        "```ts",
        "const value = 1;",
        "```",
        "Then retry.",
        "```diff",
        "@@ -0,0 +1,1 @@",
        "+one",
        "```",
        "</review_comment>",
      ].join("\n"),
    );

    expect(segment).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          text: ["Try this:", "```ts", "const value = 1;", "```", "Then retry."].join("\n"),
          diff: "@@ -0,0 +1,1 @@\n+one",
        }),
      }),
    );
  });

  it("round-trips greater-than signs in review attributes", () => {
    const serialized = formatReviewCommentContext(
      { ...makeTarget(), sectionTitle: "Changes > 5" },
      "Check this.",
    );
    const [comment] = parseReviewInlineComments(serialized);

    expect(serialized).toContain('sectionTitle="Changes &gt; 5"');
    expect(comment?.sectionTitle).toBe("Changes > 5");
  });
});

describe("review comment selection store", () => {
  const changes = { id: "git:branch-range", content: "hash-1" };
  const scope = reviewCommentSelectionScope(1, "env:thread", changes)!;
  const otherScope = reviewCommentSelectionScope(1, "env:thread", {
    id: "turn:2",
    content: "diff",
  })!;
  const target = makeTarget();
  const pending = {
    sectionId: target.sectionId,
    sectionTitle: target.sectionTitle,
    filePath: target.filePath,
    lines: target.lines,
    lineIndex: 0,
    rowId: "row-1",
  };

  it("keeps a long-pressed range start when replacing an earlier target", () => {
    setReviewCommentTarget(scope, target);
    startReviewCommentRange(scope, pending);

    expect(getReviewCommentSelection()).toEqual({ scope, target: null, pending });
  });

  it("keeps the range start after a same-line range end and drops it on a plain tap", () => {
    startReviewCommentRange(scope, pending);
    const sameLine = { ...target, startIndex: 0, endIndex: 0 };
    completeReviewCommentRange(scope, sameLine);
    expect(getReviewCommentSelection().pending).toEqual(pending);

    setReviewCommentTarget(scope, sameLine);
    expect(getReviewCommentSelection().pending).toBeNull();
  });

  it("clears the target and the range start together", () => {
    startReviewCommentRange(scope, pending);
    clearReviewCommentTarget();

    expect(getReviewCommentSelection()).toEqual({ scope: null, target: null, pending: null });
  });

  it("reads as empty from another thread or section", () => {
    setReviewCommentTarget(scope, target);

    expect(selectReviewCommentSelection(getReviewCommentSelection(), scope).target).toBe(target);
    expect(selectReviewCommentSelection(getReviewCommentSelection(), otherScope).target).toBeNull();
    expect(selectReviewCommentSelection(getReviewCommentSelection(), null).target).toBeNull();
  });

  it("reads as empty in a reopened review sheet", () => {
    setReviewCommentTarget(scope, target);
    const reopenedScope = reviewCommentSelectionScope(2, "env:thread", changes);

    expect(
      selectReviewCommentSelection(getReviewCommentSelection(), reopenedScope).target,
    ).toBeNull();
  });

  it("reads as empty when the section disappears and comes back over a different diff", () => {
    setReviewCommentTarget(scope, target);
    // The working tree went clean, so the default showed; the section later returns.
    const returned = reviewCommentSelectionScope(1, "env:thread", {
      ...changes,
      content: "hash-2",
    });
    const unchanged = reviewCommentSelectionScope(1, "env:thread", { ...changes });

    expect(selectReviewCommentSelection(getReviewCommentSelection(), returned).target).toBeNull();
    expect(selectReviewCommentSelection(getReviewCommentSelection(), unchanged).target).toBe(
      target,
    );
  });

  it("drops the selection when the section changes, so switching back starts empty", () => {
    setReviewCommentTarget(scope, target);
    setReviewSelectedSectionId("env:thread", "turn:2");
    setReviewSelectedSectionId("env:thread", "git:branch-range");

    expect(selectReviewCommentSelection(getReviewCommentSelection(), scope).target).toBeNull();
  });
});
