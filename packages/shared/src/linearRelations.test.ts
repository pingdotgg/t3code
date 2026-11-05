import { describe, expect, it } from "vite-plus/test";
import type { LinearIssue, LinearIssueRef } from "@t3tools/contracts";

import { blockedBySummary, isLinearIssueBlocked, linearRelationGroups } from "./linearRelations.ts";

type StateType = LinearIssueRef["state"]["type"];
const ref = (n: number, type: StateType): LinearIssueRef => ({
  id: `i${n}`,
  identifier: `ATT-${n}`,
  title: `Issue ${n}`,
  state: { type, name: type, color: "#000" },
});
const issue = (blockedBy: ReadonlyArray<LinearIssueRef>, type: StateType = "unstarted") =>
  ({ blockedBy, state: { type } }) as Pick<LinearIssue, "blockedBy" | "state">;

describe("isLinearIssueBlocked", () => {
  it.each([
    ["started", true],
    ["unstarted", true],
    ["completed", false],
    ["canceled", false],
  ] as const)("a %s blocker => blocked %s", (type, blocked) => {
    expect(isLinearIssueBlocked(issue([ref(1, type)]))).toBe(blocked);
  });

  it("is false without blockers and when any blocker is open only", () => {
    expect(isLinearIssueBlocked(issue([]))).toBe(false);
    expect(isLinearIssueBlocked(issue([ref(1, "completed"), ref(2, "started")]))).toBe(true);
  });

  it("is false for done issues", () => {
    expect(isLinearIssueBlocked(issue([ref(1, "started")], "completed"))).toBe(false);
    expect(isLinearIssueBlocked(issue([ref(1, "started")], "canceled"))).toBe(false);
  });
});

describe("blockedBySummary", () => {
  it("names one open blocker and counts several, ignoring done ones", () => {
    expect(blockedBySummary(issue([ref(12, "started"), ref(13, "completed")]))).toBe(
      "Blocked by ATT-12",
    );
    expect(blockedBySummary(issue([ref(12, "started"), ref(15, "backlog")]))).toBe(
      "Blocked by 2 issues",
    );
  });
});

describe("linearRelationGroups", () => {
  it("orders groups, puts open blockers first and leaves out empty groups", () => {
    const groups = linearRelationGroups({
      issue: { blockedBy: [ref(1, "completed"), ref(2, "started")] },
      blocks: [],
      relatedIssues: [ref(3, "started")],
      duplicates: [
        { ...ref(4, "started"), direction: "duplicatedBy" },
        { ...ref(5, "started"), direction: "duplicateOf" },
      ],
    });
    expect(groups.map((group) => [group.title, group.refs.map((r) => r.identifier)])).toEqual([
      ["Blocked by", ["ATT-2", "ATT-1"]],
      ["Related", ["ATT-3"]],
      ["Duplicate of", ["ATT-5"]],
      ["Duplicated by", ["ATT-4"]],
    ]);
  });
});
