import {
  formatClaudeContextHeadline,
  type ClaudeContextReport,
} from "@t3tools/shared/claudeContextReport";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ClaudeContextCardBody } from "./ClaudeContextCard";

export function ComposerClaudeContext(props: {
  readonly report: ClaudeContextReport;
  readonly onClose: () => void;
}) {
  const { report } = props;
  const { height } = useWindowDimensions();
  return (
    <View className="overflow-hidden rounded-[20px] border-continuous bg-card">
      <ScrollView
        bounces={false}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={{ maxHeight: Math.round(height * 0.4) }}
        contentContainerClassName="gap-2.5 px-4 py-3"
      >
        <View className="flex-row items-center gap-3">
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-base text-foreground" numberOfLines={1}>
              Context window
            </Text>
            <Text className="text-xs tabular-nums text-foreground-muted" numberOfLines={1}>
              {report.model ? `${report.model} · ` : ""}
              {formatClaudeContextHeadline(report)}
            </Text>
          </View>
          <Pressable
            accessibilityLabel="Dismiss context window"
            accessibilityRole="button"
            hitSlop={12}
            onPress={props.onClose}
            className="-me-1 p-1 active:opacity-60"
          >
            <SymbolView
              name="xmark"
              size={14}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
        </View>
        <ClaudeContextCardBody report={report} />
      </ScrollView>
    </View>
  );
}
