import { useMemo } from "react";
import { useNavigation } from "@react-navigation/native";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenHeaderButton } from "../../components/ui/ScreenHeaderButton";
import type { AppBarAction } from "../../components/ui/AppBar.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-content-stack";
import { useThreadHeaderOptions } from "./useThreadHeaderOptions";
import { useThreadGitMenuDefinition } from "./ThreadGitControls";
import { THREAD_WORKSPACE_GLYPH } from "./threadGitActions";
import { useWorkspaceBackNavigation } from "../workspace/useAndroidWorkspaceNavigation";
import { readWorkspacePane, workspaceThreadMemoryKey } from "../workspace/workspacePaneMemory";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";

export function ThreadHeader(
  props: Parameters<typeof useThreadHeaderOptions>[0] & {
    readonly hasThreadCwd: boolean;
    readonly hasWorkspaceRoot: boolean;
    readonly fileInspectorSupported: boolean;
    readonly inspectorMode: ThreadInspectorMode | null;
    readonly onToggleInspector: () => void;
    readonly onOpenGitInspector: () => void;
    readonly onOpenFilesInspector: () => void;
  },
) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { layout, panes, composerKeyboardActive } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const { onOpenTerminal, onMergeBack } = props.gitControls;
  const native = useThreadHeaderOptions(props);
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const androidHeaderActions = useMemo<ReadonlyArray<AppBarAction>>(() => {
    const actions: AppBarAction[] = [];
    const environmentId = String(props.gitControls.environmentId);
    const threadId = String(props.gitControls.threadId);
    if (props.onReturnToThread) {
      actions.push({
        accessibilityLabel: "Return to chat",
        icon: "chevron.left",
        onPress: props.onReturnToThread,
      });
    }
    if (props.hasThreadCwd) {
      actions.push({
        accessibilityLabel: "Open workspace",
        icon: THREAD_WORKSPACE_GLYPH,
        onPress: () => {
          const pane = readWorkspacePane(workspaceThreadMemoryKey(environmentId, threadId));
          if (pane === "files") navigation.navigate("ThreadFiles", { environmentId, threadId });
          else navigation.navigate("ThreadReview", { environmentId, threadId });
        },
      });
    }
    if (props.hasWorkspaceRoot && props.gitControls.canOpenTerminal) {
      actions.push({
        accessibilityLabel: "Open terminal",
        icon: "terminal",
        onPress: () => onOpenTerminal(null),
      });
    }
    if (onMergeBack) {
      actions.push({
        accessibilityLabel: "Merge back to source",
        icon: PullRequestGlyph.merged,
        onPress: onMergeBack,
      });
    }
    return actions;
  }, [
    onOpenTerminal,
    onMergeBack,
    props.onReturnToThread,
    props.hasThreadCwd,
    props.hasWorkspaceRoot,
    props.gitControls.canOpenTerminal,
    props.gitControls.environmentId,
    props.gitControls.threadId,
    navigation,
  ]);

  return (
    <>
      <AppBar
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
        onBack={layout.usesSplitView ? undefined : goBack}
        actions={androidHeaderActions}
        menus={gitMenu ? [gitMenu] : undefined}
        hideBottomBorder
        compact={composerKeyboardActive}
      />
      {native.fallback}
    </>
  );
}
