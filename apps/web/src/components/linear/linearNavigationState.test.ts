import { describe, expect, it } from "vite-plus/test";

import { readStoredLinearSearch, writeStoredLinearLocation } from "./linearNavigationState";

describe("stored Linear location", () => {
  it("falls back to the workspace root when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredLinearSearch(throwing)).toEqual({});
    expect(() =>
      writeStoredLinearLocation({ organizationId: null, search: {} }, throwing),
    ).not.toThrow();
  });
});
