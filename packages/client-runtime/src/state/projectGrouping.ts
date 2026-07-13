import { scopedProjectKey, scopeProjectRef } from "../environment/scoped.ts";
import type { ScopedProjectRef, SidebarProjectGroupingMode } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";

import type { EnvironmentProject } from "./models.ts";
import { normalizeProjectPathForComparison } from "./projects.ts";

export interface ProjectGroupingSettings {
  readonly sidebarProjectGroupingMode: SidebarProjectGroupingMode;
  readonly sidebarProjectGroupingOverrides: Record<string, SidebarProjectGroupingMode>;
}

export type ProjectGroupingMode = SidebarProjectGroupingMode;

type GroupableProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity"
>;

export function selectProjectGroupingSettings(settings: ClientSettings): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  };
}

function uniqueNonEmptyValues(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function deriveRepositoryRelativeProjectPath(
  project: Pick<EnvironmentProject, "workspaceRoot" | "repositoryIdentity">,
): string | null {
  const rootPath = project.repositoryIdentity?.rootPath?.trim();
  if (!rootPath) {
    return null;
  }

  const normalizedProjectPath = normalizeProjectPathForComparison(project.workspaceRoot);
  const normalizedRootPath = normalizeProjectPathForComparison(rootPath);
  if (normalizedProjectPath.length === 0 || normalizedRootPath.length === 0) {
    return null;
  }

  if (normalizedProjectPath === normalizedRootPath) {
    return "";
  }

  const separator = normalizedRootPath.includes("\\") ? "\\" : "/";
  const rootPrefix = `${normalizedRootPath}${separator}`;
  if (!normalizedProjectPath.startsWith(rootPrefix)) {
    return null;
  }

  return normalizedProjectPath.slice(rootPrefix.length).replaceAll("\\", "/");
}

export function derivePhysicalProjectKeyFromPath(environmentId: string, cwd: string): string {
  return `${environmentId}:${normalizeProjectPathForComparison(cwd)}`;
}

export function derivePhysicalProjectKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKeyFromPath(project.environmentId, project.workspaceRoot);
}

export function deriveProjectGroupingOverrideKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKey(project);
}

export function getProjectOrderKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKey(project);
}

export function resolveProjectGroupingMode(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
  settings: ProjectGroupingSettings,
): SidebarProjectGroupingMode {
  return (
    settings.sidebarProjectGroupingOverrides?.[deriveProjectGroupingOverrideKey(project)] ??
    settings.sidebarProjectGroupingMode
  );
}

function deriveRepositoryScopedKeys(
  project: Pick<EnvironmentProject, "workspaceRoot" | "repositoryIdentity">,
  groupingMode: SidebarProjectGroupingMode,
): string[] {
  const canonicalKey = project.repositoryIdentity?.canonicalKey;
  if (!canonicalKey) {
    return [];
  }

  const repositoryKeys = uniqueNonEmptyValues([
    canonicalKey,
    ...(project.repositoryIdentity?.remoteKeys ?? []),
  ]);

  if (groupingMode === "repository") {
    return repositoryKeys;
  }

  const relativeProjectPath = deriveRepositoryRelativeProjectPath(project);
  if (relativeProjectPath === null) {
    return repositoryKeys;
  }

  return relativeProjectPath.length === 0
    ? repositoryKeys
    : repositoryKeys.map((repositoryKey) => `${repositoryKey}::${relativeProjectPath}`);
}

function deriveRepositoryScopedKey(
  project: Pick<EnvironmentProject, "workspaceRoot" | "repositoryIdentity">,
  groupingMode: SidebarProjectGroupingMode,
): string | null {
  return deriveRepositoryScopedKeys(project, groupingMode)[0] ?? null;
}

export function deriveLogicalProjectKey(
  project: Pick<
    EnvironmentProject,
    "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity"
  >,
  options?: {
    readonly groupingMode?: SidebarProjectGroupingMode;
  },
): string {
  const groupingMode = options?.groupingMode ?? "repository";
  if (groupingMode === "separate") {
    return derivePhysicalProjectKey(project);
  }

  return (
    deriveRepositoryScopedKey(project, groupingMode) ??
    derivePhysicalProjectKey(project) ??
    scopedProjectKey(scopeProjectRef(project.environmentId, project.id))
  );
}

export function deriveLogicalProjectKeyFromSettings(
  project: Pick<
    EnvironmentProject,
    "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity"
  >,
  settings: ProjectGroupingSettings,
): string {
  return deriveLogicalProjectKey(project, {
    groupingMode: resolveProjectGroupingMode(project, settings),
  });
}

/**
 * Resolve logical keys for a complete project collection. Repository identities
 * advertise every configured remote so a fork-only clone can join a checkout
 * whose preferred identity comes from `upstream`.
 */
export function deriveLogicalProjectKeyMap(
  projects: ReadonlyArray<GroupableProject>,
  settings: ProjectGroupingSettings,
): Map<string, string> {
  const entries = projects.map((project) => {
    const groupingMode = resolveProjectGroupingMode(project, settings);
    return {
      project,
      physicalKey: derivePhysicalProjectKey(project),
      logicalKey: deriveLogicalProjectKey(project, { groupingMode }),
      repositoryKeys:
        groupingMode === "separate" ? [] : deriveRepositoryScopedKeys(project, groupingMode),
    };
  });
  const parents = entries.map((_entry, index) => index);

  const findRoot = (index: number): number => {
    let root = index;
    while (parents[root] !== root) {
      root = parents[root]!;
    }
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = findRoot(left);
    const rightRoot = findRoot(right);
    if (leftRoot !== rightRoot) {
      parents[rightRoot] = leftRoot;
    }
  };

  const firstProjectByRepositoryKey = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    for (const repositoryKey of entry.repositoryKeys) {
      const existingIndex = firstProjectByRepositoryKey.get(repositoryKey);
      if (existingIndex === undefined) {
        firstProjectByRepositoryKey.set(repositoryKey, index);
      } else {
        union(existingIndex, index);
      }
    }
  }

  const componentMembers = new Map<number, number[]>();
  for (const index of entries.keys()) {
    const root = findRoot(index);
    const members = componentMembers.get(root);
    if (members) {
      members.push(index);
    } else {
      componentMembers.set(root, [index]);
    }
  }

  const logicalKeyByComponent = new Map<number, string>();
  for (const [root, memberIndexes] of componentMembers) {
    const representativeIndex = memberIndexes.toSorted((leftIndex, rightIndex) => {
      const left = entries[leftIndex]!;
      const right = entries[rightIndex]!;
      const upstreamPreference =
        Number(right.project.repositoryIdentity?.locator.remoteName === "upstream") -
        Number(left.project.repositoryIdentity?.locator.remoteName === "upstream");
      if (upstreamPreference !== 0) {
        return upstreamPreference;
      }

      const remoteCountPreference = right.repositoryKeys.length - left.repositoryKeys.length;
      if (remoteCountPreference !== 0) {
        return remoteCountPreference;
      }

      return left.logicalKey.localeCompare(right.logicalKey);
    })[0]!;
    logicalKeyByComponent.set(root, entries[representativeIndex]!.logicalKey);
  }

  return new Map(
    entries.map((entry, index) => [
      entry.physicalKey,
      logicalKeyByComponent.get(findRoot(index)) ?? entry.logicalKey,
    ]),
  );
}

export function deriveLogicalProjectKeyFromRef(
  projectRef: ScopedProjectRef,
  project:
    | Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity">
    | null
    | undefined,
  options?: {
    readonly groupingMode?: SidebarProjectGroupingMode;
  },
): string {
  return project ? deriveLogicalProjectKey(project, options) : scopedProjectKey(projectRef);
}

export function deriveProjectGroupLabel(input: {
  readonly representative: Pick<EnvironmentProject, "title" | "repositoryIdentity">;
  readonly members: ReadonlyArray<Pick<EnvironmentProject, "title" | "repositoryIdentity">>;
}): string {
  const sharedDisplayNames = uniqueNonEmptyValues(
    input.members.map((member) => member.repositoryIdentity?.displayName),
  );
  if (sharedDisplayNames.length === 1) {
    return sharedDisplayNames[0]!;
  }

  const sharedRepositoryNames = uniqueNonEmptyValues(
    input.members.map((member) => member.repositoryIdentity?.name),
  );
  if (sharedRepositoryNames.length === 1) {
    return sharedRepositoryNames[0]!;
  }

  return input.representative.title;
}
