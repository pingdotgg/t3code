import { describe, expect, it } from "@effect/vitest";

import { issueSearchQuery, issueStateOf } from "./gitHubIssues.ts";

describe("issueStateOf", () => {
  it.each([
    ["OPEN", null, "open"],
    ["OPEN", "REOPENED", "open"],
    ["CLOSED", "COMPLETED", "done"],
    ["CLOSED", "NOT_PLANNED", "not-planned"],
    ["CLOSED", "DUPLICATE", "not-planned"],
    // Issues closed before GitHub recorded reasons carry none; GitHub shows them as completed.
    ["CLOSED", null, "done"],
  ] as const)("%s with reason %s is %s", (state, stateReason, expected) => {
    expect(issueStateOf({ state, stateReason })).toBe(expected);
  });
});

describe("issueSearchQuery", () => {
  const repositories = ["toolboxmd/t3code", "toolboxmd/model-router"];

  it.each([
    [
      "open, by update",
      { state: "open" },
      "is:issue is:open sort:updated-desc repo:toolboxmd/t3code repo:toolboxmd/model-router",
    ],
    [
      "closed, by creation",
      { state: "closed", sort: "created" },
      "is:issue is:closed sort:created-desc repo:toolboxmd/t3code repo:toolboxmd/model-router",
    ],
    [
      "all, by number, which is creation order on GitHub",
      { state: "all", sort: "number" },
      "is:issue sort:created-desc repo:toolboxmd/t3code repo:toolboxmd/model-router",
    ],
    [
      "text, labels and milestone, all quoted",
      { state: "open", query: "parent tree", labels: ["good first issue", "bug"], milestone: "M1" },
      'is:issue is:open "parent tree" label:"good first issue" label:"bug" milestone:"M1" sort:updated-desc repo:toolboxmd/t3code repo:toolboxmd/model-router',
    ],
    [
      "typed qualifiers stay text",
      { state: "all", query: 'is:pr "x' },
      'is:issue "is:pr \\"x" sort:updated-desc repo:toolboxmd/t3code repo:toolboxmd/model-router',
    ],
    [
      "a quote cannot end a label value early",
      { state: "all", labels: ['a" repo:evil/x'] },
      'is:issue label:"a repo:evil/x" sort:updated-desc repo:toolboxmd/t3code repo:toolboxmd/model-router',
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(issueSearchQuery({ repositories, ...input })).toBe(expected);
  });

  it("refuses no repositories, or one that is not owner/name", () => {
    expect(issueSearchQuery({ repositories: [], state: "open" })).toBeNull();
    expect(
      issueSearchQuery({ repositories: ["toolboxmd/t3code is:pr"], state: "open" }),
    ).toBeNull();
    expect(issueSearchQuery({ repositories: ["t3code"], state: "open" })).toBeNull();
  });
});
