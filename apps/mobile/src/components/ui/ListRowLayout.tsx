import type { ReactNode } from "react";
import { Platform, useWindowDimensions, View } from "react-native";

import { cn } from "../../lib/cn";
import { AppText } from "./AppText";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

export interface ListRowContentProps {
  readonly icon?: AppSymbolName;
  /** Drawn in the icon column for marks a single symbol can't express. */
  readonly leading?: ReactNode;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  /** Rich secondary content under the description, such as scores with emphasized values. */
  readonly meta?: ReactNode;
  readonly disabled?: boolean;
}

export function ListRowLayout({
  icon,
  leading,
  label,
  description,
  detail,
  meta,
  disabled,
  accessory,
  tone = "default",
}: ListRowContentProps & { readonly accessory?: ReactNode; readonly tone?: "default" | "danger" }) {
  const { fontScale } = useWindowDimensions();
  const stackDetail = fontScale >= 1.5;
  return (
    <View
      className={cn(
        "min-h-14 flex-row items-center gap-3 px-4 py-3",
        description && Platform.OS !== "android" && "min-h-18",
        disabled && "opacity-45",
      )}
    >
      {icon ? (
        <View
          className={
            Platform.OS === "android"
              ? "size-5 items-center justify-center"
              : "size-6 items-center justify-center"
          }
        >
          <SymbolView
            name={icon}
            size={Platform.OS === "android" ? 18 : 22}
            tintColorClassName={tone === "danger" ? "accent-danger-foreground" : "accent-icon"}
            type="monochrome"
            weight="regular"
          />
        </View>
      ) : leading ? (
        <View className="size-6 items-center justify-center">{leading}</View>
      ) : null}
      <View className="min-w-0 flex-1 gap-1">
        <AppText
          textRole={Platform.OS === "android" ? "footnote" : "body"}
          className={cn(
            tone === "danger" ? "text-danger-foreground" : "text-foreground",
            Platform.OS === "android" && "font-t3-medium",
          )}
        >
          {label}
        </AppText>
        {description ? (
          <AppText
            textRole={Platform.OS === "android" ? "caption" : "footnote"}
            className="text-foreground-muted"
          >
            {description}
          </AppText>
        ) : null}
        {meta}
        {detail && stackDetail ? (
          <AppText
            textRole={Platform.OS === "android" ? "caption" : "footnote"}
            className="text-foreground-muted"
          >
            {detail}
          </AppText>
        ) : null}
      </View>
      {detail && !stackDetail ? (
        <AppText
          textRole={Platform.OS === "android" ? "caption" : "footnote"}
          className="max-w-[40%] shrink text-right text-foreground-muted"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {detail}
        </AppText>
      ) : null}
      {accessory}
    </View>
  );
}
