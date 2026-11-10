import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useSafeAreaFrame, useSafeAreaInsets } from "react-native-safe-area-context";
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
import { threadTitleMaxWidth, threadTitleMenuVersion } from "./thread-title-menu";
import { ThreadTitleMenu } from "./ThreadTitleMenu";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { isDuoDevice } from "../../lib/device-type";
import { useDeviceType, useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";

export function ThreadHeader(props: {
  readonly thread: EnvironmentThreadShell | null;
  /** False while a client-only creation is preparing, before the server owns the thread. */
  readonly canMutateThread: boolean;
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
  const { layout, toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const frame = useSafeAreaFrame();
  const insets = useSafeAreaInsets();
  const metrics = useNativeLayoutMetrics();
  const deviceType = useDeviceType();
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const usesDuoHeader = usesNativeWorkspaceColumns && isDuoDevice(deviceType);
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
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
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);

  // Mirrors the iOS AppBar's buttons so the custom title gets a width cap; Android ignores it.
  const button = { type: "button", icon: {} };
  const titleMaxWidth = threadTitleMaxWidth({
    paneWidth: Math.min(frame.width, panes.contentPaneWidth),
    horizontalInsets: insets.left + insets.right,
    verticalBar: metrics != null && metrics.verticalBarEdge !== "none",
    leadingItems: layout.usesSplitView
      ? [
          ...(props.onReturnToThread ? [button] : []),
          {
            ...button,
            ...(usesNativeWorkspaceColumns ? { axisBehavior: "horizontalOnly" } : undefined),
          },
          ...(!usesDuoHeader && !props.draft ? [button] : []),
        ]
      : null,
    trailingItems: Array.from({ length: actions.length + menus.length }, () => button),
    compose: usesDuoHeader,
  });
  const titleContent = props.thread ? (
    <ThreadTitleMenu
      key={scopedThreadKey(props.thread.environmentId, props.thread.id)}
      thread={props.thread}
      canMutate={props.canMutateThread}
      subtitle={props.subtitle}
      maxWidth={titleMaxWidth}
    />
  ) : undefined;

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      titleContent={titleContent}
      optionsVersion={[
        props.subtitle,
        titleMaxWidth,
        threadTitleMenuVersion(props.thread),
        props.canMutateThread,
      ]}
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
