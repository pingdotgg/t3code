import type {
  MessageId,
  ModelSelection,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import type { ThreadStructure } from "./state/models.ts";
import { REASONING_EFFORT_OPTION_IDS } from "./state/threadExecution.ts";

export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

/** Options are set only for model switches, which can show effort. */
export interface HandoffEndpoint {
  readonly instanceId: ProviderInstanceId;
  readonly model?: string | undefined;
  readonly options?: ModelSelection["options"];
}

export interface HandoffEndpoints {
  readonly from: ReadonlyArray<HandoffEndpoint>;
  readonly to: HandoffEndpoint;
}

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
): HandoffEndpoints {
  const handoffRun = item.runId === null ? undefined : runs.find((run) => run.id === item.runId);
  const toModel =
    item.toModel ??
    (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
      ? handoffRun.modelSelection.model
      : undefined);
  const fromEndpoints: ReadonlyArray<HandoffEndpoint> =
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
  "id" | "ordinal" | "status" | "modelSelection" | "userMessageId" | "contextHandoffId"
>;

export interface ModelSwitch {
  readonly from: ModelSelection;
  readonly to: ModelSelection;
  /** Both runs stated an effort and they differ. */
  readonly effortChanged: boolean;
}

/**
 * Model or effort changes between consecutive runs, keyed by the message that started the later
 * run. Runs that carried a context handoff are skipped; their handoff row already shows the swap.
 */
export function resolveModelSwitches(
  runs: ReadonlyArray<ModelSwitchRun>,
): ReadonlyMap<MessageId, ModelSwitch> {
  const switches = new Map<MessageId, ModelSwitch>();
  let previous: ModelSwitchRun | undefined;
  for (const run of [...runs].sort((left, right) => left.ordinal - right.ordinal)) {
    if (run.status === "rolled_back") continue;
    if (previous !== undefined && run.contextHandoffId === null) {
      const from = previous.modelSelection;
      const to = run.modelSelection;
      const fromEffort = statedEffort(from);
      const toEffort = statedEffort(to);
      const effortChanged =
        fromEffort !== undefined && toEffort !== undefined && fromEffort !== toEffort;
      if (from.instanceId !== to.instanceId || from.model !== to.model || effortChanged) {
        switches.set(run.userMessageId, { from, to, effortChanged });
      }
    }
    previous = run;
  }
  return switches;
}

function statedEffort(selection: ModelSelection): string | undefined {
  for (const id of REASONING_EFFORT_OPTION_IDS) {
    const value = getModelSelectionStringOptionValue(selection, id);
    if (value !== undefined) return value;
  }
  return undefined;
}
