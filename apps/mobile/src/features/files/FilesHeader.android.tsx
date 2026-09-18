import type { MenuAction } from "@react-native-menu/menu";
import { useMemo, useCallback } from "react";
import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ControlPillMenu } from "../../components/ControlPill";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidWorkspaceSidebarButton } from "../layout/workspace-sidebar-toolbar";
import { MaterialFilesHeader } from "./MaterialFilesHeader";
import type { FilesBrowserHeaderProps, FileHeaderProps } from "./FilesHeader.types";

export function FilesBrowserHeader(props: FilesBrowserHeaderProps) {
  return (
    <>
      <NativeStackScreenOptions
        options={{
          contentStyle: { backgroundColor: props.headerColor },
          headerShown: false,
        }}
      />
      <MaterialFilesHeader
        projectName={props.projectName}
        leading={<AndroidWorkspaceSidebarButton />}
        searchQuery={props.searchQuery}
        onSearchQueryChange={props.onSearchQueryChange}
        onRefresh={props.onRefresh}
        onBack={props.onBack}
      />
    </>
  );
}

export function FileHeader(props: FileHeaderProps) {
  const { panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const androidFileMenuActions = useMemo<MenuAction[]>(
    () =>
      props.actions.map((action) => ({
        id: action.id,
        title: action.title,
        image: action.icon,
        state: action.id === props.activeMode ? "on" : undefined,
      })),
    [props.actions, props.activeMode],
  );
  const handleAndroidFileMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const action = props.actions.find(({ id }) => id === event.nativeEvent.event);
      void action?.onPress();
    },
    [props.actions],
  );
  return (
    <>
      <NativeStackScreenOptions
        options={{
          headerShown: false,
          headerTintColor: props.iconColor,
          headerTitle: props.title,
          title: props.title,
        }}
      />
      <AndroidScreenHeader
        title={props.title}
        subtitle={props.subtitle}
        leading={<AndroidWorkspaceSidebarButton />}
        hideBottomBorder
        onBack={props.onBack}
        trailing={
          <>
            {props.fileInspectorSupported ? (
              <AndroidHeaderIconButton
                accessibilityLabel={
                  panes.auxiliaryPaneVisible ? "Hide file navigator" : "Show file navigator"
                }
                icon="sidebar.right"
                selected={panes.auxiliaryPaneVisible}
                onPress={toggleAuxiliaryPane}
              />
            ) : null}
            <ControlPillMenu
              actions={androidFileMenuActions}
              isAnchoredToRight
              title="File actions"
              onPressAction={handleAndroidFileMenuAction}
            >
              <AndroidHeaderIconButton accessibilityLabel="File actions" icon="ellipsis" />
            </ControlPillMenu>
          </>
        }
      />
    </>
  );
}
