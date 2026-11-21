import { View } from "react-native";

import { AppText as Text } from "./ui/AppText";
import { cn } from "../lib/cn";
import { defineNativePluginFeature } from "../plugins/features";
export const StatusPill = defineNativePluginFeature(
  "native.components.status-pill",
  BuiltinStatusPill,
);

export interface StatusTone {
  readonly label: string;
  readonly pillClassName: string;
  readonly textClassName: string;
}

function BuiltinStatusPill(
  props: StatusTone & {
    readonly size?: "default" | "compact";
  },
) {
  const size = props.size ?? "default";
  return (
    <View
      className={cn(
        "rounded-full",
        size === "compact" ? "px-2.5 py-1" : "px-3 py-1.5",
        props.pillClassName,
      )}
    >
      <Text
        className={cn(
          "font-t3-bold",
          size === "compact" ? "text-2xs" : "text-xs",
          props.textClassName,
        )}
      >
        {props.label}
      </Text>
    </View>
  );
}
