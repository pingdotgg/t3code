import { describe, expect, it } from "@effect/vitest";

import { issueAssigneesAfterPicks, issueLabelsAfterPicks } from "./issueSelection.ts";
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
});
