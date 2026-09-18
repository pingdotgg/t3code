import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import type { FilesBrowserHeaderProps, FileHeaderProps } from "./FilesHeader.types";

export function FilesBrowserHeader(props: FilesBrowserHeaderProps) {
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const usesCompactMailToolbar = !layout.usesSplitView && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;
  return (
    <>
      {/* Static header config (glass preset and title) lives in Stack.tsx. The
          live sheet color stays dynamic here so the FlatList can remain the
          direct scene child for native scroll-edge sampling. */}
      <NativeStackScreenOptions
        options={{
          contentStyle: {
            backgroundColor: props.sheetSurfaceColor,
          },
          headerShown: true,
          unstable_headerSubtitle: props.projectName.length > 0 ? props.projectName : undefined,
          // No refresh button: the list already supports pull-to-refresh.
          unstable_headerToolbarItems: usesCompactMailToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  onSearchTextChange: props.onSearchQueryChange,
                  placeholder: "Search files",
                  searchTextChangeId: "files-search-text",
                }),
              ]
            : undefined,
          headerSearchBarOptions: usesCompactMailToolbar
            ? undefined
            : {
                allowToolbarIntegration: true,
                autoCapitalize: "none",
                hideNavigationBar: false,
                placeholder: "Search files",
                onChangeText: (event) => {
                  props.onSearchQueryChange(event.nativeEvent.text);
                },
                onCancelButtonPress: () => {
                  props.onSearchQueryChange("");
                },
              },
        }}
      />

      <>
        {layout.usesSplitView ? (
          <NativeHeaderToolbar placement="left">
            <NativeHeaderToolbar.Button
              accessibilityLabel={panes.primarySidebarVisible ? "Maximize files" : "Show threads"}
              icon={
                panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"
              }
              onPress={togglePrimarySidebar}
              separateBackground
            />
          </NativeHeaderToolbar>
        ) : null}
        {usesCompactMailToolbar ? null : (
          <NativeHeaderToolbar placement="bottom">
            <NativeHeaderToolbar.SearchBarSlot />
          </NativeHeaderToolbar>
        )}
      </>
    </>
  );
}

export function FileHeader(props: FileHeaderProps) {
  const { panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  return (
    <>
      <NativeStackScreenOptions
        options={{
          // Static header config lives in Stack.tsx (SOLID_HEADER_OPTIONS: solid
          // sheet-colored header — this route's content scrolls internally, so
          // there is nothing for glass to sample). Only dynamic values here.
          headerShown: true,
          headerTintColor: props.iconColor,
          headerTitle: props.title,
          title: props.title,
          unstable_headerSubtitle: props.subtitle.length > 0 ? props.subtitle : undefined,
        }}
      />
      <WorkspaceSidebarToolbar>
        {props.fileInspectorSupported ? (
          <NativeHeaderToolbar.Button
            accessibilityLabel="Return to chat"
            icon="chevron.left"
            onPress={props.onReturnToThread}
          />
        ) : null}
      </WorkspaceSidebarToolbar>
      <NativeHeaderToolbar placement="right">
        {props.fileInspectorSupported ? (
          <NativeHeaderToolbar.Button
            accessibilityLabel={
              panes.auxiliaryPaneVisible ? "Hide file navigator" : "Show file navigator"
            }
            icon="sidebar.right"
            onPress={toggleAuxiliaryPane}
            separateBackground
          />
        ) : null}
        <NativeHeaderToolbar.Menu accessibilityLabel="File actions" icon="ellipsis">
          {props.actions.some(({ inline }) => inline) ? (
            <NativeHeaderToolbar.Menu inline>
              {props.actions
                .filter(({ inline }) => inline)
                .map((action) => (
                  <NativeHeaderToolbar.MenuAction
                    key={action.id}
                    icon={action.icon}
                    isOn={action.id === props.activeMode}
                    onPress={action.onPress}
                  >
                    {action.title}
                  </NativeHeaderToolbar.MenuAction>
                ))}
            </NativeHeaderToolbar.Menu>
          ) : null}
          {props.actions
            .filter(({ inline }) => !inline)
            .map((action) => (
              <NativeHeaderToolbar.MenuAction
                key={action.id}
                icon={action.icon}
                onPress={action.onPress}
              >
                {action.title}
              </NativeHeaderToolbar.MenuAction>
            ))}
        </NativeHeaderToolbar.Menu>
      </NativeHeaderToolbar>
    </>
  );
}
