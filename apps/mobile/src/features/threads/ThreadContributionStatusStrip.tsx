import { useAtomValue } from "@effect/atom-react";
import type {
  ContributionStatusTone,
  EnvironmentId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { useMemo } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { contributionStatusEnvironment } from "../../state/contribution-status";
import {
  reservesContributionStatusBand,
  threadContributionStatusChips,
  threadHasContributionStatus,
} from "./thread-contribution-status-presentation";

/** The strip's height: one row of chip touch targets (44pt iOS, 48dp Android). */
const STRIP_HEIGHT = Platform.OS === "android" ? 48 : 44;

// Neutral, the default, has no dot: Pi status text often brings its own glyph.
const TONE_DOT_CLASS = {
  neutral: null,
  info: "bg-adaptive-sky-600-400",
  success: "bg-adaptive-emerald-600-400",
  warning: "bg-adaptive-amber-700-400",
  error: "bg-adaptive-rose-600-400",
} as const satisfies Record<ContributionStatusTone, string | null>;

/**
 * The band the feed reserves above its first row for the status strip, passed
 * to ThreadFeed's `topOverlayInset`. See `reservesContributionStatusBand`.
 */
export function useThreadContributionStatusStripInset(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly supported: boolean;
  readonly driver: ProviderDriverKind | undefined;
}): number {
  const hasStatus = useAtomValue(
    contributionStatusEnvironment.threadStatus(input.environmentId, input.threadId),
    threadHasContributionStatus,
  );
  return reservesContributionStatusBand({ ...input, hasStatus }) ? STRIP_HEIGHT : 0;
}

/**
 * Advisory statuses the thread's provider set, such as Pi extension
 * `setStatus` text, and statuses plugins set, as one row of chips floating
 * just under the navigation header. It overlays the feed like the header
 * does, so a status changing never resizes the composer; the feed reserves
 * its band through `useThreadContributionStatusStripInset`. Renders nothing
 * when the server lacks the capability or the thread has no statuses.
 * Pressing a chip shows its tooltip and where it came from.
 */
export function ThreadContributionStatusStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Distance from the screen's top edge to the bottom of the navigation header. */
  readonly top: number;
  readonly contentMaxWidth: number | undefined;
}) {
  const entries = useAtomValue(
    contributionStatusEnvironment.threadStatus(props.environmentId, props.threadId),
  );
  const chips = useMemo(() => threadContributionStatusChips(entries), [entries]);
  if (chips.length === 0) return null;

  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0"
      style={{ top: props.top, height: STRIP_HEIGHT }}
    >
      <View
        pointerEvents="box-none"
        className="w-full self-center"
        style={{ maxWidth: props.contentMaxWidth }}
      >
        {/* Sized to its chips, so the feed under the empty rest of the row
            still takes touches. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="max-w-full grow-0 self-start"
          contentContainerClassName="px-2.5"
        >
          {chips.map((chip) => {
            const dotClass = TONE_DOT_CLASS[chip.tone];
            // The compact pill sits inside a full-size touch target (44pt
            // iOS, 48dp Android); neighbours abut without overlapping.
            return (
              <Pressable
                key={chip.id}
                accessibilityRole="button"
                accessibilityLabel={chip.accessibilityLabel}
                accessibilityHint={chip.tooltip ?? chip.help}
                className="min-h-[44px] min-w-[44px] items-center justify-center px-[3px] active:opacity-60 android:min-h-[48px] android:min-w-[48px]"
                onPress={() => Alert.alert(chip.details.title, chip.details.message)}
              >
                <View className="min-h-7 flex-row items-center gap-1.5 rounded-full border border-border-subtle bg-card-alt px-2.5">
                  {chip.leadsSource && chip.driver !== null ? (
                    <ProviderIcon provider={chip.driver} size={12} />
                  ) : null}
                  {dotClass === null ? null : (
                    <View className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass)} />
                  )}
                  <Text numberOfLines={1} className="text-xs text-foreground-secondary">
                    {chip.text}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}
