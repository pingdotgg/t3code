import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "./models.ts";

export type ProjectLastUsedSettingsThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "projectId" | "modelSelection" | "runtimeMode" | "interactionMode" | "updatedAt"
> & {
  readonly latestUserAuthoredMessageAt?: string | null;
  readonly lineage?: Pick<EnvironmentThreadShell["lineage"], "relationshipToParent">;
};

export interface ProjectLastUsedSettings {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * The composer settings of the project thread the user last wrote in. Agents
 * pick subagent settings, and a null latestUserAuthoredMessageAt marks a
 * thread only automation has written in, so neither says anything about the
 * user's choice. Servers that predate the field omit it; their threads fall
 * back to updatedAt and only count when no thread carries the field.
 */
export function resolveProjectLastUsedSettings(
  threads: ReadonlyArray<ProjectLastUsedSettingsThread>,
  project: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): ProjectLastUsedSettings | null {
  let authored: ProjectLastUsedSettingsThread | null = null;
  let authoredAt = "";
  let legacy: ProjectLastUsedSettingsThread | null = null;
  let legacyAt = "";
  for (const thread of threads) {
    if (
      thread.environmentId !== project.environmentId ||
      thread.projectId !== project.projectId ||
      thread.lineage?.relationshipToParent === "subagent" ||
      thread.latestUserAuthoredMessageAt === null
    ) {
      continue;
    }
    if (thread.latestUserAuthoredMessageAt === undefined) {
      if (legacy === null || thread.updatedAt > legacyAt) {
        legacy = thread;
        legacyAt = thread.updatedAt;
      }
    } else if (authored === null || thread.latestUserAuthoredMessageAt > authoredAt) {
      authored = thread;
      authoredAt = thread.latestUserAuthoredMessageAt;
    }
  }
  const latest = authored ?? legacy;
  return latest === null
    ? null
    : {
        modelSelection: latest.modelSelection,
        runtimeMode: latest.runtimeMode,
        interactionMode: latest.interactionMode,
      };
}
