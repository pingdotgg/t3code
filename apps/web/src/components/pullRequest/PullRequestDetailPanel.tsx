import { PullRequestDetailPanelLayout } from "./PullRequestDetailPanelLayout";
import type { PullRequestDetailPanelProps } from "./pullRequestDetailPanelTypes";
import { usePullRequestDetailPanelActions } from "./usePullRequestDetailPanelActions";
import { usePullRequestDetailPanelControls } from "./usePullRequestDetailPanelControls";
import { usePullRequestDetailPanelData } from "./usePullRequestDetailPanelData";

export function PullRequestDetailPanel(props: PullRequestDetailPanelProps) {
  const state = usePullRequestDetailPanelControls(
    usePullRequestDetailPanelActions(usePullRequestDetailPanelData(props)),
  );
  return <PullRequestDetailPanelLayout state={state} />;
}
