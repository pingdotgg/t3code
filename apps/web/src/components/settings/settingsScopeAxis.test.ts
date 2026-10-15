import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  environmentAxisValue,
  projectAxisValue,
  projectScopeMenuGroups,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeEnvironmentLabel,
} from "./settingsScopeAxis";

const first = {
  environmentId: EnvironmentId.make("first"),
  label: "Development",
  displayUrl: "https://first.example.com",
};
const second = {
  environmentId: EnvironmentId.make("second"),
  label: "Development",
  displayUrl: "https://second.example.com",
};

describe("settings scope environment labels", () => {
  it("distinguishes same-name environments by address", () => {
    const environments = [first, second];
    expect(
      environments.map((environment) => settingsScopeEnvironmentLabel(environment, environments)),
    ).toEqual([
      "Development · https://first.example.com",
      "Development · https://second.example.com",
    ]);
  });

  it("falls back to environment IDs when duplicate names have no display URL", () => {
    const environments = [first, second].map((environment) => ({
      ...environment,
      displayUrl: null,
    }));
    expect(
      environments.map((environment) => settingsScopeEnvironmentLabel(environment, environments)),
    ).toEqual(["Development · first", "Development · second"]);
  });

  it("keeps unique names compact and removes disambiguation after a rename", () => {
    expect(settingsScopeEnvironmentLabel(first, [first])).toBe("Development");
    expect(settingsScopeEnvironmentLabel(first, [first, { ...second, label: "Production" }])).toBe(
      "Development",
    );
  });
});

describe("settings scope axes", () => {
  it("maps each axis to its search key and back", () => {
    expect(projectAxisValue({})).toBe("all");
    expect(projectAxisValue({ project: "app" })).toBe("app");
    expect(selectProjectAxis({ machine: "second" }, "app")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis({ machine: "second", project: "app" }, "all")).toEqual({
      machine: "second",
    });
    expect(selectEnvironmentAxis({ project: "app" }, "first")).toEqual({
      project: "app",
      machine: "first",
    });
    expect(selectEnvironmentAxis({ project: "app", machine: "first" }, "all")).toEqual({
      project: "app",
    });
  });

  it("drops a checkout narrowing from older links when either axis changes", () => {
    const checkout = { project: "app", checkout: "app@first", machine: "first" };
    expect(selectEnvironmentAxis(checkout, "second")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis(checkout, "app")).toEqual({ project: "app", machine: "first" });
  });
});

describe("environmentAxisValue", () => {
  it("shows the checkout's environment for a legacy checkout link", () => {
    expect(environmentAxisValue({ project: "p", checkout: "c" }, "laptop")).toBe("laptop");
    expect(environmentAxisValue({ project: "p" }, null)).toBe("all");
    expect(environmentAxisValue({ machine: "desk" }, "laptop")).toBe("desk");
  });
});

describe("settings project picker", () => {
  const fedora = EnvironmentId.make("fedora");
  const laptop = EnvironmentId.make("laptop");

  function group(projectKey: string, environmentIds: readonly EnvironmentId[]) {
    const members = environmentIds.map((environmentId) => ({
      id: ProjectId.make(`${projectKey}-${environmentId}`),
      environmentId,
      title: projectKey,
      workspaceRoot: `/repos/${projectKey}`,
      physicalProjectKey: `${environmentId}:/repos/${projectKey}`,
      environmentLabel: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T00:00:00.000Z",
    }));
    return {
      ...members[0]!,
      projectKey,
      displayName: projectKey,
      memberProjects: members,
      memberProjectRefs: members.map((member) => ({
        environmentId: member.environmentId,
        projectId: member.id,
      })),
      groupedProjectCount: members.length,
      environmentPresence: "mixed",
      allRemoteMembersAreDesktopLocal: false,
      allRemoteMembersAreWsl: false,
      remoteEnvironmentLabels: [],
    } as unknown as SidebarProjectSnapshot;
  }

  const groups = [
    group("api", [fedora]),
    group("shared", [laptop, fedora]),
    group("notes", [laptop]),
  ];
  const keys = (search: { machine?: string }) =>
    projectScopeMenuGroups(groups, search).map((entry) => entry.projectKey);

  it("lists only projects with a checkout on the chosen environment", () => {
    expect(keys({ machine: fedora })).toEqual(["api", "shared"]);
    expect(keys({ machine: laptop })).toEqual(["shared", "notes"]);
  });

  it("lists every project across all environments", () => {
    expect(keys({})).toEqual(["api", "shared", "notes"]);
  });
});
