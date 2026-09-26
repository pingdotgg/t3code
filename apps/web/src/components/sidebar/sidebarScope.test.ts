import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { makeEnvironmentPresentation } from "~/test/environmentPresentation";
import {
  resolveSidebarScope,
  sidebarScopeIncludes,
  sidebarScopeProjectKeys,
  type SidebarScopeFilter,
} from "./sidebarScope";

function makeGroup(
  projectKey: string,
  memberProjectRefs: readonly ScopedProjectRef[],
): SidebarProjectSnapshot {
  const representative = memberProjectRefs[0]!;
  return {
    id: representative.projectId,
    environmentId: representative.environmentId,
    title: projectKey,
    workspaceRoot: `/tmp/${projectKey}`,
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    projectKey,
    displayName: projectKey,
    groupedProjectCount: memberProjectRefs.length,
    environmentPresence: "local-only",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    memberProjects: [],
    memberProjectRefs,
    remoteEnvironmentLabels: [],
  };
}

const laptop = EnvironmentId.make("laptop");
const desk = EnvironmentId.make("desk");
const retired = EnvironmentId.make("retired");
const items = [
  makeEnvironmentPresentation({ id: laptop }),
  makeEnvironmentPresentation({ id: desk }),
];
const shared = makeGroup("github.com/example/shared", [
  { environmentId: laptop, projectId: ProjectId.make("shared-laptop") },
  { environmentId: desk, projectId: ProjectId.make("shared-desk") },
]);
const deskOnly = makeGroup("desk:/srv/tools", [
  { environmentId: desk, projectId: ProjectId.make("tools") },
]);
const groups = [shared, deskOnly];
const resolve = (overrides: Partial<Parameters<typeof resolveSidebarScope>[0]>) =>
  resolveSidebarScope({
    environmentScopeId: null,
    projectScopeKey: null,
    environmentItems: items,
    projectGroups: groups,
    snapshotsReady: true,
    ...overrides,
  });

describe("resolveSidebarScope", () => {
  it("narrows the folder menu to groups with a member on the scoped environment", () => {
    const scope = resolve({ environmentScopeId: laptop });

    expect(scope.environment).toBe(items[0]);
    expect(scope.projectGroups).toEqual([shared]);
    expect(scope.key).toBe("laptop:all");
  });

  it("hands back the input group array and null axes when nothing is scoped, so memos keyed on them stay stable", () => {
    const scope = resolve({});

    expect(scope.projectGroups).toBe(groups);
    expect(scope.environment).toBeNull();
    expect(scope.projectGroup).toBeNull();
    // A fresh group list must not turn an unscoped sidebar into a scoped one.
    const regrouped = resolve({ projectGroups: [...groups] });
    expect(regrouped.environment).toBeNull();
    expect(regrouped.projectGroup).toBeNull();
    expect(regrouped.key).toBe(scope.key);
  });

  it("reads a stored environment that is no longer a choice as all environments, stale only once snapshots are ready", () => {
    const pending = resolve({ environmentScopeId: retired, snapshotsReady: false });

    expect(pending.environment).toBeNull();
    expect(pending.projectGroups).toBe(groups);
    expect(
      pending.stale.environment,
      "clearing before proof would wipe a scope mid cold start",
    ).toBe(false);
    expect(resolve({ environmentScopeId: retired }).stale.environment).toBe(true);
  });

  it("never keeps an active scope behind a hidden control: no items means null and stale", () => {
    const scope = resolve({ environmentScopeId: laptop, environmentItems: [] });

    expect(scope.environment).toBeNull();
    expect(scope.stale.environment).toBe(true);
  });

  it("keeps a project scope alive when its environment scope dies", () => {
    const scope = resolve({ environmentScopeId: retired, projectScopeKey: deskOnly.projectKey });

    expect(scope.projectGroup).toBe(deskOnly);
    expect(scope.stale.project).toBe(false);
  });

  it("drops a project group with no member on the scoped environment, behind the same readiness gate", () => {
    const pending = resolve({
      environmentScopeId: laptop,
      projectScopeKey: deskOnly.projectKey,
      snapshotsReady: false,
    });

    expect(pending.projectGroup).toBeNull();
    expect(pending.stale.project, "the scoped machine's snapshot may not have arrived yet").toBe(
      false,
    );
    expect(
      resolve({ environmentScopeId: laptop, projectScopeKey: deskOnly.projectKey }).stale.project,
    ).toBe(true);
  });

  it("keys on effective values so a dropped stored key does not reset paging or selection", () => {
    expect(resolve({ environmentScopeId: retired, projectScopeKey: "gone" }).key).toBe("all:all");
    expect(resolve({ environmentScopeId: desk, projectScopeKey: shared.projectKey }).key).toBe(
      `desk:${shared.projectKey}`,
    );
  });
});

describe("sidebarScopeProjectKeys", () => {
  it("collects the physical keys of the scoped group's members on every machine", () => {
    expect(sidebarScopeProjectKeys(shared)).toEqual(
      new Set(["laptop:shared-laptop", "desk:shared-desk"]),
    );
  });

  it("is null, not an empty set, when no project is scoped", () => {
    expect(sidebarScopeProjectKeys(null)).toBeNull();
  });
});

describe("sidebarScopeIncludes", () => {
  const onLaptop = { environmentId: laptop, projectId: ProjectId.make("app") };
  const onDesk = { environmentId: desk, projectId: ProjectId.make("app") };
  const strayOnLaptop = { environmentId: laptop, projectId: ProjectId.make("scratch") };
  const appKeys = new Set(["laptop:app", "desk:app"]);
  const admitted = (filter: SidebarScopeFilter) =>
    [onLaptop, onDesk, strayOnLaptop].filter((ref) => sidebarScopeIncludes(filter, ref));

  it("admits everything when neither axis is set", () => {
    expect(admitted({ environmentId: null, projectKeys: null })).toEqual([
      onLaptop,
      onDesk,
      strayOnLaptop,
    ]);
  });

  it("admits any project on the scoped environment, even one the group list does not know yet", () => {
    expect(admitted({ environmentId: laptop, projectKeys: null })).toEqual([
      onLaptop,
      strayOnLaptop,
    ]);
  });

  it("admits the scoped group's members on every machine when only a project is set", () => {
    expect(admitted({ environmentId: null, projectKeys: appKeys })).toEqual([onLaptop, onDesk]);
  });

  it("requires both axes when both are set", () => {
    expect(admitted({ environmentId: laptop, projectKeys: appKeys })).toEqual([onLaptop]);
  });
});
