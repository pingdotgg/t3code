import { describe, expect, it } from "vite-plus/test";

import {
  getLinearListScroll,
  isLinearIssueExpanded,
  readStoredLinearLocation,
  readStoredLinearSearch,
  setLinearIssueExpanded,
  setLinearListScroll,
  writeStoredLinearLocation,
} from "./linearNavigationState";

const memoryStorage = (initial?: string) => {
  let value: string | null = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
};

describe("stored Linear location", () => {
  it("restores what was written, sanitised", () => {
    const storage = memoryStorage();
    writeStoredLinearLocation(
      { organizationId: "o1", search: { team: "t1", project: "p1", issue: "i1" } },
      storage,
    );
    expect(readStoredLinearSearch(storage)).toEqual({ team: "t1", project: "p1", issue: "i1" });
    expect(readStoredLinearLocation(storage)?.organizationId).toBe("o1");
  });

  it("falls back to the workspace root when storage is empty, corrupt or throws", () => {
    expect(readStoredLinearSearch(memoryStorage())).toEqual({});
    expect(readStoredLinearSearch(memoryStorage("{broken"))).toEqual({});
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

describe("session list memory", () => {
  it("remembers scroll and expanded rows per list", () => {
    setLinearListScroll("list-a", 320);
    setLinearIssueExpanded("list-a", "i1", true);
    setLinearIssueExpanded("list-a", "i2", true);
    setLinearIssueExpanded("list-a", "i2", false);
    expect(getLinearListScroll("list-a")).toBe(320);
    expect(getLinearListScroll("list-b")).toBeUndefined();
    expect(isLinearIssueExpanded("list-a", "i1")).toBe(true);
    expect(isLinearIssueExpanded("list-a", "i2")).toBe(false);
    expect(isLinearIssueExpanded("list-b", "i1")).toBe(false);
  });
});
