import { describe, expect, it } from "@effect/vitest";

import {
  issueAssigneesAfterPicks,
  issueLabelsAfterPicks,
  issuePicksAfterFailedWrite,
  issuePicksFor,
  issueWriteAfterPicks,
  noIssuePicks,
  type IssuePicks,
} from "./issueSelection.ts";
import { emptySelection, toggleSelection } from "./pullRequestSelection.ts";

const label = (name: string) => ({ name, color: null, description: null });
const person = (login: string, id: string) => ({ login, id, name: null, avatarUrl: null });

describe("issue picker picks", () => {
  it("writes the whole label set once, and nothing when the picks cancel out", () => {
    const detail = { labels: [label("bug"), label("ui")] };
    let draft = emptySelection<ReturnType<typeof label>>();
    draft = toggleSelection(draft, "docs", label("docs"), false);
    draft = toggleSelection(draft, "bug", label("bug"), true);
    expect(issueLabelsAfterPicks(detail, draft)).toEqual(["ui", "docs"]);
    draft = toggleSelection(draft, "docs", label("docs"), false);
    draft = toggleSelection(draft, "bug", label("bug"), true);
    expect(issueLabelsAfterPicks(detail, draft)).toBeNull();
  });

  it("keeps assignees by login and adds new ones by the tracker's id", () => {
    const detail = { assignees: [person("Julius", "u1"), person("theo", "u2")] };
    let draft = emptySelection<ReturnType<typeof person>>();
    draft = toggleSelection(draft, "u1", person("julius", "u1"), true);
    draft = toggleSelection(draft, "u3", person("mark", "u3"), false);
    expect(issueAssigneesAfterPicks(detail, draft)).toEqual(["theo", "u3"]);
  });

  it("builds a second write on the first while the detail has not caught up", () => {
    type Label = ReturnType<typeof label>;
    const stale = { labels: [label("bug")] };
    const names = (detail: typeof stale) => detail.labels.map((entry) => entry.name);
    const pick = (picks: IssuePicks<Label>, detail: typeof stale, name: string) => {
      const current = issuePicksFor(picks, detail, true);
      const held = names(detail).includes(name);
      return { ...current, draft: toggleSelection(current.draft, name, label(name), held) };
    };
    const close = (picks: IssuePicks<Label>, detail: typeof stale) => {
      const current = issuePicksFor(picks, detail, true);
      const write = issueWriteAfterPicks(
        issueLabelsAfterPicks(detail, current.draft),
        names(detail),
        current.written,
      );
      return { write, picks: write === null ? current : { ...current, written: write } };
    };

    const first = close(pick(noIssuePicks<Label>(), stale, "docs"), stale);
    expect(first.write).toEqual(["bug", "docs"]);
    // Reopened before the refreshed detail arrives: the second pick keeps the first.
    const second = close(pick(first.picks, stale, "ui"), stale);
    expect(second.write).toEqual(["bug", "docs", "ui"]);
    expect(close(second.picks, stale).write).toBeNull();
    // Taking both back writes the set the stale detail still shows.
    const undone = close(pick(pick(second.picks, stale, "docs"), stale, "ui"), stale);
    expect(undone.write).toEqual(["bug"]);

    const fresh = { labels: [label("bug"), label("docs"), label("ui")] };
    expect(issuePicksFor(second.picks, fresh, false).draft.size).toBe(0);
    // A picker still open over the refresh keeps its picks, which the fresh detail now confirms.
    expect(close(pick(second.picks, fresh, "p1"), fresh).write).toEqual([
      "bug",
      "docs",
      "ui",
      "p1",
    ]);
  });

  it("keeps picks made after a write that then fails, and forgets the failed ones otherwise", () => {
    const detail = { labels: [label("bug")] };
    const picked = issuePicksFor(noIssuePicks<ReturnType<typeof label>>(), detail, true);
    const sent = {
      ...picked,
      draft: toggleSelection(picked.draft, "docs", label("docs"), false),
      written: ["bug", "docs"],
    };
    expect(issuePicksAfterFailedWrite(sent, sent).draft.size).toBe(0);

    const later = { ...sent, draft: toggleSelection(sent.draft, "ui", label("ui"), false) };
    const kept = issuePicksAfterFailedWrite(later, sent);
    expect(kept.written).toBeNull();
    expect(issueLabelsAfterPicks(detail, kept.draft)).toEqual(["bug", "docs", "ui"]);

    const rewritten = { ...later, written: ["bug", "docs", "ui"] };
    expect(issuePicksAfterFailedWrite(rewritten, sent)).toBe(rewritten);
  });
});
