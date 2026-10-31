import { NO_MILESTONE_ID } from "@t3tools/client-runtime/linear/search";
import { describe, expect, it } from "vite-plus/test";

import {
  LINEAR_LINK_PATHS,
  linearDrillRoute,
  linearFiltersOf,
  linearScopeFromParams,
  linearSearchFor,
} from "./linearRoutes";

describe("linearDrillRoute", () => {
  it("maps each drill-down level to its stack route, and the workspace to none", () => {
    expect(linearDrillRoute("env", {})).toBeNull();
    expect(linearDrillRoute("env", { team: "t" })).toEqual({
      name: "LinearTeam",
      params: { environmentId: "env", teamId: "t" },
    });
    expect(linearDrillRoute("env", { team: "t", project: "p" })?.name).toBe("LinearProject");
    expect(
      linearDrillRoute("env", { team: "t", project: "p", milestone: NO_MILESTONE_ID }),
    ).toEqual({
      name: "LinearMilestone",
      params: { environmentId: "env", teamId: "t", projectId: "p", milestoneId: NO_MILESTONE_ID },
    });
  });

  it("round-trips through the params every link path names", () => {
    const scope = { team: "t", project: "p", milestone: "m" };
    const route = linearDrillRoute("env", scope)!;
    expect(linearScopeFromParams(route.params)).toEqual(scope);
    const names = LINEAR_LINK_PATHS[route.name].match(/:\w+/gu)?.map((name) => name.slice(1));
    expect(names?.sort()).toEqual(Object.keys(route.params).sort());
  });
});

describe("linearScopeFromParams", () => {
  it("ignores empty ids and levels whose parent is missing", () => {
    expect(linearScopeFromParams({ teamId: "", projectId: "p" })).toEqual({});
    expect(linearScopeFromParams({ projectId: "p", milestoneId: "m" })).toEqual({});
    expect(linearScopeFromParams({ teamId: "t", milestoneId: "m" })).toEqual({ team: "t" });
    expect(linearScopeFromParams({ teamId: ["t", "x"], projectId: "p" })).toEqual({
      team: "t",
      project: "p",
    });
  });
});

describe("session filters", () => {
  it("keeps filters while the route supplies the scope", () => {
    const filters = { assignee: "any", states: ["s1"], q: "bug" };
    expect(linearSearchFor({ team: "t" }, filters)).toEqual({ ...filters, team: "t" });
    expect(linearFiltersOf({ ...filters, team: "t", project: "p", issue: "i" })).toEqual(filters);
  });
});
