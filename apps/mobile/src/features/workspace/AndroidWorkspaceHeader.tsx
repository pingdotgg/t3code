import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";

import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { WorkspaceConnectionTitle } from "../home/WorkspaceConnectionTitle";

/** A fixed row keeps the Android list headers aligned regardless of their actions or search. */
export function AndroidWorkspaceHeader(props: {
  readonly title: string;
  readonly titleContent?: ReactNode;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly sidebar?: boolean;
  readonly onLayout?: (event: LayoutChangeEvent) => void;
  readonly onOpenEnvironments?: () => void;
}) {
  const navigation = useNavigation();
  const { height, ...headerPadding } = useToolbarLayout();
  return (
    <View
      onLayout={props.onLayout}
      className={props.sidebar ? "absolute inset-x-0 top-0 z-[4] bg-header px-2" : "bg-header px-2"}
      style={headerPadding}
    >
      <View className="flex-row items-center gap-1" style={{ height }}>
        {props.leading}
        {props.titleContent ?? (
          <View className="min-w-0 flex-1 pl-4">
            <WorkspaceConnectionTitle
              grow
              brand={
                <CompactBrandTitle
                  allowFontScaling={false}
                  accessibilityLabel={`T3 Code, ${props.title}`}
                />
              }
              onPress={
                props.onOpenEnvironments ??
                (() =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "SettingsEnvironments" },
                  }))
              }
            />
          </View>
        )}
        {props.trailing}
      </View>
    </View>
  );
}
