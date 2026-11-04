import { describe, expect, it } from "vite-plus/test";

import { draftChanges, isDraftSelected, toggleDraft } from "./pullRequestSelection.ts";

const candidates = [
  { key: "a", selected: true },
  { key: "b", selected: false },
  { key: "c", selected: false },
];
const [a, b, c] = candidates as [
  (typeof candidates)[0],
  (typeof candidates)[0],
  (typeof candidates)[0],
];
const keys = (list: ReadonlyArray<{ key: string }>) => list.map((candidate) => candidate.key);

describe("selection drafts", () => {
  it("collects several toggles into one add and one remove", () => {
    let draft = toggleDraft(new Map(), candidates, a, false);
    draft = toggleDraft(draft, candidates, b, false);
    draft = toggleDraft(draft, candidates, c, false);

    const changes = draftChanges(draft, candidates);
    expect(keys(changes.add)).toEqual(["b", "c"]);
    expect(keys(changes.remove)).toEqual(["a"]);
  });

  it("sends nothing for a choice toggled back", () => {
    const draft = toggleDraft(toggleDraft(new Map(), candidates, b, false), candidates, b, false);

    expect(draft.size).toBe(0);
    expect(draftChanges(draft, candidates)).toEqual({ add: [], remove: [] });
  });

  it("swaps the one selection when the host keeps one", () => {
    let draft = toggleDraft(new Map(), candidates, b, true);
    expect(candidates.map((candidate) => isDraftSelected(draft, candidate))).toEqual([
      false,
      true,
      false,
    ]);

    draft = toggleDraft(draft, candidates, c, true);
    const changes = draftChanges(draft, candidates);
    expect(keys(changes.add)).toEqual(["c"]);
    expect(keys(changes.remove)).toEqual(["a"]);
  });

  it("lets a single selection be cleared", () => {
    const draft = toggleDraft(new Map(), candidates, a, true);

    expect(draftChanges(draft, candidates)).toEqual({ add: [], remove: [a] });
  });

  it("diffs against the host's latest state, not the state at open", () => {
    const draft = toggleDraft(new Map(), candidates, b, false);
    const refreshed = candidates.map((candidate) =>
      candidate.key === "b" ? { ...candidate, selected: true } : candidate,
    );

    expect(draftChanges(draft, refreshed)).toEqual({ add: [], remove: [] });
  });
});
