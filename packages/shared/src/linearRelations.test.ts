import { describe, expect, it } from "vite-plus/test";
import type { LinearIssue, LinearIssueRef } from "@t3tools/contracts";

import {
  blockedBySummary,
  blockedByTitle,
  isLinearIssueBlocked,
  openBlockers,
} from "./linearBlocked.ts";

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

describe("blocker text", () => {
  const blocked = issue([ref(12, "started"), ref(13, "completed"), ref(15, "backlog")]);
  it("lists only open blockers", () => {
    expect(openBlockers(blocked).map((r) => r.identifier)).toEqual(["ATT-12", "ATT-15"]);
    expect(blockedByTitle(blocked)).toBe("Blocked by ATT-12, ATT-15");
  });
  it("summarises one or many", () => {
    expect(blockedBySummary(issue([ref(12, "started")]))).toBe("Blocked by ATT-12");
    expect(blockedBySummary(blocked)).toBe("Blocked by 2 issues");
  });
});
