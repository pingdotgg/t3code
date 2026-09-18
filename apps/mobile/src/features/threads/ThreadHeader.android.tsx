import { StackActions, useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import {
  AndroidHeaderIconButton,
  AndroidScreenHeader,
  type AndroidHeaderAction,
} from "../../components/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidWorkspaceSidebarButton } from "../layout/workspace-sidebar-toolbar";
import type { ThreadHeaderProps } from "./ThreadHeader.types";

export function ThreadHeader(props: ThreadHeaderProps) {
  const navigation = useNavigation();
  const { layout, panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const { onOpenTerminal } = props.gitControls;
  const androidHeaderActions = useMemo<ReadonlyArray<AndroidHeaderAction>>(() => {
    const actions: AndroidHeaderAction[] = [];
    if (props.onReturnToThread) {
      actions.push({
        accessibilityLabel: "Return to chat",
        icon: "chevron.left",
        onPress: props.onReturnToThread,
      });
    }
    if (props.hasThreadCwd) {
      const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
      actions.push({
        accessibilityLabel: filesVisible ? "Close files" : "Open files",
        selected: filesVisible,
        icon: "folder",
        onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
      });
    }
    if (props.hasWorkspaceRoot) {
      actions.push({
        accessibilityLabel: "Open terminal",
        icon: "terminal",
        onPress: () => onOpenTerminal(null),
      });
    }
    actions.push({
      accessibilityLabel: "Open git controls",
      icon: "point.topleft.down.curvedto.point.bottomright.up",
      onPress: props.onOpenGitInspector,
    });
    return actions;
  }, [
    props.inspectorMode,
    panes.auxiliaryPaneVisible,
    props.onOpenFilesInspector,
    onOpenTerminal,
    props.onOpenGitInspector,
    toggleAuxiliaryPane,
    props.onReturnToThread,
    props.hasThreadCwd,
    props.hasWorkspaceRoot,
  ]);

  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={props.gitControls.projectScripts}
        options={{
          headerShown: false,
          headerTitle: props.title,
          headerTitleStyle: undefined,
          title: props.title,
          headerBackVisible: !layout.usesSplitView,
          unstable_headerLeftItems: undefined,
          unstable_headerRightItems: undefined,
          unstable_headerSubtitle: undefined,
          contentStyle: { backgroundColor: props.headerColor },
        }}
      />
      <AndroidScreenHeader
        title={props.title}
        subtitle={props.subtitle}
        leading={<AndroidWorkspaceSidebarButton />}
        trailing={
          props.fileInspectorSupported && props.hasThreadCwd ? (
            <AndroidHeaderIconButton
              accessibilityLabel={
                props.inspectorMode !== null && panes.auxiliaryPaneVisible
                  ? "Hide inspector"
                  : "Show inspector"
              }
              icon="sidebar.right"
              selected={props.inspectorMode !== null && panes.auxiliaryPaneVisible}
              onPress={props.onToggleInspector}
            />
          ) : null
        }
        onBack={
          layout.usesSplitView
            ? undefined
            : () => {
                // A deep link or cold start has no previous route; Home is the way out.
                // Read the history at press time: it changes without re-rendering this screen.
                if (navigation.canGoBack()) navigation.goBack();
                else navigation.dispatch(StackActions.replace("Home"));
              }
        }
        actions={androidHeaderActions}
        hideBottomBorder
      />
    </>
  );
}
