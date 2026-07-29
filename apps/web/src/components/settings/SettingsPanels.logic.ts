import type {
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
  UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { Project, ThreadShell } from "../../types";

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
  readonly project: Project;
  readonly threads: readonly ThreadShell[];
}

export function buildArchivedThreadGroups(input: {
  readonly projects: readonly Project[];
  readonly threads: readonly ThreadShell[];
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
