import { formatModelSelectionEffort } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { ModelSelection, PipelineRun } from "@t3tools/contracts";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { getTriggerDisplayModelName } from "./providerIconUtils";

export interface PipelineStepModelLabel {
  readonly entry: ProviderInstanceEntry | null;
  readonly model: string;
  readonly effort: string | null;
}

/** Same model and effort wording as the provider-subagent bar. */
export function pipelineStepModelLabel(
  selection: ModelSelection,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): PipelineStepModelLabel {
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId) ?? null;
  if (entry === null) {
    return { entry: null, model: formatModelSlugName(selection.model), effort: null };
  }
  const slug = resolveSelectableModel(entry.driverKind, selection.model, entry.models);
  const catalogModel = entry.models.find((model) => model.slug === slug);
  return {
    entry,
    model: catalogModel
      ? getTriggerDisplayModelName(catalogModel, entry.driverKind)
      : formatModelSlugName(selection.model),
    effort: formatModelSelectionEffort(selection, entry.models),
  };
}

export type PipelineChildLiveState = "approval" | "input" | "working";

export const PIPELINE_CHILD_LIVE_STATE_LABEL: Record<PipelineChildLiveState, string> = {
  approval: "Needs approval",
  input: "Needs input",
  working: "Working",
};

/** What the step's thread is doing right now, or null when it is idle or not loaded. */
export function pipelineChildLiveState(
  shell: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "runtime"
  > | null,
): PipelineChildLiveState | null {
  if (shell === null) return null;
  if (shell.hasPendingApprovals) return "approval";
  if (shell.hasPendingUserInput) return "input";
  return threadRuntimeIsActive(shell.runtime) ? "working" : null;
}

/** The run with the later `updatedAt`; a command's result can arrive before the subscription's. */
export function newerPipelineRun(live: PipelineRun, fromCommand: PipelineRun | null): PipelineRun {
  return fromCommand !== null &&
    fromCommand.id === live.id &&
    Date.parse(fromCommand.updatedAt) > Date.parse(live.updatedAt)
    ? fromCommand
    : live;
}
