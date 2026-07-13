import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { memo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { CopyTextButton } from "../../components/CopyTextButton";
import type { ThreadFeedSessionExit } from "../../lib/threadActivity";
import { useThemeColor } from "../../lib/useThemeColor";

export const SessionExitRow = memo(function SessionExitRow(props: {
  readonly sessionExit: ThreadFeedSessionExit;
}) {
  const [expanded, setExpanded] = useState(false);
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const codeBackgroundColor = useThemeColor("--color-subtle");

  return (
    <View className="mb-3 gap-2 rounded-2xl border border-rose-500/20 bg-rose-500/8 px-3 py-2.5 dark:bg-rose-500/10">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.sessionExit.summary}. ${
          expanded ? "Hide process output" : "Show process output"
        }`}
        accessibilityState={{ expanded }}
        hitSlop={4}
        onPress={() => {
          void Haptics.selectionAsync();
          setExpanded((value) => !value);
        }}
      >
        <View className="flex-row items-start gap-2">
          <View className="h-5 w-5 items-center justify-center pt-0.5">
            <SymbolView
              name="exclamationmark.octagon.fill"
              size={16}
              tintColor="#e11d48"
              type="monochrome"
            />
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="font-t3-medium text-sm text-foreground">
              {props.sessionExit.summary}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {expanded ? "Hide process output" : "Show process output"}
            </Text>
          </View>
          <View className="h-5 w-4 items-center justify-center">
            <SymbolView
              name={expanded ? "chevron.down" : "chevron.right"}
              size={11}
              tintColor={iconSubtleColor}
              type="monochrome"
            />
          </View>
        </View>
      </Pressable>

      {expanded ? (
        <View className="gap-1.5">
          <View className="flex-row items-center justify-between gap-2">
            <Text className="font-t3-medium text-xs text-foreground-muted">Process output</Text>
            <CopyTextButton
              accessibilityLabel="Copy process output"
              text={props.sessionExit.stderrTail}
              tintColor={iconSubtleColor}
              backgroundColor={codeBackgroundColor}
              buttonSize={28}
              iconSize={12}
            />
          </View>
          <ScrollView
            nestedScrollEnabled
            showsVerticalScrollIndicator
            style={{ maxHeight: 220, borderRadius: 10, backgroundColor: codeBackgroundColor }}
          >
            <Text selectable className="px-2.5 py-2 font-mono text-xs leading-5 text-foreground">
              {props.sessionExit.stderrTail}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
});
