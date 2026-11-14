import { findSearchTokenRanges, splitSearchText } from "@t3tools/shared/paletteSearch";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { textDirection } from "@t3tools/shared/textDirection";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

export function ThreadSearchMatchExcerpt(props: {
  readonly match: EnvironmentThreadSearchMatch;
  readonly query: string;
  readonly selected?: boolean;
  readonly compact?: boolean;
  readonly sidebar?: boolean;
}) {
  const isUser = props.match.source === "user";
  const parts = splitSearchText(
    props.match.snippet,
    findSearchTokenRanges(props.match.snippet, props.query),
  );
  const direction = textDirection(props.match.snippet);
  return (
    <View className="min-w-0 flex-row items-baseline">
      <Text
        className={cn(
          props.compact ? "text-sm font-t3-medium" : "text-xs font-t3-medium",
          props.selected
            ? "text-thread-selected-foreground"
            : isUser
              ? props.sidebar
                ? "text-drawer-foreground-muted"
                : "text-foreground-secondary"
              : "text-adaptive-emerald-600-400",
        )}
      >
        {isUser ? "You:" : "Agent:"}{" "}
      </Text>
      {/* Its own paragraph, so the English label cannot set the snippet's base direction. */}
      <Text
        className={cn(
          "min-w-0 flex-1",
          props.compact ? "text-sm" : "text-xs",
          props.selected
            ? "text-thread-selected-foreground-muted"
            : props.sidebar
              ? "text-drawer-foreground-muted"
              : "text-foreground-muted",
        )}
        numberOfLines={1}
        style={direction ? { writingDirection: direction, textAlign: "left" } : undefined}
      >
        {/* Android ignores writingDirection; the mark sets its first-strong paragraph direction. */}
        {Platform.OS === "android" && direction
          ? direction === "rtl"
            ? "\u200f"
            : "\u200e"
          : null}
        {parts.map((part) => (
          <Text
            className={cn(
              props.compact ? "text-sm" : "text-xs",
              part.highlighted && "font-t3-bold",
              props.selected
                ? "text-thread-selected-foreground"
                : part.highlighted
                  ? props.sidebar
                    ? "text-drawer-foreground"
                    : "text-foreground"
                  : props.sidebar
                    ? "text-drawer-foreground-muted"
                    : "text-foreground-muted",
            )}
            key={part.start}
          >
            {part.text}
          </Text>
        ))}
      </Text>
    </View>
  );
}
