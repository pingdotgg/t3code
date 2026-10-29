import { describe, expect, it } from "vite-plus/test";

import {
  disclosureOpen,
  transcriptFoldsStartOpen,
  transcriptRowsStartOpen,
  withDisclosureOpen,
} from "./disclosure.js";

describe("transcript disclosures", () => {
  it("opens folds from Thinking up and rows only in Verbose", () => {
    const views = ["normal", "thinking", "verbose"] as const;
    expect(views.map(transcriptFoldsStartOpen)).toEqual([false, true, true]);
    expect(views.map(transcriptRowsStartOpen)).toEqual([false, false, true]);
  });

  it("reads a flipped id as the opposite of the default", () => {
    const flipped = new Set(["a"]);
    expect(disclosureOpen(flipped, "a", false)).toBe(true);
    expect(disclosureOpen(flipped, "b", false)).toBe(false);
    expect(disclosureOpen(flipped, "a", true)).toBe(false);
    expect(disclosureOpen(flipped, "b", true)).toBe(true);
    expect(disclosureOpen(undefined, "a", true)).toBe(true);
  });

  it("opens a disclosure against either default and keeps an open one unchanged", () => {
    const untouched = new Set<string>();
    expect([...withDisclosureOpen(untouched, "a", false)]).toEqual(["a"]);
    expect(withDisclosureOpen(untouched, "a", true)).toBe(untouched);
    const flipped = new Set(["a"]);
    expect([...withDisclosureOpen(flipped, "a", true)]).toEqual([]);
    expect(withDisclosureOpen(flipped, "a", false)).toBe(flipped);
  });
});
