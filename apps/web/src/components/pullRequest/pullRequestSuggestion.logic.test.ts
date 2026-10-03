import type { PullRequestReviewThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  parseReviewSuggestions,
  sliceFileLines,
  suggestionFencesAsDiff,
  suggestionIndexFromMeta,
  suggestionLineRange,
} from "./pullRequestSuggestion.logic";

const thread = (overrides: Partial<PullRequestReviewThread>): PullRequestReviewThread => ({
  id: "t1",
  path: "src/a.ts",
  line: 12,
  side: "right",
  isResolved: false,
  isOutdated: false,
  comments: [],
  ...overrides,
});

describe("parseReviewSuggestions", () => {
  it("reads every suggestion block and nothing else", () => {
    const body = [
      "Rename this:",
      "```suggestion",
      "const total = 1;",
      "```",
      "```ts",
      "not a suggestion",
      "```",
      "````suggestion",
      "a",
      "```",
      "b",
      "````",
    ].join("\n");
    expect(parseReviewSuggestions(body)).toEqual(["const total = 1;", "a\n```\nb"]);
  });

  it("closes a fence on a longer run of the same character", () => {
    expect(parseReviewSuggestions("```suggestion\na\n````\n\n```\nb\n```")).toEqual(["a"]);
  });

  it("drops the indentation the fence sits at", () => {
    expect(parseReviewSuggestions("- note\n  ```suggestion\n    if (x) {\n  ```")).toEqual([
      "  if (x) {",
    ]);
  });

  it("reads an empty block as deleting the lines", () => {
    expect(parseReviewSuggestions("```suggestion\n```")).toEqual([""]);
  });
});

describe("suggestionFencesAsDiff", () => {
  it("marks suggested lines as additions", () => {
    expect(suggestionFencesAsDiff("```suggestion\none\ntwo\n```")).toBe(
      "```diff suggestion=0\n+one\n+two\n```",
    );
  });

  it("numbers each fence so its header can find the suggestion again", () => {
    const shown = suggestionFencesAsDiff("```suggestion\na\n```\n\n```suggestion\nb\n```");
    const metas = [...shown.matchAll(/^```diff (.*)$/gmu)].map((match) => match[1]);
    expect(metas.map(suggestionIndexFromMeta)).toEqual([0, 1]);
    expect(suggestionIndexFromMeta("title=a.ts")).toBeNull();
  });
});

describe("suggestionLineRange", () => {
  it("runs from the start line to the line", () => {
    expect(suggestionLineRange(thread({ startLine: 10 }))).toEqual({ startLine: 10, endLine: 12 });
    expect(suggestionLineRange(thread({}))).toEqual({ startLine: 12, endLine: 12 });
  });

  it("refuses base-side, file-level and outdated threads", () => {
    expect(suggestionLineRange(thread({ side: "left" }))).toBeNull();
    expect(suggestionLineRange(thread({ line: null }))).toBeNull();
    expect(suggestionLineRange(thread({ isOutdated: true }))).toBeNull();
  });
});

describe("sliceFileLines", () => {
  it("reads the range and refuses one past the end", () => {
    expect(sliceFileLines("a\r\nb\r\nc\r\n", { startLine: 2, endLine: 3 })).toBe("b\nc");
    expect(sliceFileLines("a\n", { startLine: 2, endLine: 2 })).toBeNull();
  });
});
