import type { LinearIssue, LinearMilestone, LinearProject, LinearTeam } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildLinearJumpTargets, formatLinearTargetDate } from "./jump.ts";

const team = { id: "t1", key: "ATT", name: "Attraccess" } as LinearTeam;
const project = {
  id: "p1",
  name: "Attraccess project",
  teamIds: ["t1"],
} as unknown as LinearProject;
const milestone = { id: "m1", projectId: "p1", name: "v1.12.0" } as LinearMilestone;
const issue = {
  id: "i1",
  identifier: "ATT-612",
  title: "Handshake",
  team: { id: "t1" },
  project: { id: "p1" },
  milestone: null,
} as unknown as LinearIssue;

describe("buildLinearJumpTargets", () => {
  const loaded = { teams: [team], projects: [project], milestones: [milestone], issues: [issue] };

  it("lists loaded teams, projects and milestones that match, then the server's issues", () => {
    expect(buildLinearJumpTargets("att", loaded).map((target) => target.kind)).toEqual([
      "team",
      "project",
      "issue",
    ]);
    expect(buildLinearJumpTargets("1.12", { ...loaded, issues: [] })).toEqual([
      {
        kind: "milestone",
        id: "m1",
        label: "v1.12.0",
        scope: { team: "t1", project: "p1", milestone: "m1" },
      },
    ]);
    expect(buildLinearJumpTargets("x", loaded).at(-1)).toMatchObject({
      kind: "issue",
      identifier: "ATT-612",
      scope: { team: "t1", project: "p1", milestone: "none" },
    });
  });

  it("places a project naming no team in the open team, else skips it", () => {
    const loose = { ...project, teamIds: [] } as unknown as LinearProject;
    const input = { ...loaded, projects: [loose, loose], issues: [] };
    expect(buildLinearJumpTargets("project", input)).toEqual([]);
    expect(buildLinearJumpTargets("project", { ...input, fallbackTeamId: "t9" })).toEqual([
      {
        kind: "project",
        id: "p1",
        label: "Attraccess project",
        scope: { team: "t9", project: "p1" },
      },
    ]);
  });

  it("returns nothing for a blank term", () => {
    expect(buildLinearJumpTargets("  ", loaded)).toEqual([]);
  });
});

describe("formatLinearTargetDate", () => {
  it("formats date-only strings without a timezone shift", () => {
    expect(formatLinearTargetDate("2026-11-14")).toBe(
      // @effect-diagnostics-next-line globalDate:off
      new Date(2026, 10, 14).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
    expect(formatLinearTargetDate(null)).toBeNull();
  });
});
