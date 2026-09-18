import { useEnvironmentQuery } from "../../state/query";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useThreadSelection } from "../../state/use-thread-selection";
import { vcsEnvironment } from "../../state/vcs";
import { ThreadGitMenu } from "../threads/ThreadGitControls";
import type { ReviewHeaderProps, ReviewHeaderPresentation } from "./ReviewHeader.types";

export function useReviewHeaderPresentation(props: ReviewHeaderProps): ReviewHeaderPresentation {
  const { selectedThread } = useThreadSelection();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const gitStatusQuery = useEnvironmentQuery(
    selectedThread !== null && props.selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: props.selectedThreadCwd },
        })
      : null,
  );
  // The selection-based git hooks only apply when this review belongs to the
  // selected thread (it always does when reached from the thread's toolbar).
  const gitMenuAvailable =
    selectedThread !== null && String(selectedThread.id) === String(props.threadId);
  return {
    title: props.title,
    subtitle: props.subtitle,
    menuIcon: "ellipsis",
    trailing:
      gitMenuAvailable && selectedThread !== null ? (
        <ThreadGitMenu
          environmentId={props.environmentId}
          threadId={props.threadId}
          currentBranch={selectedThread.branch ?? null}
          gitStatus={gitStatusQuery.data}
          gitOperationLabel={gitState.gitOperationLabel}
          onPull={gitActions.onPullSelectedThreadBranch}
          onRunAction={gitActions.onRunSelectedThreadGitAction}
        />
      ) : null,
  };
}
