import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import type React from "react";
import { useRef } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

// Within this many points of the end still counts as following the output.
const FOLLOW_SLACK = 8;

/**
 * Output of one expanded command row: streams while the command runs, then
 * shows its final output. Subscribes only while mounted, so collapsed rows and
 * other threads receive nothing.
 */
export function ThreadCommandOutput(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
}) {
  const supported =
    useServerConfigs().get(props.environmentId)?.environment.capabilities.commandOutputStreaming ===
    true;
  const { data } = useEnvironmentQuery(
    supported
      ? orchestrationEnvironment.v2.commandOutput({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, itemId: props.itemId },
        })
      : null,
  );
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  // Follow new output until the reader scrolls up; scrolling back down resumes.
  const followRef = useRef(true);
  const text = data?.output.text ?? "";
  if (text.length === 0) return null;
  return (
    <View className="pt-1.5">
      {data?.output.truncated ? (
        <Text className="pb-0.5 text-3xs text-foreground-subtle">Earlier output not shown</Text>
      ) : null}
      <ScrollView
        ref={scrollRef}
        nestedScrollEnabled
        directionalLockEnabled
        showsVerticalScrollIndicator
        className="max-h-60"
        contentContainerStyle={{ paddingRight: 8 }}
        scrollEventThrottle={100}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          followRef.current =
            contentSize.height - contentOffset.y - layoutMeasurement.height <= FOLLOW_SLACK;
        }}
        onContentSizeChange={() => {
          if (followRef.current) scrollRef.current?.scrollToEnd({ animated: false });
        }}
      >
        <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}
