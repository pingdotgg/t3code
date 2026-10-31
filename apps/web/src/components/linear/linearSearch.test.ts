import { describe, expect, it } from "vite-plus/test";

import {
  T3_ACTIVITY_VIEW,
  buildLinearBreadcrumb,
  buildLinearNewIssueUrl,
  clearLinearFilters,
  hasActiveLinearFilters,
  linearIssueFilter,
  linearLevel,
  linearParentScope,
  parseLinearSearch,
  patchLinearSearch,
  withLinearScope,
} from "./linearSearch";

describe("parseLinearSearch", () => {
  it("drops garbage, defaults, and orphaned deeper levels", () => {
    expect(parseLinearSearch({})).toEqual({});
    expect(
      parseLinearSearch({
        project: "p1",
        milestone: "m1",
        assignee: "me",
        group: "state",
        priority: ["1", 9, "x", 2],
        states: "s1",
        showCompleted: "true",
      }),
    ).toEqual({ priority: [1, 2], states: ["s1"], showCompleted: true });
  });

  it("keeps a full drill-down and filters", () => {
    expect(
      parseLinearSearch({
        team: "t1",
        project: "p1",
        milestone: "none",
        issue: "i1",
        q: " dst ",
        assignee: "any",
        group: "milestone",
        view: T3_ACTIVITY_VIEW,
        labelIds: ["a", "a", "b"],
      }),
    ).toEqual({
      team: "t1",
      project: "p1",
      milestone: "none",
      issue: "i1",
      q: "dst",
      assignee: "any",
      group: "milestone",
      view: T3_ACTIVITY_VIEW,
      labelIds: ["a", "b"],
    });
  });
});

describe("linearLevel and scope", () => {
  it("derives the level from the deepest scope", () => {
    expect(linearLevel({})).toBe("workspace");
    expect(linearLevel({ team: "t" })).toBe("team");
    expect(linearLevel({ team: "t", project: "p" })).toBe("project");
    expect(linearLevel({ team: "t", project: "p", milestone: "m" })).toBe("milestone");
  });

  it("walks up one level at a time", () => {
    expect(linearParentScope({})).toBeNull();
    expect(linearParentScope({ team: "t" })).toEqual({});
    expect(linearParentScope({ team: "t", project: "p" })).toEqual({ team: "t" });
    expect(linearParentScope({ team: "t", project: "p", milestone: "m" })).toEqual({
      team: "t",
      project: "p",
    });
  });

  it("keeps filters when drilling and closes the issue", () => {
    expect(
      withLinearScope(
        { team: "t", assignee: "any", issue: "i", states: ["s"], group: "none" },
        { team: "t", project: "p" },
      ),
    ).toEqual({ team: "t", project: "p", assignee: "any", states: ["s"], group: "none" });
  });

  it("drops team-specific filters when the team changes", () => {
    expect(
      withLinearScope(
        { team: "t", assignee: "any", states: ["s"], labelIds: ["l"], cycle: "c" },
        { team: "other" },
      ),
    ).toEqual({ team: "other", assignee: "any" });
  });
});

describe("buildLinearBreadcrumb", () => {
  it("builds Workspace > Team > Project > Milestone with the last one current", () => {
    const crumbs = buildLinearBreadcrumb(
      { team: "t", project: "p", milestone: "m" },
      { teamName: "Attraccess", projectName: "Attraccess project", milestoneName: "v1.12.0" },
    );
    expect(crumbs.map((crumb) => crumb.label)).toEqual([
      "Workspace",
      "Attraccess",
      "Attraccess project",
      "v1.12.0",
    ]);
    expect(crumbs.map((crumb) => crumb.current)).toEqual([false, false, false, true]);
    expect(crumbs[2]?.scope).toEqual({ team: "t", project: "p" });
  });

  it("falls back to ids and names the no-milestone bucket", () => {
    const crumbs = buildLinearBreadcrumb({ team: "t", project: "p", milestone: "none" }, {});
    expect(crumbs.map((crumb) => crumb.label)).toEqual(["Workspace", "t", "p", "No milestone"]);
  });
});

describe("linearIssueFilter", () => {
  it("defaults to my issues and hides completed work", () => {
    expect(
      linearIssueFilter({ team: "t", project: "p", milestone: "m" }, { activityIssueIds: [] }),
    ).toEqual({
      teamId: "t",
      projectId: "p",
      milestoneId: "m",
      assignee: "me",
    });
  });

  it("maps every control", () => {
    expect(
      linearIssueFilter(
        {
          team: "t",
          assignee: "any",
          states: ["s1"],
          priority: [1],
          labelIds: ["l"],
          cycle: "c",
          q: "dst",
          showCompleted: true,
        },
        { activityIssueIds: [] },
      ),
    ).toEqual({
      teamId: "t",
      stateIds: ["s1"],
      priorities: [1],
      labelIds: ["l"],
      cycleId: "c",
      text: "dst",
      includeCompleted: true,
    });
  });

  it("lets a custom view replace the other controls", () => {
    expect(
      linearIssueFilter(
        { team: "t", view: "v1", assignee: "u", states: ["s"] },
        { activityIssueIds: [] },
      ),
    ).toEqual({ teamId: "t", viewId: "v1" });
  });

  it("turns the T3 view into an issue id restriction", () => {
    expect(
      linearIssueFilter({ team: "t", view: T3_ACTIVITY_VIEW }, { activityIssueIds: ["a", "b"] }),
    ).toEqual({ teamId: "t", assignee: "me", issueIds: ["a", "b"] });
  });
});

describe("filter helpers", () => {
  it("reports and clears active filters but keeps the scope", () => {
    expect(hasActiveLinearFilters({ team: "t", group: "none" })).toBe(false);
    expect(hasActiveLinearFilters({ team: "t", q: "x" })).toBe(true);
    expect(clearLinearFilters({ team: "t", q: "x", assignee: "any", group: "none" })).toEqual({
      team: "t",
    });
  });

  it("patches and removes keys", () => {
    expect(patchLinearSearch({ team: "t", q: "x" }, { q: undefined, issue: "i" })).toEqual({
      team: "t",
      issue: "i",
    });
  });

  it("builds the external new-issue link", () => {
    expect(buildLinearNewIssueUrl("acme", undefined)).toBe("https://linear.app/acme/new");
    expect(buildLinearNewIssueUrl("acme", "ATT")).toBe("https://linear.app/acme/team/ATT/new");
    expect(buildLinearNewIssueUrl(null, "ATT")).toBeNull();
  });
});
