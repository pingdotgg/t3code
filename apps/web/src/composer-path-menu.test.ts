import { describe, expect, it } from "vitest";

import { resolveComposerPathMenuEntries } from "./composer-path-menu";

describe("resolveComposerPathMenuEntries", () => {
  const entries = [{ path: "src/helpers.ts" }, { path: "src/index.ts" }] as const;

  it("hides entries for an empty @query", () => {
    expect(
      resolveComposerPathMenuEntries({
        query: "",
        isDebouncing: false,
        isFetching: false,
        isLoading: false,
        entries,
      }),
    ).toEqual([]);
  });

  it("hides entries while the next query is debouncing", () => {
    expect(
      resolveComposerPathMenuEntries({
        query: "ssh",
        isDebouncing: true,
        isFetching: false,
        isLoading: false,
        entries,
      }),
    ).toEqual([]);
  });

  it("hides entries while the next query is fetching", () => {
    expect(
      resolveComposerPathMenuEntries({
        query: "ssh",
        isDebouncing: false,
        isFetching: true,
        isLoading: false,
        entries,
      }),
    ).toEqual([]);
  });

  it("returns entries once the query settles", () => {
    expect(
      resolveComposerPathMenuEntries({
        query: "ssh",
        isDebouncing: false,
        isFetching: false,
        isLoading: false,
        entries,
      }),
    ).toBe(entries);
  });
});
