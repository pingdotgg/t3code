import { Host, Picker, Text } from "@expo/ui/swift-ui";
import { pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { StackActions, useNavigation } from "@react-navigation/native";
import { Keyboard, View } from "react-native";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

/** Wide iPad navigation belongs to the sidebar, leaving the detail's header unobstructed. */
export function WorkspaceSidebarTabs() {
  const workspace = useWorkspaceTabs()!;
  const navigation = useNavigation();
  const { themeAppearance } = useAppearancePreferences();
  return (
    <View className="px-4 pb-3 pt-2">
      <Host
        matchContents={{ vertical: true }}
        colorScheme={themeAppearance}
        style={{ width: "100%" }}
      >
        <Picker
          label="Workspace"
          selection={workspace.state.selectedTab}
          onSelectionChange={(tab: WorkspaceTab) => {
            if (tab === workspace.state.selectedTab) return;
            Keyboard.dismiss();
            if (navigation.getState()?.index) navigation.dispatch(StackActions.popToTop());
            workspace.dispatch({ type: "select", tab });
          }}
          modifiers={[pickerStyle("segmented")]}
        >
          <Text modifiers={[tag("threads")]}>Threads</Text>
          <Text modifiers={[tag("pullRequests")]}>Pull requests</Text>
        </Picker>
      </Host>
    </View>
  );
}
