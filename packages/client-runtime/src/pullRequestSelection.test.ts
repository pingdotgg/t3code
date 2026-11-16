import { describe, expect, it } from "@effect/vitest";

import {
  emptySelection,
  isSelected,
  selectionChanges,
  toggleSelection,
  type SelectionDraft,
} from "./pullRequestSelection.ts";

const host = new Set(["bug"]);
const hostSelected = (key: string) => host.has(key);

function pick(draft: SelectionDraft<string>, key: string) {
  return toggleSelection(draft, key, key, hostSelected(key));
}

describe("pull request selection draft", () => {
  it("collapses several picks into one add and one remove", () => {
    let draft = emptySelection<string>();
    for (const key of ["docs", "bug", "feature", "chore", "chore"]) draft = pick(draft, key);
    expect(isSelected(draft, "bug", true)).toBe(false);
    expect(isSelected(draft, "docs", false)).toBe(true);
    expect(selectionChanges(draft, hostSelected)).toEqual({
      add: ["docs", "feature"],
      remove: ["bug"],
    });
  });

  it("sends nothing for a pick toggled back", () => {
    const draft = pick(pick(emptySelection(), "bug"), "bug");
    expect(draft.size).toBe(0);
    expect(selectionChanges(draft, hostSelected)).toEqual({ add: [], remove: [] });
  });

  it("diffs against the host's state at close, not at the pick", () => {
    const draft = pick(pick(emptySelection(), "docs"), "bug");
    const refreshed = new Set(["docs"]);
    expect(selectionChanges(draft, (key) => refreshed.has(key))).toEqual({ add: [], remove: [] });
  });
});
