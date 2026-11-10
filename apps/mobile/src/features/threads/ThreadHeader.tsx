import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useMemo } from "react";
import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import {
  presentThreadLinkedPullRequests,
  resolveThreadPrBadgeAction,
} from "../../state/thread-pr-presentation";
import { useOpenThreadPullRequests } from "./use-open-thread-pull-requests";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly thread: EnvironmentThreadShell;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
}) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
  const openThreadPullRequests = useOpenThreadPullRequests();
  const linkedPullRequest = useMemo(
    () => presentThreadLinkedPullRequests(props.thread.pullRequests),
    [props.thread.pullRequests],
  );
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = [
    ...(props.hasThreadCwd
      ? [
          {
            accessibilityLabel: filesVisible ? "Close files" : "Open files",
            icon: "folder" as const,
            selected: filesVisible,
            disabled: !props.gitControls.canOpenFiles,
            separateBackground: false,
            onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
          },
        ]
      : []),
    ...(linkedPullRequest !== null
      ? [
          {
            accessibilityLabel: resolveThreadPrBadgeAction(linkedPullRequest).accessibilityLabel,
            icon: PullRequestGlyph.pullRequest,
            separateBackground: false,
            onPress: () => openThreadPullRequests(props.thread, linkedPullRequest),
          },
        ]
      : []),
  ];
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: "Return to chat",
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={actions}
      menus={menus}
      hideBottomBorder
    />
  );
}
