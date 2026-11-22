import { describe, expect, it } from "vite-plus/test";

import {
  anyIssueHasStatusLabel,
  assignBoardColumn,
  filterIssuesByLabelNames,
  groupIssuesByBoardColumn,
  isStatusLabelName,
  nonStatusLabels,
  statusSlugFromLabelName,
} from "./boardColumns.logic";

describe("statusSlugFromLabelName", () => {
  it("reads the slug after status:", () => {
    expect(statusSlugFromLabelName("status:todo")).toBe("todo");
    expect(statusSlugFromLabelName("Status:In-Progress")).toBe("in-progress");
    expect(statusSlugFromLabelName("bug")).toBeNull();
    expect(statusSlugFromLabelName("status:")).toBeNull();
  });
});

describe("assignBoardColumn", () => {
  it("maps each default status label to its column", () => {
    expect(assignBoardColumn([{ name: "status:backlog" }])).toBe("backlog");
    expect(assignBoardColumn([{ name: "status:todo" }])).toBe("todo");
    expect(assignBoardColumn([{ name: "status:in-progress" }])).toBe("in-progress");
    expect(assignBoardColumn([{ name: "status:review" }])).toBe("review");
    expect(assignBoardColumn([{ name: "status:done" }])).toBe("done");
  });

  it("puts unlabeled and unknown status:* issues in backlog", () => {
    expect(assignBoardColumn([])).toBe("backlog");
    expect(assignBoardColumn([{ name: "bug" }])).toBe("backlog");
    expect(assignBoardColumn([{ name: "status:blocked" }])).toBe("backlog");
  });

  it("picks the most progressed column when several status labels match", () => {
    expect(
      assignBoardColumn([{ name: "status:todo" }, { name: "status:review" }, { name: "bug" }]),
    ).toBe("review");
  });
});

describe("nonStatusLabels / isStatusLabelName", () => {
  it("drops status labels from card chips", () => {
    expect(isStatusLabelName("status:todo")).toBe(true);
    expect(
      nonStatusLabels([{ name: "bug" }, { name: "status:todo" }, { name: "urgent" }]).map(
        (label) => label.name,
      ),
    ).toEqual(["bug", "urgent"]);
  });
});

describe("groupIssuesByBoardColumn", () => {
  it("buckets every issue into one of the five columns", () => {
    const issues = [
      { id: "a", labels: [{ name: "status:todo" }] },
      { id: "b", labels: [] },
      { id: "c", labels: [{ name: "status:done" }] },
    ];
    const groups = groupIssuesByBoardColumn(issues);
    expect(groups.todo.map((issue) => issue.id)).toEqual(["a"]);
    expect(groups.backlog.map((issue) => issue.id)).toEqual(["b"]);
    expect(groups.done.map((issue) => issue.id)).toEqual(["c"]);
    expect(groups["in-progress"]).toEqual([]);
    expect(groups.review).toEqual([]);
  });
});

describe("anyIssueHasStatusLabel", () => {
  it("detects whether the board has any known status labels", () => {
    expect(anyIssueHasStatusLabel([{ labels: [{ name: "bug" }] }])).toBe(false);
    expect(anyIssueHasStatusLabel([{ labels: [{ name: "status:todo" }] }])).toBe(true);
    expect(anyIssueHasStatusLabel([{ labels: [{ name: "status:unknown" }] }])).toBe(false);
  });
});

describe("filterIssuesByLabelNames", () => {
  it("requires every selected label (case-insensitive)", () => {
    const issues = [
      { id: "1", labels: [{ name: "bug" }, { name: "status:todo" }] },
      { id: "2", labels: [{ name: "bug" }] },
      { id: "3", labels: [{ name: "urgent" }] },
    ];
    expect(filterIssuesByLabelNames(issues, ["Bug"]).map((issue) => issue.id)).toEqual(["1", "2"]);
    expect(
      filterIssuesByLabelNames(issues, ["bug", "status:todo"]).map((issue) => issue.id),
    ).toEqual(["1"]);
    expect(filterIssuesByLabelNames(issues, [])).toEqual(issues);
  });
});
