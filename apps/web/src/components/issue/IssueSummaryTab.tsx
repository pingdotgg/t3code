import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  IssueDetailView,
  IssueLinkedPullRequest,
  IssueRef,
  WorkItemMatch,
} from "@t3tools/contracts";
import {
  ArrowDownUpIcon,
  MessageSquareIcon,
  MilestoneIcon,
  PencilIcon,
  TagIcon,
  UsersIcon,
} from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { PullRequestMarkdownEditor as SourceControlMarkdownEditor } from "../pullRequest/PullRequestMarkdownEditor";
import {
  SourceControlActorLabel,
  SourceControlActorAvatar,
} from "../sourceControl/actorPresentation";
import { CommentComposer } from "../sourceControl/CommentComposer";
import { HostMarkdown } from "../sourceControl/HostMarkdown";
import { SummaryMetaRow, SummarySection } from "../sourceControl/SummaryMetaRow";
import { readableFailure } from "../sourceControl/handoff";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { IssueLabelChips } from "./issuePresentation";
import { toastManager } from "../ui/toast";
import { ActivityUnavailableState } from "../sourceControl/ActivityUnavailableState";
import { IssueAssigneePicker } from "./IssueAssigneePicker";
import {
  canEditIssueComment,
  issueCommentEditId,
  nextIssueCommentCount,
  type IssueCommentEditScope,
  LINK_PULL_REQUESTS_HANDOFF_KIND,
} from "./issueDetail.logic";
import { ConversationGhost } from "../sourceControl/ListGhosts";
import { IssueLabelPicker } from "./IssueLabelPicker";
import { IssueReactionBar } from "./IssueReactions";
import {
  useWorkItemMatches,
  WorkItemMatchButton,
  WorkItemMatchRows,
} from "../workItems/WorkItemMatches";

/**
 * Rewriting the issue where it is read, rather than in a dialog over the top of it: what the
 * description says in context is most of what an edit is about. The fields open on what the host
 * currently holds and are abandoned wholesale on cancel — half an edit is not worth keeping.
 */
function IssueEditor({
  environmentId,
  detail,
  onDone,
  onSaved,
}: {
  environmentId: EnvironmentId;
  detail: IssueDetailView;
  onDone: () => void;
  onSaved: () => void;
}) {
  const [initialTitle] = useState(detail.title);
  const [initialBody] = useState(detail.body);
  const [title, setTitle] = useState(initialTitle);
  const [saving, setSaving] = useState(false);
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });

  const trimmedTitle = title.trim();
  const changedTitle = trimmedTitle !== initialTitle;

  const save = async (body: string) => {
    const changedBody = body !== initialBody;
    if (saving) return;
    if (trimmedTitle.length === 0) {
      toastManager.add({ type: "error", title: "Enter an issue title" });
      return;
    }
    if (!changedTitle && !changedBody) {
      onDone();
      return;
    }
    setSaving(true);
    const result = await update({
      environmentId,
      input: {
        projectId: detail.projectId,
        repository: detail.repository,
        number: detail.number,
        // Only what changed: a rename should not resend a description nobody edited.
        ...(changedTitle ? { title: trimmedTitle } : {}),
        ...(changedBody ? { body } : {}),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not save this issue",
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused it. Check that you have write access, or that you opened it.",
        ),
      });
      return;
    }
    onDone();
    onSaved();
  };

  return (
    <div className="space-y-2">
      <Input
        disabled={saving}
        value={title}
        aria-label="Issue title"
        onChange={(event) => setTitle(event.target.value)}
      />
      <SourceControlMarkdownEditor
        allowEmpty
        value={initialBody}
        cwd={detail.workspaceRoot}
        environmentId={environmentId}
        label="Issue description"
        placeholder="Describe the issue"
        saving={saving}
        onSave={(body) => void save(body)}
        onCancel={onDone}
      />
    </div>
  );
}

/**
 * What a first render of the conversation carries. An issue with two hundred comments is two
 * hundred markdown documents, and the ones worth arriving for are the recent ones.
 */
const COMMENT_PAGE = 30;

export function IssueSummaryTab({
  environmentId,
  reference,
  detail,
  activityPending,
  activityError,
  editing,
  onEditingChange,
  openPicker,
  onOpenPickerChange,
  pendingHandoff,
  onLinkPullRequests,
  onOpenLinkedPullRequest,
  onOpenAiMatch,
  onLoadMoreComments,
  loadingMoreComments,
  onRefresh,
  actionPending,
  onCommentAction,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  detail: IssueDetailView;
  activityPending: boolean;
  activityError: string | null;
  /** Owned by the panel, whose menu offers the edit and whose header decides it is allowed. */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /**
   * Which of the two pickers is open, held by the panel so its own menu items can open one —
   * the meta row is where they live, and it is a tab away when the menu is pressed.
   */
  openPicker: "labels" | "assignees" | null;
  onOpenPickerChange: (picker: "labels" | "assignees" | null) => void;
  /** The hand-off currently preparing, if any, so only the control that started it says so. */
  pendingHandoff?: string | null;
  /**
   * Hands one selected change request to an agent for linking. Supplied by
   * whoever mounted the panel, because only they can open a thread for it; without one the
   * section offers nothing, which is never a dead control.
   */
  onLinkPullRequests?: (match: WorkItemMatch) => void;
  onOpenLinkedPullRequest: (link: IssueLinkedPullRequest) => void;
  onOpenAiMatch: (match: WorkItemMatch) => void;
  onRefresh: () => void;
  actionPending: boolean;
  onCommentAction: (
    body: string,
    action: "close" | "reopen",
  ) => Promise<{ readonly commentPosted: boolean }>;
  onLoadMoreComments: () => void;
  loadingMoreComments: boolean;
}) {
  // Keyed by the issue, so opening another one starts at the end of its conversation rather than
  // wherever the last one had been read back to.
  const [shown, setShown] = useState({ url: detail.url, count: COMMENT_PAGE });
  const aiMatches = useWorkItemMatches({
    environmentId,
    projectId: reference.projectId,
    source: {
      kind: "issue",
      ...(reference.provider === undefined ? {} : { provider: reference.provider }),
      repository: reference.repository,
      number: reference.number,
    },
    version: detail.updatedAt,
  });
  const shownComments = shown.url === detail.url ? shown.count : COMMENT_PAGE;
  // An issue reads in the order it was written, so the window reaches backwards from the end.
  const recentComments = detail.comments.slice(Math.max(0, detail.comments.length - shownComments));
  const hiddenCommentCount = detail.comments.length - recentComments.length;
  const [commentOrder, setCommentOrder] = useState<"newest" | "oldest">("newest");
  const visibleComments = commentOrder === "newest" ? recentComments.toReversed() : recentComments;
  const [commentScope, setCommentScope] = useState<IssueCommentEditScope | null>(null);
  const [commentSaving, setCommentSaving] = useState(false);
  const updateComment = useAtomCommand(issueEnvironment.updateComment, { reportFailure: false });
  const editingCommentId = issueCommentEditId(commentScope, detail.url);

  const saveComment = async (commentId: string, body: string) => {
    if (commentSaving) return;
    setCommentSaving(true);
    const result = await updateComment({
      environmentId,
      input: { ...reference, commentId, body },
    });
    setCommentSaving(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not save the comment" });
      return;
    }
    setCommentScope(null);
    onRefresh();
  };

  const olderComments = (
    <>
      {detail.nextCommentsCursor != null ? (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={loadingMoreComments}
          onClick={() => {
            setShown({
              url: detail.url,
              count: nextIssueCommentCount(shownComments, COMMENT_PAGE),
            });
            onLoadMoreComments();
          }}
        >
          {loadingMoreComments ? "Loading..." : "Load older comments"}
        </Button>
      ) : null}
      {hiddenCommentCount > 0 ? (
        // Hundreds of comments are hundreds of markdown renders, and the ones worth
        // opening an issue for are the recent ones. The rest are one press away and
        // stay rendered once asked for.
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => setShown({ url: detail.url, count: shownComments + COMMENT_PAGE })}
        >
          Show {Math.min(hiddenCommentCount, COMMENT_PAGE)} earlier{" "}
          {hiddenCommentCount === 1 ? "comment" : "comments"}
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="h-full overflow-y-auto" data-summary-scroll>
      <section className="px-4 py-3">
        <div>
          <SummaryMetaRow icon={<UsersIcon className="size-3.5" />} label="Assignees">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {detail.assignees.length === 0 ? (
                <span className="text-muted-foreground">Nobody</span>
              ) : (
                detail.assignees.map((actor) => (
                  <SourceControlActorLabel
                    key={actor.login}
                    actor={actor}
                    className="shrink-0 gap-0 [&>span:last-child]:sr-only"
                  />
                ))
              )}
              {/* Shown wherever the host can assign at all, and disabled with the reason where
                  this account may not: a control that vanishes teaches nobody why. A host that
                  takes an assignee but will not say who could be one has nothing to open. */}
              {detail.capabilities.assignees && detail.capabilities.listAssigneeCandidates ? (
                <IssueAssigneePicker
                  environmentId={environmentId}
                  reference={reference}
                  allowed={detail.viewerPermissions.assignees}
                  open={openPicker === "assignees"}
                  onOpenChange={(open) => onOpenPickerChange(open ? "assignees" : null)}
                  onChanged={onRefresh}
                />
              ) : null}
            </span>
          </SummaryMetaRow>
          <SummaryMetaRow icon={<TagIcon className="size-3.5" />} label="Labels">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {detail.labels.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <IssueLabelChips labels={detail.labels} />
              )}
              {detail.capabilities.labels && detail.capabilities.listLabelCandidates ? (
                <IssueLabelPicker
                  environmentId={environmentId}
                  reference={reference}
                  applied={detail.labels.map((label) => label.name)}
                  allowed={detail.viewerPermissions.labels}
                  open={openPicker === "labels"}
                  onOpenChange={(open) => onOpenPickerChange(open ? "labels" : null)}
                  onChanged={onRefresh}
                />
              ) : null}
            </span>
          </SummaryMetaRow>
          <SummaryMetaRow icon={<MilestoneIcon className="size-3.5" />} label="Milestone">
            {detail.milestone ?? <span className="text-muted-foreground">None</span>}
          </SummaryMetaRow>
          <SummaryMetaRow icon={<MessageSquareIcon className="size-3.5" />} label="Comments">
            {activityPending
              ? "Loading conversation…"
              : activityError
                ? "Conversation unavailable"
                : detail.commentCount === 1
                  ? "1 comment"
                  : `${detail.commentCount} comments`}
          </SummaryMetaRow>
        </div>
      </section>

      <SummarySection title="Description">
        <div className="group">
          {editing ? (
            <IssueEditor
              key={detail.url}
              environmentId={environmentId}
              detail={detail}
              onDone={() => onEditingChange(false)}
              onSaved={onRefresh}
            />
          ) : (
            <div className="flex items-start gap-1">
              <HostMarkdown
                className="min-w-0 flex-1"
                text={detail.body.trim().length > 0 ? detail.body : "_No description provided._"}
                cwd={detail.workspaceRoot}
                environmentId={environmentId}
              />
              {detail.capabilities.edit && detail.viewerPermissions.edit ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label="Edit description"
                  onClick={() => onEditingChange(true)}
                >
                  <PencilIcon className="size-3" />
                </Button>
              ) : null}
            </div>
          )}
          <IssueReactionBar
            className="mt-2"
            reactions={detail.reactions ?? []}
            canReact={detail.capabilities.reactions === true}
            environmentId={environmentId}
            reference={reference}
            onRefresh={onRefresh}
          />
        </div>
      </SummarySection>

      <SummarySection
        title="Related pull requests"
        {...(detail.capabilities.linkedPullRequests
          ? { count: detail.linkedPullRequests.length }
          : {})}
        actions={
          <WorkItemMatchButton
            busy={aiMatches.pending === "related"}
            disabled={aiMatches.pending !== null}
            loaded={aiMatches.related !== undefined}
            onClick={() => void aiMatches.find("related")}
          />
        }
      >
        {detail.capabilities.linkedPullRequests ? (
          detail.linkedPullRequests.length === 0 ? (
            <p className="text-xs text-muted-foreground">No pull request mentions this issue.</p>
          ) : (
            <div className="space-y-0.5">
              {detail.linkedPullRequests.map((link) => {
                const presentation = resolvePullRequestState({
                  state: link.state,
                  isDraft: link.isDraft,
                });
                return (
                  <button
                    key={`${link.repository}#${link.number}`}
                    type="button"
                    // Beside the issue rather than instead of it: reading the change that closes
                    // an issue is reading them together.
                    onClick={() => onOpenLinkedPullRequest(link)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60"
                  >
                    <presentation.Icon
                      role="img"
                      aria-label={presentation.label}
                      className={cn("size-3.5 shrink-0", presentation.toneClassName)}
                    />
                    <span className="min-w-0 flex-1 truncate">{link.title}</span>
                    {link.closesIssue ? (
                      <span className="shrink-0 rounded-full border border-border/60 px-1.5 text-[10px] text-muted-foreground">
                        closes this
                      </span>
                    ) : null}
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      #{link.number}
                    </span>
                  </button>
                );
              })}
            </div>
          )
        ) : (
          <p className="text-xs text-muted-foreground">
            This tracker does not report pull request links.
          </p>
        )}
        {aiMatches.related === undefined ? null : (
          <div className="mt-2">
            <WorkItemMatchRows
              matches={aiMatches.related}
              emptyText="No likely related pull requests found."
              onOpen={onOpenAiMatch}
              {...(detail.capabilities.linkedPullRequests && onLinkPullRequests
                ? {
                    onLink: onLinkPullRequests,
                    linking: pendingHandoff === LINK_PULL_REQUESTS_HANDOFF_KIND,
                  }
                : {})}
            />
          </div>
        )}
      </SummarySection>

      <SummarySection
        title="Possible duplicate issues"
        {...(aiMatches.duplicate === undefined ? {} : { count: aiMatches.duplicate.length })}
        actions={
          <WorkItemMatchButton
            busy={aiMatches.pending === "duplicate"}
            disabled={aiMatches.pending !== null}
            loaded={aiMatches.duplicate !== undefined}
            onClick={() => void aiMatches.find("duplicate")}
          />
        }
      >
        {aiMatches.duplicate === undefined ? (
          <p className="text-xs text-muted-foreground">
            Find issues that describe the same problem.
          </p>
        ) : (
          <WorkItemMatchRows
            matches={aiMatches.duplicate}
            emptyText="No likely duplicate issues found."
            onOpen={onOpenAiMatch}
          />
        )}
      </SummarySection>

      <SummarySection
        title="Comments"
        actions={
          !activityPending && !activityError && detail.comments.length > 0 ? (
            <Button
              size="xs"
              variant="ghost"
              className="h-7 shrink-0 px-2 text-[10px] text-muted-foreground"
              onClick={() => setCommentOrder(commentOrder === "newest" ? "oldest" : "newest")}
            >
              <ArrowDownUpIcon aria-hidden className="size-3" />
              {commentOrder === "newest" ? "Newest first" : "Oldest first"}
            </Button>
          ) : null
        }
        {...(activityPending || activityError ? {} : { count: detail.commentCount })}
      >
        {activityPending ? (
          <ConversationGhost label="Loading issue conversation" />
        ) : activityError ? (
          <ActivityUnavailableState
            compact
            title="Could not load issue activity"
            error={activityError}
            onRetry={onRefresh}
          />
        ) : (
          <>
            {detail.commentsTruncated && detail.nextCommentsCursor == null ? (
              <p className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs">
                Only {detail.comments.length} comments are available here. Open the issue on the
                host to read the rest.
              </p>
            ) : null}
            {detail.comments.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">No comments yet.</p>
            ) : (
              <div className="space-y-3">
                {commentOrder === "oldest" ? olderComments : null}
                {visibleComments.map((comment) => (
                  <article
                    key={comment.id}
                    // Offscreen comments skip style, layout and paint. Bot comments carry pages
                    // of highlighted code, and the conversation is below the description either
                    // way.
                    className="group rounded-lg border border-border/60 p-3 [contain-intrinsic-block-size:120px] [content-visibility:auto]"
                  >
                    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span
                              className="shrink-0 rounded-full"
                              aria-label={comment.author?.login ?? "ghost"}
                            />
                          }
                        >
                          <SourceControlActorAvatar actor={comment.author} />
                        </TooltipTrigger>
                        <TooltipPopup>
                          {comment.author?.name ?? comment.author?.login ?? "ghost"}
                        </TooltipPopup>
                      </Tooltip>
                      <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
                    </span>
                    {editingCommentId === comment.id ? (
                      <SourceControlMarkdownEditor
                        className="mt-2"
                        value={comment.body}
                        cwd={detail.workspaceRoot}
                        environmentId={environmentId}
                        label="Edit comment"
                        saving={commentSaving}
                        onSave={(body) => void saveComment(comment.id, body)}
                        onCancel={() => setCommentScope(null)}
                      />
                    ) : (
                      <div className="mt-2 flex items-start gap-1">
                        <HostMarkdown
                          className="min-w-0 flex-1"
                          text={comment.body}
                          cwd={detail.workspaceRoot}
                          environmentId={environmentId}
                        />
                        {canEditIssueComment(detail, comment) ? (
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                            aria-label="Edit comment"
                            onClick={() => setCommentScope({ issue: detail.url, id: comment.id })}
                          >
                            <PencilIcon className="size-3" />
                          </Button>
                        ) : null}
                      </div>
                    )}
                    <IssueReactionBar
                      className="mt-2"
                      reactions={comment.reactions ?? []}
                      canReact={detail.capabilities.reactions === true}
                      subjectId={comment.id}
                      environmentId={environmentId}
                      reference={reference}
                      onRefresh={onRefresh}
                    />
                  </article>
                ))}
                {commentOrder === "newest" ? olderComments : null}
              </div>
            )}
          </>
        )}
        {/* Posting is a core capability and remains usable even if the activity read failed. */}
        {detail.capabilities.comment && detail.viewerPermissions.comment ? (
          <CommentComposer
            key={`${environmentId}:${detail.projectId}/${detail.repository}#${detail.number}`}
            environmentId={environmentId}
            detail={detail}
            label="Comment on this issue"
            command={issueEnvironment.comment}
            actionPending={actionPending}
            followUpAction={
              detail.state === "open" &&
              detail.capabilities.actions.includes("close") &&
              detail.viewerPermissions.actions.includes("close")
                ? "close"
                : detail.state === "closed" &&
                    detail.capabilities.actions.includes("reopen") &&
                    detail.viewerPermissions.actions.includes("reopen")
                  ? "reopen"
                  : null
            }
            onCommentAction={onCommentAction}
            onCommented={onRefresh}
          />
        ) : null}
      </SummarySection>
    </div>
  );
}
