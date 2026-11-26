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
  it("hides known selected labels that do not match the search query", () => {
    expect(issueFilterLabelChoices(KNOWN_LABELS, ["bug"], "docs")).toEqual([KNOWN_LABELS[1]]);
    expect(issueFilterLabelChoices(KNOWN_LABELS, ["bug"], "zzzz")).toEqual([]);
  });

  it("keeps a matching selected label once with its color and matches descriptions", () => {
    expect(issueFilterLabelChoices(KNOWN_LABELS, ["bug"], "  BU  ")).toEqual([KNOWN_LABELS[0]]);
    expect(issueFilterLabelChoices(KNOWN_LABELS, ["bug"], "broken")).toEqual([KNOWN_LABELS[0]]);
  });

  it("leads with unoffered selected labels when empty or matching, and hides them when non-matching", () => {
    expect(issueFilterLabelChoices(KNOWN_LABELS, ["legacy"], "")).toEqual([
      { name: "legacy", description: null, color: null },
      ...KNOWN_LABELS,
    ]);
    expect(issueFilterLabelChoices(KNOWN_LABELS, ["legacy"], "leg")).toEqual([
      { name: "legacy", description: null, color: null },
    ]);
    expect(issueFilterLabelChoices(KNOWN_LABELS, ["legacy"], "docs")).toEqual([KNOWN_LABELS[1]]);
  });

  it("caps visible choices at 30 while leading with deduplicated unoffered picks", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      name: `label-${index}`,
      description: null,
      color: null,
    }));
    const result = issueFilterLabelChoices(many, ["custom", "custom"], "");
    expect(result).toHaveLength(30);
    expect(result[0]?.name).toBe("custom");
    expect(result[1]?.name).toBe("label-0");
  });
});

describe("issueFilterAssigneeChoices", () => {
  it("hides a known selected assignee that does not match the search query", () => {
    expect(issueFilterAssigneeChoices(KNOWN_ASSIGNEES, "alice", "bob")).toEqual([
      KNOWN_ASSIGNEES[1],
    ]);
    expect(issueFilterAssigneeChoices(KNOWN_ASSIGNEES, "alice", "zzzz")).toEqual([]);
  });

  it("keeps a matching selected assignee once with their display name", () => {
    expect(issueFilterAssigneeChoices(KNOWN_ASSIGNEES, "alice", "  ALI  ")).toEqual([
      KNOWN_ASSIGNEES[0],
    ]);
    expect(issueFilterAssigneeChoices(KNOWN_ASSIGNEES, "alice", "smith")).toEqual([
      KNOWN_ASSIGNEES[0],
    ]);
  });

  it("leads with an unoffered selected assignee when empty or matching, and hides them when non-matching", () => {
    expect(issueFilterAssigneeChoices(KNOWN_ASSIGNEES, "ghost", "")).toEqual([
      { login: "ghost", name: null },
      ...KNOWN_ASSIGNEES,
    ]);
    expect(issueFilterAssigneeChoices(KNOWN_ASSIGNEES, "ghost", "gho")).toEqual([
      { login: "ghost", name: null },
    ]);
    expect(issueFilterAssigneeChoices(KNOWN_ASSIGNEES, "ghost", "bob")).toEqual([
      KNOWN_ASSIGNEES[1],
    ]);
  });
});
