import type { LinearMapping, LinearProject, LinearTeam, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildLinearMappingRows,
  firstStartedStateName,
  removeLinearMapping,
  upsertLinearMapping,
} from "./linearSettings.logic";

const team = (id: string, key: string, name: string): LinearTeam => ({
  id,
  key,
  name,
  description: null,
  color: null,
  icon: null,
  projectCount: 0,
  assignedToViewerCount: 0,
});
const project = (id: string, name: string, teamIds: string[]): LinearProject => ({
  id,
  name,
  status: { name: "Started", type: "started", color: null },
  progress: 0,
  targetDate: null,
  teamIds,
  url: "https://linear.app/x",
});
const pid = (value: string) => value as ProjectId;
const mapping = (overrides: Partial<LinearMapping>): LinearMapping => ({
  id: "m1",
  kind: "team",
  linearId: "t1",
  linearName: "Old name",
  projectId: pid("p1"),
  ...overrides,
});

describe("buildLinearMappingRows", () => {
  const teams = [team("t1", "ATT", "Attraccess"), team("t2", "JJ", "JanJaap")];
  const projects = [project("lp1", "Plaudern", ["t2"])];

  it("lists mapped targets first, then teams that ask each time", () => {
    const rows = buildLinearMappingRows({
      teams,
      projects,
      mappings: [
        mapping({ id: "a", linearId: "t1" }),
        mapping({ id: "b", kind: "project", linearId: "lp1" }),
      ],
    });
    expect(rows.map((row) => [row.key, row.name, row.mapping?.id ?? null])).toEqual([
      ["a", "Attraccess", "a"],
      ["b", "Plaudern", "b"],
      ["team:t2", "JanJaap", null],
    ]);
    expect(rows[1]).toMatchObject({ parentTeamName: "JanJaap", kind: "project" });
    expect(rows[0]).toMatchObject({ teamKey: "ATT" });
  });

  it("keeps the saved name for targets Linear no longer returns", () => {
    const rows = buildLinearMappingRows({
      teams: [],
      projects: [],
      mappings: [mapping({ linearId: "gone", linearName: "Archived" })],
    });
    expect(rows[0]).toMatchObject({ name: "Archived", teamKey: null });
  });
});

describe("upsertLinearMapping", () => {
  const draft = {
    kind: "team" as const,
    linearId: "t1",
    linearName: "Attraccess",
    projectId: pid("p2"),
    baseBranch: "  develop ",
  };

  it("adds a trimmed mapping with a fresh id", () => {
    expect(upsertLinearMapping([], draft, () => "new")).toEqual([
      {
        id: "new",
        kind: "team",
        linearId: "t1",
        linearName: "Attraccess",
        projectId: "p2",
        baseBranch: "develop",
      },
    ]);
  });

  it("omits an empty base branch", () => {
    const [created] = upsertLinearMapping([], { ...draft, baseBranch: " " }, () => "new");
    expect(created).not.toHaveProperty("baseBranch");
  });

  it("replaces the mapping for the same target instead of duplicating it", () => {
    const existing = mapping({ id: "keep", baseBranch: "main" });
    const next = upsertLinearMapping([existing], { ...draft, baseBranch: "" }, () => "unused");
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: "keep", projectId: "p2", linearName: "Attraccess" });
    expect(next[0]).not.toHaveProperty("baseBranch");
  });

  it("keeps a project mapping apart from a team mapping with the same id", () => {
    const next = upsertLinearMapping([mapping({})], { ...draft, kind: "project" }, () => "p");
    expect(next).toHaveLength(2);
  });
});

describe("removeLinearMapping", () => {
  it("drops only the named mapping", () => {
    expect(
      removeLinearMapping([mapping({ id: "a" }), mapping({ id: "b", linearId: "t2" })], "a").map(
        (entry) => entry.id,
      ),
    ).toEqual(["b"]);
  });
});

describe("firstStartedStateName", () => {
  it("names the lowest-position started state", () => {
    expect(
      firstStartedStateName([
        { name: "Todo", type: "unstarted", position: 1 },
        { name: "In Review", type: "started", position: 4 },
        { name: "In Progress", type: "started", position: 2 },
      ]),
    ).toBe("In Progress");
    expect(firstStartedStateName([])).toBeNull();
  });
});
