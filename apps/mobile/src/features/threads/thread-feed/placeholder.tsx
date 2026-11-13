/**
 * Thread feed empty state, load-earlier control and presentation labels.
 */
import { Button } from "../../../components/ui/Button";
import {
  AuthFilesystemReadScope,
  idleCompactionOf,
  type OrchestrationMessageContext,
  ThreadId,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type RunId,
  type ScheduledTaskId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useId,
  type ComponentPropsWithRef,
  type ComponentRef,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import {
  Image,
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  type ColorValue,
  useWindowDimensions,
  View,
} from "react-native";
import { useUniwindTheme } from "../../../lib/useUniwindTheme";
import { AppText as Text } from "../../../components/ui/AppText";
import {
  createThreadFeedCache,
  threadFeedCompactionLabels,
  failedFeedRunIds,
  deriveThreadFeedPresentation,
  threadFeedRunIsUnsettled,
  isContextCompactionActivityGroup,
  isContextHandoffActivityGroup,
  isLinkRequestActivityGroup,
  isSecretRequestActivityGroup,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
  messageFoldRunId,
} from "../../../lib/threadActivity";
import {
  appendGuestPendingMessages,
  appendPendingThreadMessages,
  createThreadFeedGrouping,
  isCompactionCommandFeedEntry,
  type GroupedThreadFeedRow,
  type ThreadFeedRow,
} from "../pending-thread-feed";
import type {
  ThreadFeedHistoryControls,
  ThreadFeedProps,
} from "./types.ts";

export const MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

export function formatMessageTime(input: string): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return "";
  }
  return MESSAGE_TIME_FORMATTER.format(timestamp);
}

export const TURN_FOLD_HEIGHT = 42;

export const FEED_PADDING_TOP = 12;
// Rows re-measure within a commit or two of a width change. LegendList also defers imperative
// scrolls for 100ms after it compensates a size change, and a deferred restore could land
// under a drag that starts meanwhile.

export const FEED_REFLOW_SETTLE_MS = 200;
// A fold resizes the feed in steps about 200ms apart. Holding the place taken at the first step
// across all of them keeps a passing moment off the end from re-anchoring the rest to a row.

export const FEED_REFLOW_HOLD_MS = 600;

export const USER_BUBBLE_HORIZONTAL_PADDING = 3.5 * 3.5;

export const ASSISTANT_ROW_HORIZONTAL_PADDING = 3.5;

// Virtualization remounts old rows; only newly created content should replay an entrance.

export const FRESH_ENTRY_WINDOW_MS = 3_000;

export function isFreshTimestamp(input: string): boolean {
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ENTRY_WINDOW_MS;
}

export function ThreadFeedPlaceholder(props: {
  readonly bottomInset: number;
  readonly detail: string;
  readonly horizontalPadding: number;
  readonly title: string;
  readonly topInset: number;
}) {
  return (
    <View
      style={{
        flex: 1,
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset,
        paddingHorizontal: props.horizontalPadding + 24,
      }}
    >
      <View className="max-w-[320px] items-center gap-2">
        <Text className="text-center font-t3-bold text-lg text-foreground">{props.title}</Text>
        <Text className="text-center text-sm leading-normal text-foreground-secondary">
          {props.detail}
        </Text>
      </View>
    </View>
  );
}

// A hook's return value is frozen to the compiler, so ThreadFeed's later
// hooks can't drag this derivation into an uncached scope.

export function useThreadFeedPresentation(
  props: ThreadFeedProps,
  expandedTurnIds: ReadonlySet<RunId>,
  expandedWorkGroups: Record<string, boolean>,
) {
  const [feedCache] = useState(createThreadFeedCache);
  return appendPendingThreadMessages(
    deriveThreadFeedPresentation(
      props.feed,
      props.latestRun,
      expandedTurnIds,
      new Set(
        Object.entries(expandedWorkGroups)
          .filter(([, expanded]) => expanded)
          .map(([groupId]) => groupId),
      ),
      props.activeWorkStartedAt,
      props.runlessWorkActive ?? false,
      feedCache,
    ),
    props.feed,
    props.queuedMessages,
  );
}

export function ThreadFeedLoadEarlierControl(props: ThreadFeedHistoryControls) {
  const theme = useUniwindTheme();
  const mutedColor = theme["--color-icon-subtle"];
  if (!props.hasMoreHistory && props.error === null) {
    return null;
  }
  return (
    <View className="mb-3 items-center gap-1.5 px-2">
      {props.hasMoreHistory ? (
        <View className="self-center">
          <Button
            label={props.loading ? "Loading earlier activity…" : "Load earlier activity"}
            tone="secondary"
            accessibilityLabel="Load earlier activity"
            disabled={props.loading}
            onPress={props.onLoadEarlier}
            icon="chevron.up"
            loading={props.loading}
          />
        </View>
      ) : null}
      {props.error !== null ? (
        <Text className="text-center text-xs" style={{ color: mutedColor }}>
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}
