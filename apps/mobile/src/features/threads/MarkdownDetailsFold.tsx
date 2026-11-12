import * as Haptics from "expo-haptics";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { ThreadDisclosureChevron } from "./thread-work-log";

export function MarkdownDetailsFold(props: {
  readonly summary: string;
  readonly initiallyOpen: boolean;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(props.initiallyOpen);
  const iconSubtleColor = useUniwindTheme()["--color-icon-subtle"];
  return (
    <View className="my-2 border-y border-border">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.summary}
        accessibilityState={{ expanded }}
        hitSlop={4}
        className="min-h-10 flex-row items-center gap-2 py-2"
        onPress={() => {
          void Haptics.selectionAsync();
          setExpanded((value) => !value);
        }}
      >
        <ThreadDisclosureChevron
          expanded={expanded}
          collapsedDirection="right"
          size={12}
          tintColor={iconSubtleColor}
        />
        <Text className="min-w-0 shrink font-t3-medium text-sm text-foreground">
          {props.summary}
        </Text>
      </Pressable>
      {expanded ? <View className="pb-3 pl-5">{props.children}</View> : null}
    </View>
  );
}
