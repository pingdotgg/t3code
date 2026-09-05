import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
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
export function resolveSettingsProjectGroup<
  T extends {
    projectKey: string;
    memberProjects: ReadonlyArray<{ environmentId: string; id: string }>;
  },
>(groups: ReadonlyArray<T>, projectKey: string, checkout?: string): T | null {
  return (
    (checkout
      ? groups.find((group) =>
          group.memberProjects.some((member) => checkoutKey(member) === checkout),
        )
      : undefined) ??
    groups.find((group) => group.projectKey === projectKey) ??
    null
  );
}

export function relinkProjectGroupingSettings(
  settings: ProjectGroupingSettings,
  previous: EnvironmentProject,
  project: EnvironmentProject,
): ProjectGroupingSettings {
  const oldKey = derivePhysicalProjectKey(previous);
  const newKey = derivePhysicalProjectKey(project);
  const overrides = settings.sidebarProjectGroupingOverrides;
  if (oldKey === newKey || overrides[oldKey] === undefined) return settings;
  const nextOverrides = { ...overrides, [newKey]: overrides[oldKey] };
  delete nextOverrides[oldKey];
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
export function relinkProjectUiState(
  state: UiProjectState,
  input: {
    readonly previous: EnvironmentProject;
    readonly project: EnvironmentProject;
    readonly projects: ReadonlyArray<EnvironmentProject>;
    readonly settings: ProjectGroupingSettings;
  },
): UiProjectState {
  const { previous, project, projects, settings } = input;
  const matches = (ref: { environmentId: string; projectId: string }) =>
    ref.environmentId === project.environmentId && ref.projectId === project.id;
  const beforeGroups = buildProjectGroups({
    projects: projects.map((item) =>
      matches({ environmentId: item.environmentId, projectId: item.id }) ? previous : item,
    ),
    settings,
  });
  const afterGroups = buildProjectGroups({
    projects,
    settings: relinkProjectGroupingSettings(settings, previous, project),
  });
  const before = beforeGroups.find((group) => group.memberProjectRefs.some(matches));
  const after = afterGroups.find((group) => group.memberProjectRefs.some(matches));
  if (!before || !after) return state;

  const oldKey = derivePhysicalProjectKey(previous);
  const newKey = derivePhysicalProjectKey(project);
  const oldGroupRemains = afterGroups.some((group) => group.key === before.key);
  const destinationExisted = beforeGroups.some(
    (group) => group.key === after.key && group.key !== before.key,
  );
  const hasDestinationPreference = expansionPreferenceKeys(after).some(
    (key) => state.projectExpandedById[key] !== undefined,
  );
  return {
    ...state,
    projectOrder: state.projectOrder.map((key) => (key === oldKey ? newKey : key)),
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
  };
}
