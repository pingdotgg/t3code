import { useAtomValue } from "@effect/atom-react";
import { issueEventSentence, issueWriteAccess } from "@t3tools/client-runtime/issue-presentation";
import { prependIssueComments } from "@t3tools/client-runtime/state/issues";
import {
  issueAssigneeHeld,
  issueAssigneesAfterPicks,
  issueLabelsAfterPicks,
  issuePicksAfterFailedWrite,
  issuePicksFor,
  issueWriteAfterPicks,
  noIssuePicks,
} from "@t3tools/client-runtime/issue-selection";
import { isSelected, toggleSelection } from "@t3tools/client-runtime/pull-request-selection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, threadIssueKeysEqual } from "@t3tools/contracts";
import type {
  EnvironmentId,
  IssueAssigneeCandidate,
  IssueComment,
  IssueDetail,
  IssueEvent,
  IssueLabelCandidate,
  IssueLinkedPullRequest,
  IssueListEntry,
  IssueReaction,
  IssueRef,
  PullRequestRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  Link2Icon,
  Link2OffIcon,
  TagIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { issueEnvironment, refreshIssueLists } from "~/state/issues";
import { useProjects, useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { PullRequestMetaRow, PullRequestSection } from "../pullRequest/PullRequestSummaryTab";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestCandidatePicker } from "../pullRequest/PullRequestCandidatePicker";
import { PullRequestCommentBody } from "../pullRequest/PullRequestCommentBody";
import { PullRequestDetailTitleRow } from "../pullRequest/PullRequestDetailLayout";
import { PullRequestEditButton } from "../pullRequest/PullRequestEditButton";
import {
  PullRequestMarkdown,
  PullRequestMarkdownContext,
} from "../pullRequest/PullRequestMarkdown";
import { issueMarkdownPlugins } from "../pullRequest/pullRequestMarkdown.logic";
import { PullRequestMarkdownEditor } from "../pullRequest/PullRequestMarkdownEditor";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { pullRequestLabelColor } from "../pullRequest/pullRequestList.logic";
import {
  PullRequestActorLabel,
  PullRequestLabelChip,
  PullRequestMetaLine,
  PullRequestStateGlyph,
} from "../pullRequest/pullRequestPresentation";
import { IssueCommentComposer } from "./IssueCommentComposer";
import { IssueDetailGhost } from "./IssueDetailGhost";
import { ReactionBar } from "../pullRequest/PullRequestReactions";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import { issueTrackerPresentation, issueStatePresentation } from "./issuePresentation";

/**
 * Links or unlinks the issue to the thread it is shown beside. Dispatches the orchestration
 * command directly, as pull request linking does.
 */
function IssueThreadLinkButton({
  environmentId,
  reference,
  issue,
  threadRef,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  issue: Pick<IssueDetail, "url" | "displayKey" | "title">;
  threadRef: ScopedThreadRef;
}) {
  const thread = useThreadShell(threadRef.environmentId === environmentId ? threadRef : null);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const link = useAtomCommand(threadEnvironment.linkIssue, { reportFailure: false });
  const unlink = useAtomCommand(threadEnvironment.unlinkIssue, { reportFailure: false });
  const [pending, setPending] = useState(false);
  if (thread === null || !canOperate) return null;
  const key = { ...reference, host: reference.host ?? "" };
  const linked = (thread.issues ?? []).some((existing) => threadIssueKeysEqual(existing, key));
  const toggle = async () => {
    if (pending || reference.host === undefined) return;
    setPending(true);
    const result = await (linked
      ? unlink({ environmentId, input: { threadId: threadRef.threadId, ...key } })
      : link({
          environmentId,
          input: {
            threadId: threadRef.threadId,
            ...key,
            url: issue.url,
            displayKey: issue.displayKey,
            title: issue.title,
            source: "manual",
          },
        }));
    setPending(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: linked ? "Could not unlink the issue" : "Could not link the issue",
        description: readableFailure(squashAtomCommandFailure(result), "The server refused it."),
      });
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={linked ? "Unlink from thread" : "Link to thread"}
            aria-pressed={linked}
            disabled={pending || reference.host === undefined}
            onClick={() => void toggle()}
          />
        }
      >
        {linked ? (
          <Link2OffIcon aria-hidden className="size-3.5" />
        ) : (
          <Link2Icon aria-hidden className="size-3.5" />
        )}
      </TooltipTrigger>
      <TooltipPopup>{linked ? "Unlink from this thread" : "Link to this thread"}</TooltipPopup>
    </Tooltip>
  );
}

function IssueReactionBar({
  reactions,
  canReact,
  subjectId,
  environmentId,
  reference,
}: {
  reactions: ReadonlyArray<IssueReaction>;
  canReact: boolean;
  subjectId?: string | undefined;
  environmentId: EnvironmentId;
  reference: IssueRef;
}) {
  const react = useAtomCommand(issueEnvironment.react, { reportFailure: false });
  return (
    <ReactionBar
      reactions={reactions}
      canReact={canReact}
      onReact={async (content, reacted) => {
        const result = await react({
          environmentId,
          input: {
            ...reference,
            ...(subjectId === undefined ? {} : { subjectId }),
            content,
            reacted,
          },
        });
        return result._tag !== "Failure";
      }}
    />
  );
}

function IssueLabelPicker({
  environmentId,
  reference,
  detail,
  allowed,
  disabledReason,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  detail: IssueDetail;
  allowed: boolean;
  disabledReason: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picks, setPicks] = useState(noIssuePicks<IssueLabelCandidate>);
  const current = issuePicksFor(picks, detail, open);
  const draft = current.draft;
  const candidatesQuery = useEnvironmentQuery(
    open ? issueEnvironment.candidates({ environmentId, input: reference }) : null,
  );
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const applied = new Set(detail.labels.map((label) => label.name));
  const needle = query.toLowerCase();
  const candidates = (candidatesQuery.data?.labels ?? []).filter(
    (label) =>
      needle.length === 0 ||
      label.name.toLowerCase().includes(needle) ||
      (label.description ?? "").toLowerCase().includes(needle),
  );
  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      // Picks made against an older read are not this picker's any more.
      setPicks(issuePicksFor(picks, detail, false));
      return;
    }
    const labels = issueWriteAfterPicks(
      issueLabelsAfterPicks(detail, draft),
      detail.labels.map((label) => label.name),
      current.written,
    );
    if (labels === null) return;
    const sent = { ...current, written: labels };
    setPicks(sent);
    void update({ environmentId, input: { ...reference, labels } }).then((result) => {
      if (result._tag !== "Failure") {
        refreshIssueLists(environmentId);
        return;
      }
      setPicks((latest) => issuePicksAfterFailedWrite(latest, sent));
      toastManager.add({
        type: "error",
        title: "Could not change labels",
        description: readableFailure(squashAtomCommandFailure(result), "The tracker refused it."),
      });
    });
  };
  return (
    <PullRequestCandidatePicker
      icon={<TagIcon className="size-3.5" />}
      label="Change labels"
      allowed={allowed}
      disabledReason={disabledReason}
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      searchLabel="Search labels"
      isPending={candidatesQuery.isPending && candidatesQuery.data === null}
      error={candidatesQuery.data === null ? candidatesQuery.error : null}
      candidates={candidates}
      emptyLabel="This tracker has no labels."
      noMatchLabel="No label matches that."
      errorLabel="The labels could not be read."
      truncated={candidatesQuery.data?.truncated === true}
      truncatedLabel="More labels exist than are listed here."
      candidateKey={(candidate) => candidate.name}
      onSelect={(candidate) =>
        setPicks({
          ...current,
          draft: toggleSelection(draft, candidate.name, candidate, applied.has(candidate.name)),
        })
      }
    >
      {(candidate) => {
        const dot = pullRequestLabelColor(candidate.color);
        return (
          <>
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-muted-foreground"
              {...(dot ? { style: { backgroundColor: dot } } : {})}
            />
            <span className="min-w-0 flex-1 truncate">
              {candidate.name}
              {candidate.description ? (
                <span className="text-muted-foreground"> · {candidate.description}</span>
              ) : null}
            </span>
            {isSelected(draft, candidate.name, applied.has(candidate.name)) ? (
              <CheckIcon aria-label="Applied" className="size-3.5 shrink-0" />
            ) : null}
          </>
        );
      }}
    </PullRequestCandidatePicker>
  );
}

function IssueAssigneePicker({
  environmentId,
  reference,
  detail,
  allowed,
  disabledReason,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  detail: IssueDetail;
  allowed: boolean;
  disabledReason: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picks, setPicks] = useState(noIssuePicks<IssueAssigneeCandidate>);
  const current = issuePicksFor(picks, detail, open);
  const draft = current.draft;
  const candidatesQuery = useEnvironmentQuery(
    open ? issueEnvironment.candidates({ environmentId, input: reference }) : null,
  );
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const needle = query.toLowerCase();
  const candidates = (candidatesQuery.data?.assignees ?? []).filter(
    (candidate) =>
      needle.length === 0 ||
      candidate.login.toLowerCase().includes(needle) ||
      (candidate.name ?? "").toLowerCase().includes(needle),
  );
  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      // Picks made against an older read are not this picker's any more.
      setPicks(issuePicksFor(picks, detail, false));
      return;
    }
    const assignees = issueWriteAfterPicks(
      issueAssigneesAfterPicks(detail, draft),
      detail.assignees.map((actor) => actor.login),
      current.written,
    );
    if (assignees === null) return;
    const sent = { ...current, written: assignees };
    setPicks(sent);
    void update({ environmentId, input: { ...reference, assignees } }).then((result) => {
      if (result._tag !== "Failure") {
        refreshIssueLists(environmentId);
        return;
      }
      setPicks((latest) => issuePicksAfterFailedWrite(latest, sent));
      toastManager.add({
        type: "error",
        title: "Could not change assignees",
        description: readableFailure(squashAtomCommandFailure(result), "The tracker refused it."),
      });
    });
  };
  return (
    <PullRequestCandidatePicker
      icon={<UserPlusIcon className="size-3.5" />}
      label="Change assignees"
      allowed={allowed}
      disabledReason={disabledReason}
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      searchLabel="Search people"
      isPending={candidatesQuery.isPending && candidatesQuery.data === null}
      error={candidatesQuery.data === null ? candidatesQuery.error : null}
      candidates={candidates}
      emptyLabel="Nobody can be assigned here."
      noMatchLabel="Nobody matches that."
      errorLabel="The people could not be read."
      truncated={candidatesQuery.data?.truncated === true}
      truncatedLabel="More people exist than are listed here."
      candidateKey={(candidate) => candidate.id}
      onSelect={(candidate) =>
        setPicks({
          ...current,
          draft: toggleSelection(
            draft,
            candidate.id,
            candidate,
            issueAssigneeHeld(detail, candidate),
          ),
        })
      }
    >
      {(candidate) => (
        <>
          <PullRequestActorLabel actor={candidate} tooltip={false} className="min-w-0 flex-1" />
          {isSelected(draft, candidate.id, issueAssigneeHeld(detail, candidate)) ? (
            <CheckIcon aria-label="Assigned" className="size-3.5 shrink-0" />
          ) : null}
        </>
      )}
    </PullRequestCandidatePicker>
  );
}

type TimelineItem =
  | { kind: "comment"; at: string; comment: IssueComment }
  | { kind: "event"; at: string; event: IssueEvent };

function LinkedPullRequestRow({
  link,
  scope,
  onSelect,
}: {
  link: IssueLinkedPullRequest;
  /** The issue's own repository, left off a pull request that lives in it. */
  scope: string;
  onSelect: (() => void) | null;
}) {
  const body = (
    <>
      <PullRequestStateGlyph state={link.state} isDraft={link.isDraft} />
      <span className="min-w-0 flex-1 truncate text-sm">{link.title}</span>
      <PullRequestMetaLine className="shrink-0 text-xs text-muted-foreground">
        {link.closesIssue ? <span>Closes this issue</span> : null}
        <span className="tabular-nums">
          {link.repository.toLowerCase() === scope.toLowerCase() ? "" : link.repository}#
          {link.number}
        </span>
      </PullRequestMetaLine>
    </>
  );
  const className =
    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent";
  return onSelect ? (
    <button type="button" className={className} onClick={onSelect}>
      {body}
    </button>
  ) : (
    <a href={link.url} target="_blank" rel="noopener noreferrer" className={className}>
      {body}
    </a>
  );
}

export function IssueDetailPanel({
  environmentId,
  reference,
  threadRef = null,
  listEntry = null,
  onSelectPullRequest,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /** The list row this issue was opened from, shown until the detail arrives. */
  listEntry?: IssueListEntry | null;
  threadRef?: ScopedThreadRef | null;
  /** Opens a linked change request beside this one; absent, the link goes to the host. */
  onSelectPullRequest?: ((reference: PullRequestRef) => void) | undefined;
}) {
  const detailQuery = useEnvironmentQuery(
    issueEnvironment.detail({ environmentId, input: reference }),
  );
  const detail = detailQuery.data;
  const canWrite = useAtomValue(issueEnvironment.comment.permissionAtom(environmentId));
  const projects = useProjects();
  const cwd =
    projects.find((p) => p.environmentId === environmentId && p.id === reference.projectId)
      ?.workspaceRoot ?? "";

  const [older, setOlder] = useState<{
    readonly seed: string | null;
    readonly comments: ReadonlyArray<IssueComment>;
    readonly cursor: string | null;
  } | null>(null);
  const loadComments = useAtomCommand(issueEnvironment.comments, { reportFailure: false });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  const [editing, setEditing] = useState<"title" | "body" | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [changingState, setChangingState] = useState(false);

  if (detail === null) {
    if (detailQuery.error !== null && !detailQuery.isPending) {
      return (
        <PullRequestsUnavailableState
          title="Could not load this issue"
          error={detailQuery.error}
          onRetry={detailQuery.refresh}
        />
      );
    }
    return <IssueDetailGhost seed={listEntry} />;
  }
  const markdownContext = {
    remarkPlugins: issueMarkdownPlugins(detail),
    lineBreaks: false,
    threadRef,
    repository: null,
  };

  // Older pages are tied to the cursor the detail was read with; a refreshed detail starts over.
  const olderComments = older?.seed === detail.commentsCursor ? older.comments : [];
  const nextCursor = older?.seed === detail.commentsCursor ? older.cursor : detail.commentsCursor;
  const comments = prependIssueComments(detail.comments, olderComments);
  const timeline: ReadonlyArray<TimelineItem> = [
    ...comments.map((c): TimelineItem => ({ kind: "comment", at: c.createdAt, comment: c })),
    ...detail.events.map((e): TimelineItem => ({ kind: "event", at: e.createdAt, event: e })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const access = issueWriteAccess(detail, canWrite);
  const { blocked } = access;
  const canComment = access.comment;
  const canEdit = access.edit;
  const canLabel = access.labels;
  const canAssign = access.assignees;
  const canReact = access.react;
  const otherStates = access.states;
  const tracker = issueTrackerPresentation(detail.tracker);
  const currentState = issueStatePresentation(detail.state);

  const loadOlder = async () => {
    if (nextCursor === null || loadingOlder) return;
    setLoadingOlder(true);
    const result = await loadComments({
      environmentId,
      input: { ...reference, cursor: nextCursor },
    });
    setLoadingOlder(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Older comments could not be read" });
      return;
    }
    setOlder({
      seed: detail.commentsCursor,
      comments: prependIssueComments(olderComments, result.value.comments),
      cursor: result.value.nextCursor,
    });
  };

  const save = async (patch: { title?: string; body?: string }) => {
    setSaving(true);
    const result = await update({ environmentId, input: { ...reference, ...patch } });
    setSaving(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "The issue could not be updated",
        description: readableFailure(squashAtomCommandFailure(result), "The tracker refused it."),
      });
      return;
    }
    refreshIssueLists(environmentId);
    setEditing(null);
  };

  const moveTo = async (state: string) => {
    if (changingState) return;
    setChangingState(true);
    const result = await setState({
      environmentId,
      input: { ...reference, state },
    });
    setChangingState(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "The state could not be changed",
        description: readableFailure(squashAtomCommandFailure(result), "The tracker refused it."),
      });
      return;
    }
    refreshIssueLists(environmentId);
  };

  const currentStateIcon = (
    <currentState.Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", currentState.toneClassName)}
    />
  );
  const stateControl: ReactNode =
    otherStates.length > 0 ? (
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              aria-label={`Issue state, ${currentState.label}`}
              disabled={changingState}
            />
          }
        >
          {currentStateIcon}
          {currentState.label}
          <ChevronDownIcon aria-hidden className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end">
          {otherStates.map((state) => {
            const presentation = issueStatePresentation(state);
            return (
              <MenuItem key={state.name} onClick={() => void moveTo(state.name)}>
                <presentation.Icon
                  aria-hidden
                  className={cn("size-3.5 shrink-0", presentation.toneClassName)}
                />
                {state.name}
              </MenuItem>
            );
          })}
        </MenuPopup>
      </Menu>
    ) : (
      <span className="flex shrink-0 items-center gap-1 font-medium">
        {currentStateIcon}
        {currentState.label}
      </span>
    );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          // Room for the floating composer, so the last comment can scroll clear of it.
          detail.capabilities.comment && "pb-32",
        )}
        data-pull-request-summary-scroll
      >
        <div className="px-4 pb-1">
          <PullRequestDetailTitleRow className="h-7 gap-1 text-sm sm:text-xs">
            <span className="min-w-0 truncate font-medium text-muted-foreground">
              {detail.scope}
            </span>
            <InlineButton
              className={cn("shrink-0 font-medium", currentState.toneClassName)}
              aria-label={`Open ${detail.displayKey} on ${tracker.providerName}`}
              render={<a href={detail.url} target="_blank" rel="noopener noreferrer" />}
            >
              {detail.displayKey}
              <ExternalLinkIcon aria-hidden className="size-2.5" />
            </InlineButton>
            <span className="flex-1" />
            {stateControl}
            {threadRef ? (
              <IssueThreadLinkButton
                environmentId={environmentId}
                reference={{ ...reference, host: reference.host ?? detail.host }}
                issue={detail}
                threadRef={threadRef}
              />
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh issue"
              disabled={detailQuery.isPending}
              onClick={() => {
                // Older pages are cached under the cursor, which a refresh can hand back unchanged.
                setOlder(null);
                detailQuery.refresh();
              }}
            >
              <RefreshIcon size="sm" refreshing={detailQuery.isPending} />
            </Button>
          </PullRequestDetailTitleRow>

          {editing === "title" ? (
            <form
              className="mt-1 flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const next = titleDraft.trim();
                if (next.length > 0 && next !== detail.title) void save({ title: next });
                else setEditing(null);
              }}
            >
              <Input
                autoFocus
                aria-label="Issue title"
                value={titleDraft}
                disabled={saving}
                onChange={(event) => setTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditing(null);
                }}
              />
              <Button type="submit" size="sm" disabled={saving}>
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <PullRequestDetailTitleRow className="group mt-1 gap-1">
              <h2 className="min-w-0 flex-1 text-base font-semibold leading-snug">
                {detail.title}
              </h2>
              {canEdit ? (
                <PullRequestEditButton
                  aria-label="Edit title"
                  onClick={() => {
                    setTitleDraft(detail.title);
                    setEditing("title");
                  }}
                />
              ) : null}
            </PullRequestDetailTitleRow>
          )}

          <PullRequestMetaLine className="mt-2 min-h-5 text-xs text-muted-foreground">
            <PullRequestActorLabel actor={detail.author} />
            <span>opened {formatRelativeTimeLabel(detail.createdAt)}</span>
            {detail.closedAt ? (
              <span>closed {formatRelativeTimeLabel(detail.closedAt)}</span>
            ) : null}
            {detail.writable ? null : <span>Read-only</span>}
          </PullRequestMetaLine>

          <div className="mt-4 space-y-2">
            <PullRequestMetaRow icon={<TagIcon className="size-3.5" />} label="Labels">
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
                {detail.capabilities.labels ? (
                  <IssueLabelPicker
                    environmentId={environmentId}
                    reference={reference}
                    detail={detail}
                    allowed={canLabel}
                    disabledReason={
                      blocked ?? "Changing labels needs triage access on this tracker."
                    }
                  />
                ) : null}
              </span>
            </PullRequestMetaRow>
            <PullRequestMetaRow icon={<UsersIcon className="size-3.5" />} label="Assignees">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                {detail.assignees.length === 0 ? (
                  <span className="text-muted-foreground">None</span>
                ) : (
                  detail.assignees.map((actor) => (
                    <PullRequestActorLabel key={actor.login} actor={actor} />
                  ))
                )}
                {detail.capabilities.assignees ? (
                  <IssueAssigneePicker
                    environmentId={environmentId}
                    reference={reference}
                    detail={detail}
                    allowed={canAssign}
                    disabledReason={
                      blocked ?? "Changing assignees needs triage access on this tracker."
                    }
                  />
                ) : null}
              </span>
            </PullRequestMetaRow>
          </div>
        </div>

        <PullRequestSection
          key={`description:${detail.url}`}
          title="Description"
          keepMounted
          actions={
            canEdit && editing !== "body" ? (
              <PullRequestEditButton
                aria-label="Edit description"
                onClick={() => setEditing("body")}
              />
            ) : null
          }
        >
          <div className="flex flex-col gap-2">
            {editing === "body" ? (
              <PullRequestMarkdownEditor
                value={detail.body}
                cwd={cwd}
                environmentId={environmentId}
                threadRef={threadRef}
                label="Description"
                completionScope={null}
                saving={saving}
                allowEmpty
                onSave={(next) => void save({ body: next })}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <PullRequestMarkdownContext value={markdownContext}>
                <PullRequestMarkdown
                  text={detail.body.trim().length > 0 ? detail.body : "_No description provided._"}
                  cwd={cwd}
                  environmentId={environmentId}
                  threadRef={threadRef}
                />
              </PullRequestMarkdownContext>
            )}
            {detail.reactions !== undefined ? (
              <IssueReactionBar
                reactions={detail.reactions}
                canReact={canReact}
                environmentId={environmentId}
                reference={reference}
              />
            ) : null}
          </div>
        </PullRequestSection>

        {detail.linkedPullRequests.length > 0 ? (
          <PullRequestSection key={`linked:${detail.url}`} title="Linked pull requests">
            <div className="flex flex-col gap-1">
              {detail.linkedPullRequests.map((link) => (
                <LinkedPullRequestRow
                  key={`${link.repository}#${link.number}`}
                  link={link}
                  scope={detail.scope}
                  onSelect={
                    onSelectPullRequest
                      ? () =>
                          onSelectPullRequest({
                            projectId: reference.projectId,
                            ...(reference.host === undefined ? {} : { host: reference.host }),
                            repository: link.repository,
                            number: link.number,
                          })
                      : null
                  }
                />
              ))}
            </div>
          </PullRequestSection>
        ) : null}

        <PullRequestSection
          key={`activity:${detail.url}`}
          title={detail.commentCount > 0 ? `Activity (${detail.commentCount})` : "Activity"}
        >
          <div className="flex flex-col gap-3">
            {nextCursor !== null ? (
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={loadingOlder}
                onClick={() => void loadOlder()}
              >
                {loadingOlder ? "Loading…" : "Load older comments"}
              </Button>
            ) : null}
            {timeline.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing has happened here yet.</p>
            ) : null}
            {timeline.map((item) =>
              item.kind === "comment" ? (
                <article
                  key={`c:${item.comment.id}`}
                  className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
                >
                  <PullRequestMetaLine className="text-xs text-muted-foreground">
                    <PullRequestActorLabel actor={item.comment.author} />
                    {item.comment.url ? (
                      <InlineButton
                        tone="muted"
                        render={
                          <a href={item.comment.url} target="_blank" rel="noopener noreferrer" />
                        }
                      >
                        {formatRelativeTimeLabel(item.comment.createdAt)}
                      </InlineButton>
                    ) : (
                      <span>{formatRelativeTimeLabel(item.comment.createdAt)}</span>
                    )}
                  </PullRequestMetaLine>
                  <PullRequestMarkdownContext value={markdownContext}>
                    <PullRequestCommentBody
                      text={item.comment.body}
                      cwd={cwd}
                      environmentId={environmentId}
                      threadRef={threadRef}
                    />
                  </PullRequestMarkdownContext>
                  {item.comment.reactions !== undefined ? (
                    <IssueReactionBar
                      reactions={item.comment.reactions}
                      canReact={canReact}
                      subjectId={item.comment.id}
                      environmentId={environmentId}
                      reference={reference}
                    />
                  ) : null}
                </article>
              ) : (
                <PullRequestMetaLine
                  key={`e:${item.event.id}`}
                  className="px-1 text-xs text-muted-foreground"
                >
                  <PullRequestActorLabel actor={item.event.actor} />
                  <span>{issueEventSentence(item.event)}</span>
                  <span>{formatRelativeTimeLabel(item.event.createdAt)}</span>
                </PullRequestMetaLine>
              ),
            )}
          </div>
        </PullRequestSection>
      </div>

      {detail.capabilities.comment ? (
        <IssueCommentComposer
          environmentId={environmentId}
          reference={reference}
          blocked={canComment ? null : (blocked ?? "You cannot comment here.")}
        />
      ) : null}
    </div>
  );
}
