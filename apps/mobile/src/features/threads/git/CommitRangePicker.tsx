import type { GitRewriteableCommit } from "@t3tools/contracts";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../lib/cn";

export function CommitRangePicker({
  commits,
  startIndex,
  endIndex,
  onRangeChange,
  onReset,
}: {
  readonly commits: ReadonlyArray<GitRewriteableCommit>;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly onReset: () => void;
  readonly onRangeChange: (startIndex: number, endIndex: number) => void;
}) {
  const selectedCount = Math.max(0, endIndex - startIndex + 1);
  return (
    <View className="overflow-hidden rounded-xl bg-subtle">
      <View className="flex-row items-center justify-between gap-2 px-3 py-2">
        <View className="min-w-0 flex-1 gap-1">
          <Text accessibilityLiveRegion="polite" className="text-sm font-t3-medium text-foreground">
            {selectedCount} {selectedCount === 1 ? "commit" : "commits"} selected
          </Text>
          <Text className="text-xs text-foreground-secondary">
            Oldest to newest · both ends included
          </Text>
        </View>
        <Button label="All commits" tone="text" size="compact" onPress={onReset} />
      </View>
      <ScrollView nestedScrollEnabled style={{ maxHeight: 360 }} accessibilityLabel="Commit range">
        {commits.map((commit, index) => {
          const selected = index >= startIndex && index <= endIndex;
          const isStart = index === startIndex;
          const isEnd = index === endIndex;
          return (
            <View
              key={commit.sha}
              className={cn("flex-row gap-3 px-3", selected && "bg-primary/10")}
            >
              <View aria-hidden className="relative w-3">
                {index > 0 && (
                  <View
                    className={cn(
                      "absolute left-1/2 top-0 h-1/2 w-0.5 -translate-x-1/2",
                      index > startIndex && index <= endIndex ? "bg-primary" : "bg-subtle-strong",
                    )}
                  />
                )}
                {index < commits.length - 1 && (
                  <View
                    className={cn(
                      "absolute left-1/2 bottom-0 h-1/2 w-0.5 -translate-x-1/2",
                      index >= startIndex && index < endIndex ? "bg-primary" : "bg-subtle-strong",
                    )}
                  />
                )}
                <View
                  className={cn(
                    "absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
                    selected ? "bg-primary" : "bg-subtle-strong",
                  )}
                />
              </View>
              <View className="min-w-0 flex-1 gap-1 py-3">
                <Text className="text-sm font-t3-medium text-foreground">{commit.subject}</Text>
                <Text className="text-xs font-mono text-foreground-secondary">
                  {commit.shortSha}
                </Text>
                <View className="flex-row gap-1">
                  <Button
                    label={isStart ? "Start" : "Start here"}
                    tone={isStart ? "primary" : "text"}
                    size="compact"
                    accessibilityLabel={`${isStart ? "Range starts" : "Start"} at ${commit.shortSha}: ${commit.subject}`}
                    onPress={() => onRangeChange(index, Math.max(index, endIndex))}
                  />
                  <Button
                    label={isEnd ? "End" : "End here"}
                    tone={isEnd ? "primary" : "text"}
                    size="compact"
                    accessibilityLabel={`${isEnd ? "Range ends" : "End"} at ${commit.shortSha}: ${commit.subject}`}
                    onPress={() => onRangeChange(Math.min(index, startIndex), index)}
                  />
                </View>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
