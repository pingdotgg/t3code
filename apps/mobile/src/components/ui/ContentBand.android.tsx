import { View } from "react-native";

import { cn } from "../../lib/cn";
import { AppActivityIndicator } from "./AppActivityIndicator";
import { AppText as Text } from "./AppText";
import type { ContentBandProps, ContentStatusProps } from "./ContentBand.types";
export type { ContentBandProps, ContentStatusProps } from "./ContentBand.types";

/** A rounded card floating in the content's margin. */
export function ContentBand(props: ContentBandProps) {
  return (
    <View
      className={cn(
        "m-2 rounded-[20px] px-4",
        props.spacing === "roomy" ? "gap-3 py-4" : "py-3",
        props.tone === "warning" ? "bg-warning" : "bg-card",
      )}
    >
      {props.children}
    </View>
  );
}

/** Material centers an empty state in the space it has. */
export function ContentStatus(props: ContentStatusProps) {
  if (props.loading) {
    return (
      <View className="items-center gap-3 px-4 py-6">
        <AppActivityIndicator size="small" />
        <Text className="text-xs text-foreground-muted">{props.detail}</Text>
      </View>
    );
  }
  return (
    <View className="items-center px-6 py-5">
      {props.title ? (
        <Text className="text-sm font-t3-bold text-foreground">{props.title}</Text>
      ) : null}
      <Text className="mt-2 text-center text-xs leading-normal text-foreground-muted">
        {props.detail}
      </Text>
    </View>
  );
}

export const contentStatusContainerStyle = { flexGrow: 1, justifyContent: "center" } as const;
