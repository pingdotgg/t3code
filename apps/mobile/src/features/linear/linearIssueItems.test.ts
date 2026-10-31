import type { LinearIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { linearIssueListItems } from "./linearIssueItems";

function issue(id: string, state: string, parentId?: string): LinearIssue {
  return {
    id,
    state: { id: state, name: state, type: "started", color: "#fff" },
    milestone: null,
    parent: parentId === undefined ? null : { id: parentId, identifier: parentId },
  } as unknown as LinearIssue;
}

const issues = [issue("a", "s1"), issue("b", "s2"), issue("child", "s1", "a")];

describe("linearIssueListItems", () => {
  it("interleaves group headers with their issues and leaves listed sub-issues to their parent", () => {
    const items = linearIssueListItems(issues, "state", new Map(), new Set());
    expect(items.map((item) => `${item.type}:${item.key}`)).toEqual([
      "header:group:s1",
      "issue:a",
      "header:group:s2",
      "issue:b",
    ]);
    expect(items[0]).toMatchObject({ count: 1, collapsed: false });
  });

  it("keeps a collapsed group's header and count but drops its rows", () => {
    const items = linearIssueListItems(issues, "state", new Map(), new Set(["s1"]));
    expect(items.map((item) => item.key)).toEqual(["group:s1", "group:s2", "b"]);
    expect(items[0]).toMatchObject({ type: "header", collapsed: true });
  });

  it("has no headers when ungrouped", () => {
    expect(linearIssueListItems(issues, "none", new Map(), new Set()).map((i) => i.type)).toEqual([
      "issue",
      "issue",
    ]);
  });
});
