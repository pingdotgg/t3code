import { useState } from "react";
import {
  deriveStableTimelineRows,
  handoffRunsSignature,
  type MessagesTimelineRowsInput,
  sameRowsInput,
  deriveMessagesTimelineRowsWithState,
  type MessagesTimelineRow,
  type StableTimelineRowsInput,
  type StableTimelineRowsProjection,
} from "./MessagesTimeline.logic";
import { type HandoffTimelineRun } from "./V2LifecycleRow";
import { type SlashCommandCatalog } from "./timelineSlashCommands";

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
    readonly projection: StableTimelineRowsProjection | null;
  }>({ identity, projection: null });
  const previous = state.identity === identity ? state.projection : null;
  const projection = deriveStableTimelineRows(rows, input, previous);
  if (projection !== previous) setState({ identity, projection });
  return projection.stable.result;
}

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
