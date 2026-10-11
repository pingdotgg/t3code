import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Alert } from "react-native";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenHeaderButton } from "../../components/ScreenHeaderButton";
import type { ScreenHeaderAction } from "../../components/ScreenHeader.types";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { resolveLinkedPullRequestHeaderAction } from "./git/linkedPullRequestStatus";
import type { ThreadInspectorMode } from "./thread-inspector-content-stack";
import { useThreadHeaderOptions } from "./useThreadHeaderOptions";

export function ThreadHeader(
  props: Parameters<typeof useThreadHeaderOptions>[0] & {
    readonly linkedPullRequests?: ReadonlyArray<ThreadPullRequestLink>;
    readonly hasThreadCwd: boolean;
    readonly hasWorkspaceRoot: boolean;
    readonly fileInspectorSupported: boolean;
    readonly inspectorMode: ThreadInspectorMode | null;
    readonly onToggleInspector: () => void;
    readonly onOpenGitInspector: () => void;
    readonly onOpenFilesInspector: () => void;
  },
) {
  const navigation = useNavigation();
  const { layout, panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const { onOpenTerminal, onMergeBack } = props.gitControls;
  const native = useThreadHeaderOptions(props);
  const linkedPullRequestAction = useMemo(
    () => resolveLinkedPullRequestHeaderAction(props.linkedPullRequests),
    [props.linkedPullRequests],
  );
  const androidHeaderActions = useMemo<ReadonlyArray<ScreenHeaderAction>>(() => {
    const actions: ScreenHeaderAction[] = [];
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
    if (props.hasWorkspaceRoot && props.gitControls.canOpenTerminal) {
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
    if (linkedPullRequestAction !== null) {
      actions.push({
        accessibilityLabel: linkedPullRequestAction.label,
        icon: "arrow.triangle.pull",
        onPress:
          linkedPullRequestAction.kind === "open"
            ? () => {
                void tryOpenExternalUrl(linkedPullRequestAction.url, "pull-request").then(
                  (opened) => {
                    if (!opened) {
                      Alert.alert("Unable to open PR", "The pull request could not be opened.");
                    }
                  },
                );
              }
            : props.onOpenGitInspector,
      });
    }
    if (onMergeBack) {
      actions.push({
        accessibilityLabel: "Merge back to source",
        icon: "arrow.triangle.merge",
        onPress: onMergeBack,
      });
    }
    return actions;
  }, [
    linkedPullRequestAction,
    props.inspectorMode,
    panes.auxiliaryPaneVisible,
    props.onOpenFilesInspector,
    onOpenTerminal,
    onMergeBack,
    props.onOpenGitInspector,
    toggleAuxiliaryPane,
    props.onReturnToThread,
    props.hasThreadCwd,
    props.hasWorkspaceRoot,
    props.gitControls.canOpenTerminal,
  ]);

  return (
    <>
      <ScreenHeader
        title={props.title}
        subtitle={props.subtitle}
        sidebar={native.sidebar}
        options={native.options}
        optionsVersion={native.optionsVersion}
        trailing={
          props.fileInspectorSupported && props.hasThreadCwd ? (
            <ScreenHeaderButton
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
      {native.fallback}
    </>
  );
}
