import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Keyboard,
  Pressable,
  View,
  useWindowDimensions,
  type TextInputInstance,
} from "react-native";
import { KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { useHardwareBack } from "../../lib/backHandler";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceDock } from "./WorkspaceDock";
import { WorkspaceSearchField } from "./WorkspaceSearchField";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WORKSPACE_TOOLBAR, type WorkspaceTab } from "./workspace-tabs-state";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";

const TABS: ReadonlyArray<{ id: WorkspaceTab; label: string; icon: AppSymbolName }> = [
  { id: "threads", label: "Threads", icon: "text.bubble" },
  { id: "pullRequests", label: "PRs", icon: PullRequestGlyph.pullRequest },
];

function ToolbarButton(props: {
  label: string;
  icon: AppSymbolName;
  onPress: () => void;
  size?: number;
}) {
  const size = props.size ?? WORKSPACE_TOOLBAR.height;
  return (
    <GlassSurface style={{ width: size, height: size, borderRadius: size / 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.label}
        onPress={props.onPress}
        className="flex-1 items-center justify-center"
      >
        <SymbolView name={props.icon} size={22} tintColorClassName="accent-icon" />
      </Pressable>
    </GlassSurface>
  );
}

export function WorkspaceToolbar(props: {
  readonly sidebar?: boolean;
  readonly onNewTask: () => void;
}) {
  const workspace = useWorkspaceTabs();
  const input = useRef<TextInputInstance>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const edge = width < 360 ? 12 : WORKSPACE_TOOLBAR.edge;
  const gap = width < 360 ? 6 : WORKSPACE_TOOLBAR.gap;
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const focusSearch = useCallback(() => {
    if (!workspace) return false;
    const tab = workspace.state.selectedTab;
    if (tab !== "threads" && tab !== "pullRequests") return false;
    workspace.dispatch({ type: "scroll", tab, offset: workspace.getScrollOffset(tab) });
    workspace.dispatch({ type: "search" });
    setFocusRequest((request) => request + 1);
    return true;
  }, [workspace]);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  useFocusEffect(useCallback(() => () => Keyboard.dismiss(), []));
  const cancelSearch = useCallback(() => {
    Keyboard.dismiss();
    if (workspace)
      workspace.recordScrollOffset(
        workspace.state.selectedTab,
        workspace.state.tabs[workspace.state.selectedTab].searchEntryOffset,
      );
    workspace?.dispatch({ type: "cancel" });
  }, [workspace]);
  const searchOpen =
    workspace !== null &&
    workspace.state.tabs[workspace.state.selectedTab].searchMode !== "resting";
  useHardwareBack(searchOpen, () => {
    if (keyboardVisible) Keyboard.dismiss();
    else cancelSearch();
    return true;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the search TextInput after a focus request renders it
  useEffect(() => {
    if (focusRequest > 0) input.current?.focus();
  }, [focusRequest]);
  if (!workspace) return null;
  const { state, dispatch } = workspace;
  const tab = state.tabs[state.selectedTab];
  const activeTab = TABS.find((item) => item.id === state.selectedTab)!;
  const searching = tab.searchMode !== "resting";
  const expanded = tab.searchMode === "expanded" && !keyboardVisible;
  const showNavigation = !searching || expanded;
  const bottom = Math.max(insets.bottom, 12);

  return (
    <KeyboardStickyView
      pointerEvents="box-none"
      className="absolute inset-x-0 bottom-0"
      offset={{ closed: 0, opened: bottom - 8 }}
    >
      <View
        pointerEvents="box-none"
        style={{ paddingHorizontal: edge, paddingBottom: bottom, gap: 10 }}
      >
        {searching ? (
          <View className="flex-row items-center" style={{ gap }}>
            {!keyboardVisible && !expanded ? (
              <ToolbarButton
                label={`Show tabs, ${activeTab.label} selected`}
                icon={activeTab.icon}
                size={48}
                onPress={() => dispatch({ type: "expand" })}
              />
            ) : null}
            <WorkspaceSearchField
              ref={input}
              tab={state.selectedTab}
              query={tab.query}
              onChangeQuery={(query) => dispatch({ type: "query", query })}
              onFocus={() => dispatch({ type: "search" })}
              onClear={() => {
                dispatch({ type: "query", query: "" });
                focusSearch();
              }}
            />
            <ToolbarButton label="Cancel search" icon="xmark" size={48} onPress={cancelSearch} />
          </View>
        ) : null}
        {showNavigation ? <WorkspaceDock onNewTask={props.onNewTask} /> : null}
      </View>
    </KeyboardStickyView>
  );
}
