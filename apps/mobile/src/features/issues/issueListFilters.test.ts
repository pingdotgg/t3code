import { expect, it } from "vite-plus/test";

import { IssueListInput } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { issueSearchQuery, unofferedIssueFilters } from "./issueListFilters";

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

it("searches a pasted wall of text by its start within the server's limit", () => {
  const decode = Schema.decodeUnknownExit(IssueListInput);
  const words = issueSearchQuery(`  ${"word ".repeat(60)}`);
  expect(words).toBe("word ".repeat(40).trim());
  expect(Exit.isSuccess(decode({ state: "open", query: words }))).toBe(true);
  expect(issueSearchQuery(`${"a".repeat(199)}😀 tail`)).toBe("a".repeat(199));
});
