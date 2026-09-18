import { useNavigation } from "@react-navigation/native";
import type { ComponentProps, ReactNode } from "react";
import { Platform, View } from "react-native";

import { AndroidScreenHeader } from "../../../components/AndroidScreenHeader";
import { MaterialScreenContent as SettingsScreenContent } from "../../../components/MaterialScreenContent";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { AndroidWorkspaceSidebarButton } from "../../layout/workspace-sidebar-toolbar";

export { SettingsScreenContent };

export function SettingsScreen(
  props: Pick<ComponentProps<typeof AndroidScreenHeader>, "title" | "actions" | "trailing"> & {
    readonly children: ReactNode;
    /** A native form sheet already owns its rounded outer frame. */
    readonly formSheet?: boolean;
  },
) {
  const navigation = useNavigation();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={props.title}
            leading={props.formSheet ? undefined : <AndroidWorkspaceSidebarButton />}
            actions={props.actions}
            trailing={props.trailing}
            onBack={() => navigation.goBack()}
            hideBottomBorder={!props.formSheet}
          />
        </>
      ) : null}
      {props.formSheet ? (
        props.children
      ) : (
        <SettingsScreenContent>{props.children}</SettingsScreenContent>
      )}
    </View>
  );
}
