import { useNavigation } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { Platform } from "react-native";

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
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls, m);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? gt("Close files") : gt("Open files"),
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);
  // The git menu's last row opens the git sheet, and knows when a draft can't.
  const openGitSheet = gitMenu?.items.find(
    (item): item is Extract<typeof item, { onPress: () => void }> =>
      item.id === "git-more" && "onPress" in item,
  );
  // iOS keeps one ellipsis in the bar. Each row opens its sheet in one tap.
  const moreMenu: AppBarMenu = {
    title: gt("More actions"),
    untitled: true,
    icon: "ellipsis",
    items: [
      ...(terminalMenu
        ? [
            {
              id: terminalMenu.title,
              title: terminalMenu.title,
              icon:
                typeof terminalMenu.icon === "string" ? terminalMenu.icon : terminalMenu.icon.ios,
              onPress: () =>
                navigation.navigate("ThreadTerminalOptions", {
                  environmentId: props.gitControls.environmentId,
                  threadId: props.gitControls.threadId,
                }),
            },
          ]
        : []),
      ...(gitMenu && openGitSheet
        ? [
            {
              id: gitMenu.title,
              title: gitMenu.title,
              icon: typeof gitMenu.icon === "string" ? gitMenu.icon : gitMenu.icon.ios,
              disabled: openGitSheet.disabled,
              onPress: openGitSheet.onPress,
            },
          ]
        : []),
      ...actions.map((action) => ({
        id: action.accessibilityLabel,
        title: action.accessibilityLabel,
        icon: typeof action.icon === "string" ? action.icon : action.icon.ios,
        disabled: action.disabled,
        selected: action.selected,
        onPress: action.onPress,
      })),
    ],
  };

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: gt("Return to chat"),
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={Platform.OS === "ios" ? undefined : actions}
      menus={Platform.OS === "ios" ? [moreMenu] : menus}
      hideBottomBorder
    />
  );
}
