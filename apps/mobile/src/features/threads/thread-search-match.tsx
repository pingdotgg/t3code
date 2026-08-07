import {
  splitThreadSearchText,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

export function ThreadSearchMatchExcerpt(props: {
  readonly match: EnvironmentThreadSearchMatch;
  readonly query: string;
  readonly selected?: boolean;
  readonly compact?: boolean;
}) {
  const isUser = props.match.source === "user";
  const parts = splitThreadSearchText(props.match.snippet, props.query);
  return (
    <Text
      className={cn(
        props.compact ? "text-sm" : "text-xs",
        props.selected ? "text-user-bubble-foreground-muted" : "text-foreground-muted",
      )}
      numberOfLines={1}
    >
      <Text
        className={cn(
          props.compact ? "text-sm font-t3-medium" : "text-xs font-t3-medium",
          props.selected
            ? "text-user-bubble-foreground"
            : isUser
              ? "text-blue-500 dark:text-blue-400"
              : "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {isUser ? "You:" : "Agent:"}{" "}
      </Text>
      {parts.map((part) => (
        <Text
          className={cn(
            props.compact ? "text-sm" : "text-xs",
            part.highlighted && "font-t3-bold",
            props.selected
              ? "text-user-bubble-foreground"
              : part.highlighted
                ? "text-foreground"
                : "text-foreground-muted",
          )}
          key={part.start}
        >
          {part.text}
        </Text>
      ))}
    </Text>
  );
}
