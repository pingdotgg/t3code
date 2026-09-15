import { useNavigation } from "@react-navigation/native";
import type { ComponentProps, ReactNode } from "react";
import { Platform, View } from "react-native";

import { AndroidScreenHeader } from "../../../components/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { useAppearancePreferences } from "../appearance/AppearancePreferencesProvider";

/** Clips scrolling settings content below the header, leaving the shared frame behind its corners. */
export function SettingsScreenContent({ children }: { readonly children: ReactNode }) {
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  if (!materialYouStyleLayoutActive) return children;

  return (
    <View className="flex-1 bg-header">
      <View className="flex-1 overflow-hidden rounded-t-[28px] bg-sheet-solid">{children}</View>
    </View>
  );
}

export function SettingsScreen(
  props: Pick<ComponentProps<typeof AndroidScreenHeader>, "title" | "actions" | "trailing"> & {
    readonly children: ReactNode;
    /** Preserve this route's native Android header when Material You layout is off. */
    readonly nativeAndroidHeader?: boolean;
    /** A native form sheet already owns its rounded outer frame. */
    readonly formSheet?: boolean;
  },
) {
  const navigation = useNavigation();
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  const showAndroidHeader = materialYouStyleLayoutActive || !props.nativeAndroidHeader;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: !showAndroidHeader }} />
          {showAndroidHeader ? (
            <AndroidScreenHeader
              title={props.title}
              actions={props.actions}
              trailing={props.trailing}
              onBack={() => navigation.goBack()}
              hideBottomBorder={materialYouStyleLayoutActive && !props.formSheet}
            />
          ) : null}
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
