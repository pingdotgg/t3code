import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
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

function menuIcon(icon: AppSymbolName): string | undefined {
  return typeof icon === "string" ? icon : icon.android;
}

/** One "More" menu: plain items first, then each tool menu as a submenu. */
function overflowMenu(
  items: ReadonlyArray<AppBarMenuItem>,
  submenus: ReadonlyArray<AppBarMenu>,
): AppBarMenu[] {
  const all: AppBarMenuItem[] = [
    ...items,
    ...submenus.map((menu) => ({
      id: `submenu:${menu.title}`,
      title: menu.title,
      icon: menuIcon(menu.icon),
      items: menu.items,
    })),
  ];
  if (all.length === 0) return [];
  return [
    {
      title: "More options",
      icon: { ios: "ellipsis.circle", android: "more_vert" },
      separateBackground: false,
      items: all,
    },
  ];
}

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  /** One-tap settle for the open thread (phone). */
  readonly settle?: {
    readonly settled: boolean;
    readonly busy: boolean;
    readonly onPress: () => void;
  };
}) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { layout, toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const settleAction: AppBarAction[] = props.settle
    ? [
        {
          accessibilityLabel: props.settle.settled ? "Un-settle thread" : "Settle thread",
          // Filled once settled; Android's plain "checkmark.circle.fill" maps to the outline.
          icon: props.settle.settled
            ? { ios: "checkmark.circle.fill", android: "check_circle" }
            : "checkmark.circle",
          selected: props.settle.settled,
          disabled: props.settle.busy,
          separateBackground: false,
          onPress: props.settle.onPress,
        },
      ]
    : [];
  const fileActions: AppBarAction[] = props.hasThreadCwd
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
  const toolMenus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);
  // Phones: the title needs the room, so files, Git and the terminal share one overflow menu and
  // only Settle stays a button.
  const collapseTools = layout.variant === "compact";
  const actions = collapseTools ? settleAction : [...settleAction, ...fileActions];
  const menus = collapseTools
    ? overflowMenu(
        fileActions.map((action) => ({
          id: "open-files",
          title: action.accessibilityLabel === "Close files" ? "Close files" : "Files",
          icon: menuIcon(action.icon),
          selected: action.selected,
          disabled: action.disabled,
          onPress: action.onPress,
        })),
        toolMenus,
      )
    : toolMenus;

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
