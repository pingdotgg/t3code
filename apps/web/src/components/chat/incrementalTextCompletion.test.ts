import { describe, expect, it } from "vite-plus/test";

import {
  getIncrementalTextCompletionStart,
  splitTextForIncrementalCompletion,
} from "./incrementalTextCompletion";

describe("incremental text completion", () => {
  it("keeps the shared prefix when the selected project changes", () => {
    expect(getIncrementalTextCompletionStart("t3code-web", "t3code-mobile")).toBe(7);
  });

  it("starts over when project names do not share a prefix", () => {
    expect(getIncrementalTextCompletionStart("frontend", "backend")).toBe(0);
  });

  it("advances through unicode text by code point instead of UTF-16 code unit", () => {
    expect(splitTextForIncrementalCompletion("T3 🚀")).toEqual(["T", "3", " ", "🚀"]);
  });
});
