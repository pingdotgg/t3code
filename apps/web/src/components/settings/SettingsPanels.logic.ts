import type {
  CollaborativeAcceptancePolicy,
  EnvironmentId,
  OrchestrationShellSnapshot,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
  UnifiedSettings,
} from "@t3tools/contracts";
import {
  DEFAULT_AUTO_ARCHIVE_SETTLED_AFTER_DAYS,
  DEFAULT_UNIFIED_SETTINGS,
  MAX_AUTO_ARCHIVE_SETTLED_AFTER_DAYS,
  MIN_AUTO_ARCHIVE_SETTLED_AFTER_DAYS,
} from "@t3tools/contracts/settings";
import type { Project, ThreadShell } from "../../types";

export type CollaborativeAcceptancePolicyPatch = Omit<
  Partial<CollaborativeAcceptancePolicy>,
  "reviewWorkflow" | "budgets"
> & {
  readonly reviewWorkflow?: Partial<CollaborativeAcceptancePolicy["reviewWorkflow"]>;
  readonly budgets?: Partial<CollaborativeAcceptancePolicy["budgets"]>;
};

export function mergeCollaborativeAcceptancePolicy(
  policy: CollaborativeAcceptancePolicy,
  patch: CollaborativeAcceptancePolicyPatch,
): CollaborativeAcceptancePolicy {
  return {
    ...policy,
    ...patch,
    reviewWorkflow: { ...policy.reviewWorkflow, ...patch.reviewWorkflow },
    budgets: { ...policy.budgets, ...patch.budgets },
  };
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): Partial<UnifiedSettings> {
  type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
  const legacyProviderDefaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  const legacyProviderDefault = input.isDefault ? legacyProviderDefaults[input.driver] : undefined;
  return {
    ...(legacyProviderDefault !== undefined
      ? {
          providers: {
            ...input.settings.providers,
            [input.driver]: legacyProviderDefault,
          } as ServerSettings["providers"],
        }
      : {}),
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}

export interface ArchivedThreadGroup {
  readonly project: Pick<Project, "id" | "environmentId" | "name" | "cwd">;
  readonly threads: ReadonlyArray<
    Pick<
      ThreadShell,
      "id" | "environmentId" | "projectId" | "title" | "archivedAt" | "createdAt" | "worktreePath"
    >
  >;
}

export function buildArchivedThreadGroupsFromSnapshots(input: {
  readonly snapshots: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly snapshot: OrchestrationShellSnapshot;
  }>;
}): readonly ArchivedThreadGroup[] {
  return buildArchivedThreadGroups({
    projects: input.snapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.projects.map((project) => ({
        id: project.id,
        environmentId,
        name: project.title,
        cwd: project.workspaceRoot,
      })),
    ),
    threads: input.snapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        id: thread.id,
        environmentId,
        projectId: thread.projectId,
        title: thread.title,
        createdAt: thread.createdAt,
        archivedAt: thread.archivedAt,
        worktreePath: thread.worktreePath,
      })),
    ),
  });
}

export function buildArchivedThreadGroups(input: {
  readonly projects: ReadonlyArray<ArchivedThreadGroup["project"]>;
  readonly threads: ReadonlyArray<ArchivedThreadGroup["threads"][number]>;
}): readonly ArchivedThreadGroup[] {
  return input.projects
    .map((project) => ({
      project,
      threads: input.threads
        .filter(
          (thread) =>
            thread.environmentId === project.environmentId &&
            thread.projectId === project.id &&
            thread.archivedAt !== null,
        )
        .toSorted((left, right) => {
          const leftKey = left.archivedAt ?? left.createdAt;
          const rightKey = right.archivedAt ?? right.createdAt;
          return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
        }),
    }))
    .filter((group) => group.threads.length > 0);
}

export function filterArchivedThreadGroups(
  groups: readonly ArchivedThreadGroup[],
  query: string,
): readonly ArchivedThreadGroup[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return groups;
  }

  return groups.flatMap((group) => {
    const projectMatches = group.project.name.toLocaleLowerCase().includes(normalizedQuery);
    const threads = projectMatches
      ? group.threads
      : group.threads.filter((thread) =>
          thread.title.toLocaleLowerCase().includes(normalizedQuery),
        );
    return threads.length > 0 ? [{ ...group, threads }] : [];
  });
}

/**
 * Resolves the raw `autoArchiveSettledAfterDays` setting for display. The
 * key may still be absent on older servers or until the contracts change
 * lands everywhere, so an absent value falls back to the default while an
 * explicit null keeps its "never archive" meaning.
 */
export function resolveAutoArchiveSettledAfterDays(raw: number | null | undefined): number | null {
  return raw === undefined ? DEFAULT_AUTO_ARCHIVE_SETTLED_AFTER_DAYS : raw;
}

/**
 * Parses the days-before-archive draft. Whole-string digits only so "3.5"
 * and "3days" are rejected instead of silently truncating; out-of-range
 * values return null and the caller keeps the previous setting.
 */
export function parseAutoArchiveSettledAfterDays(draft: string): number | null {
  const trimmed = draft.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_AUTO_ARCHIVE_SETTLED_AFTER_DAYS ||
    parsed > MAX_AUTO_ARCHIVE_SETTLED_AFTER_DAYS
  ) {
    return null;
  }
  return parsed;
}

export async function runSequentiallySettled<T>(
  items: readonly T[],
  operation: (item: T) => Promise<void>,
): Promise<ReadonlyArray<PromiseSettledResult<void>>> {
  const results: Array<PromiseSettledResult<void>> = [];
  for (const item of items) {
    try {
      await operation(item);
      results.push({ status: "fulfilled", value: undefined });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
  }
  return results;
}
