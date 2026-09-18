import { ScreenHeader } from "../../components/ScreenHeader";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { FilesBrowserHeaderProps, FileHeaderProps } from "./FilesHeader.types";

export function FilesBrowserHeader(props: FilesBrowserHeaderProps) {
  return (
    <ScreenHeader
      title="Files"
      subtitle={props.projectName}
      onBack={props.onBack}
      hideBottomBorder
      matchSearchSurface
      search={{
        value: props.searchQuery,
        onChangeText: props.onSearchQueryChange,
        placeholder: "Search files",
        onRefresh: props.onRefresh,
        refreshAccessibilityLabel: "Refresh files",
        closeAccessibilityLabel: "Close file search",
        clearAccessibilityLabel: "Clear file search",
      }}
    />
  );
}

export function FileHeader(props: FileHeaderProps) {
  const { panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const modes = props.actions.filter(({ inline }) => inline);
  return (
    <ScreenHeader
      title={props.title}
      subtitle={props.subtitle}
      onBack={props.onBack}
      hideBottomBorder
      options={{ headerTintColor: props.iconColor, headerTitle: props.title }}
      backInSplitView={
        props.fileInspectorSupported
          ? {
              accessibilityLabel: "Return to chat",
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={
        props.fileInspectorSupported
          ? [
              {
                accessibilityLabel: panes.auxiliaryPaneVisible
                  ? "Hide file navigator"
                  : "Show file navigator",
                icon: "sidebar.right",
                selected: panes.auxiliaryPaneVisible,
                onPress: toggleAuxiliaryPane,
              },
            ]
          : undefined
      }
      menus={[
        {
          title: "File actions",
          icon: "ellipsis",
          separateBackground: false,
          items: [
            ...(modes.length > 0
              ? [
                  {
                    id: "modes",
                    inline: true,
                    items: modes.map((action) => ({
                      ...action,
                      selected: action.id === props.activeMode,
                    })),
                  },
                ]
              : []),
            ...props.actions.filter(({ inline }) => !inline),
          ],
        },
      ]}
    />
  );
}
