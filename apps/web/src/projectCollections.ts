import {
  deriveLogicalProjectKeyFromSettings,
  resolveProjectGroupingMode,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { SidebarProjectGroupMember, SidebarProjectSnapshot } from "./sidebarProjectGrouping";

export const PROJECT_COLLECTIONS_STORAGE_KEY = "t3code:project-collections:v1";
export const PROJECT_COLLECTION_NAME_LIMIT = 80;

export type CollectionMember =
  | { readonly kind: "scratch" }
  | {
      readonly kind: "project";
      readonly physicalKey: string;
      readonly label: string;
      readonly repositoryKey: string | null;
      readonly repositoryPathKey: string | null;
    };

export interface ProjectCollection {
  readonly id: string;
  readonly name: string;
  readonly members: readonly CollectionMember[];
}

export interface ProjectCollectionScope {
  readonly key: string | null;
  readonly catalog: readonly SidebarProjectSnapshot[];
  readonly groups: readonly SidebarProjectSnapshot[] | null;
  readonly projectKeys: ReadonlySet<string> | null;
}

export function projectCollectionNameError(
  name: string,
  collections: readonly ProjectCollection[],
  id: string | null,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a group name.";
  if (trimmed.length > PROJECT_COLLECTION_NAME_LIMIT) return "Use 80 characters or fewer.";
  if (trimmed.toLowerCase() === "all") return "All is reserved.";
  if (
    collections.some(
      (group) => group.id !== id && group.name.toLowerCase() === trimmed.toLowerCase(),
    )
  ) {
    return "A group with this name already exists.";
  }
  return null;
}

function parseMember(value: unknown): CollectionMember | null {
  if (!value || typeof value !== "object" || !("kind" in value)) return null;
  if (value.kind === "scratch") return { kind: "scratch" };
  if (
    value.kind !== "project" ||
    !("physicalKey" in value) ||
    typeof value.physicalKey !== "string" ||
    !value.physicalKey ||
    !("label" in value) ||
    typeof value.label !== "string" ||
    !("repositoryKey" in value) ||
    (value.repositoryKey !== null && typeof value.repositoryKey !== "string") ||
    !("repositoryPathKey" in value) ||
    (value.repositoryPathKey !== null && typeof value.repositoryPathKey !== "string")
  )
    return null;
  return {
    kind: "project",
    physicalKey: value.physicalKey,
    label: value.label,
    repositoryKey: value.repositoryKey || null,
    repositoryPathKey: value.repositoryPathKey || null,
  };
}

export function collectionMemberKey(member: CollectionMember): string {
  return member.kind === "scratch" ? "scratch" : member.physicalKey;
}

export function parseProjectCollections(value: unknown): readonly ProjectCollection[] {
  if (!Array.isArray(value)) return [];
  const collections: ProjectCollection[] = [];
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !entry.id ||
      !("name" in entry) ||
      typeof entry.name !== "string" ||
      !("members" in entry) ||
      !Array.isArray(entry.members) ||
      collections.some((group) => group.id === entry.id) ||
      projectCollectionNameError(entry.name, collections, null)
    )
      continue;
    const members = new Map<string, CollectionMember>();
    for (const raw of entry.members) {
      const member = parseMember(raw);
      if (member) members.set(collectionMemberKey(member), member);
    }
    collections.push({ id: entry.id, name: entry.name.trim(), members: [...members.values()] });
  }
  return collections;
}

function captureProject(
  project: SidebarProjectGroupMember,
): Extract<CollectionMember, { kind: "project" }> {
  const alias = (mode: "repository" | "repository_path") => {
    const key = deriveLogicalProjectKeyFromSettings(project, {
      sidebarProjectGroupingMode: mode,
      sidebarProjectGroupingOverrides: {},
    });
    return key === project.physicalProjectKey ? null : key;
  };
  return {
    kind: "project",
    physicalKey: project.physicalProjectKey,
    label: project.title,
    repositoryKey: alias("repository"),
    repositoryPathKey: alias("repository_path"),
  };
}

export function collectionMemberMatchesRow(
  member: CollectionMember,
  row: SidebarProjectSnapshot,
  settings: ProjectGroupingSettings,
): boolean {
  if (member.kind === "scratch") return row.isScratch === true;
  if (row.isScratch) return false;
  return row.memberProjects.some((project) => {
    if (project.physicalProjectKey === member.physicalKey) return true;
    const mode = resolveProjectGroupingMode(project, settings);
    return (
      (mode === "repository"
        ? member.repositoryKey
        : mode === "repository_path"
          ? member.repositoryPathKey
          : null) === row.projectKey
    );
  });
}

export function editProjectCollectionMembers(input: {
  readonly members: readonly CollectionMember[];
  readonly catalog: readonly SidebarProjectSnapshot[];
  readonly settings: ProjectGroupingSettings;
  readonly selectedProjectKeys: ReadonlySet<string>;
  readonly removedMemberKeys: ReadonlySet<string>;
}): readonly CollectionMember[] {
  const members = input.members.filter(
    (member) =>
      !input.removedMemberKeys.has(collectionMemberKey(member)) &&
      !input.catalog.some(
        (row) =>
          !input.selectedProjectKeys.has(row.projectKey) &&
          collectionMemberMatchesRow(member, row, input.settings),
      ),
  );
  for (const row of input.catalog) {
    if (
      !input.selectedProjectKeys.has(row.projectKey) ||
      members.some((member) => collectionMemberMatchesRow(member, row, input.settings))
    )
      continue;
    members.push(
      ...(row.isScratch
        ? [{ kind: "scratch" } satisfies CollectionMember]
        : row.memberProjects.map(captureProject)),
    );
  }
  return [...new Map(members.map((member) => [collectionMemberKey(member), member])).values()];
}

export function mergeCollectionMemberAliases(
  members: readonly CollectionMember[],
  authoritative: readonly CollectionMember[],
): readonly CollectionMember[] {
  const byKey = new Map(authoritative.map((member) => [collectionMemberKey(member), member]));
  let changed = false;
  const next = members.map((member) => {
    if (member.kind === "scratch") return member;
    const current = byKey.get(member.physicalKey);
    if (current?.kind !== "project") return member;
    const repositoryKey = current.repositoryKey ?? member.repositoryKey;
    const repositoryPathKey = current.repositoryPathKey ?? member.repositoryPathKey;
    if (repositoryKey === member.repositoryKey && repositoryPathKey === member.repositoryPathKey)
      return member;
    changed = true;
    return { ...member, repositoryKey, repositoryPathKey };
  });
  return changed ? next : members;
}

export function learnProjectCollectionAliases(
  collections: readonly ProjectCollection[],
  catalog: readonly SidebarProjectSnapshot[],
): readonly ProjectCollection[] {
  const projects = new Map(
    catalog.flatMap((row) =>
      row.memberProjects.map((project) => [project.physicalProjectKey, project] as const),
    ),
  );
  let changed = false;
  const next = collections.map((collection) => {
    let collectionChanged = false;
    const members = collection.members.map((member) => {
      if (member.kind === "scratch") return member;
      const project = projects.get(member.physicalKey);
      if (!project) return member;
      const captured = captureProject(project);
      const repositoryKey = captured.repositoryKey ?? member.repositoryKey;
      const repositoryPathKey = captured.repositoryPathKey ?? member.repositoryPathKey;
      if (repositoryKey === member.repositoryKey && repositoryPathKey === member.repositoryPathKey)
        return member;
      collectionChanged = true;
      return { ...member, repositoryKey, repositoryPathKey };
    });
    if (!collectionChanged) return collection;
    changed = true;
    return { ...collection, members };
  });
  return changed ? next : collections;
}

export function resolveProjectCollectionScope(input: {
  readonly collections: readonly ProjectCollection[];
  readonly activeCollectionId: string | null;
  readonly catalog: readonly SidebarProjectSnapshot[];
  readonly settings: ProjectGroupingSettings;
  readonly adHocProjectKeys: readonly string[];
}): ProjectCollectionScope {
  const collection = input.collections.find((group) => group.id === input.activeCollectionId);
  const catalog = collection
    ? input.catalog.filter((row) =>
        collection.members.some((member) =>
          collectionMemberMatchesRow(member, row, input.settings),
        ),
      )
    : input.catalog;
  const narrowed = catalog.filter((row) => input.adHocProjectKeys.includes(row.projectKey));
  const groups = narrowed.length > 0 ? narrowed : collection ? catalog : null;
  const projectKeys =
    groups === null
      ? null
      : new Set(
          groups.flatMap((row) =>
            row.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
          ),
        );
  return {
    catalog,
    groups,
    projectKeys,
    key:
      projectKeys === null
        ? null
        : JSON.stringify([
            collection?.id ?? null,
            collection?.members ?? null,
            [...projectKeys].sort(),
          ]),
  };
}
