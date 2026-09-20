import type { SourceControlEnvironmentPanelProps } from "./SourceControlEnvironmentPanel";
import type { VcsPanelSnapshotResult } from "@t3tools/contracts";
import { useSourceControlPanelActions } from "./useSourceControlPanelActions";
import { useSourceControlPanelExpansion } from "./useSourceControlPanelExpansion";
import { useSourceControlPanelRefresh } from "./useSourceControlPanelRefresh";
import { useSourceControlPanelState } from "./useSourceControlPanelState";

export function useSourceControlPanelController(
  props: SourceControlEnvironmentPanelProps,
  onPublishRepository: (cwd: string) => void,
) {
  const state = useSourceControlPanelState(props);
  const refreshControls = useSourceControlPanelRefresh(state);
  const actions = useSourceControlPanelActions(state, refreshControls.refresh, onPublishRepository);
  const expansion = useSourceControlPanelExpansion(state);
  return { ...state, ...refreshControls, ...actions, ...expansion };
}

export type SourceControlPanelController = ReturnType<typeof useSourceControlPanelController>;
export type ReadySourceControlPanelController = SourceControlPanelController & {
  readonly snapshot: VcsPanelSnapshotResult;
};
