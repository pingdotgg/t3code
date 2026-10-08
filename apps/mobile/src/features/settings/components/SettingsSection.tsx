import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";

export function SettingsSection(props: {
  readonly title?: string;
  readonly titleIcon?: ReactNode;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-2">
      {props.title ? (
        <View className="flex-row items-center justify-between gap-3">
          <View
            className={
              Platform.OS === "android"
                ? "min-w-0 flex-1 flex-row items-center gap-2 px-4"
                : "min-w-0 flex-1 flex-row items-center gap-2 px-2"
            }
          >
            {props.titleIcon}
            <Text
              className={
                Platform.OS === "android"
                  ? "shrink text-sm font-t3-medium text-primary-text"
                  : "shrink text-sm font-t3-medium text-foreground-muted"
              }
            >
              {props.title}
            </Text>
          </View>
          {props.trailing}
        </View>
      ) : null}
      <View
        className={
          Platform.OS === "android"
            ? "overflow-hidden rounded-[28px] bg-grouped-card"
            : "overflow-hidden rounded-[24px] border-continuous bg-grouped-card"
        }
      >
        {props.children}
      </View>
    </View>
  );
}
