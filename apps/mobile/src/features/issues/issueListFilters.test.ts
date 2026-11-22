import { expect, it } from "vite-plus/test";

import { unofferedIssueFilters } from "./issueListFilters";

it("keeps the picks the listed scopes no longer offer", () => {
  const offered = { labels: [{ name: "bug" }], assignees: [{ login: "alice" }] };
  expect(
    unofferedIssueFilters(
      { labels: ["bug", "gone"], assignee: { login: "bob", name: "Bob" } },
      offered,
    ),
  ).toEqual({ labels: ["gone"], assignee: { login: "bob", name: "Bob" } });
  expect(
    unofferedIssueFilters({ labels: ["bug"], assignee: { login: "alice", name: null } }, offered),
  ).toEqual({ labels: [], assignee: null });
});
