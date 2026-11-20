import { useGT, useMessages } from "gt-react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
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
  /** Set for a bot's chat, whose details open from the header. */
  readonly onOpenBotDetails?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls, m);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = [
    ...(props.onOpenBotDetails
      ? [
          {
            accessibilityLabel: gt("Bot details"),
            icon: "info.circle" as const,
            separateBackground: false,
            onPress: props.onOpenBotDetails,
          },
        ]
      : []),
    ...(props.hasThreadCwd
      ? [
          {
            accessibilityLabel: filesVisible ? gt("Close files") : gt("Open files"),
            icon: "folder" as const,
            selected: filesVisible,
            disabled: !props.gitControls.canOpenFiles,
            separateBackground: false,
            onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
          },
        ]
      : []),
  ];
  // A bot has no repository and its chat is its only thread.
  const menus = [props.gitControls.showGitMenu === false ? null : gitMenu, terminalMenu].filter(
    (menu): menu is AppBarMenu => menu !== null,
  );

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft || props.onOpenBotDetails ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: gt("Return to chat"),
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
