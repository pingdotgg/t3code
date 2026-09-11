import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ClientSettings } from "@t3tools/contracts/settings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  buildProjectGroups,
  derivePhysicalProjectKey,
  type ProjectGroup,
  type ProjectGroupingSettings,
} from "../../logicalProject";
import {
  legacyProjectCwdPreferenceKey,
  resolveProjectExpanded,
  type UiProjectState,
} from "../../uiStateStore";

export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return wasEdited && memberTitles.some((title) => title !== nextTitle);
}

export function checkoutKey(member: { environmentId: string; id: string }): string {
  return JSON.stringify([member.environmentId, member.id]);
}

/** Follow a checkout even when relinking moves it out of a still-existing group. */
export function resolveSettingsProjectGroup(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
  projectKey: string,
  checkout?: string,
  projects: ReadonlyArray<EnvironmentProject> = [],
): SidebarProjectSnapshot | null {
  const selected =
    (checkout
      ? groups.find((group) =>
          group.memberProjectRefs.some(
            (ref) =>
              checkoutKey({ environmentId: ref.environmentId, id: ref.projectId }) === checkout,
          ),
        )
      : undefined) ??
    groups.find((group) => group.projectKey === projectKey) ??
    null;
  if (
    !selected ||
    !checkout ||
    selected.memberProjects.some((member) => checkoutKey(member) === checkout)
  ) {
    return selected;
  }
  const project = projects.find((item) => checkoutKey(item) === checkout);
  const member =
    project &&
    selected.memberProjects.find(
      (item) => item.physicalProjectKey === derivePhysicalProjectKey(project),
    );
  // Grouping hides older registrations, but their conversations still target their exact IDs.
  return project && member
    ? {
        ...selected,
        memberProjects: selected.memberProjects.map((item) =>
          item === member
            ? {
                ...project,
                physicalProjectKey: member.physicalProjectKey,
                environmentLabel: member.environmentLabel,
              }
            : item,
        ),
      }
    : selected;
}

export function relinkProjectGroupingSettings<T extends ProjectGroupingSettings>(
  settings: T,
  previous: EnvironmentProject,
  project: EnvironmentProject,
  projects: ReadonlyArray<EnvironmentProject>,
): T {
  const oldKey = derivePhysicalProjectKey(previous);
  const newKey = derivePhysicalProjectKey(project);
  const overrides = settings.sidebarProjectGroupingOverrides;
  if (oldKey === newKey || overrides[oldKey] === undefined) return settings;
  const nextOverrides = { ...overrides, [newKey]: overrides[newKey] ?? overrides[oldKey] };
  if (!projects.some((item) => derivePhysicalProjectKey(item) === oldKey)) {
    delete nextOverrides[oldKey];
  }
  return { ...settings, sidebarProjectGroupingOverrides: nextOverrides };
}

function expansionPreferenceKeys(group: ProjectGroup): string[] {
  return [
    group.key,
    ...group.members.map((member) => member.physicalProjectKey),
    ...group.members.map((member) => legacyProjectCwdPreferenceKey(member.project.workspaceRoot)),
  ];
}

/** Carry checkout preferences without moving a group that still has other members. */
export function relinkProjectPreferences(
  state: UiProjectState,
  input: {
    readonly previous: EnvironmentProject;
    readonly project: EnvironmentProject;
    readonly projects: ReadonlyArray<EnvironmentProject>;
    readonly settings: ProjectGroupingSettings &
      Pick<ClientSettings, "pullRequestMergeMethodOverrides">;
  },
) {
  const { previous, project, projects, settings } = input;
  const matches = (ref: { environmentId: string; projectId: string }) =>
    ref.environmentId === project.environmentId && ref.projectId === project.id;
  const beforeGroups = buildProjectGroups({
    projects: projects.map((item) =>
      matches({ environmentId: item.environmentId, projectId: item.id }) ? previous : item,
    ),
    settings,
  });
  const nextSettings = relinkProjectGroupingSettings(settings, previous, project, projects);
  const afterGroups = buildProjectGroups({
    projects,
    settings: nextSettings,
  });
  const before = beforeGroups.find((group) => group.memberProjectRefs.some(matches));
  const after = afterGroups.find((group) => group.memberProjectRefs.some(matches));
  if (!before || !after) return { uiState: state, settings: nextSettings };

  const oldKey = derivePhysicalProjectKey(previous);
  const newKey = derivePhysicalProjectKey(project);
  const oldPhysicalRemains = projects.some((item) => derivePhysicalProjectKey(item) === oldKey);
  const oldGroupRemains = afterGroups.some((group) => group.key === before.key);
  const destinationExisted = beforeGroups.some(
    (group) => group.key === after.key && group.key !== before.key,
  );
  const hasDestinationPreference = expansionPreferenceKeys(after).some(
    (key) => state.projectExpandedById[key] !== undefined,
  );
  const mergeMethods = settings.pullRequestMergeMethodOverrides;
  const previousMergeMethod = mergeMethods[before.key];
  let nextMergeMethods = mergeMethods;
  if (before.key !== after.key && !oldGroupRemains && previousMergeMethod !== undefined) {
    const migrated = { ...mergeMethods };
    if (!destinationExisted) {
      migrated[after.key] = mergeMethods[after.key] ?? previousMergeMethod;
    }
    delete migrated[before.key];
    nextMergeMethods = migrated;
  }
  return {
    settings: { ...nextSettings, pullRequestMergeMethodOverrides: nextMergeMethods },
    uiState: {
      ...state,
      projectOrder: state.projectOrder.includes(newKey)
        ? state.projectOrder.filter((key) => oldPhysicalRemains || key !== oldKey)
        : state.projectOrder.flatMap((key) =>
            key === oldKey ? (oldPhysicalRemains ? [oldKey, newKey] : [newKey]) : [key],
          ),
      sidebarProjectScopeKey:
        state.sidebarProjectScopeKey === before.key && !oldGroupRemains
          ? after.key
          : state.sidebarProjectScopeKey,
      projectExpandedById:
        destinationExisted || hasDestinationPreference
          ? state.projectExpandedById
          : {
              ...state.projectExpandedById,
              [after.key]: resolveProjectExpanded(
                state.projectExpandedById,
                expansionPreferenceKeys(before),
              ),
            },
    },
  };
}
