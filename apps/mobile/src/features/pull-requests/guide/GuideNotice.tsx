import { Button } from "../../../components/ui/Button";
import { View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { PR_ROW_EXIT, PR_ROW_LAYOUT } from "../pullRequestAnimations";
import { guideNoticeState } from "./reviewGuideState";
import type { useReviewGuide } from "./useReviewGuide";

const NOTICE_ENTER = FadeIn.delay(180).duration(120).reduceMotion(ReduceMotion.System);

export function GuideNotice({ state }: { readonly state: ReturnType<typeof useReviewGuide> }) {
  const notice = guideNoticeState(state);
  if (notice.kind === "ready") return null;
  const compact = state.data?.guide != null;
  const failed = notice.kind === "failed" || notice.kind === "unavailable";
  const busy = notice.kind === "loading" || notice.kind === "writing";
  return (
    <Animated.View
      layout={PR_ROW_LAYOUT}
      entering={compact ? NOTICE_ENTER : undefined}
      exiting={PR_ROW_EXIT}
      className={
        compact ? "mb-5 rounded-2xl bg-grouped-card p-4" : "rounded-2xl bg-grouped-card p-5"
      }
      accessibilityLiveRegion="polite"
      accessibilityState={{ busy }}
    >
      <View className="flex-row items-center gap-3">
        <SymbolView
          name={failed ? "exclamationmark.circle" : busy ? "clock" : "list.number"}
          size={19}
          tintColorClassName={failed ? "accent-danger-foreground" : "accent-icon-muted"}
        />
        <Text className="text-base font-t3-semibold">
          {compact ? notice.title : "Review guide"}
        </Text>
      </View>
      <View style={compact ? undefined : { minHeight: 100 }} className="pt-3 pb-4">
        <Text className="text-sm leading-6 text-foreground-muted">{notice.description}</Text>
      </View>
      <View className="min-h-12 flex-row flex-wrap items-center justify-between gap-3">
        {state.canWrite || busy || notice.kind === "unavailable" ? (
          <Button
            label={notice.action}
            tone={compact ? "secondary" : "contrast"}
            disabled={busy}
            onPress={() => (notice.kind === "unavailable" ? state.refresh() : void state.write())}
            loading={busy}
          />
        ) : (
          <Text className="text-xs text-foreground-muted">
            {notice.kind === "failed"
              ? "Reconnect or ask someone with write access to retry."
              : "Writing a guide requires a connection and write access."}
          </Text>
        )}
        {notice.kind === "writing" && state.data?.run?._tag === "Running" ? (
          <Text className="shrink text-xs text-foreground-muted">
            Started{" "}
            {new Date(state.data.run.startedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Text>
        ) : null}
      </View>
    </Animated.View>
  );
}
