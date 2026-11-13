/**
 * Thread feed automation rows, run folds and compaction labels.
 */
import * as Haptics from "expo-haptics";
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
import { renderAssistantCitationsAsText } from "@t3tools/shared/assistantCitations";
import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
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
import {
  SelectableMarkdownText,
  type MarkdownFileContextMenu,
  type MarkdownImageRenderer,
  type MarkdownImageSourceResolver,
  type MarkdownLinkCustomization,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from "../../../native/SelectableMarkdownText";
import { AppText as Text } from "../../../components/ui/AppText";
import {
  ReviewCommentCard,
  useReviewCommentColors,
  type ReviewCommentColors,
} from "../../review/ReviewCommentCard";
import {
  deriveCenteredContentHorizontalPadding,
  deriveThreadFeedInitialContentInset,
  deriveThreadWorkLogSizing,
  type LayoutVariant,
} from "../../../lib/layout";
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
  collapsedWorkLogHeight,
  ThreadDisclosureChevron,
  THREAD_DISCLOSURE_TRANSITION_MS,
  ThreadWorkGroupToggle,
  ThreadThinkingRow,
  ThreadWorkLog,
  WORK_GROUP_TOGGLE_HEIGHT,
} from "../thread-work-log";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { environmentThreadShells, threadEnvironment } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import {
  MarkdownImageAvailableWidthContext,
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "../ThreadMarkdownImage";
import { openSettings } from "../../settings/settings-navigation";
import type {
  MarkdownLinkHandlers,
  MarkdownStyleSet,
} from "./markdown.tsx";
import {
  UserMessageContent,
  UserMessageCopyButton,
} from "./message-rows.tsx";
import {
  TURN_FOLD_HEIGHT,
} from "./placeholder.tsx";

export function ThreadAutomationMessageRow(props: {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly context?: OrchestrationMessageContext;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
  readonly timestampLabel: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly bubbleColor: ColorValue;
  readonly bubbleMaxWidth: number | "85%";
  readonly contentMaxWidth: number;
  readonly iconSubtleColor: ColorValue;
  readonly markdownStyles: MarkdownStyleSet;
  readonly reviewCommentColors: ReviewCommentColors;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly renderImage: MarkdownImageRenderer;
}) {
  const navigation = useNavigation();
  const tasks = useEnvironmentQuery(
    props.scheduledTaskId
      ? serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const taskTitle = tasks.data?.tasks.find((task) => task.id === props.scheduledTaskId)?.title;
  const summary = taskTitle ?? props.text.trim().split(/\r?\n/, 1)[0] ?? "";

  return (
    <View className="mb-5 items-end">
      <View
        className="min-w-0 rounded-[20px]"
        style={{
          backgroundColor: props.bubbleColor,
          maxWidth: props.bubbleMaxWidth,
          ...(props.expanded ? { width: props.bubbleMaxWidth } : null),
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Automation: ${summary}`}
          accessibilityHint={`Double tap to ${props.expanded ? "hide" : "show"} the prompt.`}
          accessibilityState={{ expanded: props.expanded }}
          hitSlop={4}
          className="min-h-10 flex-row items-center gap-1.5 px-3.5 py-2"
          onPress={() => {
            void Haptics.selectionAsync();
            props.onToggle();
          }}
        >
          <SymbolView
            name="calendar.badge.clock"
            size={14}
            weight="medium"
            tintColorClassName="accent-user-bubble-foreground-muted"
            type="monochrome"
          />
          <Text className="font-t3-medium text-sm text-user-bubble-foreground-muted">
            Automation
          </Text>
          <Text numberOfLines={1} className="min-w-0 shrink text-sm text-user-bubble-foreground">
            {summary}
          </Text>
          <ThreadDisclosureChevron
            expanded={props.expanded}
            collapsedDirection="down"
            size={11}
            tintColor={props.iconSubtleColor}
          />
        </Pressable>
        {props.expanded ? (
          <View className="px-3.5 pb-2.5">
            <MarkdownImageAvailableWidthContext value={props.contentMaxWidth}>
              <UserMessageContent
                text={renderAssistantCitationsAsText(props.text)}
                environmentId={props.environmentId}
                context={props.context}
                markdownStyles={props.markdownStyles}
                reviewCommentColors={props.reviewCommentColors}
                skills={props.skills}
                linkHandlers={props.linkHandlers}
                renderImage={props.renderImage}
              />
            </MarkdownImageAvailableWidthContext>
          </View>
        ) : null}
      </View>
      {props.expanded ? (
        <View className="mt-1 flex-row items-center justify-end gap-2 pr-0.5">
          {props.scheduledTaskId ? (
            <Pressable
              accessibilityRole="link"
              hitSlop={6}
              onPress={() => openSettings(navigation, "SettingsScheduledTasks")}
            >
              <Text className="font-t3-medium text-xs text-foreground-secondary">
                Open automation
              </Text>
            </Pressable>
          ) : null}
          <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">
            {props.timestampLabel}
          </Text>
          <UserMessageCopyButton
            text={props.text}
            onCopy={undefined}
            tintColor={props.iconSubtleColor}
          />
        </View>
      ) : null}
    </View>
  );
}

/** Leads with why T3 Code compacted, when it did so without being asked. */

export function compactionLabel(label: string, title: string | undefined) {
  return title !== undefined && label.startsWith("Context compacted")
    ? title + label.slice("Context compacted".length)
    : label;
}

export function RunFoldButton({
  entry,
  environmentId,
  threadId,
  onToggle,
  rowSizing,
  iconColor,
}: {
  entry: Extract<ThreadFeedEntry, { type: "run-fold" }>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onToggle: (runId: RunId) => void;
  rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  iconColor: ColorValue;
}) {
  const loadWork = useAtomCommand(threadEnvironment.loadEarlierHistory, { reportFailure: false });
  const anchorsKey = entry.deferredWorkItemIds?.join("\n") ?? "";
  const [failed, setFailed] = useState(false);
  const load = () => {
    if (!anchorsKey) return;
    void Promise.all(
      anchorsKey
        .split("\n")
        .map((workAnchorId) => loadWork({ environmentId, input: { threadId, workAnchorId } })),
    ).then((results) =>
      setFailed(
        results.some((result) => result._tag === "Failure" || result.value._tag === "error"),
      ),
    );
  };
  const loadOnExpand = useEffectEvent(load);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restored expanded folds load their deferred server history on mount.
  useEffect(() => {
    if (entry.expanded && anchorsKey && environmentId && threadId) loadOnExpand();
  }, [entry.expanded, anchorsKey, environmentId, threadId]);
  const error = anchorsKey && failed ? "Couldn't load work. Tap to retry." : null;
  const loading = entry.expanded && anchorsKey !== "" && !failed;
  const toggle = () => {
    setFailed(false);
    if (error && entry.expanded) load();
    else onToggle(entry.runId);
  };

  return (
    <View className="min-w-0 flex-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: entry.expanded, busy: loading }}
        onPress={toggle}
        hitSlop={4}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2"
        style={{ minHeight: Math.max(TURN_FOLD_HEIGHT - 3.5, rowSizing.estimatedRowHeight) }}
      >
        <Text
          key={rowSizing.textSizeKey}
          numberOfLines={1}
          className="shrink font-t3-medium text-sm tabular-nums text-foreground-muted"
        >
          {entry.label}
          {error ? ` · ${error}` : ""}
        </Text>
        <ThreadDisclosureChevron
          expanded={entry.expanded}
          collapsedDirection="right"
          size={15}
          tintColor={iconColor}
        />
      </Pressable>
      {loading ? (
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          className="gap-2 px-1 pb-2"
        >
          {(["40%", "60%", "33%"] as const).map((width) => (
            <View key={width} className="flex-row items-center gap-2">
              <View className="size-3 rounded bg-subtle-strong" />
              <View className="h-2.5 rounded-full bg-subtle-strong" style={{ width }} />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
