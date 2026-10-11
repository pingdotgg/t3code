import type { ReactNode } from "react";
import { View } from "react-native";

/** Shared leading column and text alignment for PR activity and commit rows. */
export function PullRequestEntryRow({
  leading,
  children,
}: {
  readonly leading: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <View className="flex-row gap-3">
      <View className="relative w-8 items-center">{leading}</View>
      <View className="min-w-0 flex-1">{children}</View>
    </View>
  );
}
