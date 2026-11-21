import { T, useGT } from "gt-react-native";
import type { EnvironmentId, ThreadId, TurnItemId } from "@lathe/contracts";
import { TERMINAL_PALETTES, terminalOutputSpans } from "@lathe/shared/terminalOutput";
import type React from "react";
import { useMemo, useRef } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { ThreadTerminalCard } from "./ThreadTerminalCard";

const FOLLOW_SLACK = 8;

export function useCommandOutputStreaming(environmentId: EnvironmentId): boolean {
  return (
    useServerConfigs().get(environmentId)?.environment.capabilities.commandOutputStreaming === true
  );
}

/**
 * Fork: a terminal card whose output comes from the stream. The copied
 * transcript is the final output, and copying stays disabled until the
 * command has finished; the panel shows the live output meanwhile.
 */
export function StreamedThreadTerminalCard(props: {
  readonly command: string;
  readonly exitCode: number | undefined;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly themeAppearance: "light" | "dark";
  readonly onCopy: (transcript: string) => void;
}) {
  const { data } = useEnvironmentQuery(
    orchestrationEnvironment.v2.commandOutput({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, itemId: props.itemId },
    }),
  );
  const finished = data !== null && data !== undefined && !data.running;
  const text = finished ? data.output.text : "";
  return (
    <ThreadTerminalCard
      command={props.command}
      exitCode={props.exitCode}
      output={text.length > 0 ? text : null}
      status={finished ? null : "Loading output…"}
      outputSlot={
        <ThreadCommandOutput
          environmentId={props.environmentId}
          threadId={props.threadId}
          itemId={props.itemId}
          themeAppearance={props.themeAppearance}
        />
      }
      themeAppearance={props.themeAppearance}
      onCopy={props.onCopy}
    />
  );
}

/** Mount only while useCommandOutputStreaming holds; unmount to stop subscriptions for collapsed rows or other threads. */
export function ThreadCommandOutput(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly themeAppearance: "light" | "dark";
}) {
  const gt = useGT();
  const { data, error } = useEnvironmentQuery(
    orchestrationEnvironment.v2.commandOutput({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, itemId: props.itemId },
    }),
  );
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const followRef = useRef(true);
  const text = data?.output.text ?? "";
  const spans = useMemo(
    () => terminalOutputSpans(text, TERMINAL_PALETTES[props.themeAppearance]),
    [text, props.themeAppearance],
  );
  if (text.length === 0) {
    const message = error
      ? gt("Couldn't load output: {error}", { error })
      : data === null
        ? gt("Loading output…")
        : data.running
          ? null
          : gt("No output.");
    return message === null ? null : (
      <Text className="pt-1.5 font-mono text-2xs leading-normal text-foreground-muted">
        {message}
      </Text>
    );
  }
  return (
    <View className="pt-1.5">
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
        {data?.output.truncated ? (
          <Text className="pb-0.5 text-3xs text-foreground-subtle">
            <T>Earlier output not shown</T>
          </Text>
        ) : null}
        <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
          {spans.map((span, index) =>
            span.style === null ? (
              span.text
            ) : (
              // Spans are rebuilt from scratch on every update and never reorder.
              // oxlint-disable-next-line react/no-array-index-key
              <Text key={index} style={span.style}>
                {span.text}
              </Text>
            ),
          )}
        </Text>
      </ScrollView>
    </View>
  );
}
