import { formatTokens } from "@t3tools/shared/usageFormat";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";

/** Shown while the next send compacts a stale Claude thread first; the chip keeps the history. */
export function CompactBeforeSendNotice(props: {
  readonly tokens: number;
  readonly keepFullHistory: boolean;
  readonly disabled: boolean;
  readonly onToggleKeepFullHistory: () => void;
}) {
  const tokens = formatTokens(props.tokens);
  return (
    <View className="flex-row items-center gap-3 px-4 pb-3">
      <AppText
        textRole="footnote"
        accessibilityLiveRegion="polite"
        className="min-w-0 flex-1 text-foreground-muted"
      >
        {props.keepFullHistory
          ? `Next send keeps all ${tokens} tokens.`
          : `Next send compacts ${tokens} tokens first.`}
      </AppText>
      <Chip
        icon="arrow.down.right.and.arrow.up.left"
        label={props.keepFullHistory ? "Compact first" : "Keep full history"}
        disabled={props.disabled}
        onPress={props.onToggleKeepFullHistory}
      />
    </View>
  );
}
