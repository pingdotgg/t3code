import { useNavigation, useNavigationState, useRoute } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import type { AppBarProps } from "../../../components/ui/AppBar.types";
import { AppBar } from "../../../components/ui/AppBar";
import { ScreenContent as SettingsScreenContent } from "../../../components/ui/ScreenContent";
import { useWorkspaceTabs } from "../../workspace/WorkspaceTabsContext";

export { SettingsScreenContent };

export function SettingsScreen(
  props: Pick<AppBarProps, "title" | "actions" | "trailing"> & {
    readonly children: ReactNode;
    readonly formSheet?: boolean;
  },
) {
  const navigation = useNavigation();
  const route = useRoute();
  const index = useNavigationState((state) => state.index);
  const workspace = useWorkspaceTabs();
  // Android opens Settings as a workspace tab; its root page has nothing to go back to.
  const workspaceRoot =
    Platform.OS === "android" && workspace !== null && index === 0 && route.name === "Settings";

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar
        title={props.title}
        actions={props.actions}
        trailing={Platform.OS === "android" ? props.trailing : undefined}
        sidebar={false}
        onBack={workspaceRoot ? undefined : () => navigation.goBack()}
        hideBottomBorder={!props.formSheet}
      />
      {props.formSheet ? (
        props.children
      ) : (
        <SettingsScreenContent>{props.children}</SettingsScreenContent>
      )}
    </View>
  );
}
