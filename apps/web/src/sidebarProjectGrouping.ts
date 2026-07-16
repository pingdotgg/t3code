import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import {
  deriveLogicalProjectKeyFromSettings,
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

interface SidebarProjectGroupCandidate {
  readonly logicalKey: string;
  readonly project: Project;
}

function getProjectFreshnessTime(project: Project): number {
  const updatedAtTime = Date.parse(project.updatedAt);
  if (Number.isFinite(updatedAtTime)) {
    return updatedAtTime;
  }
  const createdAtTime = Date.parse(project.createdAt);
  return Number.isFinite(createdAtTime) ? createdAtTime : 0;
}

function shouldReplaceDuplicateMember(input: {
  existingMember: Project;
  candidateMember: Project;
  primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  if (
    input.primaryEnvironmentId !== null &&
    input.existingMember.environmentId !== input.primaryEnvironmentId &&
    input.candidateMember.environmentId === input.primaryEnvironmentId
  ) {
    return true;
  }

  const existingFreshness = getProjectFreshnessTime(input.existingMember);
  const candidateFreshness = getProjectFreshnessTime(input.candidateMember);
  if (candidateFreshness !== existingFreshness) {
    return candidateFreshness > existingFreshness;
  }

  return input.candidateMember.id > input.existingMember.id;
}

function collectProjectWinnersByPhysicalKey(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): Map<string, SidebarProjectGroupCandidate> {
  const winnersByPhysicalKey = new Map<string, SidebarProjectGroupCandidate>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.settings);
    const physicalProjectKey = derivePhysicalProjectKey(project);
    const existing = winnersByPhysicalKey.get(physicalProjectKey);
    if (!existing) {
      winnersByPhysicalKey.set(physicalProjectKey, { logicalKey, project });
      continue;
    }
    if (
      shouldReplaceDuplicateMember({
        existingMember: existing.project,
        candidateMember: project,
        primaryEnvironmentId: input.primaryEnvironmentId,
      })
    ) {
      winnersByPhysicalKey.set(physicalProjectKey, { logicalKey, project });
    }
  }
  return winnersByPhysicalKey;
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const [physicalProjectKey, winner] of collectProjectWinnersByPhysicalKey(input)) {
    mapping.set(physicalProjectKey, winner.logicalKey);
  }
  return mapping;
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
  const winnersByPhysicalKey = collectProjectWinnersByPhysicalKey(input);
  const groupedMembers = new Map<string, SidebarProjectGroupMember[]>();
  for (const { logicalKey, project } of winnersByPhysicalKey.values()) {
    const member: SidebarProjectGroupMember = {
      ...project,
      physicalProjectKey: derivePhysicalProjectKey(project),
      environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
    };
    const existingMembers = groupedMembers.get(logicalKey);
    if (existingMembers) {
      existingMembers.push(member);
    } else {
      groupedMembers.set(logicalKey, [member]);
    }
  }

  const result: SidebarProjectSnapshot[] = [];
  const seen = new Set<string>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.settings);
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
