import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { issueEventSentence, issueWriteAccess } from "@t3tools/client-runtime/issue-presentation";
import { createIssueCommentPager } from "@t3tools/client-runtime/state/issues";
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
  ExternalLinkIcon,
  MoreHorizontalIcon,
  TagIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useContext, useState, type ReactNode } from "react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { m } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";
import { issueEnvironment, refreshIssueLists } from "~/state/issues";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { PULL_REQUEST_ROW_CLASS } from "../pullRequest/PullRequestListRow";
import {
  PAGE_ROW_CLASS,
  PAGE_ROW_HOVER_CLASS,
  PAGE_ROW_PRESS_CLASS,
} from "../pullRequest/PullRequestRow";
import {
  PullRequestSection,
  WorkItemCommentCard,
  WorkItemCommentIdentity,
} from "../pullRequest/PullRequestSummaryTab";
import { toastManager } from "../ui/toast";
import { PullRequestCandidatePicker } from "../pullRequest/PullRequestCandidatePicker";
import { PullRequestCommentBody } from "../pullRequest/PullRequestCommentBody";
import { WorkItemDetailCrumbs } from "../pullRequest/PullRequestDetailCrumbs";
import { PullRequestEditButton } from "../pullRequest/PullRequestEditButton";
import { PullRequestMarkdownEditor } from "../pullRequest/PullRequestMarkdownEditor";
import { PullRequestReviewEntry } from "../pullRequest/PullRequestQuietEntries";
import { WorkItemTitleEditor } from "../pullRequest/PullRequestTitleEditor";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { pullRequestLabelColor } from "../pullRequest/pullRequestList.logic";
import {
  PullRequestActorLabel,
  PullRequestLabelChip,
  PullRequestStateGlyph,
} from "../pullRequest/pullRequestPresentation";
import { IssueCommentComposer } from "./IssueCommentComposer";
import { IssueDetailGhost } from "./IssueDetailGhost";
import { IssueThreadLinks } from "./IssueThreadLinks";
import { ReactionBar } from "../pullRequest/PullRequestReactions";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import { IssueGlyph, issueTrackerPresentation, issueStatePresentation } from "./issuePresentation";

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
  const gt = useGT();
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
        title: m(msg("Could not change labels")),
        description: readableFailure(
          squashAtomCommandFailure(result),
          m(msg("The tracker refused it.")),
        ),
      });
    });
  };
  return (
    <PullRequestCandidatePicker
      icon={<TagIcon className="size-3.5" />}
      label={gt("Change labels")}
      popupWidth="labels"
      allowed={allowed}
      disabledReason={disabledReason}
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      searchLabel={gt("Search labels")}
      isPending={candidatesQuery.isPending && candidatesQuery.data === null}
      error={candidatesQuery.data === null ? candidatesQuery.error : null}
      candidates={candidates}
      emptyLabel={gt("This tracker has no labels.")}
      noMatchLabel={gt("No label matches that.")}
      errorLabel={gt("The labels could not be read.")}
      truncated={candidatesQuery.data?.truncated === true}
      truncatedLabel={gt("More labels exist than are listed here.")}
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
            <span className="min-w-0 flex-1">
              <span className="block truncate">{candidate.name}</span>
              {candidate.description ? (
                <span className="block truncate text-muted-foreground">
                  {candidate.description}
                </span>
              ) : null}
            </span>
            {isSelected(draft, candidate.name, applied.has(candidate.name)) ? (
              <CheckIcon
                aria-label={gt("Applied", { $context: "label is applied to the issue" })}
                className="size-3.5 shrink-0"
              />
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
  const gt = useGT();
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
        title: m(msg("Could not change assignees")),
        description: readableFailure(
          squashAtomCommandFailure(result),
          m(msg("The tracker refused it.")),
        ),
      });
    });
  };
  return (
    <PullRequestCandidatePicker
      icon={<UserPlusIcon className="size-3.5" />}
      label={gt("Change assignees")}
      popupWidth="reviewers"
      allowed={allowed}
      disabledReason={disabledReason}
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      searchLabel={gt("Search people")}
      isPending={candidatesQuery.isPending && candidatesQuery.data === null}
      error={candidatesQuery.data === null ? candidatesQuery.error : null}
      candidates={candidates}
      emptyLabel={gt("Nobody can be assigned here.")}
      noMatchLabel={gt("Nobody matches that.")}
      errorLabel={gt("The people could not be read.")}
      truncated={candidatesQuery.data?.truncated === true}
      truncatedLabel={gt("More people exist than are listed here.")}
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
            <CheckIcon
              aria-label={gt("Assigned", { $context: "person is assigned to the issue" })}
              className="size-3.5 shrink-0"
            />
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
      <span className="min-w-0 flex-1 truncate text-body">{link.title}</span>
      <span className="flex min-w-0 items-center gap-x-2.5 shrink-0 text-meta text-muted-foreground">
        {link.closesIssue ? (
          <span>
            <T>Closes this issue</T>
          </span>
        ) : null}
        <span className="tabular-nums">
          {link.repository.toLowerCase() === scope.toLowerCase() ? "" : link.repository}#
          {link.number}
        </span>
      </span>
    </>
  );
  const className = cn(
    PULL_REQUEST_ROW_CLASS,
    PAGE_ROW_CLASS,
    PAGE_ROW_HOVER_CLASS,
    PAGE_ROW_PRESS_CLASS,
  );
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
  onBack,
  backLabel,
  onSelectPullRequest,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /** The list row this issue was opened from, shown until the detail arrives. */
  listEntry?: IssueListEntry | null;
  threadRef?: ScopedThreadRef | null;
  /** Shown where the issue fills a pane too narrow for the list beside it. */
  onBack?: (() => void) | undefined;
  /** Says where back goes; the issues list by default. */
  backLabel?: string | undefined;
  /** Opens a linked change request beside this one; absent, the link goes to the host. */
  onSelectPullRequest?: ((reference: PullRequestRef) => void) | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const detailAtom = issueEnvironment.detail({ environmentId, input: reference });
  const detailQuery = useEnvironmentQuery(detailAtom);
  const registry = useContext(RegistryContext);
  const [pager] = useState(() => createIssueCommentPager(detailAtom));
  const { comments, nextCursor, loadingOlder, canLoadOlder } = useAtomValue(pager.view);
  const detail = detailQuery.data;
  const canWrite = useAtomValue(issueEnvironment.comment.permissionAtom(environmentId));
  const projects = useProjects();
  const cwd =
    projects.find((p) => p.environmentId === environmentId && p.id === reference.projectId)
      ?.workspaceRoot ?? "";

  const loadComments = useAtomCommand(issueEnvironment.comments, { reportFailure: false });
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  const [editingBody, setEditingBody] = useState(false);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [changingState, setChangingState] = useState(false);

  if (detail === null) {
    if (detailQuery.error !== null && !detailQuery.isPending) {
      return (
        <PullRequestsUnavailableState
          icon={IssueGlyph.issue}
          title={gt("Could not load this issue")}
          error={detailQuery.error}
          onRetry={detailQuery.refresh}
        />
      );
    }
    return <IssueDetailGhost seed={listEntry} />;
  }

  const timeline: ReadonlyArray<TimelineItem> = [
    ...comments.map((c): TimelineItem => ({ kind: "comment", at: c.createdAt, comment: c })),
    ...detail.events.map((e): TimelineItem => ({ kind: "event", at: e.createdAt, event: e })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const access = issueWriteAccess(detail, canWrite, messages);
  const { blocked } = access;
  const canComment = access.comment;
  const canEdit = access.edit;
  const canLabel = access.labels;
  const canAssign = access.assignees;
  const canReact = access.react;
  const otherStates = access.states;
  const tracker = issueTrackerPresentation(detail.tracker);
  const currentState = issueStatePresentation(detail.state);
  const sourceControl = sourceControlClients.find(detail.tracker);
  const profileUrl = (actor: { readonly login: string } | null) =>
    actor && sourceControl ? sourceControl.authorProfileUrl(actor.login, detail.url) : null;
  const openOnHostText = gt("Open {issue} on {provider}", {
    issue: detail.displayKey,
    provider: tracker.providerName,
  });

  const loadOlder = async () => {
    const failure = await pager.loadOlder(registry, (cursor) =>
      loadComments({ environmentId, input: { ...reference, cursor } }),
    );
    if (failure) {
      toastManager.add({ type: "error", title: m(msg("Older comments could not be read")) });
    }
  };

  const save = async (patch: { title?: string; body?: string }) => {
    setSaving(true);
    const result = await update({ environmentId, input: { ...reference, ...patch } });
    setSaving(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("The issue could not be updated")),
        description: readableFailure(
          squashAtomCommandFailure(result),
          m(msg("The tracker refused it.")),
        ),
      });
      return;
    }
    refreshIssueLists(environmentId);
    if (patch.title !== undefined) setTitleDraft(null);
    if (patch.body !== undefined) setEditingBody(false);
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
        title: m(msg("The state could not be changed")),
        description: readableFailure(
          squashAtomCommandFailure(result),
          m(msg("The tracker refused it.")),
        ),
      });
      return;
    }
    refreshIssueLists(environmentId);
  };

  // Plain open reads as an open pull request does, with no badge after the key; a workflow
  // tracker's own open states, such as "In Review", still say which.
  const stateBadge: ReactNode =
    detail.state.category === "open" && detail.state.name.toLowerCase() === "open" ? null : (
      <Badge
        size="status"
        variant={
          detail.state.category === "open"
            ? "success"
            : detail.state.closeReason !== undefined && detail.state.closeReason !== "completed"
              ? "secondary"
              : "merged"
        }
      >
        <currentState.Icon aria-hidden />
        <span className="@max-sm/pr-header:sr-only">{currentState.label}</span>
      </Badge>
    );
  const actionsLabel = gt("More issue actions");
  // Moving the issue lives in the actions menu, where a pull request's close and reopen do.
  const actionsMenu = (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<Button aria-label={actionsLabel} size="icon-xs" variant="ghost-muted" />}
            >
              {detailQuery.isPending || changingState ? (
                <RefreshIcon refreshing size="md" />
              ) : (
                <MoreHorizontalIcon className="size-4" />
              )}
            </MenuTrigger>
          }
        />
        <TooltipPopup>{actionsLabel}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom">
        <MenuItem
          disabled={detailQuery.isPending}
          onClick={() => void pager.refresh(registry, detailQuery.refresh)}
        >
          <RefreshIcon size="sm" refreshing={detailQuery.isPending} />
          <T context="verb, menu item">Refresh</T>
        </MenuItem>
        {otherStates.length > 0 ? <MenuSeparator /> : null}
        {otherStates.map((state) => {
          const presentation = issueStatePresentation(state);
          return (
            <MenuItem
              key={state.name}
              disabled={changingState}
              onClick={() => void moveTo(state.name)}
            >
              <presentation.Icon
                aria-hidden
                className={cn("size-3.5 shrink-0", presentation.toneClassName)}
              />
              {state.name}
            </MenuItem>
          );
        })}
        <MenuSeparator />
        <MenuItem onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}>
          <ExternalLinkIcon className="size-3.5" />
          {openOnHostText}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );

  return (
    <div
      className="relative flex h-[calc(100%+var(--surface-top-inset,0px))] min-h-0 w-full flex-col bg-(--code-surface) pt-under-header"
      data-surface-reaches-under-header=""
    >
      <div className="@container/pr-header grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2">
        <WorkItemDetailCrumbs
          subject={{
            url: detail.url,
            scope: detail.scope,
            scopeUrl: null,
            keyLabel: detail.displayKey,
            keyAriaLabel: openOnHostText,
            openLabel: openOnHostText,
          }}
          toneClassName={currentState.toneClassName}
          openOnHostText={openOnHostText}
          badge={stateBadge}
          {...(onBack
            ? {
                back: {
                  onBack,
                  label: backLabel ?? gt("Back to issues"),
                  tooltip: backLabel ?? gt("Back to issues"),
                },
              }
            : {})}
        />
        <div className="mt-2 mr-3 flex h-6 shrink-0 select-none items-center justify-end gap-1">
          <IssueThreadLinks
            key={`${environmentId}:${detail.url}`}
            environmentId={environmentId}
            reference={{ ...reference, host: reference.host ?? detail.host }}
            issue={detail}
            threadRef={threadRef}
          />
          {actionsMenu}
        </div>
        <div className="col-span-2 flex min-w-0 flex-col gap-1.5 px-4 pt-1.5 pb-2.5">
          <WorkItemTitleEditor
            title={detail.title}
            canEdit={canEdit}
            draft={titleDraft}
            onDraftChange={setTitleDraft}
            saving={saving}
            label={gt("Issue title")}
            onSave={(next) => {
              const title = next.trim();
              if (title.length > 0 && title !== detail.title) void save({ title });
              else setTitleDraft(null);
            }}
          />
          <div className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
            <PullRequestActorLabel actor={detail.author} profileUrl={profileUrl(detail.author)} />
            <span className="shrink-0">
              <T>
                opened <Var>{formatRelativeTimeLabel(detail.createdAt, undefined, messages)}</Var>
              </T>
            </span>
            {detail.closedAt ? (
              <span className="shrink-0">
                <T>
                  closed <Var>{formatRelativeTimeLabel(detail.closedAt, undefined, messages)}</Var>
                </T>
              </span>
            ) : null}
            {detail.writable ? null : (
              <span className="shrink-0">
                <T>Read-only</T>
              </span>
            )}
          </div>
        </div>
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          // Room for the floating comment button, so the last comment can scroll clear of it.
          detail.capabilities.comment && "pb-16",
        )}
        data-pull-request-summary-scroll
      >
        {detailQuery.error !== null && !detailQuery.isPending ? (
          <div className="px-4 pb-2">
            <Alert variant="error">
              <AlertTitle>{gt("Could not refresh this issue")}</AlertTitle>
              <AlertDescription>{detailQuery.error}</AlertDescription>
            </Alert>
          </div>
        ) : null}

        <PullRequestSection
          key={`description:${detail.url}`}
          title={gt("Description")}
          keepMounted
        >
          <div className="group">
            {editingBody ? (
              <PullRequestMarkdownEditor
                value={detail.body}
                cwd={cwd}
                environmentId={environmentId}
                threadRef={threadRef}
                label={gt("Description")}
                completionScope={null}
                saving={saving}
                allowEmpty
                onSave={(next) => void save({ body: next })}
                onCancel={() => setEditingBody(false)}
              />
            ) : (
              <div className="flex items-start gap-1">
                <PullRequestCommentBody
                  key={detail.url}
                  variant="description"
                  className="min-w-0 flex-1"
                  text={
                    detail.body.trim().length > 0 ? detail.body : gt("_No description provided._")
                  }
                  cwd={cwd}
                  environmentId={environmentId}
                  threadRef={threadRef}
                />
                {canEdit ? (
                  <PullRequestEditButton
                    aria-label={gt("Edit description")}
                    onClick={() => setEditingBody(true)}
                  />
                ) : null}
              </div>
            )}
          </div>
          {detail.reactions !== undefined ? (
            <div className="mt-2 flex">
              <IssueReactionBar
                reactions={detail.reactions}
                canReact={canReact}
                environmentId={environmentId}
                reference={reference}
              />
            </div>
          ) : null}
          {/* Labels and assignees ride under the description, as a pull request's labels do. */}
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1 text-meta">
            <TagIcon aria-label={gt("Labels")} className="mr-0.5 size-3.5 text-muted-foreground" />
            {detail.labels.length === 0 && !detail.capabilities.labels ? (
              <span className="text-muted-foreground">
                <T context="no labels">None</T>
              </span>
            ) : null}
            {detail.labels.map((label) => (
              <PullRequestLabelChip
                key={label.name}
                label={label}
                size="default"
                className="max-w-48"
                focusable
              />
            ))}
            {detail.capabilities.labels ? (
              <IssueLabelPicker
                environmentId={environmentId}
                reference={reference}
                detail={detail}
                allowed={canLabel}
                disabledReason={
                  blocked ?? gt("Changing labels needs triage access on this tracker.")
                }
              />
            ) : null}
          </div>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-meta">
            <UsersIcon
              aria-label={gt("Assignees")}
              className="mr-0.5 size-3.5 text-muted-foreground"
            />
            {detail.assignees.length === 0 ? (
              <span className="text-muted-foreground">
                <T context="no assignees">None</T>
              </span>
            ) : (
              detail.assignees.map((actor) => (
                <PullRequestActorLabel
                  key={actor.login}
                  actor={actor}
                  profileUrl={profileUrl(actor)}
                />
              ))
            )}
            {detail.capabilities.assignees ? (
              <IssueAssigneePicker
                environmentId={environmentId}
                reference={reference}
                detail={detail}
                allowed={canAssign}
                disabledReason={
                  blocked ?? gt("Changing assignees needs triage access on this tracker.")
                }
              />
            ) : null}
          </div>
        </PullRequestSection>

        {detail.linkedPullRequests.length > 0 ? (
          <PullRequestSection
            key={`linked:${detail.url}`}
            title={gt("Linked pull requests")}
            count={detail.linkedPullRequests.length}
          >
            <div className="-mx-3 flex flex-col">
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
          title={gt("Activity")}
          {...(detail.commentCount > 0 ? { count: detail.commentCount } : {})}
        >
          <div className="flex flex-col gap-3">
            {nextCursor !== null ? (
              <Button
                size="xs"
                variant="ghost"
                className="self-start"
                disabled={!canLoadOlder}
                onClick={() => void loadOlder()}
              >
                {loadingOlder ? <T>Loading…</T> : <T>Load older comments</T>}
              </Button>
            ) : null}
            {timeline.length === 0 ? (
              <p className="py-2 text-meta text-muted-foreground">
                <T>Nothing has happened here yet.</T>
              </p>
            ) : null}
            {timeline.map((item) =>
              item.kind === "comment" ? (
                <WorkItemCommentCard
                  key={`c:${item.comment.id}`}
                  header={
                    <WorkItemCommentIdentity
                      actor={item.comment.author}
                      profileUrl={profileUrl(item.comment.author)}
                      createdAt={item.comment.createdAt}
                      url={item.comment.url}
                    />
                  }
                  reactions={
                    item.comment.reactions !== undefined ? (
                      <IssueReactionBar
                        reactions={item.comment.reactions}
                        canReact={canReact}
                        subjectId={item.comment.id}
                        environmentId={environmentId}
                        reference={reference}
                      />
                    ) : null
                  }
                >
                  <PullRequestCommentBody
                    className="mt-2 px-3"
                    text={item.comment.body}
                    cwd={cwd}
                    environmentId={environmentId}
                    threadRef={threadRef}
                  />
                </WorkItemCommentCard>
              ) : (
                <div key={`e:${item.event.id}`} className="-my-1.5">
                  <PullRequestReviewEntry
                    actor={item.event.actor}
                    profileUrl={profileUrl(item.event.actor)}
                    createdAt={item.event.createdAt}
                    url={null}
                    outcome={null}
                    stateLabel={issueEventSentence(item.event, messages)}
                    preview={null}
                    icon={
                      <IssueGlyph.issue aria-hidden className="size-3.5 text-dim-foreground" />
                    }
                  >
                    {null}
                  </PullRequestReviewEntry>
                </div>
              ),
            )}
          </div>
        </PullRequestSection>
      </div>

      {detail.capabilities.comment ? (
        <div className="absolute right-4 bottom-4 z-20">
          <IssueCommentComposer
            environmentId={environmentId}
            reference={reference}
            displayKey={detail.displayKey}
            blocked={canComment ? null : (blocked ?? gt("You cannot comment here."))}
          />
        </div>
      ) : null}
    </div>
  );
}
