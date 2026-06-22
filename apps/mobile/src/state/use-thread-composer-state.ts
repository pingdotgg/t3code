import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  liveWindowOldestActivityId,
  oldestActivityByChronology,
} from "@t3tools/client-runtime/state/thread-reducer";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildThreadFeed } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  removeComposerDraftAttachment,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { orchestrationEnvironment } from "../state/orchestration";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import { useAtomCommand } from "./use-atom-command";
import { enqueueThreadOutboxMessage } from "./thread-outbox";
import { useThreadOutboxMessages } from "./use-thread-outbox";
import { dispatchingQueuedMessageIdAtom } from "./use-thread-outbox-drain";

const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? "";
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`);
  if (input.attachments && input.attachments.length > 0) {
    appendComposerDraftAttachments(threadKey, input.attachments);
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

export function useThreadComposerState() {
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );

  // ── Older-history lazy-load (mirrors web ChatView) ──────────────────────────
  // The detail snapshot windows activities to the most recent page (the server
  // sets `hasMoreActivities`); older pages are fetched on demand and prepended.
  const [olderActivities, setOlderActivities] = useState<
    ReadonlyArray<OrchestrationThreadActivity>
  >([]);
  const [olderLoaded, setOlderLoaded] = useState(false);
  const [olderHasMore, setOlderHasMore] = useState(false);
  const [loadingOlderActivities, setLoadingOlderActivities] = useState(false);
  const loadThreadActivities = useAtomCommand(orchestrationEnvironment.loadThreadActivities, {
    reportFailure: false,
  });

  const activityRequestKey = selectedThreadShell
    ? `${selectedThreadShell.environmentId}\u0000${selectedThreadShell.id}`
    : null;
  const liveActivities = selectedThreadDetail?.activities ?? EMPTY_ACTIVITIES;
  // Order-independent oldest boundary: `activities[0]` shifts when the reducer
  // re-sorts unsequenced rows on the first live append, which would otherwise
  // make a plain append look like a window reshape. See helper docs.
  const liveOldestActivityId = useMemo(
    () => liveWindowOldestActivityId(liveActivities),
    [liveActivities],
  );
  const liveActivityCount = liveActivities.length;
  // Bumps on every lazy-load reset so a late in-flight load can't repopulate the
  // freshly-cleared state (the thread key alone doesn't change on a same-thread
  // window reshape).
  const olderActivitiesGenRef = useRef(0);
  // The request key of an in-flight older-history load — coalesces the duplicate
  // dispatches the list fires before the loading state updates.
  const inFlightOlderKeyRef = useRef<string | null>(null);
  // The oldest row we've paged past. Advancing this (not re-deriving from the
  // merged set) lets an all-overlap page keep paging when the server still
  // reports `hasMore`, without re-requesting the same cursor. Reset on reshape.
  const olderCursorRef = useRef<OrchestrationThreadActivity | null>(null);
  // Reset the lazy-loaded older pages when the live window is *reshaped* rather
  // than purely appended-to: a different thread or a re-snapshot (reconnect)
  // changes its oldest row, and a checkpoint revert removes rows so the count
  // shrinks. A pure append (same thread, same oldest, larger count) keeps them.
  const olderWindowRef = useRef({
    key: activityRequestKey,
    oldest: liveOldestActivityId,
    count: liveActivityCount,
  });
  // useLayoutEffect (not useEffect) so the cleared state commits before the new
  // thread paints; otherwise the previous thread's lazy-loaded pages stay merged
  // in for one frame, flashing stale feed rows.
  useLayoutEffect(() => {
    const prev = olderWindowRef.current;
    olderWindowRef.current = {
      key: activityRequestKey,
      oldest: liveOldestActivityId,
      count: liveActivityCount,
    };
    const reshaped =
      activityRequestKey !== prev.key ||
      liveOldestActivityId !== prev.oldest ||
      liveActivityCount < prev.count;
    if (!reshaped) {
      return;
    }
    olderActivitiesGenRef.current += 1;
    inFlightOlderKeyRef.current = null;
    olderCursorRef.current = null;
    setOlderActivities([]);
    setOlderLoaded(false);
    setOlderHasMore(false);
    setLoadingOlderActivities(false);
  }, [activityRequestKey, liveOldestActivityId, liveActivityCount]);
  const mergedActivities = useMemo(
    () =>
      olderActivities.length > 0 ? [...olderActivities, ...liveActivities] : liveActivities,
    [olderActivities, liveActivities],
  );
  // Latest merged set, read inside the async load handler so dedup runs against
  // the current state, not the snapshot captured when the load was dispatched.
  const mergedActivitiesRef = useRef(mergedActivities);
  mergedActivitiesRef.current = mergedActivities;
  // Before any page is loaded, the server tells us whether older history exists.
  const hasMoreOlderActivities = olderLoaded
    ? olderHasMore
    : (selectedThreadDetail?.hasMoreActivities ?? false);

  const onLoadOlderActivities = useCallback(() => {
    if (!selectedThreadShell || !hasMoreOlderActivities) {
      return;
    }
    // Page from the explicit cursor (oldest row already paged past) or, before
    // any page, the chronologically-oldest loaded row (matches the reshape
    // sentinel): the reducer sorts unsequenced rows to the end, so index 0 can be
    // a newer sequenced row whose cursor would skip older unsequenced history.
    const oldestActivity = olderCursorRef.current ?? oldestActivityByChronology(mergedActivities);
    if (!oldestActivity || !activityRequestKey) {
      return;
    }
    if (inFlightOlderKeyRef.current === activityRequestKey) {
      return;
    }
    const cursorInput =
      oldestActivity.sequence !== undefined
        ? { beforeSequence: oldestActivity.sequence }
        : { beforeCreatedAt: oldestActivity.createdAt, beforeActivityId: oldestActivity.id };
    const requestKey = activityRequestKey;
    const gen = olderActivitiesGenRef.current;
    inFlightOlderKeyRef.current = requestKey;
    setLoadingOlderActivities(true);
    void loadThreadActivities({
      environmentId: selectedThreadShell.environmentId,
      input: { threadId: selectedThreadShell.id, ...cursorInput },
    })
      .then((result) => {
        // Window/thread reset while in flight — drop the page so it can't
        // repopulate state cleared by the reset.
        if (olderActivitiesGenRef.current !== gen) {
          return;
        }
        if (result._tag !== "Success") {
          return;
        }
        const page = result.value;
        // Advance the cursor to this page's oldest row (pages are ascending) even
        // if every row dedupes away — the server cursor is strict, so the cursor
        // strictly decreases and paging can't loop, while an all-overlap page no
        // longer terminates paging the server says has more.
        const pageOldest = page.activities[0];
        if (pageOldest) {
          olderCursorRef.current = pageOldest;
        }
        // Dedup against the LATEST merged set (via ref) so a live append or a
        // prior prepend that settled mid-flight can't leave duplicate ids.
        const seen = new Set(mergedActivitiesRef.current.map((activity) => activity.id));
        const fresh = page.activities.filter((activity) => !seen.has(activity.id));
        if (fresh.length === 0) {
          setOlderLoaded(true);
          setOlderHasMore(page.hasMore);
          return;
        }
        setOlderActivities((prev) => [...fresh, ...prev]);
        setOlderLoaded(true);
        setOlderHasMore(page.hasMore);
      })
      .finally(() => {
        if (olderActivitiesGenRef.current === gen) {
          inFlightOlderKeyRef.current = null;
          setLoadingOlderActivities(false);
        }
      });
  }, [
    selectedThreadShell,
    hasMoreOlderActivities,
    mergedActivities,
    activityRequestKey,
    loadThreadActivities,
  ]);

  const selectedThreadFeed = useMemo(
    () =>
      selectedThreadDetail
        ? buildThreadFeed(
            { ...selectedThreadDetail, activities: mergedActivities },
            selectedThreadQueuedMessages,
            dispatchingQueuedMessageId,
          )
        : [],
    [dispatchingQueuedMessageId, selectedThreadDetail, mergedActivities, selectedThreadQueuedMessages],
  );

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const interactionMode = selectedDraft?.interactionMode ?? selectedThread?.interactionMode ?? null;

  const selectedThreadSessionActivity = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThreadDetail, selectedThreadShell]);

  const queuedSendStartedAt = selectedThreadQueuedMessages[0]?.createdAt ?? null;
  const activeWorkStartedAt = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      queuedSendStartedAt,
    );
  }, [
    queuedSendStartedAt,
    selectedThreadDetail,
    selectedThreadSessionActivity,
    selectedThreadShell,
  ]);

  const activeThreadBusy =
    !!selectedThread &&
    (selectedThread.session?.status === "running" || selectedThread.session?.status === "starting");

  const onSendMessage = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    const thread = selectedThreadDetail ?? selectedThreadShell;
    const text = draft.text.trim();
    const attachments = draft.attachments;
    if (text.length === 0 && attachments.length === 0) {
      return;
    }

    const metadata = makeQueuedMessageMetadata();
    try {
      await enqueueThreadOutboxMessage({
        environmentId: selectedThreadShell.environmentId,
        threadId: selectedThreadShell.id,
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text,
        attachments,
        modelSelection: draft.modelSelection ?? thread.modelSelection,
        runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
        interactionMode: draft.interactionMode ?? thread.interactionMode,
        createdAt: metadata.createdAt,
      });
      clearComposerDraftContent(threadKey);
    } catch (error) {
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to save the queued message.",
      );
    }
  }, [selectedThreadDetail, selectedThreadShell]);

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pickComposerImages({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { modelSelection: value });
    },
    [selectedThreadKey],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { interactionMode: value });
    },
    [selectedThreadKey],
  );

  return {
    selectedThreadFeed,
    selectedThreadQueueCount,
    activeWorkStartedAt,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    hasMoreOlderActivities,
    loadingOlderActivities,
    onLoadOlderActivities,
    onChangeDraftMessage,
    onPickDraftImages,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
