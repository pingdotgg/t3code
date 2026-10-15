import { useAtomValue } from "@effect/atom-react";
import { issueEntryKey } from "@t3tools/client-runtime/state/issues";
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
  IssueReaction,
  IssueReactionContent,
  IssueRef,
  IssueState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  Link2Icon,
  Link2OffIcon,
  SendIcon,
  SmilePlusIcon,
  TagIcon,
  UserPlusIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { cn } from "~/lib/utils";
import { issueEnvironment } from "~/state/issues";
import { useProjects, useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestCandidatePicker } from "../pullRequest/PullRequestCandidatePicker";
import { PullRequestCommentBody } from "../pullRequest/PullRequestCommentBody";
import { PullRequestDetailTitleRow } from "../pullRequest/PullRequestDetailLayout";
import { PullRequestEditButton } from "../pullRequest/PullRequestEditButton";
import { PullRequestDetailGhost } from "../pullRequest/PullRequestGhosts";
import { PullRequestMarkdownEditor } from "../pullRequest/PullRequestMarkdownEditor";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { pullRequestLabelColor } from "../pullRequest/pullRequestList.logic";
import {
  PullRequestActorLabel,
  PullRequestLabelChip,
  PullRequestMetaLine,
  PullRequestStateGlyph,
} from "../pullRequest/pullRequestPresentation";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  applyPendingPullRequestReactions,
  pullRequestReactionEmoji,
  pullRequestReactionName,
  pullRequestReactionTooltip,
} from "../pullRequest/pullRequestReactions.logic";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import {
  issueCloseReasonLabel,
  IssueStateGlyph,
  issueTrackerPresentation,
} from "./issuePresentation";
import {
  appendOlderIssueComments,
  issueAssigneeId,
  issueCommentsView,
  issueAssigneeOptions,
  issueDisplayLabel,
  issueLabelOptions,
  issueLabelId,
  issuePickerIds,
  heldIssuePicker,
  nextIssueLabels,
  issueSupportsReactions,
  offeredIssueReactionContents,
  retainUnacknowledgedIssueReactions,
  isIssueAssignee,
  linkedPullRequestTarget,
  nextIssueAssignees,
  type IssueLinkedPullRequestTarget,
  type IssueOlderComments,
  type IssuePickerConfirmed,
} from "./issueDetail.logic";

/**
 * Links or unlinks the issue to the thread it is shown beside. Dispatches the orchestration
 * command directly, as pull request linking does; the server reads the snapshot afterwards.
 */
function IssueThreadLinkButton({
  environmentId,
  reference,
  url,
  threadRef,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  url: string;
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
          input: { threadId: threadRef.threadId, ...key, url, source: "manual" },
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

/** Why a control is off, said once so each disabled affordance can point at it. */
function writeBlockReason(detail: IssueDetail, canWrite: boolean): string | null {
  if (!canWrite) return "Writing to this tracker needs the source-control write scope.";
  if (!detail.writable)
    return "This issue is outside every project's own scope, so it is read-only here.";
  return null;
}

function IssueTruncatedNote({
  text,
  url,
  providerName,
}: {
  text: string;
  url: string;
  providerName: string;
}) {
  return (
    <p className="text-xs text-muted-foreground">
      {text}{" "}
      <InlineButton
        tone="muted"
        render={<a href={url} target="_blank" rel="noopener noreferrer" />}
      >
        View on {providerName}
      </InlineButton>
    </p>
  );
}

const REACTION_PILL_CLASS =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The pull-request reaction bar's shape, routed to the issue tracker instead of the host. */
export function IssueReactionBar({
  reactions,
  canReact,
  contents,
  subjectId,
  viewer,
  environmentId,
  reference,
}: {
  reactions: ReadonlyArray<IssueReaction>;
  canReact: boolean;
  contents: ReadonlyArray<IssueReactionContent> | undefined;
  subjectId?: string | undefined;
  viewer: string | null;
  environmentId: EnvironmentId;
  reference: IssueRef;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState({
    native: reactions,
    values: new Map<IssueReactionContent, boolean>() as ReadonlyMap<IssueReactionContent, boolean>,
  });
  const [busy, setBusy] = useState<ReadonlySet<IssueReactionContent>>(new Set());
  const react = useAtomCommand(issueEnvironment.react, { reportFailure: false });
  const values =
    pending.native === reactions
      ? pending.values
      : retainUnacknowledgedIssueReactions(reactions, viewer === null ? new Map() : pending.values);
  if (pending.native !== reactions) setPending({ native: reactions, values });
  const shown = applyPendingPullRequestReactions(reactions, values);
  const offered = offeredIssueReactionContents(contents);

  const toggle = async (content: IssueReactionContent, reacted: boolean) => {
    if (!canReact || !offered.includes(content) || busy.has(content)) return;
    setBusy((current) => new Set([...current, content]));
    setPending({ native: reactions, values: new Map([...values, [content, reacted]]) });
    const result = await react({
      environmentId,
      input: { ...reference, ...(subjectId === undefined ? {} : { subjectId }), content, reacted },
    });
    setBusy((current) => {
      const next = new Set(current);
      next.delete(content);
      return next;
    });
    if (result._tag === "Failure") {
      setPending((current) => {
        if (viewer === null && current.native !== reactions) return current;
        const next = new Map(current.values);
        const previous = values.get(content);
        if (previous === undefined) next.delete(content);
        else next.set(content, previous);
        return { native: current.native, values: next };
      });
      toastManager.add({ type: "error", title: "The reaction could not be saved" });
    }
  };

  if (shown.length === 0 && !canReact) return null;
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
      {shown.map((reaction) => (
        <Tooltip key={reaction.content}>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-pressed={reaction.viewerHasReacted}
                aria-label={`${pullRequestReactionName(reaction.content)}, ${reaction.count}`}
                disabled={
                  !canReact || !offered.includes(reaction.content) || busy.has(reaction.content)
                }
                className={cn(
                  REACTION_PILL_CLASS,
                  reaction.viewerHasReacted
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border/70 bg-muted/40 text-muted-foreground",
                  canReact && offered.includes(reaction.content)
                    ? "hover:border-primary/60"
                    : "cursor-default",
                )}
                onClick={() => void toggle(reaction.content, !reaction.viewerHasReacted)}
              />
            }
          >
            <span aria-hidden>{pullRequestReactionEmoji(reaction.content)}</span>
            <span className="tabular-nums">{reaction.count}</span>
          </TooltipTrigger>
          <TooltipPopup side="top">{pullRequestReactionTooltip(reaction)}</TooltipPopup>
        </Tooltip>
      ))}
      {canReact && offered.length > 0 ? (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Add a reaction"
                className={cn(
                  REACTION_PILL_CLASS,
                  "border-border/70 px-1.5 text-muted-foreground hover:border-primary/60 hover:text-foreground",
                )}
              />
            }
          >
            <SmilePlusIcon aria-hidden className="size-3.5" />
          </PopoverTrigger>
          <PopoverPopup align="start" side="top" padding="compact">
            <div className="flex items-center gap-0.5">
              {offered.map((content) => {
                const reacted =
                  shown.find((reaction) => reaction.content === content)?.viewerHasReacted ?? false;
                return (
                  <button
                    key={content}
                    type="button"
                    aria-pressed={reacted}
                    disabled={busy.has(content)}
                    aria-label={pullRequestReactionName(content)}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-md text-base outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      reacted && "bg-primary/10",
                    )}
                    onClick={() => {
                      setPickerOpen(false);
                      void toggle(content, !reacted);
                    }}
                  >
                    <span aria-hidden>{pullRequestReactionEmoji(content)}</span>
                  </button>
                );
              })}
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}

/** Label and assignee pickers read the scope's candidates once, when they open. */
export function IssueLabelPicker({
  environmentId,
  reference,
  detail,
  allowed,
  disabledReason,
  onUpdated,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  detail: IssueDetail;
  allowed: boolean;
  disabledReason: string;
  onUpdated: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<IssuePickerConfirmed | null>(null);
  const candidatesQuery = useEnvironmentQuery(
    open ? issueEnvironment.candidates({ environmentId, input: reference }) : null,
  );
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const held = heldIssuePicker(detail, "labels", confirmed, environmentId);
  if (held !== confirmed) setConfirmed(held);
  const selectedIds = issuePickerIds(detail, "labels", held, environmentId);
  const applied = new Set(selectedIds);
  const candidates = useMemo(
    () => issueLabelOptions(detail.labels, candidatesQuery.data?.labels ?? [], query),
    [detail.labels, candidatesQuery.data, query],
  );
  const toggle = async (candidate: IssueLabelCandidate) => {
    if (pending !== null) return;
    setPending(issueLabelId(candidate));
    const labels = nextIssueLabels(selectedIds, issueLabelId(candidate));
    const result = await update({ environmentId, input: { ...reference, labels } });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not change labels",
        description: readableFailure(squashAtomCommandFailure(result), "The tracker refused it."),
      });
      return;
    }
    setConfirmed({ base: detail, ids: labels, environmentId, kind: "labels" });
    onUpdated?.();
  };
  return (
    <PullRequestCandidatePicker
      icon={<TagIcon className="size-3.5" />}
      label="Change labels"
      allowed={allowed}
      disabledReason={disabledReason}
      open={open}
      onOpenChange={setOpen}
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
      candidateKey={(candidate) => issueLabelId(candidate)}
      disabled={pending !== null}
      onSelect={(candidate) => void toggle(candidate)}
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
            {applied.has(issueLabelId(candidate)) ? (
              <CheckIcon aria-label="Applied" className="size-3.5 shrink-0" />
            ) : null}
          </>
        );
      }}
    </PullRequestCandidatePicker>
  );
}

export function IssueAssigneePicker({
  environmentId,
  reference,
  detail,
  allowed,
  disabledReason,
  onUpdated,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  detail: IssueDetail;
  allowed: boolean;
  disabledReason: string;
  onUpdated: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<IssuePickerConfirmed | null>(null);
  const candidatesQuery = useEnvironmentQuery(
    open ? issueEnvironment.candidates({ environmentId, input: reference }) : null,
  );
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const held = heldIssuePicker(detail, "assignees", confirmed, environmentId);
  if (held !== confirmed) setConfirmed(held);
  const selectedIds = issuePickerIds(detail, "assignees", held, environmentId);
  const candidates = useMemo(
    () => issueAssigneeOptions(detail.assignees, candidatesQuery.data?.assignees ?? [], query),
    [detail.assignees, candidatesQuery.data, query],
  );
  const toggle = async (candidate: IssueAssigneeCandidate) => {
    if (pending !== null) return;
    setPending(candidate.id);
    const assignees = nextIssueAssignees(
      selectedIds,
      candidate.id,
      detail.capabilities.maxAssignees,
    );
    const result = await update({ environmentId, input: { ...reference, assignees } });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not change assignees",
        description: readableFailure(squashAtomCommandFailure(result), "The tracker refused it."),
      });
      return;
    }
    setConfirmed({ base: detail, ids: assignees, environmentId, kind: "assignees" });
    onUpdated?.();
  };
  return (
    <PullRequestCandidatePicker
      icon={<UserPlusIcon className="size-3.5" />}
      label="Change assignees"
      allowed={allowed}
      disabledReason={disabledReason}
      open={open}
      onOpenChange={setOpen}
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
      disabled={pending !== null}
      onSelect={(candidate) => void toggle(candidate)}
    >
      {(candidate) => (
        <>
          <PullRequestActorLabel actor={candidate} tooltip={false} className="min-w-0 flex-1" />
          {isIssueAssignee(selectedIds, candidate.id) ? (
            <CheckIcon aria-label="Assigned" className="size-3.5 shrink-0" />
          ) : null}
        </>
      )}
    </PullRequestCandidatePicker>
  );
}

function eventSentence(event: IssueEvent): string {
  switch (event.kind) {
    case "closed":
      return event.detail
        ? `closed this as ${issueCloseReasonLabel(event.detail).toLowerCase()}`
        : "closed this";
    case "reopened":
      return "reopened this";
    case "labeled":
      return event.detail ? `added the ${event.detail} label` : "added a label";
    case "unlabeled":
      return event.detail ? `removed the ${event.detail} label` : "removed a label";
    case "assigned":
      return event.detail ? `assigned ${event.detail}` : "assigned someone";
    case "unassigned":
      return event.detail ? `unassigned ${event.detail}` : "unassigned someone";
    case "renamed":
      return event.detail ? `renamed this to “${event.detail}”` : "renamed this";
    case "referenced":
      return event.detail ? `referenced this from ${event.detail}` : "referenced this";
    case "state-changed":
      return event.detail ? `moved this to ${event.detail}` : "changed the state";
  }
}

type TimelineItem =
  | { kind: "comment"; at: string; comment: IssueComment }
  | { kind: "event"; at: string; event: IssueEvent };

function LinkedPullRequestRow({
  link,
  onSelect,
}: {
  link: IssueLinkedPullRequest;
  onSelect: (() => void) | null;
}) {
  const body = (
    <>
      {link.state === null ? (
        <PullRequestGlyph.pullRequest
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
      ) : (
        <PullRequestStateGlyph state={link.state} isDraft={link.isDraft} />
      )}
      <span className="min-w-0 flex-1 truncate text-sm">{link.title}</span>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {link.repository}#{link.number}
      </span>
      {link.closesIssue ? (
        <span className="shrink-0 text-2xs text-muted-foreground">closes</span>
      ) : null}
    </>
  );
  const className =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60";
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
  onSelectPullRequest,
  onUpdated,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  threadRef?: ScopedThreadRef | null;
  /** Opens a linked change request beside this one; absent, the link goes to the host. */
  onSelectPullRequest?: ((target: IssueLinkedPullRequestTarget) => void) | undefined;
  onUpdated?: (() => void) | undefined;
}) {
  const detailQuery = useEnvironmentQuery(
    issueEnvironment.detail({ environmentId, input: reference }),
  );
  const detail = detailQuery.data;
  const canWrite = useAtomValue(issueEnvironment.comment.permissionAtom(environmentId));
  const projects = useProjects();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const cwd =
    projects.find((p) => p.environmentId === environmentId && p.id === reference.projectId)
      ?.workspaceRoot ?? "";

  const [older, setOlder] = useState<IssueOlderComments | null>(null);
  const loadComments = useAtomCommand(issueEnvironment.comments, { reportFailure: false });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const comment = useAtomCommand(issueEnvironment.comment, { reportFailure: false });
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
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
    return <PullRequestDetailGhost />;
  }

  const { comments, cursor: nextCursor, held: heldComments } = issueCommentsView(detail, older);
  const timeline: ReadonlyArray<TimelineItem> = [
    ...comments.map((c): TimelineItem => ({ kind: "comment", at: c.createdAt, comment: c })),
    ...detail.events.map((e): TimelineItem => ({ kind: "event", at: e.createdAt, event: e })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const blocked = writeBlockReason(detail, canWrite);
  const may = (capability: boolean, permission: boolean) =>
    blocked === null && capability && permission;
  const canComment = may(detail.capabilities.comment, detail.viewerPermissions.comment);
  const canEdit = may(detail.capabilities.edit, detail.viewerPermissions.edit);
  const canEditBody = canEdit && detail.bodyEditable !== false;
  const canLabel = may(detail.capabilities.labels, detail.viewerPermissions.labels);
  const canAssign = may(detail.capabilities.assignees, detail.viewerPermissions.assignees);
  const canReact = blocked === null && detail.capabilities.reactions;
  const canReactToComment = blocked === null && issueSupportsReactions(detail.capabilities, true);
  const states = detail.states ?? detail.capabilities.states;
  const canSetState = may(states.length > 0, detail.viewerPermissions.setState);
  const tracker = issueTrackerPresentation(detail.tracker);
  const reactionOwner = `${environmentId}\u0000${issueEntryKey(detail)}\u0000${detail.viewer ?? ""}`;
  const isCurrentState = (state: IssueState) =>
    state.category === detail.state.category &&
    (state.name === detail.state.name || state.name === state.category);
  const closeReasonsFor = (state: IssueState) =>
    state.category === "closed"
      ? detail.capabilities.closeReasons.filter(
          (reason) => !isCurrentState(state) || reason !== detail.state.closeReason,
        )
      : [];
  const otherStates = states.filter(
    (state) => !isCurrentState(state) || closeReasonsFor(state).length > 0,
  );
  const closingStates = otherStates.filter((state) => state.category === "closed");
  const openingStates = otherStates.filter((state) => state.category === "open");

  const loadOlder = async () => {
    if (nextCursor === null || loadingOlder) return;
    setLoadingOlder(true);
    const result = await loadComments({
      environmentId,
      input: {
        ...reference,
        cursor: nextCursor,
        ...(detail.viewer === null ? {} : { viewer: detail.viewer }),
      },
    });
    setLoadingOlder(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Older comments could not be read" });
      return;
    }
    setOlder(appendOlderIssueComments(detail, heldComments, result.value));
  };

  const submitComment = async () => {
    const body = draft.trim();
    if (body.length === 0 || submitting) return;
    setSubmitting(true);
    const result = await comment({ environmentId, input: { ...reference, body: draft } });
    setSubmitting(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "The comment could not be posted",
        description: readableFailure(squashAtomCommandFailure(result), "The tracker refused it."),
      });
      return;
    }
    setDraft("");
    onUpdated?.();
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
    setEditing(null);
    onUpdated?.();
  };

  const moveTo = async (state: string, closeReason?: string) => {
    if (changingState) return;
    setChangingState(true);
    const result = await setState({
      environmentId,
      input: { ...reference, state, ...(closeReason === undefined ? {} : { closeReason }) },
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
    onUpdated?.();
  };

  const stateControl: ReactNode = canSetState ? (
    <span className="flex shrink-0 items-center gap-1">
      {openingStates.length === 1 && closingStates.length === 0 ? (
        <Button
          size="xs"
          variant="outline"
          disabled={changingState}
          onClick={() => void moveTo(openingStates[0]!.name)}
        >
          Reopen
        </Button>
      ) : null}
      {closingStates.length === 1 &&
      detail.capabilities.closeReasons.length === 0 &&
      openingStates.length === 0 ? (
        <Button
          size="xs"
          variant="outline"
          disabled={changingState}
          onClick={() => void moveTo(closingStates[0]!.name)}
        >
          Close
        </Button>
      ) : null}
      {(closingStates.length > 0 && detail.capabilities.closeReasons.length > 0) ||
      otherStates.length > 1 ? (
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="outline" disabled={changingState} />}>
            {detail.state.category === "open" ? "Close" : "Change state"}
            <ChevronDownIcon aria-hidden className="size-3" />
          </MenuTrigger>
          <MenuPopup align="end">
            {otherStates.flatMap((state) =>
              state.category === "closed" && detail.capabilities.closeReasons.length > 0
                ? closeReasonsFor(state).map((reason) => (
                    <MenuItem
                      key={`${state.name}:${reason}`}
                      onClick={() => void moveTo(state.name, reason)}
                    >
                      {state.name === "closed" ? "Close" : state.name} as{" "}
                      {issueCloseReasonLabel(reason).toLowerCase()}
                    </MenuItem>
                  ))
                : [
                    <MenuItem key={state.name} onClick={() => void moveTo(state.name)}>
                      {state.category === "open" && state.name === "open"
                        ? "Reopen"
                        : state.name === "closed"
                          ? "Close"
                          : `Move to ${state.name}`}
                    </MenuItem>,
                  ],
            )}
          </MenuPopup>
        </Menu>
      ) : null}
    </span>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 px-4 pt-3 pb-4">
          <PullRequestDetailTitleRow className="gap-2">
            <IssueStateGlyph state={detail.state} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              <tracker.Icon aria-hidden className="mr-1 inline size-3 align-[-2px]" />
              {issueDisplayLabel(detail.scope, detail.displayKey)}
            </span>
            {stateControl}
            {threadRef ? (
              <IssueThreadLinkButton
                environmentId={environmentId}
                reference={{ ...reference, host: reference.host ?? detail.host }}
                url={detail.url}
                threadRef={threadRef}
              />
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh issue"
              disabled={detailQuery.isPending}
              onClick={detailQuery.refresh}
            >
              <RefreshIcon size="sm" refreshing={detailQuery.isPending} />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Open on ${tracker.providerName}`}
              render={<a href={detail.url} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
            </Button>
          </PullRequestDetailTitleRow>

          {editing === "title" ? (
            <form
              className="flex items-center gap-2"
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
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  setEditing(null);
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
            <div className="group flex items-start gap-1">
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
            </div>
          )}

          <PullRequestMetaLine className="text-xs text-muted-foreground">
            <PullRequestActorLabel actor={detail.author} />
            <span>opened {formatRelativeTimeLabel(detail.createdAt)}</span>
            {detail.closedAt ? (
              <span>closed {formatRelativeTimeLabel(detail.closedAt)}</span>
            ) : null}
            {detail.writable ? null : <span>Read-only</span>}
          </PullRequestMetaLine>

          <div className="flex flex-wrap items-center gap-1.5">
            {detail.labels.map((label) => (
              <PullRequestLabelChip key={issueLabelId(label)} label={label} />
            ))}
            {detail.capabilities.labels ? (
              <IssueLabelPicker
                environmentId={environmentId}
                reference={reference}
                detail={detail}
                allowed={canLabel && detail.labelsTruncated !== true}
                disabledReason={
                  blocked ??
                  (detail.labelsTruncated === true
                    ? `Not every label is shown here, so change them on ${tracker.providerName}.`
                    : "Changing labels needs triage access on this tracker.")
                }
                onUpdated={onUpdated}
              />
            ) : null}
          </div>
          {detail.labelsTruncated === true ? (
            <IssueTruncatedNote
              text="Not every label is shown here."
              url={detail.url}
              providerName={tracker.providerName}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">Assignees</span>
            {detail.assignees.length === 0 ? <span>none</span> : null}
            {detail.assignees.map((actor) => (
              <PullRequestActorLabel key={issueAssigneeId(actor)} actor={actor} />
            ))}
            {detail.capabilities.assignees ? (
              <IssueAssigneePicker
                environmentId={environmentId}
                reference={reference}
                detail={detail}
                allowed={canAssign}
                disabledReason={
                  blocked ?? "Changing assignees needs triage access on this tracker."
                }
                onUpdated={onUpdated}
              />
            ) : null}
          </div>

          <section className="group flex flex-col gap-2 rounded-lg border border-border/60 p-3">
            <div className="flex items-start gap-1">
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">Description</span>
              {canEditBody && editing !== "body" ? (
                <PullRequestEditButton
                  aria-label="Edit description"
                  onClick={() => setEditing("body")}
                />
              ) : null}
              {canEdit && !canEditBody ? (
                <InlineButton
                  tone="muted"
                  render={<a href={detail.url} target="_blank" rel="noopener noreferrer" />}
                >
                  Edit description on {tracker.providerName}
                </InlineButton>
              ) : null}
            </div>
            {editing === "body" && canEditBody ? (
              <PullRequestMarkdownEditor
                value={detail.body}
                cwd={cwd}
                environmentId={environmentId}
                threadRef={threadRef}
                label="Description"
                saving={saving}
                allowEmpty
                onSave={(next) => void save({ body: next })}
                onCancel={() => setEditing(null)}
              />
            ) : detail.body.trim().length > 0 ? (
              <PullRequestCommentBody
                text={detail.body}
                cwd={cwd}
                environmentId={environmentId}
                threadRef={threadRef}
              />
            ) : (
              <p className="text-sm text-muted-foreground italic">No description.</p>
            )}
            {detail.reactions !== undefined ? (
              <IssueReactionBar
                key={reactionOwner}
                reactions={detail.reactions}
                canReact={canReact}
                contents={detail.capabilities.reactionContents}
                viewer={detail.viewer}
                environmentId={environmentId}
                reference={reference}
              />
            ) : null}
            {detail.reactionsTruncated === true ? (
              <IssueTruncatedNote
                text="Reaction details are limited."
                url={detail.url}
                providerName={tracker.providerName}
              />
            ) : null}
          </section>

          {detail.linkedPullRequests.length > 0 ? (
            <section className="flex flex-col gap-1">
              <h3 className="text-xs text-muted-foreground">Linked pull requests</h3>
              {detail.linkedPullRequests.map((link) => {
                const target = linkedPullRequestTarget(
                  link,
                  reference,
                  environmentId,
                  projects,
                  serverConfig?.environment.capabilities,
                );
                return (
                  <LinkedPullRequestRow
                    key={link.url}
                    link={link}
                    onSelect={
                      onSelectPullRequest && target ? () => onSelectPullRequest(target) : null
                    }
                  />
                );
              })}
            </section>
          ) : null}

          <section className="flex flex-col gap-3">
            <h3 className="text-xs text-muted-foreground">
              Activity
              {detail.commentCount !== null && detail.commentCount > 0
                ? ` · ${detail.commentCount} ${detail.commentCount === 1 ? "comment" : "comments"}`
                : ""}
            </h3>
            {detail.historyTruncated === true ? (
              <IssueTruncatedNote
                text="Some older activity is not shown here."
                url={detail.url}
                providerName={tracker.providerName}
              />
            ) : null}
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
                        className="text-muted-foreground"
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
                  <PullRequestCommentBody
                    text={item.comment.body}
                    cwd={cwd}
                    environmentId={environmentId}
                    threadRef={threadRef}
                  />
                  {item.comment.reactions !== undefined ||
                  issueSupportsReactions(detail.capabilities, true) ? (
                    <IssueReactionBar
                      key={reactionOwner}
                      reactions={item.comment.reactions ?? []}
                      canReact={canReactToComment}
                      contents={detail.capabilities.reactionContents}
                      subjectId={item.comment.id}
                      viewer={detail.viewer}
                      environmentId={environmentId}
                      reference={reference}
                    />
                  ) : null}
                  {item.comment.reactionsTruncated === true ? (
                    <IssueTruncatedNote
                      text="Reaction details are limited."
                      url={item.comment.url ?? detail.url}
                      providerName={tracker.providerName}
                    />
                  ) : null}
                </article>
              ) : (
                <PullRequestMetaLine
                  key={`e:${item.event.id}`}
                  className="px-1 text-xs text-muted-foreground"
                >
                  <PullRequestActorLabel actor={item.event.actor} />
                  <span>{eventSentence(item.event)}</span>
                  <span>{formatRelativeTimeLabel(item.event.createdAt)}</span>
                </PullRequestMetaLine>
              ),
            )}
          </section>
        </div>
      </div>

      {detail.capabilities.comment ? (
        <form
          className="flex flex-col gap-2 border-t border-border/60 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submitComment();
          }}
        >
          <Textarea
            size="sm"
            aria-label="Add a comment"
            placeholder={canComment ? "Leave a comment" : (blocked ?? "You cannot comment here.")}
            value={draft}
            disabled={!canComment || submitting}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && draft.length > 0) {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submitComment();
              }
            }}
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={!canComment || submitting || draft.trim().length === 0}
            >
              <SendIcon aria-hidden className="size-3.5" />
              {submitting ? "Posting…" : "Comment"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
