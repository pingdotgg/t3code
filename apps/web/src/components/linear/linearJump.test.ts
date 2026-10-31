import type { LinearMilestone, LinearProject, LinearTeam } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatLinearTargetDate, matchLinearJumpTargets } from "./linearJump";

const team = { id: "t1", key: "ATT", name: "Attraccess" } as LinearTeam;
const project = { id: "p1", name: "Attraccess project" } as LinearProject;
const milestone = { id: "m1", projectId: "p1", name: "v1.12.0" } as LinearMilestone;

describe("matchLinearJumpTargets", () => {
  const loaded = {
    teams: [team],
    projects: [project],
    milestones: [milestone],
    projectScopes: new Map([["p1", { team: "t1", project: "p1" }]]),
  };

  it("matches loaded teams, projects and milestones by name or key", () => {
    expect(matchLinearJumpTargets("att", loaded).map((target) => target.kind)).toEqual([
      "team",
      "project",
    ]);
    expect(matchLinearJumpTargets("1.12", loaded)).toEqual([
      {
        kind: "milestone",
        id: "m1",
        label: "v1.12.0",
        scope: { team: "t1", project: "p1", milestone: "m1" },
      },
    ]);
  });

  it("returns nothing for an empty term and skips projects without a known team", () => {
    expect(matchLinearJumpTargets("  ", loaded)).toEqual([]);
    expect(matchLinearJumpTargets("project", { ...loaded, projectScopes: new Map() })).toEqual([]);
  });
});

describe("formatLinearTargetDate", () => {
  it("formats date-only strings without a timezone shift", () => {
    expect(formatLinearTargetDate("2026-11-14")).toBe(
      new Date(2026, 10, 14).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
    expect(formatLinearTargetDate(null)).toBeNull();
  });
});
