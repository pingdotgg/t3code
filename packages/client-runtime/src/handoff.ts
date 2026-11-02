import type {
  MessageId,
  ModelSelection,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";

import { isReasoningSelect } from "./modelTraits.ts";
import type { ThreadStructure } from "./state/models.ts";
import { REASONING_EFFORT_OPTION_IDS } from "./state/threadExecution.ts";

export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

export type HandoffEndpoints = ReturnType<typeof resolveHandoffEndpoints>;

export function resolvePendingHandoff(
  projection: ThreadStructure | null | undefined,
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<ServerProvider>,
): HandoffEndpoints | null {
  // A thread with an empty timeline has nothing to hand off. Any loaded row
  // counts: paging can leave a window of only tool rows.
  if (!projection?.visibleTurnItems.length) return null;
  // The handoff row is committed before the provider starts. Use its destination
  // during startup so the footer does not duplicate the committed handoff.
  const from = projection.runs.findLast(
    (run) =>
      run.status !== "rolled_back" &&
      (run.startedAt !== null || (run.status === "starting" && run.contextHandoffId !== null)),
  )?.modelSelection;
  if (from === undefined || selection == null) return null;
  const source = providers.find((provider) => provider.instanceId === from.instanceId);
  const target = providers.find((provider) => provider.instanceId === selection.instanceId);
  const needsHandoff =
    from.instanceId !== selection.instanceId &&
    (source?.continuation?.groupKey === undefined ||
      source.driver !== target?.driver ||
      source.continuation.groupKey !== target.continuation?.groupKey);
  return needsHandoff ? { from: [from], to: selection } : null;
}

export function resolveHandoffEndpoints(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "handoff" }>,
    "runId" | "fromModelSelections" | "fromProviderInstanceIds" | "toModel" | "toProviderInstanceId"
  >,
  runs: ReadonlyArray<HandoffTimelineRun>,
) {
  const handoffRun = item.runId === null ? undefined : runs.find((run) => run.id === item.runId);
  const toModel =
    item.toModel ??
    (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
      ? handoffRun.modelSelection.model
      : undefined);
  const fromEndpoints: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model?: string | undefined;
  }> =
    item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
      ? item.fromModelSelections
      : item.fromProviderInstanceIds.map((instanceId) => ({
          instanceId,
          model: latestRunModelBefore(runs, instanceId, handoffRun?.ordinal),
        }));
  return { from: fromEndpoints, to: { instanceId: item.toProviderInstanceId, model: toModel } };
}

function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}

export type ModelSwitchRun = Pick<
  OrchestrationV2Run,
  | "id"
  | "ordinal"
  | "status"
  | "startedAt"
  | "modelSelection"
  | "userMessageId"
  | "contextHandoffId"
>;

export type ModelSwitchAttempt = Pick<
  OrchestrationV2RunAttempt,
  "runId" | "attemptOrdinal" | "status" | "startedAt" | "restartedFrom"
>;

export interface ModelSwitch {
  readonly from: ModelSelection;
  readonly to: ModelSelection;
  readonly modelChanged: boolean;
  /** When set, each side states its effort, defaults included. */
  readonly effortChanged: boolean;
}

/**
 * Model or effort changes, keyed by the message that started each run or steering restart.
 * Starts that brought a context handoff are skipped; the handoff row already shows them.
 * `providers` resolves an unset effort to the model's default.
 */
export function resolveModelSwitches(
  runs: ReadonlyArray<ModelSwitchRun>,
  attempts: ReadonlyArray<ModelSwitchAttempt> = [],
  providers: ReadonlyArray<ServerProvider> = [],
): ReadonlyMap<MessageId, ModelSwitch> {
  const switches = new Map<MessageId, ModelSwitch>();
  let previous: ModelSelection | undefined;
  for (const run of [...runs].sort((left, right) => left.ordinal - right.ordinal)) {
    for (const start of runStarts(run, attempts)) {
      const from = previous;
      const to = start.modelSelection;
      previous = to;
      if (from === undefined || start.handedOff) continue;
      const fromEffort = resolveEffort(from, modelsFor(providers, from));
      const toEffort = resolveEffort(to, modelsFor(providers, to));
      const modelChanged = from.model !== to.model;
      const effortChanged =
        fromEffort !== undefined && toEffort !== undefined && fromEffort.value !== toEffort.value;
      if (!modelChanged && !effortChanged) continue;
      switches.set(start.userMessageId, {
        from: effortChanged ? withEffort(from, fromEffort) : from,
        to: effortChanged ? withEffort(to, toEffort) : to,
        modelChanged,
        effortChanged,
      });
    }
  }
  return switches;
}

/** Effort label for a switch endpoint; the stored value stands in when the catalog lacks it. */
export function formatModelSwitchEffort(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> | undefined,
): string | null {
  const effort = resolveEffort(selection, models);
  return effort?.label ?? effort?.value ?? null;
}

/**
 * The message and selection of each start that ran. A steering restart rewrites its run, so
 * earlier starts come from the restart attempts that replaced them.
 */
function runStarts(run: ModelSwitchRun, attempts: ReadonlyArray<ModelSwitchAttempt>) {
  // Runs that never ran do not change what the agent used.
  if (
    run.status === "rolled_back" ||
    (run.startedAt === null && run.status !== "preparing" && run.status !== "starting")
  ) {
    return [];
  }
  const restarts = attempts
    .filter((attempt) => attempt.runId === run.id && attempt.restartedFrom !== undefined)
    .sort((left, right) => left.attemptOrdinal - right.attemptOrdinal);
  const current = {
    userMessageId: run.userMessageId,
    modelSelection: run.modelSelection,
    contextHandoffId: run.contextHandoffId,
  };
  return [...restarts.flatMap((attempt) => attempt.restartedFrom ?? []), current].flatMap(
    (start, index, all) => {
      // Each later start belongs to the restart that launched it; one stopped first never ran.
      const launcher = index === 0 ? undefined : restarts[index - 1];
      if (launcher && launcher.startedAt === null && launcher.status !== "pending") return [];
      const handedOff =
        start.contextHandoffId !== null &&
        start.contextHandoffId !== all[index - 1]?.contextHandoffId;
      return [{ ...start, handedOff }];
    },
  );
}

function modelsFor(providers: ReadonlyArray<ServerProvider>, selection: ModelSelection) {
  return providers.find((provider) => provider.instanceId === selection.instanceId)?.models;
}

/** The model's reasoning control, as the composer picks it, or a stated effort without a catalog. */
function resolveEffort(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> | undefined,
): { readonly id: string; readonly value: string; readonly label?: string } | undefined {
  const descriptor = models
    ?.find((model) => model.slug === selection.model)
    ?.capabilities?.optionDescriptors?.find(isReasoningSelect);
  if (descriptor === undefined) {
    for (const id of REASONING_EFFORT_OPTION_IDS) {
      const value = getModelSelectionStringOptionValue(selection, id);
      if (value !== undefined) return { id, value };
    }
    return undefined;
  }
  const value =
    getModelSelectionStringOptionValue(selection, descriptor.id) ??
    getProviderOptionCurrentValue(descriptor, selection);
  if (typeof value !== "string") return undefined;
  const label = descriptor.options.find((option) => option.id === value)?.label;
  return { id: descriptor.id, value, ...(label === undefined ? {} : { label }) };
}

function withEffort(
  selection: ModelSelection,
  effort: { readonly id: string; readonly value: string },
): ModelSelection {
  if (getModelSelectionStringOptionValue(selection, effort.id) === effort.value) return selection;
  return {
    ...selection,
    options: [
      ...(selection.options ?? []).filter((option) => option.id !== effort.id),
      { id: effort.id, value: effort.value },
    ],
  };
}
