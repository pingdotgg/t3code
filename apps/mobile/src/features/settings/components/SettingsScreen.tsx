import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import type { AppBarProps } from "../../../components/ui/AppBar.types";
import { AppBar } from "../../../components/ui/AppBar";
import { ScreenContent as SettingsScreenContent } from "../../../components/ui/ScreenContent";

export { SettingsScreenContent };

export function SettingsScreen(
  props: Pick<AppBarProps, "title" | "actions" | "trailing"> & {
    readonly children: ReactNode;
    readonly formSheet?: boolean;
  },
) {
  const navigation = useNavigation();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar
        title={props.title}
        actions={props.actions}
        trailing={Platform.OS === "android" ? props.trailing : undefined}
        sidebar={false}
        onBack={() => navigation.goBack()}
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
