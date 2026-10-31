import { useState } from "react";
import {
  computeStableMessagesTimelineRows,
  handoffRunsSignature,
  type MessagesTimelineRowsInput,
  sameRowsInput,
  deriveMessagesTimelineRowsWithState,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  applyWorkingWindow,
  applyBackgroundActivityGroups,
} from "./MessagesTimeline.logic";
import { type HandoffTimelineRun } from "./V2LifecycleRow";
import { type SlashCommandCatalog } from "./timelineSlashCommands";
import { shallow } from "zustand/vanilla/shallow";

const EMPTY_TIMELINE_RUNS: ReadonlyArray<HandoffTimelineRun> = [];

export function useStableHandoffRuns(
  runs: ReadonlyArray<HandoffTimelineRun>,
): ReadonlyArray<HandoffTimelineRun> {
  const [state, setState] = useState<{
    readonly source: ReadonlyArray<HandoffTimelineRun> | null;
    readonly signature: string;
    readonly value: ReadonlyArray<HandoffTimelineRun>;
  }>({ source: null, signature: "", value: EMPTY_TIMELINE_RUNS });
  if (state.source === runs) return state.value;
  const signature = handoffRunsSignature(runs);
  const value =
    signature === state.signature
      ? state.value
      : runs.map((run) => ({
          id: run.id,
          ordinal: run.ordinal,
          providerInstanceId: run.providerInstanceId,
          modelSelection: run.modelSelection,
        }));
  setState({ source: runs, signature, value });
  return value;
}

/**
 * Rows derived from the previous projection of the same list, so a streamed
 * text update patches its message rows instead of deriving every row again.
 */
export function useIncrementalTimelineRows(
  identity: string,
  input: MessagesTimelineRowsInput,
): MessagesTimelineRow[] {
  const [state, setState] = useState(() => ({
    identity,
    input,
    projection: deriveMessagesTimelineRowsWithState(input),
  }));
  if (state.identity === identity && sameRowsInput(state.input, input)) {
    return state.projection.rows;
  }
  const projection = deriveMessagesTimelineRowsWithState(
    input,
    state.identity === identity ? state.projection : null,
  );
  setState({ identity, input, projection });
  return projection.rows;
}

export function useStableRows(
  rows: MessagesTimelineRow[],
  identity: string,
  input: StableTimelineRowsInput,
): MessagesTimelineRow[] {
  const [state, setState] = useState<{
    readonly identity: string;
    readonly source: MessagesTimelineRow[] | null;
    readonly input: StableTimelineRowsInput | null;
    readonly stable: StableMessagesTimelineRowsState;
  }>({ identity, source: null, input: null, stable: { byId: new Map(), result: [] } });
  if (state.identity === identity && state.source === rows && state.input !== null) {
    const {
      expandedWorkGroupIds: previousGroups,
      pendingApprovalRequestIds: previousApprovals,
      ...previousInput
    } = state.input;
    const {
      expandedWorkGroupIds: nextGroups,
      pendingApprovalRequestIds: nextApprovals,
      ...nextInput
    } = input;
    if (
      shallow(previousGroups, nextGroups) &&
      shallow(previousApprovals, nextApprovals) &&
      shallow(previousInput, nextInput)
    ) {
      return state.stable.result;
    }
  }
  const previous = state.identity === identity ? state.stable : { byId: new Map(), result: [] };
  const windowed = input.windowlessCitation
    ? rows
    : applyWorkingWindow(rows, input, input.workingHistoryKey);
  const visibleRows =
    input.activeFindEntryId !== null &&
    windowed.some(
      (row) =>
        row.kind === "working" &&
        row.window?.items.some((item) => item.id === input.activeFindEntryId),
    )
      ? rows
      : windowed;
  const groupedRows = applyBackgroundActivityGroups(visibleRows, input, previous.result);
  const stable = computeStableMessagesTimelineRows(groupedRows, previous);
  setState({ identity, source: rows, input, stable });
  return stable.result;
}

type StableTimelineRowsInput = Parameters<typeof applyBackgroundActivityGroups>[1] & {
  readonly pendingApprovalRequestIds: NonNullable<
    MessagesTimelineRowsInput["pendingApprovalRequestIds"]
  >;
  readonly isWorking: boolean;
  readonly runlessWorkActive: boolean;
  readonly workingHistoryKey: string | null;
  readonly windowlessCitation: boolean;
  readonly activeFindEntryId: string | null;
};

export function useTimelineSlashCommandCatalog(
  commands: SlashCommandCatalog["commands"],
  skills: SlashCommandCatalog["skills"],
): SlashCommandCatalog {
  // Projection only reads names; provider pushes must not invalidate streaming rows.
  const key = JSON.stringify([
    commands.map((command) => command.name),
    skills.map((skill) => skill.name),
  ]);
  const [state, setState] = useState({ key, catalog: { commands, skills } });
  if (state.key === key) return state.catalog;
  const catalog = { commands, skills };
  setState({ key, catalog });
  return catalog;
}
