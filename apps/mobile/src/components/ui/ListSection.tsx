import { MOBILE_SHAPE } from "../../lib/designTokens";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "./AppText";

export function ListSection(props: {
  readonly title?: string;
  readonly titleIcon?: ReactNode;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: string;
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
            <Text textRole="footnote" className="shrink font-t3-medium text-foreground-muted">
              {props.title}
            </Text>
          </View>
          {props.trailing}
        </View>
      ) : null}
      <View
        className="overflow-hidden border-continuous bg-grouped-card"
        style={{
          borderRadius:
            Platform.OS === "android" ? MOBILE_SHAPE.group.android : MOBILE_SHAPE.group.ios,
        }}
      >
        {props.children}
      </View>
      {props.footer ? (
        <Text textRole="footnote" className="px-4 text-foreground-muted">
          {props.footer}
        </Text>
      ) : null}
    </View>
  );
}
