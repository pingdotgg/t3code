import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { resolveSettingsScope, validateSettingsScopeSearch } from "./settingsScope";

const laptopId = EnvironmentId.make("laptop");
const serverId = EnvironmentId.make("server");
const environments = [
  { environmentId: laptopId, label: "Laptop" },
  { environmentId: serverId, label: "Server" },
];

function member(id: string, environmentId: EnvironmentId): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "T3 Code",
    workspaceRoot: `/repos/${id}`,
    physicalProjectKey: `${environmentId}:/repos/${id}`,
    groupingRepositoryIdentity: null,
    environmentLabel:
      environments.find((environment) => environment.environmentId === environmentId)?.label ??
      null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

const first = member("first", laptopId);
const second = member("second", laptopId);
const third = member("third", serverId);
const other = member("other", serverId);

function group(
  projectKey: string,
  members: readonly SidebarProjectGroupMember[],
): SidebarProjectSnapshot {
  return {
    ...members[0]!,
    projectKey,
    displayName: projectKey,
    memberProjects: members,
    memberProjectRefs: members.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    groupedProjectCount: members.length,
    environmentPresence: "mixed",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    remoteEnvironmentLabels: [],
  };
}

const groups = [group("t3code", [first, second, third]), group("other", [other])];

describe("settings scope search", () => {
  it("retains an orphan checkout so it cannot turn into all environments", () => {
    const search = validateSettingsScopeSearch({ checkout: first.physicalProjectKey });
    expect(search).toEqual({ checkout: first.physicalProjectKey });
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "unavailable",
      reason: "project-required",
      members: [],
      environmentIds: [],
    });
  });
});

describe("settings scope resolution", () => {
  it("keeps all physical members in a project aggregate, including several on one environment", () => {
    expect(resolveSettingsScope({ project: "t3code" }, groups, environments)).toMatchObject({
      kind: "project",
      environmentId: null,
      members: [first, second, third],
      environmentIds: [laptopId, serverId],
    });
  });

  it("narrows a checkout target to exactly one member, deriving its environment when omitted", () => {
    expect(
      resolveSettingsScope(
        { project: "t3code", checkout: second.physicalProjectKey },
        groups,
        environments,
      ),
    ).toMatchObject({
      kind: "checkout",
      checkout: second,
      environmentId: laptopId,
      label: "t3code / Laptop · /repos/second",
      members: [second],
      environmentIds: [laptopId],
    });
  });

  it.each([
    { project: "missing" },
    { machine: "removed" },
    { project: "t3code", machine: "removed" },
    { project: "t3code", checkout: "deleted" },
    { project: "other", machine: laptopId },
    { project: "other", checkout: first.physicalProjectKey },
    { project: "t3code", machine: serverId, checkout: first.physicalProjectKey },
  ])("never widens an invalid or stale target: %j", (search) => {
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "unavailable",
      members: [],
      environmentIds: [],
    });
  });

  it("leaves a removed checkout unavailable while sibling checkouts remain", () => {
    const search = {
      project: "t3code",
      machine: laptopId,
      checkout: first.physicalProjectKey,
    };
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "checkout",
      members: [first],
    });
    expect(
      resolveSettingsScope(search, [group("t3code", [second, third])], environments),
    ).toMatchObject({ kind: "unavailable", members: [], environmentIds: [] });
  });

  it("does not select another environment after removing a project's last local checkout", () => {
    const search = { project: "t3code", machine: laptopId };
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "project",
      members: [first, second],
    });
    expect(resolveSettingsScope(search, [group("t3code", [third])], environments)).toMatchObject({
      kind: "unavailable",
      members: [],
      environmentIds: [],
    });
  });

  it("rejects a cached checkout whose environment was removed", () => {
    expect(
      resolveSettingsScope(
        { project: "t3code", checkout: third.physicalProjectKey },
        groups,
        environments.slice(0, 1),
      ),
    ).toMatchObject({
      kind: "unavailable",
      reason: "environment-missing",
      members: [],
      environmentIds: [],
    });
  });
});
