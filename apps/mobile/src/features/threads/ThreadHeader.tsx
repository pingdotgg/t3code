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
  useThreadGitBar,
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
  const goBack = useWorkspaceBackNavigation("threads");
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const { primaryAction: gitPrimaryAction, menu: gitMenu } = useThreadGitBar(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
  // Edit-style text CTA + Safari-Back long-press menu (no chevron). Nest Terminal under Git.
  const gitMenuWithTerminal: AppBarMenu =
    terminalMenu !== null
      ? {
          ...gitMenu,
          items: [
            ...gitMenu.items,
            {
              id: "git-terminal",
              title: terminalMenu.title,
              icon:
                typeof terminalMenu.icon === "string" ? terminalMenu.icon : terminalMenu.icon.ios,
              items: terminalMenu.items,
            },
          ],
        }
      : gitMenu;
  // Disabled pills drop their iOS long-press menu (V5StackHeader), so keep the
  // standalone Git control whenever the pill cannot run the primary action.
  const activePill = gitPrimaryAction !== null && !gitPrimaryAction.disabled;
  const confirm = activePill ? { ...gitPrimaryAction, menu: gitMenuWithTerminal } : undefined;
  const menus: AppBarMenu[] = activePill ? [] : [gitMenuWithTerminal];
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
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
      confirm={confirm}
      hideBottomBorder
    />
  );
}
