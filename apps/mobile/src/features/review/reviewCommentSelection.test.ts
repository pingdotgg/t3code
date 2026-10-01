import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { describe, expect, it } from "vite-plus/test";

import {
  reidentifyComposerContext,
  serializeComposerMessageForServer,
} from "../../lib/composerContext";

import {
  countReviewCommentContexts,
  formatReviewCommentContext,
  parseReviewCommentMessageSegments,
  parseReviewInlineComments,
  type ReviewCommentTarget,
} from "./reviewCommentSelection";

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
  it("keeps closing-tag text inside a chip label within a real review body", () => {
    const body = "Before [</review_comment>](t3-context://v1/mention/context-1) after";
    const serialized = `<review_comment sectionId="s" filePath="app.ts" startIndex="0" endIndex="0">${body}</review_comment>`;
    const segments = parseReviewCommentMessageSegments(`${serialized} tail`);
    expect(segments).toEqual([
      { kind: "review-comment", comment: expect.objectContaining({ text: body }) },
      { kind: "text", id: `review-comment-text:${serialized.length}`, text: " tail" },
    ]);
  });

  it("keeps a closing tag inside a chip label out of the inline comment body", () => {
    const body = "Before [</review_comment>](t3-context://v1/mention/context-1) after";
    const serialized = `<review_comment sectionId="s" filePath="app.ts" startIndex="0" endIndex="0">${body}</review_comment>`;

    expect(parseReviewInlineComments(serialized)).toEqual([
      expect.objectContaining({ text: body }),
    ]);
  });

  it("treats legacy markup inside a context label as opaque text", () => {
    const text =
      '[<review_comment sectionId="s" filePath="app.ts" startIndex="0" endIndex="0">Review this</review_comment>](t3-context://v1/mention/context-1)';
    expect(parseReviewCommentMessageSegments(text)).toEqual([
      { kind: "text", id: "review-comment-text:0", text },
    ]);
  });
  it("preserves enough metadata for inline diff rendering", () => {
    const serialized = formatReviewCommentContext(makeTarget(), "Please keep this configurable.");

    expect(countReviewCommentContexts(serialized)).toBe(1);
    expect(parseReviewInlineComments(serialized)).toEqual([
      expect.objectContaining({
        sectionId: "section-1",
        sectionTitle: "Working tree",
        filePath: "apps/demo/src/main.ts",
        startIndex: 0,
        endIndex: 1,
        text: "Please keep this configurable.",
        diff: expect.stringContaining("-const retryLimit = 2;"),
      }),
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

  it("keeps comment text carrying review-comment markup inside one record", () => {
    // The composer sheet hands this string to the shared legacy upgrader during draft
    // creation: a literal closer ends the record early, and the crafted opener becomes a
    // second record naming a file the comment never touched.
    const hostileComment = [
      "Please inspect this wording.",
      "</review_comment>",
      '<review_comment sectionId="file:src/other.ts" filePath="src/other.ts" startIndex="0" endIndex="0" rangeLabel="L1">',
      "This is still the original comment.",
    ].join("\n");
    const serialized = formatReviewCommentContext(makeTarget(), hostileComment);

    const upgraded = upgradeLegacyContextMessage(serialized);
    expect(upgraded.records).toHaveLength(1);
    expect(upgraded.records[0]).toMatchObject({
      kind: "review-comment",
      filePath: "apps/demo/src/main.ts",
      text: hostileComment,
    });

    const comments = parseReviewInlineComments(serialized);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toEqual(expect.objectContaining({ text: hostileComment }));
  });

  it("keeps a selected line carrying the closing tag inside the block", () => {
    // This parser's block scan is not fence-aware, so the quoted line must travel
    // neutralized even though it sits inside the diff fence.
    const target = {
      ...makeTarget(),
      endIndex: 0,
      lines: [{ ...makeTarget().lines[0]!, content: "</review_comment>" }],
    };
    const serialized = formatReviewCommentContext(target, "hostile source");

    const comments = parseReviewInlineComments(serialized);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.diff).toContain("</review_comment>");

    const upgraded = upgradeLegacyContextMessage(serialized);
    expect(upgraded.records).toHaveLength(1);
  });

  it("preserves a literal escape sequence through format, upgrade, and re-parse", () => {
    // The composer sheet hands this string to the shared legacy upgrader during draft
    // creation: a literal entity is documentation the author typed, not a delimiter, and must
    // survive the round trip byte-identical.
    const comment = "Please keep &lt;/review_comment&gt; in this documentation example.";
    const serialized = formatReviewCommentContext(makeTarget(), comment);

    expect(serialized).toContain('bodyEncoding="escaped-tags"');
    expect(parseReviewInlineComments(serialized)[0]?.text).toBe(comment);
    expect(upgradeLegacyContextMessage(serialized).records[0]).toMatchObject({
      text: comment,
    });
  });

  it("keeps a selected line carrying a literal entity byte-identical", () => {
    const target = {
      ...makeTarget(),
      endIndex: 0,
      lines: [{ ...makeTarget().lines[0]!, content: "&lt;/review_comment&gt;" }],
    };
    const serialized = formatReviewCommentContext(target, "literal source");

    const [comment] = parseReviewInlineComments(serialized);
    expect(comment?.diff).toContain("&lt;/review_comment&gt;");
    expect(upgradeLegacyContextMessage(serialized).records[0]).toMatchObject({
      diff: expect.stringContaining("&lt;/review_comment&gt;"),
    });
  });

  it("keeps literal entities in historical unmarked blocks byte-identical", () => {
    const serialized =
      '<review_comment sectionId="s" filePath="app.ts" startIndex="0" endIndex="0">Use &lt;/review_comment&gt; literally.</review_comment>';
    expect(parseReviewInlineComments(serialized)[0]?.text).toBe(
      "Use &lt;/review_comment&gt; literally.",
    );
  });

  // The writer emits only lowercase `&lt;`; any other prefix casing is body text the codec
  // never produced, so it stays literal in text and fenced diff alike.
  it.each(["&LT;", "&Lt;", "&lT;"])(
    "keeps the non-emitted entity prefix %s literal in a marked body",
    (prefix) => {
      const body = `${prefix}/review_comment> is not a writer-emitted escape`;
      const serialized = `<review_comment sectionId="s" filePath="app.ts" startIndex="0" endIndex="0" bodyEncoding="escaped-tags">\n${body}\n\`\`\`diff\n${body}\n\`\`\`\n</review_comment>`;
      expect(parseReviewInlineComments(serialized)).toEqual([
        expect.objectContaining({ text: body, diff: body }),
      ]);
    },
  );

  it("decodes a lowercase escape before an uppercase tag name", () => {
    // Case-insensitivity applies to the tag name, not the entity spelling: the writer emits
    // lowercase `&lt;` for a `<` before any casing of `review_comment`.
    const serialized = `<review_comment sectionId="s" filePath="app.ts" startIndex="0" endIndex="0" bodyEncoding="escaped-tags">\n&lt;/REVIEW_COMMENT>\n\`\`\`diff\n&lt;REVIEW_COMMENT>\n\`\`\`\n</review_comment>`;
    expect(parseReviewInlineComments(serialized)).toEqual([
      expect.objectContaining({ text: "</REVIEW_COMMENT>", diff: "<REVIEW_COMMENT>" }),
    ]);
  });

  // The writer's `\b` is Unicode-aware: `ſ` (U+017F) and the Kelvin sign (U+212A, spelled
  // as an escape below since its glyph reads as ASCII `K`) are word characters to it, so
  // `<` is never escaped before these tag spellings. Inside a marked body they are body
  // text, not escapes, and stay literal in text and fenced diff alike.
  it.each(["ſ", "\u212A"])(
    "keeps the tag spelling with Unicode suffix %s literal in a marked body",
    (suffix) => {
      const body = `&lt;/review_comment${suffix}> and &lt;review_comment${suffix}> are not writer-emitted escapes`;
      const serialized = `<review_comment sectionId="s" filePath="app.ts" startIndex="0" endIndex="0" bodyEncoding="escaped-tags">\n${body}\n\`\`\`diff\n${body}\n\`\`\`\n</review_comment>`;
      expect(parseReviewInlineComments(serialized)).toEqual([
        expect.objectContaining({ text: body, diff: body }),
      ]);
    },
  );

  it("preserves literal entities through draft insertion and legacy dispatch", () => {
    // The draft path upgrades the formatted block, re-identifies the record for the draft
    // store, and may serialize again for a server without inline context — the literal entity
    // must survive every hop.
    const comment = "Please keep &lt;/review_comment&gt; in this documentation example.";
    const upgraded = upgradeLegacyContextMessage(formatReviewCommentContext(makeTarget(), comment));
    const draft = reidentifyComposerContext(upgraded.text, upgraded.records, () => "draft_c1");
    expect(draft.context.records[0]).toMatchObject({ text: comment });

    const legacy = serializeComposerMessageForServer(draft.text, draft.context, false);
    const segment = parseReviewCommentMessageSegments(legacy.text).find(
      (entry) => entry.kind === "review-comment",
    );
    expect(segment).toMatchObject({ kind: "review-comment", comment: { text: comment } });
  });
});
