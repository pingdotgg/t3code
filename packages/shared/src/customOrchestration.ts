import {
  isProviderAvailable,
  type CustomOrchestrationModel,
  type ModelSelection,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import { exhaustedUsageWindow } from "./usageLimits.ts";

export type CustomOrchestrationModelProblem =
  | { readonly kind: "provider" }
  | { readonly kind: "model" }
  | { readonly kind: "limit"; readonly resetsAt: string | null };

/** Why a configured model cannot run now, as far as its provider has reported, or null. */
export function customOrchestrationModelProblem(
  selection: ModelSelection,
  input: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly now: number;
    readonly settings?: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
    readonly projectId?: ProjectId | null;
  },
): CustomOrchestrationModelProblem | null {
  const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
  if (
    provider === undefined ||
    !provider.enabled ||
    !isProviderAvailable(provider) ||
    provider.auth.status === "unauthenticated" ||
    provider.status === "disabled" ||
    // A failed check that follows a ready one keeps its models, and so keeps its place.
    (provider.status === "error" && provider.modelsRetained !== true) ||
    // Not installed with a warning is a provider that has not been checked yet.
    (!provider.installed && provider.status !== "warning") ||
    (input.settings !== undefined &&
      !resolveProjectProviderInstanceEnabled(
        input.settings,
        input.projectId ?? null,
        selection.instanceId,
      ))
  ) {
    return { kind: "provider" };
  }
  const models = [
    ...provider.models,
    ...(provider.workspaceSnapshots?.flatMap((snapshot) => snapshot.models ?? []) ?? []),
  ];
  const wanted = selection.model.toLowerCase();
  // A provider that lists no models accepts any.
  if (
    models.length > 0 &&
    !models.some(
      (model) =>
        model.slug === selection.model ||
        model.aliases?.some((alias) => alias.toLowerCase() === wanted),
    )
  ) {
    return { kind: "model" };
  }
  const window = exhaustedUsageWindow(provider, input.now, selection.model);
  return window ? { kind: "limit", resetsAt: window.resetsAt ?? null } : null;
}

export interface ResolvedCustomOrchestrationModel<Problem> {
  /**
   * The first model that can run. With none, the first that only waits on a usage limit, so its
   * provider reports the limit and the usual recovery applies. Null when nothing can run.
   */
  readonly selection: ModelSelection | null;
  /** The configured model and fallbacks that can run now, in order. */
  readonly usable: ReadonlyArray<ModelSelection>;
  /** The ones that cannot, in order. */
  readonly skipped: ReadonlyArray<{
    readonly selection: ModelSelection;
    readonly problem: Problem;
  }>;
}

export function resolveCustomOrchestrationModel<Problem extends { readonly kind: string }>(
  entry: CustomOrchestrationModel,
  problemOf: (selection: ModelSelection) => Problem | null,
): ResolvedCustomOrchestrationModel<Problem> {
  const usable: Array<ModelSelection> = [];
  const skipped: Array<{ selection: ModelSelection; problem: Problem }> = [];
  for (const selection of [entry.modelSelection, ...entry.fallbacks]) {
    const problem = problemOf(selection);
    if (problem === null) usable.push(selection);
    else skipped.push({ selection, problem });
  }
  return {
    selection:
      usable[0] ?? skipped.find((item) => item.problem.kind === "limit")?.selection ?? null,
    usable,
    skipped,
  };
}
