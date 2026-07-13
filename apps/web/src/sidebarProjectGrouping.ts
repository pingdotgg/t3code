import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import {
  deriveLogicalProjectKeyMap,
  derivePhysicalProjectKey,
  deriveProjectGroupLabel,
  type ProjectGroupingSettings,
} from "./logicalProject";
import type { Project } from "./types";

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  // True iff every non-primary member of this group lives in a
  // desktopLocal env (today: the WSL backend). The sidebar uses this
  // to differentiate "lives on this machine but in a sandbox" from
  // "lives on a real remote" so the project header can pick a
  // container icon instead of the generic cloud icon.
  allRemoteMembersAreDesktopLocal: boolean;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
}): Map<string, string> {
  return deriveLogicalProjectKeyMap(input.projects, input.settings);
}

export function buildSidebarProjectSnapshots(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  // Returns true when an env id maps to a desktopLocal saved-env
  // record (today: the WSL backend). Defaults to "false for every
  // env" so callers that don't care about the distinction get the
  // legacy behavior.
  isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
}): SidebarProjectSnapshot[] {
  const logicalKeyByPhysicalKey = deriveLogicalProjectKeyMap(input.projects, input.settings);
  const getLogicalKey = (project: Project): string =>
    logicalKeyByPhysicalKey.get(derivePhysicalProjectKey(project)) ??
    derivePhysicalProjectKey(project);
  const groupedMembers = new Map<string, SidebarProjectGroupMember[]>();
  for (const project of input.projects) {
    const logicalKey = getLogicalKey(project);
    const member: SidebarProjectGroupMember = {
      ...project,
      physicalProjectKey: derivePhysicalProjectKey(project),
      environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
    };
    const existing = groupedMembers.get(logicalKey);
    if (existing) {
      existing.push(member);
    } else {
      groupedMembers.set(logicalKey, [member]);
    }
  }

  const result: SidebarProjectSnapshot[] = [];
  const seen = new Set<string>();
  for (const project of input.projects) {
    const logicalKey = getLogicalKey(project);
    if (seen.has(logicalKey)) {
      continue;
    }
    seen.add(logicalKey);

    const members = groupedMembers.get(logicalKey) ?? [];
    const representative =
      (input.primaryEnvironmentId
        ? members.find((member) => member.environmentId === input.primaryEnvironmentId)
        : null) ?? members[0];
    if (!representative) {
      continue;
    }

    const hasLocal =
      input.primaryEnvironmentId !== null &&
      members.some((member) => member.environmentId === input.primaryEnvironmentId);
    const hasRemote =
      input.primaryEnvironmentId !== null
        ? members.some((member) => member.environmentId !== input.primaryEnvironmentId)
        : false;
    const remoteMembers = members.filter(
      (member) =>
        input.primaryEnvironmentId !== null && member.environmentId !== input.primaryEnvironmentId,
    );
    const remoteEnvironmentLabels = remoteMembers
      .flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : []))
      .filter((label, index, labels) => labels.indexOf(label) === index);
    const isDesktopLocal = input.isDesktopLocalEnvironment ?? (() => false);
    const allRemoteMembersAreDesktopLocal =
      remoteMembers.length > 0 &&
      remoteMembers.every((member) => isDesktopLocal(member.environmentId));

    result.push({
      ...representative,
      projectKey: logicalKey,
      displayName:
        members.length > 1
          ? deriveProjectGroupLabel({
              representative,
              members,
            })
          : representative.title,
      groupedProjectCount: members.length,
      environmentPresence:
        hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
      allRemoteMembersAreDesktopLocal,
      memberProjects: members,
      memberProjectRefs: members.map((member) => scopeProjectRef(member.environmentId, member.id)),
      remoteEnvironmentLabels,
    });
  }

  return result;
}
