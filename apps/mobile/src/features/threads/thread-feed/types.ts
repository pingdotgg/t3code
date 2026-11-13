import type {
  MarkdownLinkHandlers,
  MarkdownStyleSets,
} from "./markdown.tsx";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { WorkflowOpening } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  ReviewCommentCard,
  useReviewCommentColors,
  type ReviewCommentColors,
} from "../../review/ReviewCommentCard";
import {
  appendGuestPendingMessages,
  appendPendingThreadMessages,
  createThreadFeedGrouping,
  isCompactionCommandFeedEntry,
  type GroupedThreadFeedRow,
  type ThreadFeedRow,
} from "../pending-thread-feed";
import {
  resolveThreadFeedLiveFollow,
  resolveThreadFeedReflowAnchor,
  resolveThreadFeedReflowOffset,
  resolveThreadFeedReflowScroll,
  type ThreadFeedLiveFollowEvent,
  type ThreadFeedReflowAnchor,
  type ThreadWorkGroupScrollPosition,
} from "../thread-feed-live-follow";
import { FilePreviewModal, type FilePreviewSource } from "../../../components/FilePreviewModal";
/**
 * Thread feed props and imperative handle shapes.
 */
import {
  WorktreeWorkingHeader,
  WorktreeSetupCard,
  type WorktreeSetupCardProps,
} from "../worktree-setup-card";
import { useViewabilityAmount, type LegendListRef } from "@legendapp/list/react-native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { HandoffEndpoints } from "@t3tools/client-runtime/handoff";
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
  codexArtifactTemplatePresentationLabel,
  type CodexArtifactTemplate,
} from "@t3tools/shared/codexArtifactTemplates";
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
import type { ThreadContentPresentation } from "../threadContentPresentation";
import type { QueuedThreadMessage } from "../../../state/thread-outbox-model";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../../state/threads";
import { waitForThreadShellReady } from "../threadForkNavigation";

export interface ThreadFeedHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: () => void;
  /** Loads earlier history down to the entry, in one request. */
  readonly onLoadThrough: (entryId: string) => void;
}

export interface ThreadFeedHandle {
  /** A send re-arms following the end, whatever the reader had scrolled to. */
  readonly resetEndFollow: () => void;
}

export interface ThreadFeedProps {
  readonly worktreeSetup?: WorktreeSetupCardProps | null;
  readonly setupWorkingStartedAt?: string | null;
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  readonly dispatchingMessageId: MessageId | null;
  readonly onEditPendingMessage: ((message: QueuedThreadMessage) => void) | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Null while the thread's creation is queued: reading detail then caches a not-found as deleted. */
  readonly detailRef: ScopedThreadRef | null;
  readonly threadTitle: string;
  readonly workspaceRoot?: string | null;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly pendingHandoff?: HandoffEndpoints | null;
  readonly contentPresentation: ThreadContentPresentation;
  readonly latestRun: ThreadFeedLatestRun | null;
  readonly activeWorkStartedAt: string | null;
  readonly runlessWorkActive?: boolean;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly freeze: SharedValue<boolean>;
  readonly anchorMessageId: MessageId | null;
  /** A message to scroll to once it is in the feed; see `onJumpedToMessage`. */
  readonly jumpToMessageId?: MessageId | null;
  readonly onJumpedToMessage?: () => void;
  readonly contentInsetEndAdjustment: SharedValue<number>;
  readonly keyboardOffset: number;
  readonly sendingWithKeyboard?: boolean;
  readonly fitShortFeedToViewport?: boolean;
  readonly contentTopInset?: number;
  readonly contentBottomInset?: number;
  readonly historyControls?: ThreadFeedHistoryControls;
  readonly contentMaxWidth?: number;
  readonly contentSideInsets?: { readonly left: number; readonly right: number };
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onEndFollowEnabledChange?: (enabled: boolean) => void;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
}

async function waitForThreadShell(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<boolean> {
  const atom = environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId));
  return waitForThreadShellReady({
    read: () => appAtomRegistry.get(atom) !== null,
  });
}

export type FeedEntryRenderProps =
    Pick<
    ThreadFeedProps,
    | "environmentId"
    | "onUseArtifactTemplate"
    | "skills"
    | "dispatchingMessageId"
    | "onEditPendingMessage"
    | "threadId"
    | "workspaceRoot"
    > & {
    readonly copiedRowId: string | null;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly workRowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
    readonly workGroupScrollPositions: Map<string, ThreadWorkGroupScrollPosition>;
    readonly terminalAssistantMessageIds: ReadonlySet<string>;
    readonly unsettledTurnId: RunId | null;
    readonly compactionLabelsByEntryId: ReadonlyMap<string, { title: string; compacting: string }>;
    readonly failedRunIds: ReadonlySet<RunId>;
    readonly onCopyWorkRow: (rowId: string, value: string) => void;
    readonly onToggleWorkGroup: (groupId: string, anchorKey?: string) => void;
    readonly onToggleWorkRow: (rowId: string, anchorKey?: string, groupId?: string) => void;
    readonly onToggleTurnFold: (runId: RunId) => void;
    readonly onOpenTurnDiff: (checkpoint: ThreadCheckpointSummary) => void;
    readonly onPressPreview: (source: FilePreviewSource) => void;
    readonly onPlaybackStart: () => void;
    readonly markdownLinkHandlers: MarkdownLinkHandlers;
    readonly renderMarkdownImage: MarkdownImageRenderer;
    readonly renderViewedImage: MarkdownImageRenderer;
    readonly renderReasoning: (text: string) => ReactNode;
    readonly iconSubtleColor: string | import("react-native").ColorValue;
    readonly replyActionSize: { readonly button: number; readonly icon: number };
    readonly screenColor: string;
    readonly userBubbleColor: string | import("react-native").ColorValue;
    readonly markdownStyles: MarkdownStyleSets;
    readonly reviewCommentColors: ReviewCommentColors;
    readonly reviewCommentBubbleWidth: number;
    readonly themeAppearance: "light" | "dark";
    readonly duoColumns: boolean;
    readonly userBubbleMaxWidth: number;
    readonly markdownContentWidth: number;
    readonly contentWidth: number;
    readonly threadTitle: string;
    readonly workflowOpening: WorkflowOpening | null;
    readonly userMessageGrouping: GroupedThreadFeedRow["userMessageGrouping"];
};
