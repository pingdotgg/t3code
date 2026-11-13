/**
 * Thread feed user/assistant message rows, fold headers and disclosure rows.
 */
import * as Dialog from "../../../components/ui/Dialog";
import {
  enrichedContextLinkCustomization,
  enrichedThreadLinkCustomization,
  withChipIcon,
} from "../../../native/useEnrichedLinkVariants";
import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import * as Haptics from "expo-haptics";
import { useViewabilityAmount, type LegendListRef } from "@legendapp/list/react-native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
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
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import { PROMPT_LINK_MAX_PROMPT_LENGTH } from "@t3tools/shared/promptLinks";
import {
  parseComposerContextHref,
  collectComposerContextReferences,
  replaceComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { ComposerContextSheet } from "../../../components/ComposerContextSheet";
import { writeComposerContextClipboard } from "../../../lib/composerContextClipboard";
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
import Animated, { FadeIn, FadeInDown, type SharedValue } from "react-native-reanimated";
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
import { CopyTextButton } from "../CopyTextButton";
import { Menu } from "../../../components/ui/Menu";
import { copyPromptLink } from "../../prompt-links/prompt-link-actions";
import { parseReviewCommentMessageSegments } from "../../review/reviewCommentSelection";
import {
  ReviewCommentCard,
  useReviewCommentColors,
  type ReviewCommentColors,
} from "../../review/ReviewCommentCard";
import { uuidv4 } from "../../../lib/uuid";
import {
  collapsedWorkLogHeight,
  ThreadDisclosureChevron,
  THREAD_DISCLOSURE_TRANSITION_MS,
  ThreadWorkGroupToggle,
  ThreadThinkingRow,
  ThreadWorkLog,
  WORK_GROUP_TOGGLE_HEIGHT,
} from "../thread-work-log";
import {
  resolveThreadLink,
  useLiveThreadLinkLabels,
  useQuietThreadShell,
  useThreadChipIcons,
} from "../../../state/entities";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { composerDocumentAttachmentRecord } from "../../../lib/composerContext";
import { environmentThreadShells, threadEnvironment } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useV2ItemSupport } from "../../../state/v2-item-support";
import { useOpenLinkedThread } from "../useOpenLinkedThread";
import { useSelectWorkspaceDetail } from "../../workspace/useSelectWorkspaceDetail";
import type {
  MarkdownLinkHandlers,
  MarkdownStyleSet,
} from "./markdown.tsx";
import {
  waitForThreadShell,
} from "./shell.ts";

export const USER_MESSAGE_COPY_MENU_ACTIONS = [
  { id: "copy-prompt-link", title: "Copy prompt link", image: "link" },
];

export function UserMessageCopyButton(props: {
  readonly text: string;
  readonly onCopy: (() => Promise<void>) | undefined;
  readonly tintColor: ColorValue;
}) {
  const button = (
    <CopyTextButton
      accessibilityLabel="Copy message"
      text={props.text}
      onCopy={props.onCopy}
      tintColor={props.tintColor}
      buttonSize={28}
      iconSize={13}
    />
  );
  const linkText = replaceComposerContextReferences(props.text, (reference) => reference.label);
  if (linkText.length > PROMPT_LINK_MAX_PROMPT_LENGTH) return button;
  return (
    <Menu
      actions={USER_MESSAGE_COPY_MENU_ACTIONS}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "copy-prompt-link") void copyPromptLink(linkText);
      }}
      shouldOpenOnLongPress
    >
      {button}
    </Menu>
  );
}

export function AssistantForkButton(props: {
  readonly environmentId: EnvironmentId;
  readonly iconColor: ColorValue;
  readonly buttonSize: number;
  readonly iconSize: number;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly sourceTitle: string;
}) {
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: props.projectedItem.sourceThreadId,
    sourceItemId: props.projectedItem.sourceItemId,
  });
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, "fork from response");
  const selectDetail = useSelectWorkspaceDetail();
  const [busy, setBusy] = useState(false);
  const canFork = canForkProjectedAssistantItem({
    projectedItem: props.projectedItem,
    capabilities: support.providerSession?.capabilities,
  });
  const runId = props.projectedItem.item.runId;

  if (!canFork || runId === null) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Fork from this response"
      disabled={busy}
      onPress={() => {
        const targetThreadId = ThreadId.make(uuidv4());
        setBusy(true);
        void Haptics.selectionAsync();
        void forkFromRun({
          environmentId: props.environmentId,
          input: {
            sourceThreadId: props.projectedItem.sourceThreadId,
            targetThreadId,
            runId,
            title: `${props.sourceTitle} fork`,
            creationSource: "mobile",
          },
        })
          .then(async (result) => {
            if (result._tag !== "Success") return;
            const targetThreadReady = await waitForThreadShell(props.environmentId, targetThreadId);
            if (!targetThreadReady) {
              Dialog.alert(
                "Fork created",
                "Its thread data did not reach this client. Reconnect and try opening it from the thread list.",
              );
              return;
            }
            selectDetail({
              name: "Thread",
              params: { environmentId: props.environmentId, threadId: targetThreadId },
            });
          })
          .finally(() => setBusy(false));
      }}
      className="h-7 w-7 items-center justify-center disabled:opacity-40"
      style={
        Platform.OS === "android"
          ? { width: props.buttonSize, height: props.buttonSize }
          : undefined
      }
    >
      {busy ? (
        <AppActivityIndicator size="small" />
      ) : (
        <SymbolView
          name="arrow.triangle.branch"
          size={props.iconSize}
          tintColor={props.iconColor}
          type="monochrome"
        />
      )}
    </Pressable>
  );
}

export type UserMessageContentProps = {
  readonly text: string;
  readonly environmentId: EnvironmentId;
  readonly context?: OrchestrationMessageContext;
  readonly markdownStyles: MarkdownStyleSet;
  readonly reviewCommentColors: ReviewCommentColors;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly renderImage: MarkdownImageRenderer;
};

export function UserMessageContent(props: UserMessageContentProps) {
  const [selected, setSelected] = useState<{ contextId: string; label: string } | null>(null);
  const navigation = useNavigation();
  const openLinkedThread = useOpenLinkedThread();
  const { selectedThread } = useThreadSelection();
  const liveText = useLiveThreadLinkLabels(props.text, props.environmentId);
  const threadIcons = useThreadChipIcons(props.environmentId, liveText, props.context?.records);
  const text = replaceComposerContextReferences(liveText, (ref) => {
    const available = props.context?.records.some((record) => record.contextId === ref.contextId);
    return `[${ref.label}${available ? "" : " (unavailable)"}](t3-context://v1/${ref.kind}/${ref.contextId})`;
  });
  const onLinkPress = (href: string) => {
    const reference = parseComposerContextHref(href);
    if (!reference) return props.linkHandlers.onLinkPress?.(href);
    const record = props.context?.records.find(
      (record) => record.contextId === reference.contextId,
    );
    if (record?.kind === "mention" && "path" in record) {
      props.linkHandlers.onLinkPress?.(record.path);
      return;
    }
    if (record?.kind === "thread" && "threadId" in record) {
      openLinkedThread({
        environmentId: String(record.environmentId),
        threadId: String(record.threadId),
      });
      return;
    }
    const document = composerDocumentAttachmentRecord(record);
    if (document) {
      navigation.navigate("ThreadAttachment", {
        environmentId: String(props.environmentId),
        ...(selectedThread ? { threadId: String(selectedThread.id) } : {}),
        attachmentId: document.attachmentId,
        name: document.name,
        mimeType: document.mimeType,
        sizeBytes: String(document.sizeBytes),
      });
      return;
    }
    setSelected({ contextId: reference.contextId, label: record?.label ?? "Context unavailable" });
  };
  return (
    <>
      <UserMessageMarkdownContent
        {...props}
        text={text}
        linkHandlers={{
          ...props.linkHandlers,
          onLinkPress,
          fileContextMenu: (href) => {
            const reference = parseComposerContextHref(href);
            if (!reference) return props.linkHandlers.fileContextMenu(href);
            const record = props.context?.records.find(
              (item) => item.contextId === reference.contextId,
            );
            return {
              title: record?.label ?? "Context unavailable",
              actions: [
                { id: "open-context", title: "Open context" },
                { id: "copy-context", title: "Copy context", disabled: !record },
              ],
            };
          },
          onFileContextMenuAction: (href, actionId) => {
            const reference = parseComposerContextHref(href);
            if (!reference) return props.linkHandlers.onFileContextMenuAction(href, actionId);
            if (actionId === "open-context") return onLinkPress(href);
            const record = props.context?.records.find(
              (item) => item.contextId === reference.contextId,
            );
            if (actionId === "copy-context" && record) {
              void writeComposerContextClipboard(
                formatComposerContextReference({
                  ...reference,
                  label: record.label,
                }),
                {
                  version: 1,
                  source: { environmentId: props.environmentId },
                  records: [record],
                },
              )
                .then(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success))
                .catch(() => {
                  Dialog.alert("Could not copy context", "Try copying this context again.");
                });
            }
          },
          linkCustomization: (href) =>
            withChipIcon(
              enrichedContextLinkCustomization(href, props.context?.records ?? []) ??
                props.linkHandlers.linkCustomization?.(href),
              threadIcons.get(href),
            ),
        }}
      />
      {selected ? (
        <ComposerContextSheet
          label={selected.label}
          environmentId={props.environmentId}
          records={props.context?.records}
          record={props.context?.records.find((record) => record.contextId === selected.contextId)}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

export function UserMessageMarkdownContent(props: UserMessageContentProps) {
  const text = props.text;
  const segments = parseReviewCommentMessageSegments(text);
  const hasReviewComment = segments.some((segment) => segment.kind === "review-comment");
  const contextClipboardFragment = props.context
    ? (encodeComposerContextFragment({
        version: 1,
        source: { environmentId: props.environmentId },
        records: props.context.records,
      }) ?? undefined)
    : undefined;
  if (!hasReviewComment) {
    return (
      <SelectableMarkdownText
        markdown={text}
        contextClipboardFragment={contextClipboardFragment}
        skills={props.skills}
        textStyle={props.markdownStyles.nativeTextStyle}
        preserveSoftBreaks
        {...props.linkHandlers}
        renderImage={props.renderImage}
      />
    );
  }

  return (
    <View className="w-full gap-2">
      {segments.map((segment) => {
        if (segment.kind === "review-comment") {
          return (
            <ReviewCommentCard
              key={segment.comment.id}
              comment={segment.comment}
              colors={props.reviewCommentColors}
            />
          );
        }

        const text = segment.text.trim();
        if (text.length === 0) {
          return null;
        }

        return (
          <SelectableMarkdownText
            key={segment.id}
            markdown={text}
            contextClipboardFragment={contextClipboardFragment}
            skills={props.skills}
            textStyle={props.markdownStyles.nativeTextStyle}
            preserveSoftBreaks
            {...props.linkHandlers}
            renderImage={props.renderImage}
          />
        );
      })}
    </View>
  );
}

export function TurnDiffStat(props: {
  readonly checkpoint: ThreadCheckpointSummary;
  readonly onOpenTurnDiff: (checkpoint: ThreadCheckpointSummary) => void;
}) {
  const { files } = props.checkpoint;
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const fileCountLabel = `${files.length} file${files.length === 1 ? "" : "s"} changed`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Review ${fileCountLabel}, ${additions} additions, ${deletions} deletions`}
      onPress={() => props.onOpenTurnDiff(props.checkpoint)}
      className="min-h-11 shrink-0 flex-row items-center gap-2 px-2 active:bg-subtle"
    >
      <Text className="font-t3-medium text-xs tabular-nums text-adaptive-emerald-700-300">
        +{formatDiffCount(additions)}
      </Text>
      <Text className="font-t3-medium text-xs tabular-nums text-adaptive-rose-700-300">
        −{formatDiffCount(deletions)}
      </Text>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-foreground-muted" />
    </Pressable>
  );
}

export function AgentMessageFoldHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly senderThreadId?: ThreadId;
  readonly summary: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly iconSubtleColor: ColorValue;
}) {
  const senderShell = useQuietThreadShell(
    props.senderThreadId ? scopeThreadRef(props.environmentId, props.senderThreadId) : null,
  );
  const label = senderShell?.title.trim() || "Agent";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${props.summary}`}
      accessibilityHint={`Double tap to ${props.expanded ? "hide" : "show"} the message.`}
      accessibilityState={{ expanded: props.expanded }}
      hitSlop={4}
      className="min-h-10 flex-row items-center gap-1.5 px-3.5 py-2"
      onPress={() => {
        void Haptics.selectionAsync();
        props.onToggle();
      }}
    >
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={14}
        weight="medium"
        tintColorClassName="accent-user-bubble-foreground-muted"
        type="monochrome"
      />
      <Text
        numberOfLines={1}
        className="max-w-[50%] shrink-0 font-t3-medium text-sm text-user-bubble-foreground-muted"
      >
        {label}
      </Text>
      <Text numberOfLines={1} className="min-w-0 shrink text-sm text-user-bubble-foreground">
        {props.summary}
      </Text>
      <ThreadDisclosureChevron
        expanded={props.expanded}
        collapsedDirection="down"
        size={11}
        tintColor={props.iconSubtleColor}
      />
    </Pressable>
  );
}

export function OpenSenderThreadButton(props: {
  readonly environmentId: EnvironmentId;
  readonly senderThreadId: ThreadId;
}) {
  const openLinkedThread = useOpenLinkedThread();
  return (
    <Pressable
      accessibilityRole="link"
      hitSlop={6}
      onPress={() =>
        openLinkedThread({
          environmentId: String(props.environmentId),
          threadId: String(props.senderThreadId),
        })
      }
    >
      <Text className="font-t3-medium text-xs text-foreground-secondary">Open thread</Text>
    </Pressable>
  );
}

/** Automation prompts are long, repeated runbooks; a folded bubble keeps them out of the way. */

export type DisclosureLayout = {
  positions: ReadonlyMap<string, number>;
  anchorIndex: number;
  list: LegendListRef;
  playing: boolean;
};

export const DISCLOSURE_DETAIL_DELAY_MS = 135;

export const DISCLOSURE_DETAIL_FADE_MS = 70;

export const unsubscribeNothing = () => {};

export function DisclosureRow(props: {
  itemKey: string;
  index: number;
  layout: DisclosureLayout | null;
  children: ReactNode;
}) {
  const { itemKey, layout } = props;
  const previous = layout?.positions.get(itemKey);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!layout || layout.playing || previous === undefined || previous <= 0)
        return unsubscribeNothing;
      return layout.list.getState().listenToPosition(itemKey, notify);
    },
    [itemKey, layout, previous],
  );
  const getOffset = () => {
    if (!layout || layout.playing || previous === undefined || previous <= 0) return 0;
    const state = layout.list.getState();
    const position = state.positionAtIndex(props.index);
    const anchor = state.positionAtIndex(layout.anchorIndex);
    return position === undefined || anchor === undefined ? 0 : previous - (position - anchor);
  };
  const offset = useSyncExternalStore(subscribe, getOffset, getOffset);
  const entering = !!layout && previous === undefined;
  return (
    <Animated.View
      collapsable={false}
      style={
        layout
          ? {
              opacity: entering && !layout.playing ? 0 : 1,
              transform: [{ translateY: offset }],
              transitionProperty: layout?.playing ? (entering ? "opacity" : "transform") : "none",
              transitionDuration: entering
                ? DISCLOSURE_DETAIL_FADE_MS
                : THREAD_DISCLOSURE_TRANSITION_MS,
              transitionDelay: entering ? DISCLOSURE_DETAIL_DELAY_MS : 0,
              transitionTimingFunction: "ease-out",
            }
          : undefined
      }
    >
      {props.children}
    </Animated.View>
  );
}
