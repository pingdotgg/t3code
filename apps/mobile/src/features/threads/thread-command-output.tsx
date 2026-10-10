import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import {
  TERMINAL_PALETTES,
  terminalOutputSpans,
  type TerminalSpanStyle,
} from "@t3tools/shared/terminalOutput";
import type React from "react";
import { useMemo, useRef } from "react";
import { ScrollView, type TextStyle, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

// Within this many points of the end still counts as following the output.
const FOLLOW_SLACK = 8;

function spanStyle(style: TerminalSpanStyle): TextStyle {
  const decorations =
    style.underline && style.strike
      ? "underline line-through"
      : style.underline
        ? "underline"
        : style.strike
          ? "line-through"
          : undefined;
  return {
    ...(style.color === undefined ? {} : { color: style.color }),
    ...(style.backgroundColor === undefined ? {} : { backgroundColor: style.backgroundColor }),
    ...(style.bold ? { fontWeight: "600" as const } : {}),
    ...(style.dim ? { opacity: 0.65 } : {}),
    ...(style.italic ? { fontStyle: "italic" as const } : {}),
    ...(decorations === undefined ? {} : { textDecorationLine: decorations }),
  };
}

/**
 * Output of one expanded command row: streams while the command runs, then
 * shows its final output. Subscribes only while mounted, so collapsed rows and
 * other threads receive nothing.
 */
/** True when the environment streams command output; older servers only return final output. */
export function useCommandOutputStreaming(environmentId: EnvironmentId): boolean {
  return (
    useServerConfigs().get(environmentId)?.environment.capabilities.commandOutputStreaming === true
  );
}

export function ThreadCommandOutput(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
}) {
  const supported = useCommandOutputStreaming(props.environmentId);
  const { data, error } = useEnvironmentQuery(
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
  const { themeAppearance } = useAppearancePreferences();
  const spans = useMemo(
    () =>
      terminalOutputSpans(text, TERMINAL_PALETTES[themeAppearance === "dark" ? "dark" : "light"]),
    [text, themeAppearance],
  );
  if (text.length === 0) {
    const message = error
      ? `Couldn't load output: ${error}`
      : data === null
        ? "Loading output…"
        : data.running
          ? null
          : "No output.";
    return message === null ? null : (
      <Text className="pt-1.5 font-mono text-2xs leading-normal text-foreground-muted">
        {message}
      </Text>
    );
  }
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
          {spans.map((span, index) =>
            span.style === null ? (
              span.text
            ) : (
              // Spans are rebuilt from scratch on every update and never reorder.
              // oxlint-disable-next-line react/no-array-index-key
              <Text key={index} style={spanStyle(span.style)}>
                {span.text}
              </Text>
            ),
          )}
        </Text>
      </ScrollView>
    </View>
  );
}
