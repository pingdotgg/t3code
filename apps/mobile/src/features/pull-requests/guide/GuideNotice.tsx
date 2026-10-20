import { Button } from "../../../components/ui/Button";
import { View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { PR_ROW_EXIT, PR_ROW_LAYOUT } from "../pullRequestAnimations";
import { guideNoticeState } from "./reviewGuideState";
import type { useReviewGuide } from "./useReviewGuide";
import { GuideGeneratingHeading } from "./GuideGeneratingHeading";

const NOTICE_ENTER = FadeIn.delay(180).duration(120).reduceMotion(ReduceMotion.System);

/** Keep the action in one place as loading, writing, and retry states change. */
export function GuideNotice({
  state,
  active = true,
}: {
  readonly state: ReturnType<typeof useReviewGuide>;
  readonly active?: boolean;
}) {
  const notice = guideNoticeState(state);
  if (notice.kind === "ready") return null;
  const compact = state.data?.guide != null;
  const failed = notice.kind === "failed" || notice.kind === "unavailable";
  const busy = notice.kind === "loading" || notice.kind === "writing";
  if (notice.kind === "loading" || notice.kind === "empty") {
    return (
      <View className="mb-3 gap-1 py-2" accessibilityLiveRegion="polite">
        <Text className="text-base font-t3-semibold text-foreground-muted">
          {notice.kind === "loading" ? "Loading guide…" : "Waiting to generate guide"}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {notice.kind === "loading"
            ? "Checking for a saved guide. You can explore the files below."
            : "The guide starts automatically when connected with write access."}
        </Text>
      </View>
    );
  }
  if (notice.kind === "writing") {
    return (
      <View className="mb-3 gap-1 py-2">
        <GuideGeneratingHeading rewriting={compact} visible={active} />
        <Text className="text-xs text-foreground-muted">
          {compact
            ? "Keep reading while the guide updates."
            : "Explore the files while the guide is written."}
        </Text>
      </View>
    );
  }
  return (
    <Animated.View
      layout={PR_ROW_LAYOUT}
      entering={compact ? NOTICE_ENTER : undefined}
      exiting={PR_ROW_EXIT}
      className={"mb-3 rounded-xl border border-border-subtle bg-screen p-3"}
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
      <View className="pt-2 pb-3">
        <Text className="text-sm leading-5 text-foreground-muted">{notice.description}</Text>
      </View>
      <View className="min-h-12 flex-row items-center justify-between gap-3">
        {state.canWrite || busy || notice.kind === "unavailable" ? (
          <View className="w-40">
            <Button
              label={notice.action}
              tone={compact ? "secondary" : "contrast"}
              disabled={busy}
              onPress={() => (notice.kind === "unavailable" ? state.refresh() : void state.write())}
              fullWidth
              loading={busy}
            />
          </View>
        ) : (
          <Text className="text-xs text-foreground-muted">
            {notice.kind === "failed"
              ? "Reconnect or ask someone with write access to retry."
              : "Writing a guide requires a connection and write access."}
          </Text>
        )}
      </View>
    </Animated.View>
  );
}
