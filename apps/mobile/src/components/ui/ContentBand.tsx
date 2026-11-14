import { View } from "react-native";

import { cn } from "../../lib/cn";
import { AppActivityIndicator } from "./AppActivityIndicator";
import { AppText as Text } from "./AppText";
import type { ContentBandProps, ContentStatusProps } from "./ContentBand.types";
export type { ContentBandProps, ContentStatusProps } from "./ContentBand.types";

/** A full-width band above or in place of content, ruled off from what follows. */
export function ContentBand(props: ContentBandProps) {
  return (
    <View
      className={cn(
        "border-b px-4",
        props.spacing === "roomy" ? "gap-3 py-4" : "py-3",
        props.tone === "warning" ? "border-warning-border bg-warning" : "border-border bg-card",
      )}
    >
      {props.children}
    </View>
  );
}

export function ContentStatus(props: ContentStatusProps) {
  if (props.loading) {
    return (
      <View className="items-center gap-3 border-b border-border bg-card px-4 py-6">
        <AppActivityIndicator size="small" />
        <Text className="text-xs text-foreground-muted">{props.detail}</Text>
      </View>
    );
  }
  return (
    <View className="border-b border-border bg-card px-4 py-5">
      {props.title ? (
        <Text className="text-sm font-t3-bold text-foreground">{props.title}</Text>
      ) : null}
      <Text className="text-xs leading-normal text-foreground-muted">{props.detail}</Text>
    </View>
  );
}

/** The scroll content style for a ContentStatus with nothing else in the scroll view. */
export const contentStatusContainerStyle = undefined;
