import { describe, expect, it } from "vite-plus/test";

import {
  appendInlineContextReference,
  collectInlineContextIds,
  ensureInlineContextReferences,
  formatInlineContextReference,
  insertInlineContextReference,
  inlineContextReferenceReplacement,
  removeInlineContextReference,
  stripInlineContextReferences,
} from "./composerContextReferences";

const review = { kind: "review-comment", contextId: "rc-1", label: "a.ts L4" };
const preview = { kind: "preview-annotation", contextId: "pa-1", label: "Checkout" };
const reviewLink = "[a.ts L4](t3-context://v1/review-comment/rc-1)";
const previewLink = "[Checkout](t3-context://v1/preview-annotation/pa-1)";

describe("composerContextReferences", () => {
  it.each([
    { prompt: "before selected after", start: 7, end: 15, expected: `before ${reviewLink} after` },
    { prompt: "selected", start: 0, end: 8, expected: `${reviewLink} ` },
    { prompt: "aSELECTb", start: 1, end: 7, expected: `a ${reviewLink} b` },
  ])(
    "replaces selected text in '$prompt' with the attachment chip",
    ({ prompt, start, end, expected }) => {
      const edit = inlineContextReferenceReplacement(prompt, { start, end }, [review]);
      expect(`${prompt.slice(0, edit.start)}${edit.text}${prompt.slice(edit.end)}`).toBe(expected);
    },
  );
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
