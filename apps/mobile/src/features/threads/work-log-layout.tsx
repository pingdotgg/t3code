import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { ComponentProps, ReactNode } from "react";
import { Pressable, View } from "react-native";
import { THREAD_WORK_ROW_MIN_HEIGHT, type deriveThreadWorkLogSizing } from "../../lib/layout";

export function WorkLogBlock({
  children,
  layout = "standalone",
  continues = false,
}: {
  children: ReactNode;
  layout?: "standalone" | "group-header";
  continues?: boolean | undefined;
}) {
  return (
    <View className={continues || layout === "group-header" ? "-mx-1 px-1" : "-mx-1 mb-1 px-1"}>
      {children}
    </View>
  );
}

export function WorkLogRows({ children }: { children: ReactNode }) {
  return <View className="gap-px">{children}</View>;
}

export function WorkLogIconSlot({ children }: { children: ReactNode }) {
  return <View className="relative h-6 w-6 shrink-0 items-center justify-center">{children}</View>;
}

/** Consumers supply actions/content; sizing comes from the feed's accessibility-aware metrics. */
export function WorkLogPressable({
  children,
  rowSizing,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children" | "className" | "style" | "hitSlop"> & {
  children: ReactNode;
  rowSizing?: ReturnType<typeof deriveThreadWorkLogSizing>;
}) {
  return (
    <Pressable {...props} hitSlop={4} className="rounded-md px-0.5 py-0 active:bg-subtle">
      <View
        className="flex-row items-center gap-1.5"
        style={{ minHeight: rowSizing?.estimatedRowHeight ?? THREAD_WORK_ROW_MIN_HEIGHT }}
      >
        {children}
      </View>
    </Pressable>
  );
}

/** Headers stay one line; only the separate detail content can wrap. */
export function WorkLogLabel({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "danger" | "warning";
}) {
  return (
    <Text
      selectable={false}
      numberOfLines={1}
      ellipsizeMode="tail"
      className={cn(
        "min-w-0 flex-1 text-sm text-foreground-muted",
        tone === "danger" && "font-t3-medium text-adaptive-rose-600-400",
        tone === "warning" && "font-t3-medium text-warning-foreground",
      )}
    >
      {children}
    </Text>
  );
}
