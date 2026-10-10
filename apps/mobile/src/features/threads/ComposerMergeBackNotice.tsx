import { pendingMergeBackNotice } from "@t3tools/client-runtime/state/thread-relationships";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

/**
 * A merged-back fork changes what the next send carries. The notice leaves on
 * its own once the next run consumes the transfer and the feed shows the
 * context handoff divider.
 */
export function ComposerMergeBackNotice(props: {
  readonly sourceThreadTitle: string | null;
  readonly forkCount: number;
  readonly waitsForIdle: boolean;
}) {
  const notice = pendingMergeBackNotice(props);
  return (
    <View className="flex-row items-center gap-2 px-4 pb-2" accessibilityLiveRegion="polite">
      <SymbolView
        name={notice.blocked ? "exclamationmark.triangle" : "arrow.triangle.merge"}
        size={12}
        tintColorClassName="accent-foreground-muted"
      />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={2}>
        <Text className="font-t3-medium text-xs text-foreground">{notice.title}</Text>
        {`. ${notice.description}`}
      </Text>
    </View>
  );
}
