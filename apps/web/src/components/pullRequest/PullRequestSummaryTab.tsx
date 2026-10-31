import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import { useAtomCommand } from "~/state/use-atom-command";
import type {
  EnvironmentId,
  PullRequestComment,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestReviewThread,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowDownUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  HammerIcon,
  ListFilterIcon,
  TagIcon,
  UsersIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useRef, useState, type ReactNode } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useOpenLink } from "~/browser/useOpenLink";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PullRequestActorLabel,
  PullRequestCheckStatusIcon,
  pullRequestCheckStatusLabel,
  PullRequestLabelChip,
  PullRequestReviewOutcomeBadge,
  pullRequestReviewOutcomeLabel,
  PullRequestReviewOutcomeAvatarBadge,
  pullRequestReviewOutcomeRingClassName,
  pullRequestReviewOutcomeStaleLabel,
} from "./pullRequestPresentation";
import { PullRequestLabelPicker } from "./PullRequestLabelPicker";
import { PullRequestReviewerPicker } from "./PullRequestReviewerPicker";
import { PullRequestActivityUnavailableState } from "./PullRequestActivityUnavailableState";
import {
  filterPullRequestConversationItems,
  isPullRequestCommentFinished,
  latestPullRequestReviewOutcomes,
  orderPullRequestComments,
  pagePullRequestConversationItems,
  pullRequestConversationItemComments,
  pullRequestConversationItems,
  pullRequestFindingKey,
  pullRequestReviewOutcome,
  visibleBody,
  type PullRequestConversationItem,
  type PullRequestFinding,
} from "./pullRequestDetail.logic";
import {
  canEditPullRequestChangeRequest,
  canEditPullRequestComment,
} from "@t3tools/client-runtime/pull-request-editing";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestCommentBody } from "./PullRequestCommentBody";
import { PullRequestMoreReplies } from "./PullRequestMoreReplies";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestReactionBar } from "./PullRequestReactions";
import { PullRequestConversationGhost } from "./PullRequestGhosts";
import { sectionCollapseAnchorScrollTop } from "./pullRequestSummaryScroll.logic";

function reviewerKey(login: string): string {
  return login.toLowerCase();
}

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
    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
      <PullRequestActorLabel actor={actor} profileUrl={profileUrl} className="max-w-full" />
      <Tooltip>
        <TooltipTrigger
          render={
            comment.url ? (
              <a
                href={comment.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground hover:underline"
              />
            ) : (
              <span className="text-muted-foreground" />
            )
          }
        >
          <time dateTime={comment.createdAt}>
            <RelativeTime timestamp={comment.createdAt} />
          </time>
        </TooltipTrigger>
        <TooltipPopup>
          {new Date(comment.createdAt).toLocaleString()}
          {comment.url ? " · Open comment on host" : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function CommentLocation({
  comment,
  thread,
}: {
  comment: PullRequestComment;
  thread: PullRequestReviewThread | undefined;
}) {
  const path = thread?.path ?? comment.path;
  if (!path) return null;
  const label = `${path}${thread?.line ? `:${thread.line}` : ""}`;
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <Tooltip>
        <TooltipTrigger render={<span className="truncate font-mono" />}>{label}</TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      {thread?.isOutdated ? <span className="shrink-0">Outdated</span> : null}
    </div>
  );
}

function reviewStateLabel(state: string): string {
  const words = state.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface CommentEditing {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
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
}: {
  comment: PullRequestComment;
  editing: CommentEditing;
  className?: string | undefined;
}) {
  if (editing.editingId === comment.id) {
    return (
      <PullRequestMarkdownEditor
        className={className}
        value={comment.body}
        cwd={editing.cwd}
        environmentId={editing.environmentId}
        threadRef={editing.threadRef}
        label="Edit comment"
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
        className="min-w-0 flex-1"
        text={comment.body}
        cwd={editing.cwd}
        environmentId={editing.environmentId}
        threadRef={editing.threadRef}
      />
      {editing.canEdit(comment) ? (
        <PullRequestEditButton aria-label="Edit comment" onClick={() => editing.onEdit(comment)} />
      ) : null}
    </div>
  );
}

function CollapsedComment({
  comment,
  editing,
  label,
  body,
  reactionBar,
  detail,
  thread,
  replyCount = 0,
  replies = null,
  moreReplies = null,
}: {
  comment: PullRequestComment;
  editing: CommentEditing;
  label: string;
  body: string | null;
  reactionBar: ReactNode;
  detail: PullRequestDetailView;
  thread: PullRequestReviewThread | undefined;
  replyCount?: number;
  replies?: ReactNode;
  moreReplies?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const statusTriggerRef = useRef<HTMLButtonElement>(null);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <article className="group rounded-lg border border-border/60 [contain-intrinsic-block-size:44px] [content-visibility:auto]">
        <div className="p-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <CommentIdentity comment={comment} detail={detail} />
            {replyCount > 0 ? (
              <span className="shrink-0 py-1 text-xs text-muted-foreground">
                {replyCount} {replyCount === 1 ? "reply" : "replies"}
              </span>
            ) : null}
            <CollapsibleTrigger
              ref={statusTriggerRef}
              className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {label}
              <ChevronDownIcon
                aria-hidden
                className={cn("size-3.5 transition-transform", open && "rotate-180")}
              />
            </CollapsibleTrigger>
            {reactionBar}
          </div>
          <CommentLocation comment={comment} thread={thread} />
          {!open && body ? (
            <CollapsibleTrigger
              className="mt-2 block w-full truncate text-left text-xs text-muted-foreground hover:text-foreground"
              onClick={() => statusTriggerRef.current?.focus({ preventScroll: true })}
            >
              {body
                .replace(/<!--[\s\S]*?-->/gu, "")
                .replace(/^\s*>?\s*\[!\w+\]\s*$/gmu, "")
                .replace(/!?(\[([^\]]+)\])\([^)]*\)/gu, "$2")
                .replace(/^[\s>#*-]+/gmu, "")
                .replace(/[*`]/gu, "")
                .replace(/\s+/g, " ")
                .trim()}
            </CollapsibleTrigger>
          ) : null}
        </div>
        <CollapsiblePanel>
          {open ? (
            <div className="px-3 pb-3">
              {body === null && !editing.canEdit(comment) ? null : (
                <CommentBody className="mt-2" comment={comment} editing={editing} />
              )}
              {replies ? <div className="mt-3">{replies}</div> : null}
            </div>
          ) : null}
        </CollapsiblePanel>
        {moreReplies ? <div className="px-3 pb-3">{moreReplies}</div> : null}
      </article>
    </Collapsible>
  );
}

function MetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-7 min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 text-xs sm:min-h-6">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}

function Section({
  title,
  defaultOpen = true,
  keepMounted = false,
  actions,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  keepMounted?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
      open={open}
      onOpenChange={setOpenWithScrollAnchor}
      render={<section aria-label={title} />}
      data-pull-request-summary-section
    >
      <div
        ref={headingRef}
        className="sticky top-0 z-10 flex w-full items-center bg-background pr-4"
      >
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
          <span>{title}</span>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
        {actions}
      </div>
      <CollapsiblePanel keepMounted={keepMounted}>
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
  scrollerRef,
  environmentId,
  threadRef,
  reference,
  detail,
  activityPending,
  checksStale = false,
  activityError,
  pendingFinding,
  fixFindingLabel = "Fix in a thread",
  fixCheckLabel = "Fix",
  onFixFinding,
  onRefresh,
  onRefreshChecks = onRefresh,
}: {
  scrollerRef: (node: HTMLDivElement | null) => void;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  activityPending: boolean;
  checksStale?: boolean;
  activityError: string | null;
  pendingFinding?: string | null;
  fixFindingLabel?: string;
  fixCheckLabel?: string;
  onFixFinding?: (finding: PullRequestFinding) => void;
  onRefresh: () => void;
  onRefreshChecks?: () => void;
}) {
  const terminology = sourceControlClients.get(detail.provider).changeRequest;
  const [shown, setShown] = useState({ url: detail.url, count: COMMENT_PAGE });
  const shownConversations = shown.url === detail.url ? shown.count : COMMENT_PAGE;
  const [commentFilter, setCommentFilter] = useLocalStorage(
    COMMENT_FILTER_STORAGE_KEY,
    DEFAULT_COMMENT_FILTER,
    CommentFilterSchema,
  );
  const items = pullRequestConversationItems(detail.comments, detail.reviewThreads);
  const filteredItems = filterPullRequestConversationItems(items, commentFilter);
  const commentCount = items.reduce(
    (count, item) => count + pullRequestConversationItemComments(item).length,
    0,
  );
  const filteredOutCount =
    commentCount -
    filteredItems.reduce(
      (count, item) => count + pullRequestConversationItemComments(item).length,
      0,
    );
  const { shown: recentItems, hidden: hiddenConversationCount } = pagePullRequestConversationItems(
    filteredItems,
    shownConversations,
  );
  const [commentOrder, setCommentOrder] = useState<"newest" | "oldest">("newest");
  const visibleItems = orderPullRequestComments(recentItems, commentOrder);
  const showOldestCommentsButton =
    hiddenConversationCount > 0 ? (
      <Button
        size="sm"
        variant="outline"
        className="w-full"
        onClick={() => setShown({ url: detail.url, count: shownConversations + COMMENT_PAGE })}
      >
        Show {Math.min(hiddenConversationCount, COMMENT_PAGE)} older conversation
        {hiddenConversationCount === 1 ? "" : "s"} ({hiddenConversationCount} hidden)
      </Button>
    ) : null;
  // Verdicts outside the visible comment window still count.
  const reviewOutcomes = latestPullRequestReviewOutcomes(detail.comments, detail.commits);
  // Host login casing varies; normalize to preserve verdicts and deduplicate reviewers.
  const outcomeByLogin = new Map(
    reviewOutcomes.flatMap((entry) =>
      entry.actor ? [[reviewerKey(entry.actor.login), entry] as const] : [],
    ),
  );
  // Hosts remove reviewed actors from requests; include submitted verdicts.
  const reviewerEntries = [
    ...detail.reviewers.map((actor) => ({
      key: actor.login,
      actor,
      outcome: outcomeByLogin.get(reviewerKey(actor.login))?.outcome ?? null,
      stale: outcomeByLogin.get(reviewerKey(actor.login))?.stale ?? false,
    })),
    ...reviewOutcomes
      .filter(
        (entry) =>
          !detail.reviewers.some(
            (actor) =>
              entry.actor !== null && reviewerKey(actor.login) === reviewerKey(entry.actor.login),
          ),
      )
      .map((entry) => ({
        key: entry.key,
        actor: entry.actor,
        outcome: entry.outcome,
        stale: entry.stale,
      })),
  ];

  const openLink = useOpenLink(threadRef);
  const openCheck = (url: string) => {
    void openLink(url).catch((error: unknown) => {
      console.error(error);
      toastManager.add({ type: "error", title: "Unable to open check details" });
    });
  };

  const update = useAtomCommand(pullRequestEnvironment.update, { reportFailure: false });
  const updateComment = useAtomCommand(pullRequestEnvironment.updateComment, {
    reportFailure: false,
  });
  const [bodyScope, setBodyScope] = useState<string | null>(null);
  const [bodySaving, setBodySaving] = useState(false);
  // Hosts can reuse comment ids across pull requests.
  const [commentScope, setCommentScope] = useState<{
    readonly pullRequest: string;
    readonly commentId: string;
  } | null>(null);
  const [commentSaving, setCommentSaving] = useState(false);
  const editingCommentId = commentScope?.pullRequest === detail.url ? commentScope.commentId : null;

  const saveBody = async (body: string) => {
    if (bodySaving) return;
    setBodySaving(true);
    const result = await update({ environmentId, input: { ...reference, body } });
    setBodySaving(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not save the description" });
      return;
    }
    setBodyScope(null);
    onRefresh();
  };

  const commentEditing: CommentEditing = {
    cwd: detail.workspaceRoot,
    environmentId,
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
        toastManager.add({ type: "error", title: "Could not save the comment" });
        return;
      }
      setCommentScope(null);
      onRefresh();
    },
  };

  const reactionBarFor = (comment: PullRequestComment) => (
    <PullRequestReactionBar
      className="ml-auto justify-end"
      reactions={comment.reactions ?? []}
      canReact={detail.capabilities.reactions === true}
      subjectId={comment.id}
      environmentId={environmentId}
      reference={reference}
      onRefresh={onRefresh}
    />
  );

  const renderCommentCard = (
    comment: PullRequestComment,
    thread: PullRequestReviewThread | undefined,
    { reply = false }: { reply?: boolean } = {},
  ) => {
    const body = visibleBody(comment.body);
    const outcome = pullRequestReviewOutcome(comment.reviewState);
    const finding: PullRequestFinding | null =
      reply ||
      (comment.kind !== "review" && comment.kind !== "review-comment") ||
      outcome === "approved"
        ? null
        : thread === undefined
          ? body === null
            ? null
            : { kind: "comment", comment }
          : { kind: "thread", thread };
    return (
      <article
        key={`${detail.url}:${comment.id}`}
        className="group rounded-lg border border-border/60 bg-background [contain-intrinsic-block-size:160px] [content-visibility:auto]"
      >
        <div className="flex flex-wrap items-baseline gap-2 rounded-t-lg bg-muted/25 px-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
            <CommentIdentity comment={comment} detail={detail} />
            {outcome ? (
              <PullRequestReviewOutcomeBadge outcome={outcome} />
            ) : comment.reviewState ? (
              <span>{reviewStateLabel(comment.reviewState)}</span>
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
                    ? "Preparing..."
                    : fixFindingLabel}
                </span>
              </span>
            </Button>
          ) : null}
          {reactionBarFor(comment)}
        </div>
        {reply ? null : (
          <div className="px-3">
            <CommentLocation comment={comment} thread={thread} />
          </div>
        )}
        {body === null && !commentEditing.canEdit(comment) ? null : (
          <CommentBody className="px-3 py-3" comment={comment} editing={commentEditing} />
        )}
      </article>
    );
  };

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
    if (isPullRequestCommentFinished(comment, thread)) {
      return (
        <CollapsedComment
          key={`${detail.url}:${item.kind}:${item.id}`}
          comment={comment}
          editing={commentEditing}
          detail={detail}
          thread={thread}
          label={thread?.isResolved ? "Resolved" : "Review dismissed"}
          body={visibleBody(comment.body)}
          replyCount={item.kind === "thread" ? item.replies.length + item.moreReplies : 0}
          replies={replies}
          moreReplies={moreReplies}
          reactionBar={reactionBarFor(comment)}
        />
      );
    }
    if (item.kind === "comment") return renderCommentCard(comment, undefined);
    return (
      <div key={`${detail.url}:thread:${item.id}`} className="space-y-2">
        {renderCommentCard(comment, thread)}
        {replies}
        {moreReplies}
      </div>
    );
  };

  return (
    <div ref={scrollerRef} className="h-full overflow-y-auto" data-pull-request-summary-scroll>
      <section className="px-4 pt-2.5 pb-1">
        <div className="space-y-2">
          <MetaRow icon={<UsersIcon className="size-3.5" />} label="Reviewers">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {reviewerEntries.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <span className="flex items-center -space-x-1">
                  {reviewerEntries.map((entry) => {
                    const login = entry.actor?.login ?? "ghost";
                    const named =
                      entry.actor?.name && entry.actor.name !== login
                        ? `${entry.actor.name} (@${login})`
                        : login;
                    return (
                      <Tooltip key={entry.key}>
                        <TooltipTrigger
                          render={
                            <span
                              className={cn(
                                "relative rounded-full hover:z-10",
                                entry.outcome
                                  ? pullRequestReviewOutcomeRingClassName(
                                      entry.outcome,
                                      entry.stale,
                                    )
                                  : undefined,
                              )}
                            />
                          }
                        >
                          <PullRequestActorLabel
                            actor={entry.actor}
                            tooltip={false}
                            variant="avatar"
                          />
                          {entry.outcome ? (
                            <>
                              <PullRequestReviewOutcomeAvatarBadge
                                outcome={entry.outcome}
                                stale={entry.stale}
                              />
                              <span className="sr-only">
                                {entry.stale
                                  ? pullRequestReviewOutcomeStaleLabel(entry.outcome)
                                  : pullRequestReviewOutcomeLabel(entry.outcome)}
                              </span>
                            </>
                          ) : null}
                        </TooltipTrigger>
                        <TooltipPopup side="bottom">
                          {entry.outcome
                            ? `${named}: ${
                                entry.stale
                                  ? pullRequestReviewOutcomeStaleLabel(entry.outcome)
                                  : pullRequestReviewOutcomeLabel(entry.outcome)
                              }`
                            : named}
                        </TooltipPopup>
                      </Tooltip>
                    );
                  })}
                </span>
              )}
              {/* Azure DevOps accepts reviewers but cannot list candidates. */}
              {detail.capabilities.reviewers.request &&
              detail.capabilities.reviewers.listCandidates ? (
                <PullRequestReviewerPicker
                  environmentId={environmentId}
                  reference={reference}
                  allowed={detail.viewerPermissions.requestReviewers}
                />
              ) : null}
            </span>
          </MetaRow>
          {detail.labels.length > 0 || detail.capabilities.labels === true ? (
            <MetaRow icon={<TagIcon className="size-3.5" />} label="Labels">
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                {detail.labels.length === 0 ? (
                  <span className="text-muted-foreground">None</span>
                ) : (
                  detail.labels.map((label) => (
                    <PullRequestLabelChip
                      key={label.name}
                      label={label}
                      size="default"
                      className="max-w-48"
                    />
                  ))
                )}
                {detail.capabilities.labels === true ? (
                  <PullRequestLabelPicker
                    environmentId={environmentId}
                    reference={reference}
                    allowed={detail.viewerPermissions.labels !== false}
                  />
                ) : null}
              </span>
            </MetaRow>
          ) : null}
        </div>
      </section>

      <Section key={`description:${detail.url}`} title="Description" keepMounted>
        <div className="group">
          {bodyScope === detail.url ? (
            <PullRequestMarkdownEditor
              allowEmpty
              value={detail.body}
              cwd={detail.workspaceRoot}
              environmentId={environmentId}
              threadRef={threadRef}
              label={`${capitalizeTerm(terminology.singular)} description`}
              placeholder={`Describe this ${terminology.singular}`}
              saving={bodySaving}
              onSave={(body) => void saveBody(body)}
              onCancel={() => setBodyScope(null)}
            />
          ) : (
            <div className="flex items-start gap-1">
              <PullRequestMarkdown
                className="min-w-0 flex-1"
                text={detail.body.trim().length > 0 ? detail.body : "_No description provided._"}
                cwd={detail.workspaceRoot}
                environmentId={environmentId}
                threadRef={threadRef}
              />
              {canEditPullRequestChangeRequest(detail) ? (
                <PullRequestEditButton
                  aria-label="Edit description"
                  onClick={() => setBodyScope(detail.url)}
                />
              ) : null}
            </div>
          )}
        </div>
      </Section>

      <Section key={`checks:${detail.url}`} title="Checks" defaultOpen={false}>
        {checksStale ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Check details are out of date.</span>
            <Button size="xs" variant="ghost" onClick={onRefreshChecks}>
              Refresh
            </Button>
          </div>
        ) : detail.checks.length === 0 ? (
          <p className="text-xs text-muted-foreground">No checks reported.</p>
        ) : (
          detail.checks.map(
            (
              check,
              index,
            ) => /* oxlint-disable react/no-array-index-key -- Check names and URLs can repeat; these status rows have no local state. */ {
                const finding = { kind: "check", check } as const;
                const failing = check.status === "failure" || check.status === "cancelled";
                return (
                  <div
                    key={`${index}:${check.name}:${check.url ?? ""}`}
                    className="group flex items-center gap-2 rounded-md pr-1 hover:bg-accent/60"
                  >
                    <button
                      type="button"
                      disabled={!check.url}
                      onClick={() => check.url && openCheck(check.url)}
                      className={cn(
                        "flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left text-xs leading-5 [&>svg]:mt-0.5",
                        check.url ? "cursor-pointer" : "cursor-default",
                      )}
                    >
                      <PullRequestCheckStatusIcon status={check.status} />
                      <span className="min-w-0 flex-1 wrap-anywhere">{check.name}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {pullRequestCheckStatusLabel(check)}
                      </span>
                    </button>
                    {onFixFinding && failing ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        className="shrink-0"
                        disabled={pendingFinding !== null && pendingFinding !== undefined}
                        onClick={() => onFixFinding(finding)}
                      >
                        <HammerIcon className="size-3" />
                        {pendingFinding === pullRequestFindingKey(finding)
                          ? "Preparing..."
                          : fixCheckLabel}
                      </Button>
                    ) : null}
                  </div>
                );
              } /* oxlint-enable react/no-array-index-key */,
          )
        )}
      </Section>

      <Section
        title={`Comments (${detail.commentCount})`}
        actions={
          <div className="flex shrink-0 items-center gap-1">
            <Menu>
              <MenuTrigger
                render={<Button size="xs" variant="ghost-muted" />}
                aria-label="Filter comments"
              >
                <ListFilterIcon aria-hidden className="size-3" />
                {filteredOutCount > 0 ? `${filteredOutCount} hidden` : "Filter"}
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuGroup>
                  <MenuGroupLabel>Show</MenuGroupLabel>
                  <MenuCheckboxItem
                    checked={commentFilter.bots}
                    closeOnClick={false}
                    onCheckedChange={(bots) => setCommentFilter((value) => ({ ...value, bots }))}
                  >
                    Bot comments
                  </MenuCheckboxItem>
                  <MenuCheckboxItem
                    checked={commentFilter.resolved}
                    closeOnClick={false}
                    onCheckedChange={(resolved) =>
                      setCommentFilter((value) => ({ ...value, resolved }))
                    }
                  >
                    Resolved or dismissed
                  </MenuCheckboxItem>
                </MenuGroup>
              </MenuPopup>
            </Menu>
            <Button
              size="xs"
              variant="ghost-muted"
              aria-label={
                commentOrder === "newest"
                  ? "Show oldest comments first"
                  : "Show newest comments first"
              }
              onClick={() => setCommentOrder((value) => (value === "newest" ? "oldest" : "newest"))}
            >
              <ArrowDownUpIcon aria-hidden className="size-3" />
              {commentOrder === "newest" ? "Newest first" : "Oldest first"}
            </Button>
          </div>
        }
      >
        {activityPending ? (
          <PullRequestConversationGhost terminology={terminology} />
        ) : activityError ? (
          <PullRequestActivityUnavailableState
            compact
            error={activityError}
            term={terminology.singular}
            onRetry={onRefresh}
          />
        ) : (
          <>
            {detail.commentsTruncated ? (
              <p className="mb-2 rounded-md border border-warning/30 bg-warning-surface px-2 py-1.5 text-xs">
                This conversation is only partially loaded. {commentCount} comment
                {commentCount === 1 ? " is" : "s are"} loaded; open it on the host to read the rest.
              </p>
            ) : null}
            {items.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">No comments yet.</p>
            ) : filteredItems.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">
                {filteredOutCount === 1
                  ? "The only comment is hidden by the filter."
                  : `All ${filteredOutCount} comments are hidden by the filter.`}
              </p>
            ) : (
              <div className="space-y-3">
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
                    Show only {COMMENT_PAGE} recent conversations
                  </Button>
                ) : null}
              </div>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
