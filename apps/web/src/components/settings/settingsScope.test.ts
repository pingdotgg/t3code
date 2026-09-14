import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { checkoutKey, resolveSettingsProjectSuccessor } from "./ProjectSettingsPanel.logic";
import { derivePhysicalProjectKey } from "../../logicalProject";
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
  it("ignores the retired scope key from older links", () => {
    expect(validateSettingsScopeSearch({ scope: "device", project: "t3code" })).toEqual({
      project: "t3code",
    });
    expect(validateSettingsScopeSearch({ scope: "all" })).toEqual({});
  });

  it("retains legacy project and machine links without inventing an explicit broad scope", () => {
    expect(
      validateSettingsScopeSearch({ project: "t3code", machine: laptopId, unused: true }),
    ).toEqual({
      project: "t3code",
      machine: laptopId,
    });
  });

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
  it("defaults to every environment with no project", () => {
    expect(resolveSettingsScope({}, groups, environments)).toMatchObject({
      kind: "all",
      members: [],
      environmentIds: [laptopId, serverId],
    });
  });

  it("resolves one environment without targeting its project overrides", () => {
    expect(resolveSettingsScope({ machine: serverId }, groups, environments)).toMatchObject({
      kind: "environment",
      environmentId: serverId,
      environmentIds: [serverId],
      members: [],
    });
  });

  it("keeps all physical members in a project aggregate, including several on one environment", () => {
    expect(resolveSettingsScope({ project: "t3code" }, groups, environments)).toMatchObject({
      kind: "project",
      environmentId: null,
      members: [first, second, third],
      environmentIds: [laptopId, serverId],
    });
  });

  it("preserves legacy project plus machine aggregates with multiple checkouts", () => {
    expect(
      resolveSettingsScope({ project: "t3code", machine: laptopId }, groups, environments),
    ).toMatchObject({
      kind: "project",
      environmentId: laptopId,
      label: "t3code / Laptop",
      members: [first, second],
      environmentIds: [laptopId],
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

describe("folder recovery settings scope", () => {
  it("follows the same registration into its new group and path", () => {
    const moved = { ...first, workspaceRoot: "/renamed", physicalProjectKey: "laptop:/renamed" };
    const nextGroups = [group("t3code", [second, third]), group("renamed", [moved])];
    const resolved = resolveSettingsScope(
      { project: "t3code", machine: laptopId, checkout: checkoutKey(first) },
      nextGroups,
      environments,
    );
    expect(resolved).toMatchObject({
      kind: "checkout",
      members: [moved],
      group: { projectKey: "renamed" },
    });
  });

  it("does not broaden a deleted or wrong-environment registration", () => {
    for (const search of [
      { project: "t3code", checkout: checkoutKey({ ...first, id: "deleted" }) },
      { project: "t3code", machine: serverId, checkout: checkoutKey(first) },
    ]) {
      expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
        kind: "unavailable",
        members: [],
        environmentIds: [],
      });
    }
  });

  it("retains the conversation's exact ID when another registration represents the same path", () => {
    const hidden = { ...first, id: ProjectId.make("older") };
    const representative = { ...first, physicalProjectKey: derivePhysicalProjectKey(first) };
    const snapshot = {
      ...group("t3code", [representative]),
      memberProjectRefs: [
        { environmentId: first.environmentId, projectId: first.id },
        { environmentId: hidden.environmentId, projectId: hidden.id },
      ],
    };
    const resolved = resolveSettingsScope(
      { project: "t3code", checkout: checkoutKey(hidden) },
      [snapshot],
      environments,
      [hidden, first],
    );
    expect(resolved).toMatchObject({
      kind: "checkout",
      members: [{ id: hidden.id, workspaceRoot: hidden.workspaceRoot }],
    });
  });
});

it("recovers a legacy path selection after a remote move without selecting its sibling", () => {
  const moved = { ...first, workspaceRoot: "/renamed", physicalProjectKey: "laptop:/renamed" };
  const nextGroups = [group("t3code", [second, third]), group("renamed", [moved])];
  const original = resolveSettingsScope(
    { project: "t3code", checkout: first.physicalProjectKey },
    groups,
    environments,
  );
  const successor = resolveSettingsProjectSuccessor(
    nextGroups,
    original.members.map(checkoutKey),
    first.physicalProjectKey,
  );
  expect(successor).toEqual({ project: "renamed", checkout: checkoutKey(first) });
  expect(resolveSettingsScope(successor!, nextGroups, environments)).toMatchObject({
    kind: "checkout",
    members: [moved],
  });
  expect(
    resolveSettingsProjectSuccessor(
      [group("t3code", [second, third])],
      original.members.map(checkoutKey),
      first.physicalProjectKey,
    ),
  ).toBeNull();
});
