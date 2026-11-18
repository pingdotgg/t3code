import {
  parsePullRequestAnchor,
  pullRequestAnchorMatchesUrl,
  resolvePullRequestReviewAnchor,
} from "@t3tools/shared/pullRequestAnchor";
import { holdLinkedNodeInView } from "./holdLinkedNodeInView";
import { useAtomValue } from "@effect/atom-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  type EnvironmentId,
  type PullRequestComment,
  type PullRequestDetailView,
  type PullRequestRef,
  type PullRequestConversationThread,
  type PullRequestReviewThread,
  type ScopedThreadRef,
  pullRequestConversationThreads,
  type PullRequestThreadCommentsResult,
} from "@t3tools/contracts";
import {
  ArrowDownUpIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  HammerIcon,
  ListFilterIcon,
  MessageSquarePlusIcon,
  RefreshCwIcon,
  TagIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { m, type MessageResolver } from "~/i18n/messages";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { RelativeTime } from "~/components/RelativeTime";

import { Button } from "../ui/button";
import { PullRequestEditButton } from "./PullRequestEditButton";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AddToChatIconButton,
  PullRequestActorLabel,
  PullRequestLabelChip,
  PullRequestReviewOutcomeBadge,
} from "./pullRequestPresentation";
import { PullRequestLabelPicker } from "./PullRequestLabelPicker";
import { ReviewThreadCard } from "./PullRequestReviewAnnotation";
import { PullRequestActivityUnavailableState } from "./PullRequestActivityUnavailableState";
import {
  filterPullRequestConversationItems,
  isPullRequestCommentFinished,
  orderPullRequestComments,
  pagePullRequestConversationItems,
  pullRequestBodyPreview,
  pullRequestConversationItemComments,
  pullRequestConversationItems,
  pullRequestConversationSummary,
  pullRequestFindingKey,
  pullRequestReviewOutcome,
  visibleBody,
  type PullRequestChatSubject,
  type PullRequestConversationItem,
  type PullRequestFinding,
} from "./pullRequestDetail.logic";
import {
  canEditPullRequestChangeRequest,
  canEditPullRequestComment,
  canResolvePullRequestThread,
  descriptionDraftInForce,
  settleDescriptionSave,
  startDescriptionSave,
  type DescriptionDraft,
} from "@t3tools/client-runtime/pull-request-editing";
import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskList";
import { pullRequestAttachments } from "./pullRequestMarkdown.logic";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestCommentBody } from "./PullRequestCommentBody";
import { PullRequestMoreReplies } from "./PullRequestMoreReplies";
import {
  PullRequestCommentTime,
  PullRequestResolvedThreadRow,
  PullRequestReviewEntry,
} from "./PullRequestQuietEntries";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import {
  type PullRequestCompletionScope,
  pullRequestCompletionScope,
} from "./PullRequestMarkdownTextarea";
import { PullRequestReactionBar } from "./PullRequestReactions";
import { canReactPullRequestComment } from "@t3tools/client-runtime/pull-request-reactions";
import { PullRequestResolveThreadButton } from "./PullRequestResolveThreadButton";
import { PullRequestConversationGhost } from "./PullRequestGhosts";
import { sectionCollapseAnchorScrollTop } from "./pullRequestSummaryScroll.logic";
import { changeRequestTermKind } from "./changeRequestTerm";

function CommentIdentity({
  comment,
  detail,
}: {
  comment: PullRequestComment;
  detail: PullRequestDetailView;
}) {
  const actor = comment.author;
  const profileUrl = actor
    ? sourceControlClients.get(detail.provider).authorProfileUrl(actor.login, detail.url)
    : null;
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-meta">
      <PullRequestActorLabel actor={actor} profileUrl={profileUrl} className="max-w-full" />
      <PullRequestCommentTime createdAt={comment.createdAt} url={comment.url} />
    </div>
  );
}

function CommentLocation({
  comment,
  thread,
}: {
  comment: PullRequestComment;
  thread: PullRequestConversationThread | undefined;
}) {
  const path = thread?.path ?? comment.path;
  if (!path) return null;
  const label = `${path}${thread?.line ? `:${thread.line}` : ""}`;
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
      <Tooltip>
        <TooltipTrigger render={<span className="truncate font-mono" />}>{label}</TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      {thread?.isOutdated ? (
        <span className="shrink-0">
          <T context="review thread state">Outdated</T>
        </span>
      ) : null}
    </div>
  );
}

const REVIEW_STATE_LABELS: Partial<Record<string, string>> = {
  commented: msg("Commented", { $context: "review state" }),
  pending: msg("Pending", { $context: "review state" }),
};

function reviewStateLabel(state: string, resolve: MessageResolver): string {
  const known = REVIEW_STATE_LABELS[state.trim().toLowerCase()];
  if (known) return resolve(known);
  const words = state.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface CommentEditing {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly completionScope: PullRequestCompletionScope | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly canEdit: (comment: PullRequestComment) => boolean;
  readonly editingId: string | null;
  readonly saving: boolean;
  readonly onEdit: (comment: PullRequestComment | null) => void;
  readonly onSave: (comment: PullRequestComment, body: string) => void;
}

function CommentBody({
  comment,
  editing,
  className,
  revealCount = 0,
}: {
  revealCount?: number;
  comment: PullRequestComment;
  editing: CommentEditing;
  className?: string | undefined;
}) {
  const gt = useGT();
  if (editing.editingId === comment.id) {
    return (
      <PullRequestMarkdownEditor
        className={className}
        value={comment.body}
        cwd={editing.cwd}
        environmentId={editing.environmentId}
        completionScope={editing.completionScope}
        threadRef={editing.threadRef}
        label={gt("Edit comment")}
        saving={editing.saving}
        onSave={(body) => editing.onSave(comment, body)}
        onCancel={() => editing.onEdit(null)}
      />
    );
  }
  return (
    <div className={cn("flex items-start gap-1", className)}>
      <PullRequestCommentBody
        key={comment.id}
        revealCount={revealCount}
        className="min-w-0 flex-1"
        text={comment.body}
        cwd={editing.cwd}
        environmentId={editing.environmentId}
        threadRef={editing.threadRef}
      />
      {editing.canEdit(comment) ? (
        <PullRequestEditButton
          aria-label={gt("Edit comment")}
          onClick={() => editing.onEdit(comment)}
        />
      ) : null}
    </div>
  );
}

/**
 * What Add to chat hands over for a remark: a remark on a line goes as its whole conversation,
 * the way fixing one does. Null when there are no words in it to talk about.
 */
function chatSubject(
  comment: PullRequestComment,
  thread: PullRequestConversationThread | undefined,
): PullRequestChatSubject | null {
  // An overview thread has no line to attach, so it goes as its opening remark, as fixing it does.
  if (thread !== undefined && thread.path !== null) {
    return thread.comments.some((entry) => visibleBody(entry.body) !== null)
      ? { kind: "thread", thread }
      : null;
  }
  return visibleBody(comment.body) === null ? null : { kind: "comment", comment };
}

function AddToChatButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="xs" variant="ghost" className="shrink-0" onClick={onClick}>
      {/* Wrapped like Fix's label so both sit on the header's baseline. */}
      <span className="inline-flex items-baseline gap-1">
        <MessageSquarePlusIcon className="size-3 self-center" />
        <span>
          <T>Add to chat</T>
        </span>
      </span>
    </Button>
  );
}

export function PullRequestMetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-7 min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 text-meta sm:min-h-6">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}

export function PullRequestSection({
  title,
  name,
  count,
  meta,
  defaultOpen = true,
  keepMounted = false,
  revealCount = 0,
  actions,
  children,
}: {
  title: string;
  /** Stable key for links that reveal this section, since the title is translated. */
  name?: string;
  /** A number beside the title, such as how many remarks the conversation holds. */
  count?: number | undefined;
  /** A quiet summary at the heading's far end. */
  meta?: ReactNode;
  defaultOpen?: boolean;
  keepMounted?: boolean;
  /** Reopens the section each time a link reveals it. */
  revealCount?: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  // A reveal opens at once: the opening animation would move what was just scrolled to.
  const [open, setOpen] = useState<boolean | "revealed">(
    revealCount > 0 ? "revealed" : defaultOpen,
  );
  const [seenRevealCount, setSeenRevealCount] = useState(revealCount);
  if (revealCount !== seenRevealCount) {
    setSeenRevealCount(revealCount);
    setOpen("revealed");
  }
  const headingRef = useRef<HTMLDivElement>(null);
  const setOpenWithScrollAnchor = (nextOpen: boolean) => {
    if (!nextOpen) {
      const heading = headingRef.current;
      const section = heading?.closest<HTMLElement>("[data-pull-request-summary-section]");
      const scroller = heading?.closest<HTMLElement>("[data-pull-request-summary-scroll]");
      if (heading && section && scroller) {
        const target = sectionCollapseAnchorScrollTop({
          scrollTop: scroller.scrollTop,
          viewportTop: scroller.getBoundingClientRect().top,
          sectionTop: section.getBoundingClientRect().top,
          headingTop: heading.getBoundingClientRect().top,
        });
        // Adjust before paint to keep the collapsed heading in place.
        if (target !== null) scroller.scrollTop = target;
      }
    }
    setOpen(nextOpen);
  };
  return (
    <Collapsible
      open={open !== false}
      onOpenChange={setOpenWithScrollAnchor}
      render={<section aria-label={title} />}
      data-pull-request-summary-section={name ?? ""}
    >
      <div
        ref={headingRef}
        className="sticky top-0 z-10 flex w-full flex-wrap items-center gap-x-2 bg-(--code-surface) pr-4"
      >
        <CollapsibleTrigger className="flex min-w-fit flex-1 items-center gap-1.5 px-4 py-3 text-left text-label text-foreground">
          <span>{title}</span>
          {count !== undefined ? (
            <span className="font-normal tabular-nums text-muted-foreground">
              {count.toLocaleString()}
            </span>
          ) : null}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
        {meta ? (
          <span className="shrink-0 truncate text-meta text-muted-foreground">{meta}</span>
        ) : null}
        {actions}
      </div>
      <CollapsiblePanel keepMounted={keepMounted} animate={open !== "revealed"}>
        <div className="px-4 pb-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

const COMMENT_PAGE = 10;

const COMMENT_FILTER_STORAGE_KEY = "t3code:pull-request-comment-filter:v1";
const CommentFilterSchema = Schema.Struct({ bots: Schema.Boolean, resolved: Schema.Boolean });
const DEFAULT_COMMENT_FILTER: typeof CommentFilterSchema.Type = { bots: false, resolved: false };

export function PullRequestSummaryTab({
  revealUrl,
  onRevealSettled,
  scrollerRef,
  readiness,
  environmentId,
  threadRef,
  reference,
  detail,
  activityPending,
  activityError,
  pendingFinding,
  fixFindingLabel: requestedFixFindingLabel,
  onFixFinding,
  onAddToChat,
  onRefresh,
}: {
  /** A clicked link to scroll to, until onRevealSettled reports it shown. */
  revealUrl?: string | undefined;
  onRevealSettled?: ((revealUrl: string) => void) | undefined;
  scrollerRef?: (node: HTMLDivElement | null) => void;
  /** The readiness card: checks, reviews and conflicts over the merge. Built by the panel. */
  readiness?: ReactNode;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  activityPending: boolean;
  activityError: string | null;
  pendingFinding?: string | null;
  fixFindingLabel?: string;
  onFixFinding?: (finding: PullRequestFinding) => void;
  /** Absent where there is no composer beside the panel to add a remark to. */
  onAddToChat?: (subject: PullRequestChatSubject) => void;
  onRefresh: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const fixFindingLabel = requestedFixFindingLabel ?? gt("Fix in a thread");
  const terminology = sourceControlClients.get(detail.provider).changeRequest;
  const [shown, setShown] = useState({ url: detail.url, count: COMMENT_PAGE });
  const shownConversations = shown.url === detail.url ? shown.count : COMMENT_PAGE;
  const [commentFilter, setCommentFilter] = useLocalStorage(
    COMMENT_FILTER_STORAGE_KEY,
    DEFAULT_COMMENT_FILTER,
    CommentFilterSchema,
  );
  const location = parsePullRequestAnchor(revealUrl);
  const [linked, setLinked] = useState<{ url: string; anchor: string; count: number } | null>(null);
  const [seenRevealUrl, setSeenRevealUrl] = useState<string | undefined>(undefined);
  if (revealUrl !== seenRevealUrl) {
    setSeenRevealUrl(revealUrl);
    if (location?.kind === "timeline") {
      setLinked({ url: detail.url, anchor: location.anchor, count: (linked?.count ?? 0) + 1 });
    }
  }
  const linkedAnchor =
    linked?.url === detail.url
      ? resolvePullRequestReviewAnchor(
          linked.anchor,
          detail.comments,
          pullRequestConversationThreads(detail),
        )
      : null;
  const matchesLink = (url: string | null) =>
    linkedAnchor !== null && pullRequestAnchorMatchesUrl(linkedAnchor, url);
  const itemMatchesLink = (item: PullRequestConversationItem) =>
    pullRequestConversationItemComments(item).some((comment) => matchesLink(comment.url));
  const items = pullRequestConversationItems(
    detail.comments,
    pullRequestConversationThreads(detail),
  );
  const commentCount = items.reduce(
    (count, item) => count + pullRequestConversationItemComments(item).length,
    0,
  );
  // Filter whole conversations before promoting open threads, keeping human replies to bots.
  const filtered = new Set(filterPullRequestConversationItems(items, commentFilter));
  const filteredItems = items.filter((item) => filtered.has(item) || itemMatchesLink(item));
  const filteredOutCount =
    commentCount -
    filteredItems.reduce(
      (count, item) => count + pullRequestConversationItemComments(item).length,
      0,
    );
  const conversation = pullRequestConversationSummary(detail);
  const pinnedIds = new Set(conversation.changeRequests.map((entry) => entry.comment.id));
  // A dismissed root belongs with the collapsed talk even if its thread is unresolved.
  const openThreadIds = new Set(
    filteredItems.flatMap((item) =>
      item.kind === "thread" && !isPullRequestCommentFinished(item.root, item.thread)
        ? [item.id]
        : [],
    ),
  );
  const openThreads = conversation.openThreads.filter((thread) => openThreadIds.has(thread.id));
  const promotedIds = new Set(openThreads.map((thread) => thread.id));
  const talkItems = filteredItems.filter((item) =>
    item.kind === "thread" ? !promotedIds.has(item.id) : !pinnedIds.has(item.id),
  );
  // Open threads lead, but share the same mounting budget as the remaining conversation.
  const pagedOpenThreads = openThreads.slice(0, shownConversations);
  const linkedOpenThread = openThreads.find((thread) =>
    thread.comments.some((comment) => matchesLink(comment.url)),
  );
  const visibleOpenThreads =
    linkedOpenThread && !pagedOpenThreads.includes(linkedOpenThread)
      ? [...pagedOpenThreads, linkedOpenThread]
      : pagedOpenThreads;
  const page = pagePullRequestConversationItems(
    talkItems,
    Math.max(0, shownConversations - pagedOpenThreads.length),
  );
  const linkedTalkItem = talkItems.find(itemMatchesLink);
  const extraLinkedItem =
    linkedTalkItem && !page.shown.includes(linkedTalkItem) ? linkedTalkItem : null;
  const recentItems = extraLinkedItem ? [...page.shown, extraLinkedItem] : page.shown;
  const hiddenTalkCount = page.hidden - (extraLinkedItem ? 1 : 0);
  const hiddenConversationCount = openThreads.length - visibleOpenThreads.length + hiddenTalkCount;
  const [commentOrder, setCommentOrder] = useState<"newest" | "oldest">("newest");
  const visibleItems = orderPullRequestComments(recentItems, commentOrder);
  const showOldestCommentsButton =
    hiddenConversationCount > 0 ? (
      <Button
        size="sm"
        variant="secondary"
        className="w-full"
        onClick={() => setShown({ url: detail.url, count: shownConversations + COMMENT_PAGE })}
      >
        {gt(
          "{count, plural, one {Show {shown} more conversation ({count} hidden)} other {Show {shown} more conversations ({count} hidden)}}",
          {
            count: hiddenConversationCount,
            shown: Math.min(hiddenConversationCount, COMMENT_PAGE),
          },
        )}
      </Button>
    ) : null;
  const replyToThread = useAtomCommand(pullRequestEnvironment.replyToThread, {
    reportFailure: false,
  });
  const setThreadResolution = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  const loadThreadComments = useAtomCommand(pullRequestEnvironment.threadComments, {
    reportFailure: false,
  });
  const [threadPending, setThreadPending] = useState(false);
  const runThreadCommand = async (
    label: string,
    run: () => Promise<{ readonly _tag: string }>,
  ): Promise<boolean> => {
    if (threadPending) return false;
    setThreadPending(true);
    const result = await run();
    setThreadPending(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: label });
      return false;
    }
    onRefresh();
    return true;
  };
  const canReplyToThreads = detail.capabilities.review.reply && detail.viewerPermissions.comment;
  const canResolveThreads = detail.capabilities.review.resolve && detail.viewerPermissions.resolve;

  const update = useAtomCommand(pullRequestEnvironment.update, { reportFailure: false });
  const updateComment = useAtomCommand(pullRequestEnvironment.updateComment, {
    reportFailure: false,
  });
  const canUpdate = useAtomValue(pullRequestEnvironment.update.permissionAtom(environmentId));
  const canEditDescription = canUpdate && canEditPullRequestChangeRequest(detail);
  // The editor keeps the body it opened from, so a failed save cannot reset what was typed.
  const [bodyScope, setBodyScope] = useState<{
    readonly url: string;
    readonly body: string;
  } | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState<DescriptionDraft | null>(null);
  const descriptionDraftKept = descriptionDraftInForce(
    descriptionDraft,
    detail.url,
    detail.observedAt,
  );
  if (descriptionDraftKept !== descriptionDraft) setDescriptionDraft(descriptionDraftKept);
  const description = descriptionDraftKept?.body ?? detail.body;
  const descriptionSaving = (descriptionDraftKept?.saves ?? 0) > 0;
  const descriptionSavesRunning = useRef(0);
  // Hosts can reuse comment ids across pull requests.
  const [commentScope, setCommentScope] = useState<{
    readonly pullRequest: string;
    readonly commentId: string;
  } | null>(null);
  const [commentSaving, setCommentSaving] = useState(false);
  const editingCommentId = commentScope?.pullRequest === detail.url ? commentScope.commentId : null;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [descriptionRoom, setDescriptionRoom] = useState(0);
  const [checksReveals, setChecksReveals] = useState(0);
  const [descriptionReveals, setDescriptionReveals] = useState(0);
  const [seenSectionUrl, setSeenSectionUrl] = useState<string | undefined>(undefined);
  if (revealUrl !== seenSectionUrl) {
    setSeenSectionUrl(revealUrl);
    if (location?.kind === "checks") setChecksReveals((count) => count + 1);
    if (location?.kind === "summary" && location.anchor !== "top") {
      setDescriptionReveals((count) => count + 1);
    }
  }
  const stopHolding = useRef<(() => void) | null>(null);
  const revealSummary = useEffectEvent(() => {
    const root = scrollRef.current;
    if (revealUrl === undefined || !root) return;
    let target: HTMLElement | null | undefined;
    if (location?.kind === "checks") {
      target = root.querySelector<HTMLElement>(
        '[data-pull-request-summary-section="checks"]',
      );
    } else if (location?.kind === "timeline") {
      target = root.querySelector<HTMLElement>("[data-pr-link-target=true]");
    } else if (location?.kind === "summary") {
      if (location.anchor === "top") {
        stopHolding.current?.();
        root.scrollTop = 0;
        return onRevealSettled?.(revealUrl);
      }
      target = /^issue-\d+$/.test(location.anchor)
        ? root.querySelector<HTMLElement>("[data-pr-description]")
        : [...root.querySelectorAll<HTMLElement>("[id]")].find(
            (node) => node.id === location.anchor || node.id === `user-content-${location.anchor}`,
          );
    }
    // A heading may still be rendering; the link stays pending until it appears.
    if (!target) return;
    stopHolding.current?.();
    const heading = target.hasAttribute("data-pull-request-summary-section")
      ? null
      : target.closest("[data-pull-request-summary-section]")?.firstElementChild;
    stopHolding.current = holdLinkedNodeInView(
      target,
      root,
      () => (heading?.getBoundingClientRect().height ?? 0) + (heading ? 8 : 0),
    );
    onRevealSettled?.(revealUrl);
  });
  const editingDescription = bodyScope?.url === detail.url;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls to a linked section, description or heading once it renders
  useEffect(() => {
    revealSummary();
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- retries once the description markdown renders, including after its editor closes
    revealUrl,
    description,
    checksReveals,
    descriptionReveals,
    editingDescription,
    linked,
    detail.comments,
    detail.reviewThreads,
    detail.overviewThreads,
    activityPending,
  ]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the hold observes DOM outside React and must end with the tab
  useEffect(() => () => stopHolding.current?.(), []);
  // Checkbox ticks and the editor share one draft, so each starts from the other's latest body.
  const saveDescription = async (body: string) => {
    const key = detail.url;
    setDescriptionDraft((draft) => startDescriptionSave(draft, detail, body));
    descriptionSavesRunning.current += 1;
    const result = await update({ environmentId, input: { ...reference, body } });
    descriptionSavesRunning.current -= 1;
    const saved = result._tag === "Success";
    setDescriptionDraft((draft) => settleDescriptionSave(draft, key, saved));
    if (!saved) {
      toastManager.add({ type: "error", title: m(msg("Could not save the description")) });
    }
    if (descriptionSavesRunning.current === 0) onRefresh();
    return saved;
  };
  const saveBody = async (body: string) => {
    if (descriptionSaving) return;
    if (await saveDescription(body)) setBodyScope(null);
  };
  const toggleTask = ({ markerOffset, checked }: { markerOffset: number; checked: boolean }) => {
    const body = setMarkdownTaskChecked(description, markerOffset, checked);
    if (body !== description) void saveDescription(body);
  };

  const completionScope = pullRequestCompletionScope(detail, environmentId, reference);
  const commentEditing: CommentEditing = {
    cwd: detail.workspaceRoot,
    environmentId,
    completionScope,
    threadRef,
    canEdit: (comment) => canEditPullRequestComment(detail, comment),
    editingId: editingCommentId,
    saving: commentSaving,
    onEdit: (comment) =>
      setCommentScope(comment === null ? null : { pullRequest: detail.url, commentId: comment.id }),
    onSave: async (comment, body) => {
      if (commentSaving || comment.kind === "review") return;
      setCommentSaving(true);
      const result = await updateComment({
        environmentId,
        input: { ...reference, commentId: comment.id, kind: comment.kind, body },
      });
      setCommentSaving(false);
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: m(msg("Could not save the comment")) });
        return;
      }
      setCommentScope(null);
      onRefresh();
    },
  };

  const reactionBarFor = (comment: PullRequestComment) => (
    <PullRequestReactionBar
      className="justify-start"
      reactions={comment.reactions ?? []}
      canReact={canReactPullRequestComment(detail, comment)}
      subjectId={comment.id}
      environmentId={environmentId}
      reference={reference}
      onRefresh={onRefresh}
    />
  );

  const resolveButtonFor = (thread: PullRequestConversationThread | undefined) =>
    thread === undefined ? null : (
      <PullRequestResolveThreadButton
        environmentId={environmentId}
        reference={reference}
        detail={detail}
        thread={thread}
        onRefresh={onRefresh}
      />
    );

  const renderCommentCard = (
    comment: PullRequestComment,
    thread: PullRequestConversationThread | undefined,
    { reply = false, footer }: { reply?: boolean; footer?: ReactNode } = {},
  ) => {
    const body = visibleBody(comment.body);
    const outcome = pullRequestReviewOutcome(comment.reviewState);
    const finding: PullRequestFinding | null =
      reply ||
      (comment.kind !== "review" && comment.kind !== "review-comment") ||
      outcome === "approved"
        ? null
        : thread === undefined || thread.path === null
          ? body === null
            ? null
            : { kind: "comment", comment }
          : { kind: "thread", thread };
    // A reply goes with its conversation, from the card that heads it.
    const chat = reply ? null : chatSubject(comment, thread);
    return (
      <article
        key={`${detail.url}:${comment.id}`}
        data-pr-link-target={matchesLink(comment.url) || undefined}
        tabIndex={matchesLink(comment.url) ? -1 : undefined}
        className="group data-[pr-link-target=true]:ring-1 data-[pr-link-target=true]:ring-inset data-[pr-link-target=true]:ring-primary/40 rounded-xl surface-panel py-2.5 [contain-intrinsic-block-size:160px] [content-visibility:auto]"
      >
        <div className="flex flex-wrap items-center gap-1.5 px-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2 text-meta text-muted-foreground">
            <CommentIdentity comment={comment} detail={detail} />
            {outcome ? (
              <PullRequestReviewOutcomeBadge outcome={outcome} />
            ) : comment.reviewState ? (
              <span>{reviewStateLabel(comment.reviewState, resolve)}</span>
            ) : null}
          </div>
          {onFixFinding && finding ? (
            <Button
              size="xs"
              variant="ghost"
              className="shrink-0"
              disabled={pendingFinding !== null && pendingFinding !== undefined}
              onClick={() => onFixFinding(finding)}
            >
              <span className="inline-flex items-baseline gap-1">
                <HammerIcon className="size-3 self-center" />
                <span>
                  {pendingFinding === pullRequestFindingKey(finding)
                    ? gt("Preparing...")
                    : fixFindingLabel}
                </span>
              </span>
            </Button>
          ) : null}
          {resolveButtonFor(thread)}
          {onAddToChat && chat !== null ? (
            <AddToChatButton onClick={() => onAddToChat(chat)} />
          ) : null}
        </div>
        {reply ? null : (
          <div className="px-3">
            <CommentLocation comment={comment} thread={thread} />
          </div>
        )}
        {body === null && !commentEditing.canEdit(comment) ? null : (
          <CommentBody
            revealCount={matchesLink(comment.url) ? (linked?.count ?? 0) : 0}
            className="mt-2 px-3"
            comment={comment}
            editing={commentEditing}
          />
        )}
        <div className="mt-2 flex px-3">{reactionBarFor(comment)}</div>
        {footer}
      </article>
    );
  };

  const renderReview = (comment: PullRequestComment, footer?: ReactNode) => {
    const body = visibleBody(comment.body);
    const outcome = pullRequestReviewOutcome(comment.reviewState);
    const finding: PullRequestFinding | null =
      outcome === "approved" || body === null ? null : { kind: "comment", comment };
    const chat = chatSubject(comment, undefined);
    const reactions = comment.reactions ?? [];
    const hasDetail = body !== null || commentEditing.canEdit(comment) || reactions.length > 0;
    const actor = comment.author;
    return (
      <div
        key={`${detail.url}:${comment.id}:${matchesLink(comment.url) ? linked?.count : 0}`}
        data-pr-link-target={matchesLink(comment.url) || undefined}
        tabIndex={matchesLink(comment.url) ? -1 : undefined}
        className="data-[pr-link-target=true]:ring-1 data-[pr-link-target=true]:ring-inset data-[pr-link-target=true]:ring-primary/40"
      >
        <PullRequestReviewEntry
          defaultOpen={matchesLink(comment.url)}
          actor={actor}
          profileUrl={
            actor
              ? sourceControlClients.get(detail.provider).authorProfileUrl(actor.login, detail.url)
              : null
          }
          createdAt={comment.createdAt}
          url={comment.url}
          outcome={outcome}
          stateLabel={
            comment.reviewState
              ? reviewStateLabel(comment.reviewState, resolve).toLowerCase()
              : gt("reviewed", { $context: "review state, lowercase, follows the reviewer's name" })
          }
          preview={body === null ? null : pullRequestBodyPreview(body)}
          action={
            <>
              {onAddToChat && chat !== null ? (
                <AddToChatIconButton onClick={() => onAddToChat(chat)} />
              ) : null}
              {onFixFinding && finding ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={fixFindingLabel}
                        disabled={pendingFinding !== null && pendingFinding !== undefined}
                        onClick={() => onFixFinding(finding)}
                      />
                    }
                  >
                    <HammerIcon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup>
                    {pendingFinding === pullRequestFindingKey(finding)
                      ? gt("Preparing...")
                      : fixFindingLabel}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
            </>
          }
        >
          {hasDetail ? (
            <>
              {body === null && !commentEditing.canEdit(comment) ? null : (
                <CommentBody
                  revealCount={matchesLink(comment.url) ? (linked?.count ?? 0) : 0}
                  comment={comment}
                  editing={commentEditing}
                />
              )}
              <div className="mt-2 flex">{reactionBarFor(comment)}</div>
            </>
          ) : null}
        </PullRequestReviewEntry>
        {footer}
      </div>
    );
  };

  const renderThreadCard = (thread: PullRequestReviewThread) => (
    <ReviewThreadCard
      // Named with the pull request too: a thread id is the host's own.
      key={`${detail.url}:${thread.id}:${thread.comments.some((comment) => matchesLink(comment.url)) ? linked?.count : 0}`}
      standalone
      revealAnchor={linkedAnchor}
      thread={thread}
      workspaceRoot={detail.workspaceRoot}
      completionScope={completionScope}
      canReply={canReplyToThreads}
      canResolve={canResolveThreads && canResolvePullRequestThread(detail, thread)}
      canReact={detail.capabilities.reactions === true}
      environmentId={environmentId}
      reference={reference}
      pending={threadPending}
      fixPending={pendingFinding === pullRequestFindingKey({ kind: "thread", thread })}
      fixLabel={fixFindingLabel}
      {...(onAddToChat ? { onAddToChat: (thread) => onAddToChat({ kind: "thread", thread }) } : {})}
      {...(onFixFinding ? { onFix: () => onFixFinding({ kind: "thread", thread }) } : {})}
      onLoadMore={async (cursor): Promise<PullRequestThreadCommentsResult | null> => {
        const result = await loadThreadComments({
          environmentId,
          input: { ...reference, threadId: thread.id, cursor },
        });
        if (result._tag === "Failure") {
          toastManager.add({ type: "error", title: m(msg("More comments could not be loaded")) });
          return null;
        }
        return result.value;
      }}
      onReply={(body) =>
        runThreadCommand(m(msg("Reply could not be posted")), () =>
          replyToThread({ environmentId, input: { ...reference, threadId: thread.id, body } }),
        )
      }
      canEditComment={(comment) =>
        canEditPullRequestComment(detail, {
          author: comment.author,
          kind: "review-comment",
          canEdit: comment.canEdit,
        })
      }
      onEditComment={(commentId, body) =>
        runThreadCommand(m(msg("The comment could not be saved")), () =>
          updateComment({
            environmentId,
            input: { ...reference, commentId, kind: "review-comment", body },
          }),
        )
      }
      onToggleResolved={() =>
        void runThreadCommand(m(msg("The conversation could not be updated")), () =>
          setThreadResolution({
            environmentId,
            input: { ...reference, threadId: thread.id, resolved: !thread.isResolved },
          }),
        )
      }
      onReacted={onRefresh}
    />
  );

  const changeRequestCount = conversation.changeRequests.length;
  const unresolvedCount = openThreads.length;
  const conversationMeta =
    activityPending || activityError ? null : (
      <span className="flex flex-col items-end gap-0.5">
        {[
          changeRequestCount > 0
            ? gt(
                "{count, plural, one {{count} change request} other {{count} change requests}}",
                { count: changeRequestCount, $context: "reviews that requested changes" },
              )
            : null,
          unresolvedCount > 0
            ? gt("{count, plural, one {{count} unresolved} other {{count} unresolved}}", {
                count: unresolvedCount,
                $context: "review threads",
              })
            : null,
        ]
          .filter(Boolean)
          .map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
      </span>
    );

  const renderItem = (item: PullRequestConversationItem) => {
    const comment = item.kind === "comment" ? item.comment : item.root;
    const thread = item.kind === "thread" ? item.thread : undefined;
    const replies =
      item.kind === "thread" && item.replies.length > 0 ? (
        <div className="ml-4 space-y-2 border-l-2 border-border/60 pl-3">
          {item.replies.map((reply) => renderCommentCard(reply, undefined, { reply: true }))}
        </div>
      ) : null;
    const moreReplies =
      item.kind === "thread" && item.hasMoreReplies ? <PullRequestMoreReplies {...item} /> : null;
    if (item.kind === "thread" && isPullRequestCommentFinished(comment, thread)) {
      const chat = chatSubject(comment, item.thread);
      return (
        <PullRequestResolvedThreadRow
          key={`${detail.url}:thread:${item.id}:${itemMatchesLink(item) ? linked?.count : 0}`}
          defaultOpen={itemMatchesLink(item)}
          path={item.thread.path}
          line={item.thread.line}
          outdated={item.thread.isOutdated}
          dismissed={!item.thread.isResolved}
          commentCount={item.thread.commentCount ?? item.replies.length + 1 + item.moreReplies}
          action={
            onAddToChat && chat !== null ? (
              <AddToChatIconButton onClick={() => onAddToChat(chat)} />
            ) : null
          }
        >
          {item.thread.path === null ? (
            <div className="space-y-2">
              {renderCommentCard(comment, item.thread)}
              {replies}
              {moreReplies}
            </div>
          ) : (
            renderThreadCard(item.thread)
          )}
        </PullRequestResolvedThreadRow>
      );
    }
    if (item.kind === "comment") {
      return comment.kind === "review"
        ? renderReview(comment)
        : renderCommentCard(comment, undefined);
    }
    return (
      <div key={`${detail.url}:thread:${item.id}`} className="space-y-2">
        {renderCommentCard(comment, thread)}
        {replies}
        {moreReplies}
      </div>
    );
  };

  const attachments = pullRequestAttachments(detail.body);

  return (
    <div
      ref={(node) => {
        scrollRef.current = node;
        scrollerRef?.(node);
      }}
      className="h-full overflow-y-auto"
      data-pull-request-summary-scroll
    >
      <div
        ref={(content) => {
          const scroller = content?.parentElement;
          if (!content || !scroller) return;
          // A collapsed description fills what the rest of the tab leaves empty in the scroller.
          return observeResize([scroller, content], () => {
            const clip = content.querySelector<HTMLElement>(
              "[data-pr-description] [data-comment-clip]",
            );
            setDescriptionRoom(
              clip
                ? Math.floor(
                    scroller.clientHeight -
                      content.getBoundingClientRect().height +
                      clip.getBoundingClientRect().height,
                  )
                : 0,
            );
          });
        }}
      >
        {readiness ? <section className="px-4 pt-0.75 pb-1">{readiness}</section> : null}

        <PullRequestSection
          key={`description:${detail.url}`}
          title={gt("Description")}
          keepMounted
          revealCount={descriptionReveals}
        >
          <div className="group">
            {editingDescription ? (
              <PullRequestMarkdownEditor
                allowEmpty
                value={bodyScope.body}
                cwd={detail.workspaceRoot}
                environmentId={environmentId}
                completionScope={completionScope}
                threadRef={threadRef}
                label={gt(
                  "{term, select, mr {Merge request} cr {Change request} other {Pull request}} description",
                  { term: changeRequestTermKind(terminology) },
                )}
                placeholder={gt(
                  "Describe this {term, select, mr {merge request} cr {change request} other {pull request}}",
                  { term: changeRequestTermKind(terminology) },
                )}
                saving={descriptionSaving}
                onSave={(body) => void saveBody(body)}
                onCancel={() => setBodyScope(null)}
              />
            ) : (
              <div className="flex items-start gap-1" data-pr-description>
                <PullRequestCommentBody
                  key={detail.url}
                  variant="description"
                  collapsedHeight={descriptionRoom}
                  revealCount={descriptionReveals}
                  className="min-w-0 flex-1"
                  text={
                    description.trim().length > 0 ? description : gt("_No description provided._")
                  }
                  cwd={detail.workspaceRoot}
                  environmentId={environmentId}
                  threadRef={threadRef}
                  onTaskListChange={canEditDescription ? toggleTask : undefined}
                />
                {canEditDescription ? (
                  <PullRequestEditButton
                    aria-label={gt("Edit description")}
                    onClick={() => setBodyScope({ url: detail.url, body: description })}
                  />
                ) : null}
              </div>
            )}
          </div>
          {/* Labels ride under the description, where the pull request says what it is about. The
            row is shown empty only where a label could be put on it from here. */}
          {detail.labels.length > 0 || detail.capabilities.labels === true ? (
            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1 text-meta">
              <TagIcon aria-hidden className="mr-0.5 size-3.5 text-muted-foreground" />
              {detail.labels.map((label) => (
                <PullRequestLabelChip
                  key={label.name}
                  label={label}
                  size="default"
                  className="max-w-48"
                  focusable
                />
              ))}
              {detail.capabilities.labels === true ? (
                <PullRequestLabelPicker
                  environmentId={environmentId}
                  reference={reference}
                  allowed={detail.viewerPermissions.labels !== false}
                />
              ) : null}
            </div>
          ) : null}
        </PullRequestSection>

        {attachments.length > 0 ? (
          <PullRequestSection
            key={`attachments:${detail.url}`}
            title={gt("Attachments")}
            count={attachments.length}
          >
            <ScrollArea
              chainVerticalScroll
              className="-mx-4 h-auto w-auto"
              radius="none"
              viewportTabIndex={0}
            >
              <div className="flex w-max min-w-full gap-3 px-4 pb-2" data-image-gallery>
                {attachments.map((attachment) => (
                  <figure key={attachment.url} className="w-44 shrink-0">
                    <div className="h-28 overflow-hidden rounded-xl border border-border/60 [&_img]:h-28 [&_img]:w-44 [&_img]:object-cover [&_video]:h-28 [&_video]:object-cover">
                      <PullRequestMarkdown
                        gallery={false}
                        text={
                          attachment.media === "image" ? `![](<${attachment.url}>)` : attachment.url
                        }
                        cwd={detail.workspaceRoot}
                        environmentId={environmentId}
                        threadRef={threadRef}
                      />
                    </div>
                    <figcaption className="mt-2 truncate text-meta text-muted-foreground">
                      {attachment.caption}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </ScrollArea>
          </PullRequestSection>
        ) : null}

        <PullRequestSection
          key={`conversation:${detail.url}`}
          title={gt("Conversation")}
          revealCount={linked?.url === detail.url ? linked.count : 0}
          count={
            activityPending || activityError
              ? undefined
              : Math.max(detail.commentCount, commentCount)
          }
          meta={conversationMeta}
          actions={
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Menu>
                <MenuTrigger
                  render={<Button size="xs" variant="ghost-muted" />}
                  aria-label={gt("Filter comments")}
                >
                  <ListFilterIcon aria-hidden className="size-3" />
                  {filteredOutCount > 0
                    ? gt("{count, plural, one {{count} hidden} other {{count} hidden}}", {
                        count: filteredOutCount,
                      })
                    : gt("Filter", { $context: "noun, filter menu" })}
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuGroup>
                    <MenuGroupLabel>
                      <T context="which comments to show">Show</T>
                    </MenuGroupLabel>
                    <MenuCheckboxItem
                      checked={commentFilter.bots}
                      closeOnClick={false}
                      onCheckedChange={(bots) => setCommentFilter((value) => ({ ...value, bots }))}
                    >
                      <T>Bot comments</T>
                    </MenuCheckboxItem>
                    <MenuCheckboxItem
                      checked={commentFilter.resolved}
                      closeOnClick={false}
                      onCheckedChange={(resolved) =>
                        setCommentFilter((value) => ({ ...value, resolved }))
                      }
                    >
                      <T>Resolved or dismissed</T>
                    </MenuCheckboxItem>
                  </MenuGroup>
                </MenuPopup>
              </Menu>
              <Button
                size="xs"
                variant="ghost-muted"
                aria-label={
                  commentOrder === "newest"
                    ? gt("Show oldest comments first")
                    : gt("Show newest comments first")
                }
                onClick={() =>
                  setCommentOrder((value) => (value === "newest" ? "oldest" : "newest"))
                }
              >
                <ArrowDownUpIcon aria-hidden className="size-3" />
                {commentOrder === "newest" ? gt("Newest first") : gt("Oldest first")}
              </Button>
            </div>
          }
        >
          {linkedAnchor !== null && revealUrl === undefined && !items.some(itemMatchesLink) ? (
            <p role="status" className="py-4 text-meta text-muted-foreground">
              <T>The linked item is not in the loaded activity.</T>
            </p>
          ) : null}
          {activityPending ? (
            <PullRequestConversationGhost terminology={terminology} />
          ) : activityError ? (
            <PullRequestActivityUnavailableState
              compact
              error={activityError}
              term={changeRequestTermKind(terminology)}
              onRetry={onRefresh}
            />
          ) : (
            <>
              {detail.commentsTruncated ? (
                <p className="mb-2 rounded-md border border-warning/30 bg-warning-surface px-2 py-1.5 text-meta">
                  {gt(
                    "{count, plural, one {This conversation is only partially loaded. {count} comment is loaded; open it on the host to read the rest.} other {This conversation is only partially loaded. {count} comments are loaded; open it on the host to read the rest.}}",
                    { count: commentCount },
                  )}
                </p>
              ) : null}
              {items.length === 0 ? (
                <p className="py-2 text-meta text-muted-foreground">
                  <T>No comments yet.</T>
                </p>
              ) : (
                <div className="space-y-3">
                  {conversation.changeRequests.map((entry) => (
                    <div key={`pinned:${entry.comment.id}`}>
                      {renderReview(
                        entry.comment,
                        entry.openThreadCount > 0 || entry.reRequestedAt ? (
                          <div className="flex items-center gap-2 px-3 pt-0.5 text-meta text-muted-foreground">
                            {entry.openThreadCount > 0 ? (
                              <span className="inline-flex items-center gap-1.5">
                                <CornerDownRightIcon aria-hidden className="size-3.5" />
                                {gt(
                                  "{count, plural, one {{count} thread below} other {{count} threads below}}",
                                  { count: entry.openThreadCount },
                                )}
                              </span>
                            ) : null}
                            {entry.reRequestedAt ? (
                              <span className="ml-auto inline-flex items-center gap-1.5">
                                <RefreshCwIcon aria-hidden className="size-3" />
                                <T context="followed by a relative time such as 5m ago">
                                  Re-requested{" "}
                                  <Var>
                                    <RelativeTime timestamp={entry.reRequestedAt} />
                                  </Var>
                                </T>
                              </span>
                            ) : null}
                          </div>
                        ) : null,
                      )}
                    </div>
                  ))}
                  {visibleOpenThreads.map(renderThreadCard)}
                  {filteredItems.length === 0 && filteredOutCount > 0 ? (
                    <p className="py-2 text-meta text-muted-foreground">
                      {filteredOutCount === 1
                        ? gt("The only comment is hidden by the filter.")
                        : gt(
                            "{count, plural, one {All {count} comments are hidden by the filter.} other {All {count} comments are hidden by the filter.}}",
                            { count: filteredOutCount },
                          )}
                    </p>
                  ) : null}
                  {commentOrder === "oldest" ? showOldestCommentsButton : null}
                  {visibleItems.map(renderItem)}
                  {commentOrder === "newest" ? showOldestCommentsButton : null}
                  {shownConversations > COMMENT_PAGE ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-full"
                      onClick={() => setShown({ url: detail.url, count: COMMENT_PAGE })}
                    >
                      <T>
                        Show only <Var>{COMMENT_PAGE}</Var> recent conversations
                      </T>
                    </Button>
                  ) : null}
                </div>
              )}
            </>
          )}
        </PullRequestSection>
      </div>
    </div>
  );
}
