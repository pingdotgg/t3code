import { AppBar } from "../../components/ui/AppBar";
import { ScreenHeaderButton } from "../../components/ui/ScreenHeaderButton";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly onOpenConversationSummaries?: () => void;
  readonly onOpenProjectMemory?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly fileInspectorSupported: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onToggleInspector: () => void;
  readonly onOpenFilesInspector: () => void;
}) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { panes, toggleAuxiliaryPane, composerKeyboardActive, startNewTask } =
    useAdaptiveWorkspaceLayout();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const inspectorVisible = props.inspectorMode !== null && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? "Close files" : "Open files",
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  const threadActions = [
    ...(props.onOpenConversationSummaries
      ? [
          {
            id: "conversation-summaries",
            title: "Conversation summaries",
            onPress: props.onOpenConversationSummaries,
          },
        ]
      : []),
    ...(props.onOpenProjectMemory
      ? [{ id: "project-memory", title: "Project memory", onPress: props.onOpenProjectMemory }]
      : []),
  ];
  const threadMenu: AppBarMenu | null =
    threadActions.length > 0
      ? { title: "Thread actions", icon: "ellipsis", items: threadActions }
      : null;
  const menus = [gitMenu, terminalMenu, threadMenu].filter(
    (menu): menu is AppBarMenu => menu !== null,
  );

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
      trailing={
        props.fileInspectorSupported && props.hasThreadCwd ? (
          <ScreenHeaderButton
            accessibilityLabel={inspectorVisible ? "Hide inspector" : "Show inspector"}
            icon="sidebar.right"
            selected={inspectorVisible}
            onPress={props.onToggleInspector}
          />
        ) : null
      }
      hideBottomBorder
      compact={composerKeyboardActive}
    />
  );
}
