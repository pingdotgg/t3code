import { expect, it } from "vite-plus/test";
import { issueSortOptions, supportedIssueSort, compareIssueListRows } from "./IssueListFilters";

it("uses safe sort defaults until the source is known and after changing to a tracker without the saved options", () => {
  const saved = { sort: "comments" as const, order: "asc" as const };
  const forgejo = issueSortOptions([
    { capabilities: { listSorts: ["updated", "comments"], listOrders: ["asc", "desc"] } },
  ]);
  expect(supportedIssueSort(saved.sort, saved.order, forgejo)).toEqual(saved);
  const azure = issueSortOptions([
    { capabilities: { listSorts: ["updated", "created"], listOrders: ["desc"] } },
  ]);
  expect(supportedIssueSort(saved.sort, saved.order, azure)).toEqual({
    sort: "updated",
    order: "desc",
  });
  expect(supportedIssueSort(saved.sort, saved.order, issueSortOptions([{}]))).toEqual({
    sort: "updated",
    order: "desc",
  });
});

it("keeps created, updated, and comment orders distinct in the rendered group", () => {
  const rows = [
    {
      id: "old",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-03T00:00:00Z",
      commentCount: 9,
    },
    {
      id: "new",
      createdAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      commentCount: 2,
    },
  ];
  const ordered = (sort: "created" | "updated" | "comments", order: "asc" | "desc") =>
    rows
      .toSorted((left, right) => compareIssueListRows(left, right, sort, order))
      .map((row) => row.id);
  expect(ordered("created", "asc")).toEqual(["old", "new"]);
  expect(ordered("created", "desc")).toEqual(["new", "old"]);
  expect(ordered("updated", "asc")).toEqual(["new", "old"]);
  expect(ordered("updated", "desc")).toEqual(["old", "new"]);
  expect(ordered("comments", "asc")).toEqual(["new", "old"]);
  expect(ordered("comments", "desc")).toEqual(["old", "new"]);
  expect(
    compareIssueListRows({ ...rows[0]!, commentCount: null }, rows[1]!, "comments", "asc"),
  ).toBeLessThan(0);
});
