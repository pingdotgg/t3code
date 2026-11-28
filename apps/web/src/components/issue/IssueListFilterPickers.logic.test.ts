import { describe, expect, it } from "vite-plus/test";

import {
  issueFilterAssigneeChoices,
  issueFilterLabelChoices,
  type IssueAssigneeChoice,
  type IssueLabelChoice,
} from "./IssueListFilterPickers.logic";

const KNOWN_LABELS: ReadonlyArray<IssueLabelChoice> = [
  { name: "bug", description: "Something is broken", color: "d73a4a" },
  { name: "docs", description: "Documentation updates", color: "0075ca" },
];

const KNOWN_ASSIGNEES: ReadonlyArray<IssueAssigneeChoice> = [
  { login: "alice", name: "Alice Smith" },
  { login: "bob", name: "Bob Jones" },
];

describe("issueFilterLabelChoices", () => {
  it("hides a selected label the search does not match, and keeps a matching one's color", () => {
    expect(issueFilterLabelChoices(KNOWN_LABELS, ["bug"], "docs")).toEqual([KNOWN_LABELS[1]]);
    expect(issueFilterLabelChoices(KNOWN_LABELS, ["bug"], "zzzz")).toEqual([]);
    expect(issueFilterLabelChoices(KNOWN_LABELS, ["bug"], "broken")).toEqual([KNOWN_LABELS[0]]);
  });

  it("leads with a selected label the tracker did not offer, unless the search excludes it", () => {
    const legacy = { name: "legacy", description: null, color: null };
    expect(issueFilterLabelChoices(KNOWN_LABELS, ["legacy"], "")).toEqual([
      legacy,
      ...KNOWN_LABELS,
    ]);
    expect(issueFilterLabelChoices(KNOWN_LABELS, ["legacy"], "docs")).toEqual([KNOWN_LABELS[1]]);
  });
});

describe("issueFilterAssigneeChoices", () => {
  it("hides a selected assignee the search does not match, and keeps a matching one's name", () => {
    expect(issueFilterAssigneeChoices(KNOWN_ASSIGNEES, "alice", "bob")).toEqual([
      KNOWN_ASSIGNEES[1],
    ]);
    expect(issueFilterAssigneeChoices(KNOWN_ASSIGNEES, "alice", "smith")).toEqual([
      KNOWN_ASSIGNEES[0],
    ]);
  });

  it("leads with a selected assignee the tracker did not offer, unless the search excludes them", () => {
    expect(issueFilterAssigneeChoices(KNOWN_ASSIGNEES, "ghost", "")).toEqual([
      { login: "ghost", name: null },
      ...KNOWN_ASSIGNEES,
    ]);
    expect(issueFilterAssigneeChoices(KNOWN_ASSIGNEES, "ghost", "bob")).toEqual([
      KNOWN_ASSIGNEES[1],
    ]);
  });
});
