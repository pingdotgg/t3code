import { useNavigation, useNavigationState } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import { BackHandler, Keyboard, View, type TextInputInstance } from "react-native";
import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { MaterialSearchField } from "../../components/MaterialSearchField";
import { WorkspaceConnectionTitle } from "../home/WorkspaceConnectionTitle";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { WORKSPACE_TAB_PRESENTATION } from "../workspace/workspace-tabs-state";

/** PR and issue search share the thread list's native Android header placement. */
export function MaterialPullRequestToolbar(props: {
  readonly tab: "pullRequests" | "issues";
  readonly onRequestVisibility?: () => void;
}) {
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs()!;
  const { dispatch, getScrollOffset, recordScrollOffset, isTabActive } = workspace;
  const homeFocused = useNavigationState((state) => state.routes[state.index]?.name === "Home");
  const { onRequestVisibility, tab: tabId } = props;
  const listFocused = homeFocused && workspace.state.selectedTab === tabId;
  const tab = workspace.state.tabs[tabId];
  const presentation = WORKSPACE_TAB_PRESENTATION[tabId];
  const input = useRef<TextInputInstance>(null);
  const searching = tab.searchMode !== "resting";
  const openSearch = useCallback(() => {
    onRequestVisibility?.();
    dispatch({ type: "scroll", tab: tabId, offset: getScrollOffset(tabId) });
    dispatch({ type: "search", tab: tabId });
    input.current?.focus();
    return true;
  }, [dispatch, getScrollOffset, onRequestVisibility, tabId]);
  useHardwareKeyboardCommand("focusSearch", openSearch);
  const closeSearch = useCallback(() => {
    Keyboard.dismiss();
    recordScrollOffset(tabId, tab.searchEntryOffset);
    dispatch({ type: "cancel", tab: tabId });
  }, [dispatch, recordScrollOffset, tab.searchEntryOffset, tabId]);
  useEffect(() => {
    if (!searching || !listFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Frozen Home screens can keep effects alive after a detail route opens.
      const state = navigation.getState();
      if (!state || state.routes[state.index]?.name !== "Home" || !isTabActive(tabId)) return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [searching, closeSearch, listFocused, navigation, isTabActive, tabId]);
  return (
    <AndroidScreenHeader
      title={presentation.title}
      titleContent={
        searching ? (
          <MaterialSearchField
            inputRef={input}
            accessibilityLabel={presentation.search}
            clearAccessibilityLabel="Clear search"
            placeholder={presentation.search}
            value={tab.query}
            onChangeText={(query) => dispatch({ type: "query", tab: tabId, query })}
          />
        ) : (
          <View className="min-w-0 flex-1 pl-3">
            <WorkspaceConnectionTitle
              grow
              brand={
                <CompactBrandTitle
                  allowFontScaling={false}
                  accessibilityLabel={`T3 Code, ${presentation.title}`}
                />
              }
              onPress={() =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: { screen: "SettingsEnvironments" },
                })
              }
            />
          </View>
        )
      }
      leading={
        searching ? (
          <AndroidHeaderIconButton
            accessibilityLabel="Close search"
            icon="arrow.left"
            onPress={closeSearch}
          />
        ) : undefined
      }
      actions={
        searching
          ? []
          : [
              {
                accessibilityLabel: presentation.search,
                icon: "magnifyingglass",
                onPress: openSearch,
              },
              {
                accessibilityLabel: "Open settings",
                icon: "gearshape",
                onPress: () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "Settings" },
                  }),
              },
            ]
      }
    />
  );
}
