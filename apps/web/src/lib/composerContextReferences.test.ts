import { describe, expect, it } from "vite-plus/test";

import {
  appendInlineContextReference,
  collectInlineContextIds,
  ensureInlineContextReferences,
  formatInlineContextReference,
  insertInlineContextReference,
  removeInlineContextReference,
  stripInlineContextReferences,
  toComposerContextId,
  toKindScopedComposerContextId,
} from "./composerContextReferences";

const review = { kind: "review-comment", contextId: "rc-1", label: "a.ts L4" };
const preview = { kind: "preview-annotation", contextId: "pa-1", label: "Checkout" };
const reviewLink = "[a.ts L4](t3-context://v1/review-comment/rc-1)";
const previewLink = "[Checkout](t3-context://v1/preview-annotation/pa-1)";

describe("composerContextReferences", () => {
  it("formats, collects and strips references of any kind", () => {
    expect(formatInlineContextReference(review)).toBe(reviewLink);
    const prompt = `x ${reviewLink} y ${previewLink} ${reviewLink}`;
    expect(collectInlineContextIds(prompt)).toEqual(["rc-1", "pa-1"]);
    expect(stripInlineContextReferences(prompt)).toBe("x  y  ");
  });

  it("inserts at the cursor and appends at the end with boundary spacing", () => {
    expect(insertInlineContextReference("ab", 1, review)).toEqual({
      prompt: `a ${reviewLink} b`,
      cursor: 2 + reviewLink.length + 1,
    });
    expect(appendInlineContextReference("hello", preview)).toBe(`hello ${previewLink} `);
    expect(appendInlineContextReference("", preview)).toBe(`${previewLink} `);
  });

  it("removes every occurrence of an id and reports the earliest cursor", () => {
    const prompt = `${reviewLink} mid ${reviewLink} end`;
    expect(removeInlineContextReference(prompt, "rc-1")).toEqual({
      prompt: "mid end",
      cursor: 0,
    });
    expect(removeInlineContextReference("plain", "rc-1")).toEqual({ prompt: "plain", cursor: 5 });
  });

  it("appends links only for records the prompt does not mention", () => {
    expect(ensureInlineContextReferences(`see ${reviewLink}`, [review, preview])).toBe(
      `see ${reviewLink} ${previewLink} `,
    );
    expect(ensureInlineContextReferences("", [review])).toBe(`${reviewLink} `);
    expect(ensureInlineContextReferences(reviewLink, [review])).toBe(reviewLink);
  });
});

describe("toComposerContextId", () => {
  it("keeps same-kind raw IDs distinct when one contains the namespace prefix", () => {
    expect(toKindScopedComposerContextId("image", "x")).toBe("image_x");
    expect(toKindScopedComposerContextId("image", "image_x")).toBe("image_image_x");
  });
  it("keeps ids that already fit the grammar and folds the rest deterministically", () => {
    expect(toComposerContextId("file-comment-1700-1")).toBe("file-comment-1700-1");
    const folded = toComposerContextId("pull-request-selection:src/a.ts:4-9");
    expect(folded).toMatch(/^pull-request-selection-src-a-ts-4-9-[0-9a-f]{16}$/);
    expect(toComposerContextId("pull-request-selection:src/a.ts:4-9")).toBe(folded);
    expect(toComposerContextId("pull-request-selection:src/b.ts:4-9")).not.toBe(folded);
    expect(toComposerContextId("::")).toMatch(/^ctx-[0-9a-f]{16}$/);
  });
  it("tells apart producer ids that agree past the slug's truncation point", () => {
    // The slug keeps 48 characters, so only the digest distinguishes these two.
    const shared = `pull-request-finding:${"a".repeat(60)}`;
    const first = toComposerContextId(`${shared}:1`);
    const second = toComposerContextId(`${shared}:2`);

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(128);
  });
});
