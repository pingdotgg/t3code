import { useAtomValue } from "@effect/atom-react";
import { prependIssueComments } from "@t3tools/client-runtime/state/issues";
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
  PullRequestRef,
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
import {
  applyPendingPullRequestReactions,
  PULL_REQUEST_REACTION_ORDER,
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

const REACTION_PILL_CLASS =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The pull-request reaction bar's shape, routed to the issue tracker instead of the host. */
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState<ReadonlyMap<IssueReactionContent, boolean>>(new Map());
  const react = useAtomCommand(issueEnvironment.react, { reportFailure: false });
  const shown = applyPendingPullRequestReactions(reactions, pending);

  const toggle = async (content: IssueReactionContent, reacted: boolean) => {
    setPending((current) => new Map([...current, [content, reacted]]));
    const result = await react({
      environmentId,
      input: { ...reference, ...(subjectId === undefined ? {} : { subjectId }), content, reacted },
    });
    setPending((current) => {
      const next = new Map(current);
      next.delete(content);
      return next;
    });
    if (result._tag === "Failure") {
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
                disabled={!canReact}
                className={cn(
                  REACTION_PILL_CLASS,
                  reaction.viewerHasReacted
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border/70 bg-muted/40 text-muted-foreground",
                  canReact ? "hover:border-primary/60" : "cursor-default",
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
      {canReact ? (
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
              {PULL_REQUEST_REACTION_ORDER.map((content) => {
                const reacted =
                  shown.find((reaction) => reaction.content === content)?.viewerHasReacted ?? false;
                return (
                  <button
                    key={content}
                    type="button"
                    aria-pressed={reacted}
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
  const [pending, setPending] = useState<string | null>(null);
  const candidatesQuery = useEnvironmentQuery(
    open ? issueEnvironment.candidates({ environmentId, input: reference }) : null,
  );
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const applied = new Set(detail.labels.map((label) => label.name));
  const candidates = useMemo(() => {
    const needle = query.toLowerCase();
    return (candidatesQuery.data?.labels ?? []).filter(
      (label) =>
        needle.length === 0 ||
        label.name.toLowerCase().includes(needle) ||
        (label.description ?? "").toLowerCase().includes(needle),
    );
  }, [candidatesQuery.data, query]);
  const toggle = async (candidate: IssueLabelCandidate) => {
    if (pending !== null) return;
    setPending(candidate.name);
    const labels = applied.has(candidate.name)
      ? detail.labels.filter((label) => label.name !== candidate.name).map((label) => label.name)
      : [...applied, candidate.name];
    const result = await update({ environmentId, input: { ...reference, labels } });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not change labels",
        description: readableFailure(squashAtomCommandFailure(result), "The tracker refused it."),
      });
    }
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
      candidateKey={(candidate) => candidate.name}
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
            {applied.has(candidate.name) ? (
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
  const [pending, setPending] = useState<string | null>(null);
  const candidatesQuery = useEnvironmentQuery(
    open ? issueEnvironment.candidates({ environmentId, input: reference }) : null,
  );
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const assigned = new Set(detail.assignees.map((actor) => actor.login.toLowerCase()));
  const candidates = useMemo(() => {
    const needle = query.toLowerCase();
    return (candidatesQuery.data?.assignees ?? []).filter(
      (candidate) =>
        needle.length === 0 ||
        candidate.login.toLowerCase().includes(needle) ||
        (candidate.name ?? "").toLowerCase().includes(needle),
    );
  }, [candidatesQuery.data, query]);
  const toggle = async (candidate: IssueAssigneeCandidate) => {
    if (pending !== null) return;
    setPending(candidate.id);
    const login = candidate.login.toLowerCase();
    const assignees = assigned.has(login)
      ? detail.assignees.filter((actor) => actor.login.toLowerCase() !== login).map((a) => a.login)
      : [...detail.assignees.map((actor) => actor.login), candidate.id];
    const result = await update({ environmentId, input: { ...reference, assignees } });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not change assignees",
        description: readableFailure(squashAtomCommandFailure(result), "The tracker refused it."),
      });
    }
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
          {assigned.has(candidate.login.toLowerCase()) ? (
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
      <PullRequestStateGlyph state={link.state} isDraft={link.isDraft} />
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
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
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

  // Older pages are tied to the cursor the detail was read with; a refreshed detail starts over.
  const olderComments = older?.seed === detail.commentsCursor ? older.comments : [];
  const nextCursor = older?.seed === detail.commentsCursor ? older.cursor : detail.commentsCursor;
  const comments = prependIssueComments(detail.comments, olderComments);
  const timeline: ReadonlyArray<TimelineItem> = [
    ...comments.map((c): TimelineItem => ({ kind: "comment", at: c.createdAt, comment: c })),
    ...detail.events.map((e): TimelineItem => ({ kind: "event", at: e.createdAt, event: e })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const blocked = writeBlockReason(detail, canWrite);
  const may = (capability: boolean, permission: boolean) =>
    blocked === null && capability && permission;
  const canComment = may(detail.capabilities.comment, detail.viewerPermissions.comment);
  const canEdit = may(detail.capabilities.edit, detail.viewerPermissions.edit);
  const canLabel = may(detail.capabilities.labels, detail.viewerPermissions.labels);
  const canAssign = may(detail.capabilities.assignees, detail.viewerPermissions.assignees);
  const canReact = blocked === null && detail.capabilities.reactions;
  const canSetState = may(detail.capabilities.states.length > 0, detail.viewerPermissions.setState);
  const tracker = issueTrackerPresentation(detail.tracker);
  const otherStates = detail.capabilities.states.filter(
    (state) => state.category !== detail.state.category || state.name !== detail.state.name,
  );
  const closingStates = otherStates.filter((state) => state.category === "closed");
  const openingStates = otherStates.filter((state) => state.category === "open");

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
    }
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
                ? detail.capabilities.closeReasons.map((reason) => (
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
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {detail.displayKey}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              <tracker.Icon aria-hidden className="mr-1 inline size-3 align-[-2px]" />
              {detail.scope}
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
              <PullRequestLabelChip key={label.name} label={label} />
            ))}
            {detail.capabilities.labels ? (
              <IssueLabelPicker
                environmentId={environmentId}
                reference={reference}
                detail={detail}
                allowed={canLabel}
                disabledReason={blocked ?? "Changing labels needs triage access on this tracker."}
              />
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">Assignees</span>
            {detail.assignees.length === 0 ? <span>none</span> : null}
            {detail.assignees.map((actor) => (
              <PullRequestActorLabel key={actor.login} actor={actor} />
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
              />
            ) : null}
          </div>

          <section className="group flex flex-col gap-2 rounded-lg border border-border/60 p-3">
            <div className="flex items-start gap-1">
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">Description</span>
              {canEdit && editing !== "body" ? (
                <PullRequestEditButton
                  aria-label="Edit description"
                  onClick={() => setEditing("body")}
                />
              ) : null}
            </div>
            {editing === "body" ? (
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
                reactions={detail.reactions}
                canReact={canReact}
                environmentId={environmentId}
                reference={reference}
              />
            ) : null}
          </section>

          {detail.linkedPullRequests.length > 0 ? (
            <section className="flex flex-col gap-1">
              <h3 className="text-xs text-muted-foreground">Linked pull requests</h3>
              {detail.linkedPullRequests.map((link) => (
                <LinkedPullRequestRow
                  key={`${link.repository}#${link.number}`}
                  link={link}
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
            </section>
          ) : null}

          <section className="flex flex-col gap-3">
            <h3 className="text-xs text-muted-foreground">
              Activity
              {detail.commentCount > 0
                ? ` · ${detail.commentCount} ${detail.commentCount === 1 ? "comment" : "comments"}`
                : ""}
            </h3>
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
