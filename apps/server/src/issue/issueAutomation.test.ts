import { describe, expect, it } from "vite-plus/test";
import { aggregateIssueActions, changedIssueStatuses } from "./issueAutomation.ts";

describe("issue status automation decisions", () => {
  it.each([
    [["settle", "wake"], "wake"],
    [["wake", null], "wake"],
    [["settle", null], "unchanged"],
    [["settle", "unchanged"], "unchanged"],
    [["settle", "settle"], "settle"],
    [["settle", "snooze"], "snooze"],
    [["snooze", "snooze"], "snooze"],
    [[], "unchanged"],
  ] as const)("aggregates %j as %s", (actions, expected) => {
    expect(aggregateIssueActions(actions)).toBe(expected);
  });

  it("acts only when a known status moves to another known status", () => {
    expect(changedIssueStatuses(null, { one: "open" })).toBe(false);
    expect(changedIssueStatuses({ one: "open" }, { one: "open" })).toBe(false);
    expect(changedIssueStatuses({ one: "open" }, { one: "done" })).toBe(true);
    expect(changedIssueStatuses({ one: "open" }, { one: null })).toBe(false);
    expect(changedIssueStatuses({ one: null }, { one: "done" })).toBe(false);
    expect(changedIssueStatuses({ one: "open" }, { one: "open", two: "done" })).toBe(false);
  });
});
