import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  IssueAction,
  IssueCloseReason,
  IssueComment,
  IssueLinkedPullRequest,
  IssueProviderKind,
  IssueRef,
  IssueState,
  ScopedProjectRef,
  ScopedThreadRef,
  WorkItemMatch,
} from "@t3tools/contracts";
import {
  ArrowDownUpIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  ChevronDownIcon,
  HammerIcon,
  LinkIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PaperclipIcon,
  PencilLineIcon,
  RefreshCwIcon,
  TagIcon,
  UserPlusIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { SourceControlActorLabel, SourceControlMetaLine } from "../sourceControl/actorPresentation";
import { DetailTabStrip } from "../sourceControl/DetailTabStrip";
import { handoffPrompt, readableFailure } from "../sourceControl/handoff";
import { useMountedTabs } from "../sourceControl/useMountedTabs";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ActivityUnavailableState } from "../sourceControl/ActivityUnavailableState";
import {
  buildAskAboutIssueHandoff,
  buildAttachIssueContext,
  buildExplainIssueHandoff,
  buildLinkPullRequestsHandoff,
  buildSolveIssueHandoff,
  issueHandoffReviewComments,
  LINK_PULL_REQUESTS_HANDOFF_KIND,
  mergeEarlierIssueComments,
  shouldRefreshIssueActivity,
  type IssueHandoff,
  type IssueHandoffSource,
} from "./issueDetail.logic";
import { DetailGhost, TimelineGhost } from "../sourceControl/ListGhosts";
import { IssueSummaryTab } from "./IssueSummaryTab";
import { IssuesUnavailableState } from "./IssuesUnavailableState";
import { IssueTimelineTab } from "./IssueTimelineTab";
import { getIssueProviderPresentation, resolveIssueState } from "./issuePresentation";

/** An issue has no patch to read, so there is no third tab here as there is on a change request. */
type DetailTab = "summary" | "timeline";

const ACTION_SUCCESS_LABELS: Record<IssueAction, string> = {
  close: "Issue closed",
  reopen: "Issue reopened",
};

/** Said as the thing that did not happen, rather than as the operation that returned an error. */
const ACTION_FAILURE_LABELS: Record<IssueAction, string> = {
  close: "Could not close this issue",
  reopen: "Could not reopen this issue",
};

/** What to try, for the times the host says only that it refused. */
const ACTION_FAILURE_HINTS: Record<IssueAction, string> = {
  close: "The host refused it. Check that you have write access, or that you opened it.",
  reopen:
    "The host refused it. Check that you have write access, or that you opened it, and that the tracker is still on.",
};

/** The choice reads as the whole action, because that is what pressing it does. */
const CLOSE_REASON_LABELS: Record<IssueCloseReason, string> = {
  completed: "Close as completed",
  "not-planned": "Close as not planned",
};

/** The same reason inside the confirmation's sentence, where the verb is already said. */
const CLOSE_REASON_PHRASES: Record<IssueCloseReason, string> = {
  completed: " as completed",
  "not-planned": " as not planned",
};

const openOnIssueLabel = (provider: IssueProviderKind): string =>
  `Open on ${getIssueProviderPresentation(provider).providerName}`;

/** Names no hand-off, which is the point: it holds the controls shut without claiming one is running. */
const HANDOFF_WAITING_KIND = "waiting-for-activity";

const TABS: ReadonlyArray<{ value: DetailTab; label: string }> = [
  { value: "summary", label: "Summary" },
  { value: "timeline", label: "Timeline" },
];

/**
 * Where a hand-off from this panel lands. Beside a thread it is that thread's own composer, so
 * reading an issue and asking about it stay one conversation; on a page there is no conversation
 * to join, and the issue's own project gets a new thread.
 */
export type IssueHandoffTarget =
  | { readonly kind: "new-thread" }
  | {
      readonly kind: "existing-thread";
      /** Which project the thread is standing in, which is not always the issue's own. */
      readonly projectRef: ScopedProjectRef;
      /** The composer to write into: a live thread, or the draft one that has yet to become one. */
      readonly draftId: ScopedThreadRef | DraftId;
    };

/**
 * What the last hand-off wrote into each composer, kept outside React because the panel that wrote
 * it is closed by the time the next one opens. It is how a prompt the reader has since edited is
 * told apart from the one they were handed: only the sentence still exactly as written may be
 * replaced.
 */
const lastHandoffPromptByDraft = new Map<string, string>();

const draftKey = (target: ScopedThreadRef | DraftId): string =>
  typeof target === "string" ? target : scopedThreadKey(target);

export function IssueDetailPanel({
  environmentId,
  reference,
  handoffTarget,
  refreshToken: forcedRefreshToken = 0,
  onActed,
  onStateChange,
  onOpenLinkedPullRequest,
  chromeVariant = "full",
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /** Where "Solve", "Ask" and the rest put what they write. */
  handoffTarget: IssueHandoffTarget;
  /**
   * Bumped by whatever holds the panel when a reader asks for everything on screen to be read
   * again. The panel owns its own reads, so the page cannot refresh them for it — it says when,
   * and this says it.
   */
  refreshToken?: number;
  /**
   * An action changed this issue on the host, so a list showing it is now out of date. Told
   * rather than assumed: only the page knows whether it is showing one.
   */
  onActed?: () => void;
  /** Keeps compact chrome, such as the right-panel tab, in step with refreshed host state. */
  onStateChange?: (status: {
    projectId: string;
    repository: string;
    number: number;
    state: IssueState;
    stateReason: IssueCloseReason | null;
  }) => void;
  /**
   * Opens one of the change requests that reference this issue, as a peer tab beside it. Supplied
   * by whoever mounted the panel, because only they know which panel the tab belongs in; without
   * one the row opens it on the host instead, which is never a dead control.
   */
  onOpenLinkedPullRequest?: (link: IssueLinkedPullRequest) => void;
  /**
   * How the metadata above the content behaves: `full` keeps every row pinned; `collapse`
   * folds the whole of it into the top row once the active tab scrolls, and unfolds at the
   * top — the chrome spends its height on what is being read.
   */
  chromeVariant?: "full" | "collapse";
}) {
  const issueKey = `${reference.projectId}:${reference.repository}#${reference.number}`;
  const [tab, setTab] = useState<DetailTab>("summary");
  // Oldest first, unlike a change request: an issue is an argument written from its opening
  // towards whatever was settled, and reading it backwards is reading the conclusion first.
  const [timelineOrder, setTimelineOrder] = useState<"oldest" | "newest">("oldest");
  // Both live here rather than in the tab that shows them, because the menu that opens them is
  // in this header and the summary is a tab away when it is pressed.
  const [editing, setEditing] = useState(false);
  const [openPicker, setOpenPicker] = useState<"labels" | "assignees" | null>(null);
  const mountedTabs = useMountedTabs(tab);
  const [chromeCondensed, setChromeCondensed] = useState(false);
  // Each tab remembers whether its chrome was condensed. Only the active tab can emit scroll
  // events, so the capture handler always writes the active tab's entry — and a tab switch
  // reads the destination's memory instead of inheriting the tab being left. A tab too short
  // to scroll remembers "expanded", which is what keeps it from being stranded under a chrome
  // it has no scrollbar to reopen.
  const chromeStateByTab = useRef<Partial<Record<DetailTab, boolean>>>({});
  useEffect(() => {
    setChromeCondensed(chromeStateByTab.current[tab] ?? false);
  }, [tab]);
  const condensed = chromeVariant === "collapse" && chromeCondensed;
  // Collapsing removes the fold's height from the chrome, which would otherwise hand that
  // height to the scrollport and leap the content up by it mid-scroll. The cure is exact
  // compensation: collapse only once the reader has scrolled at least the fold's height,
  // then give that height back to `scrollTop` before the next paint — the content under
  // their eyes does not move, and the collapse itself is the only thing that changes.
  const scrollerRef = useRef<HTMLElement | null>(null);
  const foldRef = useRef<HTMLDivElement | null>(null);
  // The condensed chrome's second row opens as the fold closes, so the height the scrollport
  // gains is the fold's minus this row's. Measured the same way the fold is: `scrollHeight`
  // through a zero track reads its natural height in either state.
  const condensedRowRef = useRef<HTMLDivElement | null>(null);
  const compensationRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (compensationRef.current === null) return;
    const scroller = scrollerRef.current;
    const delta = compensationRef.current;
    compensationRef.current = null;
    if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
  }, [condensed]);
  // The issue the dialog was opened over travels with the question, because the panel shows a
  // different issue every time it is opened and the dialog outlives that swap: without it, a
  // confirmation asked about one issue closes whichever one the panel has moved on to.
  const [confirmClose, setConfirmClose] = useState<{
    reference: IssueRef;
    reason: IssueCloseReason | null;
  } | null>(null);
  const [actionPending, setActionPending] = useState(false);
  /** Which hand-off is under way, so only the item that was pressed says it is working. */
  const [handoff, setHandoff] = useState<string | null>(null);
  const [loadedComments, setLoadedComments] = useState<{
    readonly key: string;
    readonly comments: ReadonlyArray<IssueComment>;
    readonly nextCursor: string | null;
  } | null>(null);
  const [loadingMoreComments, setLoadingMoreComments] = useState(false);
  const readCommentsPage = useAtomCommand(issueEnvironment.commentsPage, { reportFailure: false });

  const detailQuery = useEnvironmentQuery(
    issueEnvironment.detail({ environmentId, input: reference }),
  );
  // Read apart from the detail so an issue with two hundred comments still shows its title,
  // its state and its actions while the conversation is still on its way.
  const activityQuery = useEnvironmentQuery(
    issueEnvironment.activity({ environmentId, input: reference }),
  );
  const coreDetail = detailQuery.data;
  const activity = activityQuery.data;
  const loadedPage = loadedComments?.key === issueKey ? loadedComments : null;
  const detail = useMemo(
    () =>
      coreDetail === null
        ? null
        : {
            ...coreDetail,
            author: activity?.author ?? coreDetail.author,
            comments: mergeEarlierIssueComments(
              activity?.comments ?? [],
              loadedPage?.comments ?? [],
            ),
            // The host's own count, which the core read already carries: the conversation being
            // unread is not the same as there being nothing in it.
            commentCount: activity?.commentCount ?? coreDetail.commentCount,
            commentsTruncated:
              loadedPage === null
                ? (activity?.commentsTruncated ?? false)
                : loadedPage.nextCursor !== null,
            nextCommentsCursor:
              loadedPage === null ? (activity?.nextCommentsCursor ?? null) : loadedPage.nextCursor,
            events: activity?.events ?? [],
            ...(activity?.reactions === undefined ? {} : { reactions: activity.reactions }),
          },
    [activity, coreDetail, loadedPage],
  );
  const activityPending = activityQuery.isPending && activity === null;
  const activityError = activity === null ? activityQuery.error : null;
  const refreshDetail = useCallback(() => {
    detailQuery.refresh();
    activityQuery.refresh();
  }, [activityQuery.refresh, detailQuery.refresh]);
  const activityRevision = useRef<{ readonly key: string; readonly updatedAt: string } | null>(
    null,
  );
  const loadMoreComments = useCallback(async () => {
    const cursor = detail?.nextCommentsCursor;
    if (cursor == null || loadingMoreComments) return;
    setLoadingMoreComments(true);
    const result = await readCommentsPage({
      environmentId,
      input: { ...reference, cursor },
    });
    setLoadingMoreComments(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not load more comments" });
      return;
    }
    setLoadedComments((previous) => {
      const comments = previous?.key === issueKey ? previous.comments : [];
      return {
        key: issueKey,
        comments: mergeEarlierIssueComments(comments, result.value.comments),
        nextCursor: result.value.nextCursor,
      };
    });
  }, [
    detail?.nextCommentsCursor,
    environmentId,
    issueKey,
    loadingMoreComments,
    readCommentsPage,
    reference,
  ]);

  useEffect(() => {
    if (!coreDetail) return;
    const next = { key: issueKey, updatedAt: coreDetail.updatedAt };
    if (shouldRefreshIssueActivity(activityRevision.current, next)) {
      activityQuery.refresh();
    }
    activityRevision.current = next;
  }, [activityQuery.refresh, coreDetail, issueKey]);
  useEffect(() => {
    if (!detail) return;
    onStateChange?.({
      projectId: detail.projectId,
      repository: detail.repository,
      number: detail.number,
      state: detail.state,
      stateReason: detail.stateReason,
    });
  }, [detail, onStateChange]);
  // Core detail is cheap enough to re-read while this stays open. Activity is heavier, so the
  // revision effect above reads it only after this same issue reports a change.
  useLiveRefresh(detailQuery.refresh, {
    key: `issue:${issueKey}`,
  });
  // The button, on the other hand, goes around the server's cache rather than through it: it is
  // the answer for a reader who can see that what they are looking at is behind. The
  // invalidation goes first so the re-reads miss that cache; if it fails, the reads still run
  // and at worst answer from it.
  const invalidate = useAtomCommand(issueEnvironment.invalidate, { reportFailure: false });
  const refreshFromHost = useCallback(async () => {
    await invalidate({ environmentId, input: { reference } });
    refreshDetail();
  }, [environmentId, invalidate, reference, refreshDetail]);
  // A refresh asked for by the page, rather than by the menu item below.
  const appliedForcedToken = useRef(forcedRefreshToken);
  useEffect(() => {
    if (appliedForcedToken.current === forcedRefreshToken) return;
    appliedForcedToken.current = forcedRefreshToken;
    void refreshFromHost();
  }, [forcedRefreshToken, refreshFromHost]);
  const runAction = useAtomCommand(issueEnvironment.runAction, { reportFailure: false });
  const newThread = useNewThreadHandler();

  const perform = async (action: IssueAction, target: IssueRef, reason?: IssueCloseReason) => {
    if (actionPending) return;
    setActionPending(true);
    const result = await runAction({
      environmentId,
      input: { ...target, action, ...(reason ? { reason } : {}) },
    });
    setActionPending(false);
    if (result._tag === "Failure") {
      // The host's own sentence, because it is the only thing that says why: a repository whose
      // tracker was switched off between opening this panel and pressing the button refuses with
      // a reason no page could have guessed.
      toastManager.add({
        type: "error",
        title: ACTION_FAILURE_LABELS[action],
        description: readableFailure(
          squashAtomCommandFailure(result),
          ACTION_FAILURE_HINTS[action],
        ),
      });
      return;
    }
    toastManager.add({ type: "success", title: ACTION_SUCCESS_LABELS[action] });
    refreshDetail();
    onActed?.();
  };

  /**
   * The composer a hand-off writes into without opening anything, or null where it has to open a
   * thread first.
   *
   * A thread standing in another project is not that composer: writing "solve this issue" into a
   * conversation whose working tree is a different repository hands the agent a task it cannot do
   * where it is, so the issue's own project gets a thread instead.
   */
  const inPlaceDraft =
    handoffTarget.kind === "existing-thread" &&
    handoffTarget.projectRef.environmentId === environmentId &&
    handoffTarget.projectRef.projectId === detail?.projectId
      ? handoffTarget.draftId
      : null;

  const writeHandoff = (target: ScopedThreadRef | DraftId, task: IssueHandoff) => {
    const store = useComposerDraftStore.getState();
    // The latest press is the ask: it takes over what an earlier hand-off left, prompt and chips
    // both, rather than stacking a second one under the first. What the reader typed themselves
    // survives — the composer they are handed is not always a fresh one, and a prompt they have
    // since edited is theirs rather than the hand-off's.
    const draft = store.getComposerDraft(target);
    const key = draftKey(target);
    const prompt = handoffPrompt(
      { prompt: draft?.prompt ?? "", lastHandoffPrompt: lastHandoffPromptByDraft.get(key) },
      task.prompt,
    );
    // Remember the hand-off's own contribution, not the merged prompt: only that sentence is
    // this panel's to take back next time, and the reader's text around it is not.
    lastHandoffPromptByDraft.set(key, task.prompt);
    store.setPrompt(target, prompt);
    store.setReviewComments(
      target,
      issueHandoffReviewComments(draft?.reviewComments ?? [], task.reviewComments),
    );
  };

  /**
   * Hands the issue over as a task in a composer, and leaves it there to be read before it is
   * sent. Nothing is checked out and no code is touched: an issue is a description of work, not
   * the work, and which branch to do it on is the thread's question rather than this panel's.
   */
  const startHandoff = async (
    kind: string,
    build: (source: IssueHandoffSource) => IssueHandoff,
  ) => {
    if (!detail || handoff !== null || activityPending) return;
    const task = build({
      number: detail.number,
      repository: detail.repository,
      title: detail.title,
      url: detail.url,
      body: detail.body,
      comments: detail.comments,
    });
    // "Ask" and "Add to composer" leave the composer empty on purpose, so saying the question is
    // in it would send the reader looking for something that is not there. The chips are what
    // landed.
    const description =
      task.prompt.length > 0
        ? "The task is in the composer — read it over, then send."
        : "The issue is in the composer — type your message, then send.";
    if (inPlaceDraft !== null) {
      writeHandoff(inPlaceDraft, task);
      toastManager.add({ type: "success", title: "Added to this thread", description });
      return;
    }
    setHandoff(kind);
    const opened = await newThread(scopeProjectRef(environmentId, detail.projectId)).then(
      (session) => session,
      () => null,
    );
    setHandoff(null);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: "Could not open a thread",
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    writeHandoff(opened.draftId, task);
    toastManager.add({ type: "success", title: "Opened in a thread", description });
  };

  const openOnHost = (url: string) => {
    void readLocalApi()?.shell.openExternal(url);
  };

  // Two questions, both of which have to say yes: whether this host can do it at all, and
  // whether this account may. A reader with read access on someone else's project sees the issue
  // and none of the buttons that would only ever be refused.
  const can = (action: IssueAction) =>
    detail?.capabilities.actions.includes(action) === true &&
    detail.viewerPermissions.actions.includes(action);
  const canEdit = detail?.capabilities.edit === true && detail.viewerPermissions.edit;
  // A host that takes labels but will not say which a repository has has nothing to open a picker
  // on, so the menu item that opens one goes with it.
  const canLabel =
    detail?.capabilities.labels === true &&
    detail.capabilities.listLabelCandidates &&
    detail.viewerPermissions.labels;
  const canAssign =
    detail?.capabilities.assignees === true &&
    detail.capabilities.listAssigneeCandidates &&
    detail.viewerPermissions.assignees;
  const closeReasons = detail?.capabilities.closeReasons ?? [];
  const statePresentation = detail
    ? resolveIssueState({ state: detail.state, stateReason: detail.stateReason })
    : null;
  // The pickers live in the summary's meta row, so the menu items that open them bring the reader
  // to the tab holding them first: a popup anchored to a hidden row opens nowhere.
  const openPickerOnSummary = (picker: "labels" | "assignees") => {
    setTab("summary");
    setOpenPicker(picker);
  };
  // Every hand-off quotes the conversation, and until the activity read lands there is none to
  // quote — an agent handed the issue mid-read gets the argument with the argument missing, and
  // the read that lands afterwards cannot amend a composer already written. So the controls wait
  // and say what they are waiting for, rather than sending half an issue. A failed read is not
  // waiting: nothing further is coming, and the issue itself is still worth handing over.
  const handoffDisabled = handoff !== null || activityPending;
  const handoffLabel = (kind: string, label: string) =>
    handoff === kind ? "Opening..." : activityPending ? `${label} (loading comments)` : label;
  const solveDescription = activityPending
    ? "Waiting for the issue's comments, which go with the task"
    : inPlaceDraft === null
      ? "Opens a thread on this project holding the task"
      : "Puts the task in this thread's composer";

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      {/* The top row's geometry never changes: both of its states occupy the same stacked
          cell and crossfade, so the actions on the right have one home whatever the chrome
          is doing below. The fold and this fade share one 200ms clock. */}
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-b border-border/60">
        {/* The fixed height lives on the two top-row cells — not the grid, whose later rows
            are the fold — so the actions have one immovable home in both states. */}
        <div className="ml-4 grid h-7 min-w-0 items-center">
          <div
            aria-hidden={condensed}
            inert={condensed}
            className={cn(
              "col-start-1 row-start-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground transition-[opacity,transform] ease-out motion-reduce:transform-none motion-reduce:transition-none sm:text-xs",
              // Sequenced, not simultaneous: the leaving layer clears quickly before the
              // arriving one lands, so no frame shows both texts superimposed at half opacity.
              condensed
                ? "pointer-events-none -translate-y-1 opacity-0 duration-100"
                : "translate-y-0 opacity-100 delay-50 duration-150",
            )}
          >
            {detail && statePresentation ? (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="min-w-0 truncate font-medium text-muted-foreground" />}
                  >
                    {detail.repository}
                  </TooltipTrigger>
                  <TooltipPopup side="top">{detail.repository}</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => openOnHost(detail.url)}
                        className={cn(
                          "shrink-0 font-medium underline-offset-2 hover:underline",
                          statePresentation.toneClassName,
                        )}
                        aria-label={openOnIssueLabel(detail.provider)}
                      />
                    }
                  >
                    #{detail.number}
                  </TooltipTrigger>
                  <TooltipPopup side="top">{openOnIssueLabel(detail.provider)}</TooltipPopup>
                </Tooltip>
              </>
            ) : null}
          </div>
          <div
            aria-hidden={!condensed}
            inert={!condensed}
            className={cn(
              "col-start-1 row-start-1 flex min-w-0 items-center gap-1.5 text-sm transition-[opacity,transform] ease-out motion-reduce:transform-none motion-reduce:transition-none sm:text-xs",
              condensed
                ? "translate-y-0 opacity-100 delay-50 duration-150"
                : "pointer-events-none translate-y-1 opacity-0 duration-100",
            )}
          >
            {detail && statePresentation ? (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        tabIndex={condensed ? 0 : -1}
                        onClick={() => openOnHost(detail.url)}
                        className={cn(
                          "shrink-0 font-medium underline-offset-2 hover:underline",
                          statePresentation.toneClassName,
                        )}
                        aria-label={openOnIssueLabel(detail.provider)}
                      />
                    }
                  >
                    #{detail.number}
                  </TooltipTrigger>
                  <TooltipPopup side="top">{openOnIssueLabel(detail.provider)}</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="min-w-0 truncate font-medium text-foreground" />}
                  >
                    {detail.title}
                  </TooltipTrigger>
                  <TooltipPopup side="top">{detail.title}</TooltipPopup>
                </Tooltip>
                <statePresentation.Icon
                  role="img"
                  aria-label={statePresentation.label}
                  className={cn("size-3.5 shrink-0", statePresentation.toneClassName)}
                />
              </>
            ) : null}
          </div>
        </div>
        <div className="mr-4 flex h-7 min-w-0 flex-nowrap items-center justify-end gap-1">
          {detail ? (
            <>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      aria-label="More issue actions"
                      className="size-6"
                      size="icon-xs"
                      variant="ghost-muted"
                    />
                  }
                >
                  <MoreHorizontalIcon className="size-4" />
                </MenuTrigger>
                <MenuPopup align="end" side="bottom" className="min-w-72">
                  <MenuItem disabled={detailQuery.isPending} onClick={() => void refreshFromHost()}>
                    <RefreshCwIcon className="size-3.5" />
                    Refresh
                  </MenuItem>
                  <MenuItem
                    disabled={handoffDisabled}
                    onClick={() => void startHandoff("ask", buildAskAboutIssueHandoff)}
                  >
                    <MessageCircleQuestionIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                    <span className="flex min-w-0 flex-col">
                      <span>{handoffLabel("ask", "Ask a question")}</span>
                      <span className="text-xs text-muted-foreground">
                        Leaves the issue in the composer for a question of your own.
                      </span>
                    </span>
                  </MenuItem>
                  <MenuItem
                    disabled={handoffDisabled}
                    onClick={() => void startHandoff("explain", buildExplainIssueHandoff)}
                  >
                    <BookOpenIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                    <span className="flex min-w-0 flex-col">
                      <span>{handoffLabel("explain", "Explain this issue")}</span>
                      <span className="text-xs text-muted-foreground">
                        A read of what is being asked for, and what it concerns here.
                      </span>
                    </span>
                  </MenuItem>
                  {/* Only where there is a conversation to add it to: everything else here opens
                      one, and "add to the thread you are in" would be that same thread. */}
                  {inPlaceDraft === null ? null : (
                    <MenuItem
                      disabled={handoffDisabled}
                      onClick={() => void startHandoff("attach", buildAttachIssueContext)}
                    >
                      <PaperclipIcon className="size-3.5" />
                      {handoffLabel("attach", "Add to composer")}
                    </MenuItem>
                  )}
                  {canEdit || canLabel || canAssign ? (
                    <>
                      <MenuSeparator />
                      {canEdit ? (
                        <MenuItem
                          onClick={() => {
                            setTab("summary");
                            setEditing(true);
                          }}
                        >
                          <PencilLineIcon className="size-3.5" />
                          Edit title and description
                        </MenuItem>
                      ) : null}
                      {canLabel ? (
                        <MenuItem onClick={() => openPickerOnSummary("labels")}>
                          <TagIcon className="size-3.5" />
                          Labels
                        </MenuItem>
                      ) : null}
                      {canAssign ? (
                        <MenuItem onClick={() => openPickerOnSummary("assignees")}>
                          <UserPlusIcon className="size-3.5" />
                          Assignees
                        </MenuItem>
                      ) : null}
                    </>
                  ) : null}
                  <MenuSeparator />
                  <MenuItem onClick={() => openOnHost(detail.url)}>
                    <ArrowUpRightIcon className="size-3.5" />
                    {openOnIssueLabel(detail.provider)}
                  </MenuItem>
                  {/* A clipboard that is switched off or refuses says nothing on its own, and a
                      reader who has been handed nothing goes and pastes whatever was there
                      before. The refusal is the host's own sentence, because it is the only
                      thing that says which of the two happened. */}
                  <MenuItem
                    onClick={() =>
                      void writeTextToClipboard(detail.url, "issue link").catch(
                        (error: unknown) => {
                          toastManager.add({
                            type: "error",
                            title: "Could not copy the link",
                            description:
                              error instanceof Error
                                ? error.message
                                : "The clipboard refused it. Open the issue on the host instead.",
                          });
                        },
                      )
                    }
                  >
                    <LinkIcon className="size-3.5" />
                    Copy link
                  </MenuItem>
                </MenuPopup>
              </Menu>
              {/* Handing the issue to an agent is the reason to open one at all, so it is a
                  button of its own wherever the panel is — beside a thread as much as on the
                  page. The label goes once the chrome condenses; the button itself does not. */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={handoffDisabled}
                      onClick={() => void startHandoff("solve", buildSolveIssueHandoff)}
                    />
                  }
                >
                  {handoff === "solve" ? (
                    "Opening..."
                  ) : activityPending ? (
                    "Loading..."
                  ) : (
                    <>
                      <HammerIcon className="size-3" />
                      <span className={cn(condensed && "sr-only")}>Solve</span>
                    </>
                  )}
                </TooltipTrigger>
                <TooltipPopup side="top">{solveDescription}</TooltipPopup>
              </Tooltip>
              {detail.state === "open" && can("close") ? (
                closeReasons.length > 0 ? (
                  // A reason is not a second action but a part of this one, so it is chosen on the
                  // way rather than offered as another button.
                  <Menu>
                    <MenuTrigger
                      disabled={actionPending}
                      render={
                        <Button size="xs">
                          {actionPending ? (
                            "Closing..."
                          ) : (
                            <>
                              Close
                              <ChevronDownIcon className="size-3 opacity-80" />
                            </>
                          )}
                        </Button>
                      }
                    />
                    <MenuPopup align="end" side="bottom" className="min-w-56">
                      {closeReasons.map((reason) => (
                        <MenuItem
                          key={reason}
                          disabled={actionPending}
                          onClick={() => setConfirmClose({ reference, reason })}
                        >
                          {CLOSE_REASON_LABELS[reason]}
                        </MenuItem>
                      ))}
                    </MenuPopup>
                  </Menu>
                ) : (
                  <Button
                    size="xs"
                    disabled={actionPending}
                    onClick={() => setConfirmClose({ reference, reason: null })}
                  >
                    {actionPending ? "Closing..." : "Close"}
                  </Button>
                )
              ) : detail.state === "closed" && can("reopen") ? (
                <Button
                  size="xs"
                  disabled={actionPending}
                  onClick={() => void perform("reopen", reference)}
                >
                  {actionPending ? "Reopening..." : "Reopen"}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>

        <div
          className={cn(
            "col-span-2 grid",
            condensed
              ? "grid-rows-[1fr]"
              : "grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          )}
        >
          <div
            ref={condensedRowRef}
            className={cn(
              "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
              condensed
                ? "translate-y-0 opacity-100 delay-50"
                : "translate-y-1 opacity-0 duration-100",
            )}
            inert={!condensed}
          >
            {detail && statePresentation ? (
              <div className="col-span-2 min-w-0 px-4 pb-2 pt-1">
                <SourceControlMetaLine className="min-w-0 text-xs text-muted-foreground">
                  <Badge
                    variant="outline"
                    className={cn("h-5 gap-1 rounded px-1.5", statePresentation.toneClassName)}
                  >
                    <statePresentation.Icon aria-hidden className="size-3" />
                    {statePresentation.label}
                  </Badge>
                  <SourceControlActorLabel actor={detail.author} className="font-medium" />
                  <span className="shrink-0">
                    updated {formatRelativeTimeLabel(detail.updatedAt)}
                  </span>
                </SourceControlMetaLine>
              </div>
            ) : null}
          </div>
        </div>

        {/* Folding is a grid track going to zero: the rows below stay mounted, the track
            animates closed over them, and `inert` takes the hidden controls out of the tab
            order for as long as the chrome is condensed. */}
        <div
          className={cn(
            "col-span-2 grid",
            condensed
              ? "grid-rows-[0fr]"
              : "grid-rows-[1fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          )}
        >
          <div
            ref={foldRef}
            className={cn(
              "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
              condensed
                ? "-translate-y-1 opacity-0 duration-100"
                : "translate-y-0 opacity-100 delay-50",
            )}
            inert={condensed}
          >
            {detail && statePresentation ? (
              <div className="col-span-2 mt-1 min-w-0 px-4 pb-4">
                <h1 className="text-base font-semibold leading-snug">{detail.title}</h1>
                <SourceControlMetaLine className="mt-2 text-xs text-muted-foreground">
                  <Badge
                    variant="outline"
                    className={cn("h-5 gap-1 rounded px-1.5", statePresentation.toneClassName)}
                  >
                    <statePresentation.Icon aria-hidden className="size-3" />
                    {statePresentation.label}
                  </Badge>
                  <SourceControlActorLabel actor={detail.author} className="font-medium" />
                  <span>updated {formatRelativeTimeLabel(detail.updatedAt)}</span>
                </SourceControlMetaLine>
              </div>
            ) : null}
          </div>
        </div>
        {detail ? (
          <DetailTabStrip label="Issue tabs" tabs={TABS} active={tab} onSelect={setTab}>
            {tab === "timeline" ? (
              <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 whitespace-nowrap text-[11px] transition-opacity",
                    (activityPending || activityError) && "opacity-35",
                  )}
                  aria-label={
                    activityError
                      ? "Comments unavailable"
                      : `${detail.commentCount.toLocaleString()} ${
                          detail.commentCount === 1 ? "comment" : "comments"
                        }`
                  }
                >
                  <MessageSquareIcon aria-hidden className="size-3" />
                  {activityError
                    ? "—"
                    : activityPending
                      ? "…"
                      : detail.commentCount.toLocaleString()}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  className="h-7 px-2 text-[10px] text-muted-foreground"
                  aria-label={
                    timelineOrder === "oldest"
                      ? "Show newest activity first"
                      : "Show oldest activity first"
                  }
                  onClick={() =>
                    setTimelineOrder((value) => (value === "oldest" ? "newest" : "oldest"))
                  }
                >
                  <ArrowDownUpIcon aria-hidden className="size-3" />
                  {timelineOrder === "oldest" ? "Oldest first" : "Newest first"}
                </Button>
              </div>
            ) : null}
          </DetailTabStrip>
        ) : null}
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        // Scroll does not bubble, but it captures: one listener hears every tab's own scroll
        // container. Collapse past two line-heights, expand only back at the very top, so the
        // boundary row cannot flap the chrome open and shut.
        onScrollCapture={(event) => {
          const scroller = event.target as HTMLElement;
          if (chromeVariant !== "collapse") return;
          // Only the tab's own scrollport folds the chrome. A scrollable inside it — a code block
          // running wide, the description open in an editor — is the reader moving something on
          // the page rather than the page, and its `scrollTop` is not the one the compensation
          // belongs to. The tab renders its scroller as the marked wrapper's only child, so that
          // is what the mark asks about.
          if (scroller.parentElement?.hasAttribute("data-tab-scroller") !== true) return;
          scrollerRef.current = scroller;
          const top = scroller.scrollTop;
          setChromeCondensed((previous) => {
            let next = previous;
            // `scrollHeight` reads the fold's natural height whichever state the track is in.
            const foldHeight = foldRef.current?.scrollHeight ?? 0;
            // The chrome trades the fold for the condensed second row, so the height the
            // scrollport actually gains is the difference between the two.
            const chromeDelta = foldHeight - (condensedRowRef.current?.scrollHeight ?? 0);
            if (previous) {
              // The hard top reopens the chrome. The refund puts the reader a fold's height
              // from the top, pinned to the same pixels — the metadata is scrolled up to,
              // not thrown at them.
              if (top < 4 && foldHeight > 0) {
                compensationRef.current = chromeDelta;
                next = false;
              }
            } else if (foldHeight > 0 && top > foldHeight + 32) {
              compensationRef.current = -chromeDelta;
              next = true;
            }
            chromeStateByTab.current[tab] = next;
            return next;
          });
        }}
      >
        {detailQuery.isPending && !detail ? (
          // The ghost wears the shape of the tab being waited on, so switching tabs mid-load
          // does not flash a summary outline under a timeline heading.
          tab === "timeline" ? (
            <TimelineGhost />
          ) : (
            <DetailGhost label="Loading issue" />
          )
        ) : detailQuery.error && !detail ? (
          <IssuesUnavailableState error={detailQuery.error} onRetry={refreshDetail} />
        ) : detail ? (
          <>
            {mountedTabs.has("summary") ? (
              <div
                data-tab-scroller
                className={cn("absolute inset-0", tab !== "summary" && "invisible")}
              >
                <IssueSummaryTab
                  environmentId={environmentId}
                  reference={reference}
                  detail={detail}
                  onLoadMoreComments={() => void loadMoreComments()}
                  loadingMoreComments={loadingMoreComments}
                  activityPending={activityPending}
                  activityError={activityError}
                  editing={editing}
                  onEditingChange={setEditing}
                  openPicker={openPicker}
                  onOpenPickerChange={setOpenPicker}
                  // The section's own button knows only about a hand-off already under way, so
                  // "cannot go yet" is said to it in the one word it understands.
                  pendingHandoff={handoff ?? (activityPending ? HANDOFF_WAITING_KIND : null)}
                  onLinkPullRequests={(match: WorkItemMatch) =>
                    void startHandoff(LINK_PULL_REQUESTS_HANDOFF_KIND, (source) =>
                      buildLinkPullRequestsHandoff(source, match),
                    )
                  }
                  onOpenLinkedPullRequest={(link) =>
                    onOpenLinkedPullRequest === undefined
                      ? openOnHost(link.url)
                      : onOpenLinkedPullRequest(link)
                  }
                  onOpenAiMatch={(match) => openOnHost(match.url)}
                  onRefresh={refreshDetail}
                />
              </div>
            ) : null}
            {mountedTabs.has("timeline") ? (
              <div
                data-tab-scroller
                className={cn("absolute inset-0", tab !== "timeline" && "invisible")}
              >
                {activityPending ? (
                  <TimelineGhost />
                ) : activityError ? (
                  <ActivityUnavailableState
                    title="Could not load issue activity"
                    error={activityError}
                    onRetry={activityQuery.refresh}
                  />
                ) : (
                  <IssueTimelineTab
                    environmentId={environmentId}
                    reference={reference}
                    detail={detail}
                    onLoadMoreComments={() => void loadMoreComments()}
                    loadingMoreComments={loadingMoreComments}
                    order={timelineOrder}
                    onRefresh={refreshDetail}
                  />
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <AlertDialog
        open={confirmClose !== null}
        onOpenChange={(open) => !open && setConfirmClose(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Close issue?</AlertDialogTitle>
            <AlertDialogDescription>
              {`This closes #${confirmClose?.reference.number ?? reference.number}${
                confirmClose?.reason ? CLOSE_REASON_PHRASES[confirmClose.reason] : ""
              } on the host. You can reopen it afterwards.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              variant="destructive"
              disabled={actionPending}
              onClick={() => {
                const pending = confirmClose;
                if (!pending) return;
                setConfirmClose(null);
                void perform("close", pending.reference, pending.reason ?? undefined);
              }}
            >
              Close issue
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
