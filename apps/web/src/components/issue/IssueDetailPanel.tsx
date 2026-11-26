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
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  IssueAssigneeCandidate,
  IssueComment,
  IssueDetail,
  IssueEvent,
  IssueEventReference,
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
  TagIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useContext, useState, type ReactNode } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { m } from "~/i18n/messages";
import { issueEnvironment, refreshIssueLists } from "~/state/issues";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useOpenLink } from "~/browser/useOpenLink";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { PullRequestMetaRow, PullRequestSection } from "../pullRequest/PullRequestSummaryTab";
import { toastManager } from "../ui/toast";
import { PullRequestCandidatePicker } from "../pullRequest/PullRequestCandidatePicker";
import { PullRequestCommentBody } from "../pullRequest/PullRequestCommentBody";
import { PullRequestDetailTitleRow } from "../pullRequest/PullRequestDetailLayout";
import { PullRequestEditButton } from "../pullRequest/PullRequestEditButton";
import { PullRequestMarkdown } from "../pullRequest/PullRequestMarkdown";
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
import { IssueThreadLinks } from "./IssueThreadLinks";
import { WorkflowRunsAbout } from "../workflows/WorkflowRunsAbout";
import { ReactionBar } from "../pullRequest/PullRequestReactions";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import { issueTrackerPresentation, issueStatePresentation } from "./issuePresentation";

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
            <span className="min-w-0 flex-1 truncate">
              {candidate.name}
              {candidate.description ? (
                <span className="text-muted-foreground"> · {candidate.description}</span>
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
      <span className="min-w-0 flex-1 truncate text-sm">{link.title}</span>
      <PullRequestMetaLine className="shrink-0 text-xs text-muted-foreground">
        {link.closesIssue ? (
          <span>
            <T>Closes this issue</T>
          </span>
        ) : null}
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

/** The sentence for an event, its source shown as a link where the tracker named one. */
function IssueEventText({
  event,
  sentence,
  onOpen,
}: {
  event: IssueEvent;
  sentence: string;
  /** Opens the source beside this issue, and says whether it did; if not, the link goes to the host. */
  onOpen: (source: IssueEventReference) => boolean;
}) {
  const source = event.reference;
  const at = event.detail === null ? -1 : sentence.indexOf(event.detail);
  if (source === undefined || event.detail === null || at < 0) return <span>{sentence}</span>;
  return (
    <span>
      {sentence.slice(0, at)}
      <InlineButton
        tone="muted"
        render={<a href={source.url} target="_blank" rel="noopener noreferrer" />}
        onClick={(click) => {
          if (!click.metaKey && !click.ctrlKey && onOpen(source)) click.preventDefault();
        }}
      >
        {event.detail}
      </InlineButton>
      {sentence.slice(at + event.detail.length)}
    </span>
  );
}

export function IssueDetailPanel({
  environmentId,
  reference,
  threadRef = null,
  listEntry = null,
  onSelectPullRequest,
  onSelectIssue,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /** The list row this issue was opened from, shown until the detail arrives. */
  listEntry?: IssueListEntry | null;
  threadRef?: ScopedThreadRef | null;
  /** Opens a linked change request beside this one; absent, the link goes to the host. */
  onSelectPullRequest?: ((reference: PullRequestRef) => void) | undefined;
  /** Opens a referenced issue beside this one; absent, the link goes to the host. */
  onSelectIssue?: ((reference: IssueRef & { readonly url: string }) => void) | undefined;
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
  const openLink = useOpenLink(threadRef);
  const [editing, setEditing] = useState<"title" | "body" | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [changingState, setChangingState] = useState(false);

  if (detail === null) {
    if (detailQuery.error !== null && !detailQuery.isPending) {
      return (
        <PullRequestsUnavailableState
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

  const host = reference.host === undefined ? {} : { host: reference.host };
  const openEventSource = (source: IssueEventReference) => {
    if (source.kind === "pull-request") {
      if (!onSelectPullRequest) return false;
      onSelectPullRequest({
        projectId: reference.projectId,
        ...host,
        repository: source.repository,
        number: source.number,
      });
      return true;
    }
    if (!onSelectIssue) return false;
    onSelectIssue({
      projectId: reference.projectId,
      tracker: reference.tracker,
      ...host,
      scope: source.repository,
      key: String(source.number),
      url: source.url,
    });
    return true;
  };

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
              aria-label={gt("Issue state, {state}", { state: currentState.label })}
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
              aria-label={gt("Open {issue} on {provider}", {
                issue: detail.displayKey,
                provider: tracker.providerName,
              })}
              render={<a href={detail.url} target="_blank" rel="noopener noreferrer" />}
              onClick={(event) => {
                event.preventDefault();
                void openLink(detail.url, { event }).catch(console.error);
              }}
            >
              {detail.displayKey}
              <ExternalLinkIcon aria-hidden className="size-2.5" />
            </InlineButton>
            <span className="flex-1" />
            {stateControl}
            <IssueThreadLinks
              key={`${environmentId}:${detail.url}`}
              environmentId={environmentId}
              reference={{ ...reference, host: reference.host ?? detail.host }}
              issue={detail}
              threadRef={threadRef}
            />
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Refresh issue")}
              disabled={detailQuery.isPending}
              onClick={() =>
                void pager.refresh(registry, () =>
                  executeAtomQuery(registry, detailAtom, { refresh: true, reportFailure: false }),
                )
              }
            >
              <RefreshIcon size="sm" refreshing={detailQuery.isPending} />
            </Button>
          </PullRequestDetailTitleRow>

          {detailQuery.error !== null && !detailQuery.isPending ? (
            <div className="mt-2">
              <Alert variant="error">
                <AlertTitle>{gt("Could not refresh this issue")}</AlertTitle>
                <AlertDescription>{detailQuery.error}</AlertDescription>
              </Alert>
            </div>
          ) : null}

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
                aria-label={gt("Issue title")}
                value={titleDraft}
                disabled={saving}
                onChange={(event) => setTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  setEditing(null);
                }}
              />
              <Button type="submit" size="sm" disabled={saving}>
                <T>Save</T>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => setEditing(null)}
              >
                <T>Cancel</T>
              </Button>
            </form>
          ) : (
            <PullRequestDetailTitleRow className="group mt-1 gap-1">
              <h2 className="min-w-0 flex-1 text-base font-semibold leading-snug">
                {detail.title}
              </h2>
              {canEdit ? (
                <PullRequestEditButton
                  aria-label={gt("Edit title")}
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
            <span>
              <T>
                opened <Var>{formatRelativeTimeLabel(detail.createdAt, undefined, messages)}</Var>
              </T>
            </span>
            {detail.closedAt ? (
              <span>
                <T>
                  closed <Var>{formatRelativeTimeLabel(detail.closedAt, undefined, messages)}</Var>
                </T>
              </span>
            ) : null}
            {detail.writable ? null : (
              <span>
                <T>Read-only</T>
              </span>
            )}
          </PullRequestMetaLine>

          <WorkflowRunsAbout
            environmentId={environmentId}
            item={{
              subject: detail.url,
              issue: { ...reference, host: reference.host ?? detail.host },
            }}
          />

          <div className="mt-4 space-y-2">
            <PullRequestMetaRow icon={<TagIcon className="size-3.5" />} label={gt("Labels")}>
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                {detail.labels.length === 0 ? (
                  <span className="text-muted-foreground">
                    <T context="no labels">None</T>
                  </span>
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
                      blocked ?? gt("Changing labels needs triage access on this tracker.")
                    }
                  />
                ) : null}
              </span>
            </PullRequestMetaRow>
            <PullRequestMetaRow icon={<UsersIcon className="size-3.5" />} label={gt("Assignees")}>
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                {detail.assignees.length === 0 ? (
                  <span className="text-muted-foreground">
                    <T context="no assignees">None</T>
                  </span>
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
                      blocked ?? gt("Changing assignees needs triage access on this tracker.")
                    }
                  />
                ) : null}
              </span>
            </PullRequestMetaRow>
          </div>
        </div>

        <PullRequestSection
          key={`description:${detail.url}`}
          title={gt("Description")}
          keepMounted
          actions={
            canEdit && editing !== "body" ? (
              <PullRequestEditButton
                aria-label={gt("Edit description")}
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
                label={gt("Description")}
                completionScope={null}
                saving={saving}
                allowEmpty
                onSave={(next) => void save({ body: next })}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <PullRequestMarkdown
                text={
                  detail.body.trim().length > 0 ? detail.body : gt("_No description provided._")
                }
                cwd={cwd}
                environmentId={environmentId}
                threadRef={threadRef}
              />
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
          <PullRequestSection key={`linked:${detail.url}`} title={gt("Linked pull requests")}>
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
          title={
            detail.commentCount > 0
              ? gt("Activity ({count})", { count: detail.commentCount })
              : gt("Activity")
          }
        >
          <div className="flex flex-col gap-3">
            {nextCursor !== null ? (
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={!canLoadOlder}
                onClick={() => void loadOlder()}
              >
                {loadingOlder ? <T>Loading…</T> : <T>Load older comments</T>}
              </Button>
            ) : null}
            {timeline.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <T>Nothing has happened here yet.</T>
              </p>
            ) : null}
            {timeline.map((item) =>
              item.kind === "comment" ? (
                <article
                  key={`c:${item.comment.id}`}
                  className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
                >
                  <h3>
                    <PullRequestMetaLine className="text-xs text-muted-foreground">
                      <PullRequestActorLabel actor={item.comment.author} />
                      {item.comment.url ? (
                        <InlineButton
                          tone="muted"
                          render={
                            <a href={item.comment.url} target="_blank" rel="noopener noreferrer" />
                          }
                          onClick={(event) => {
                            event.preventDefault();
                            void openLink(item.comment.url!, { event }).catch(console.error);
                          }}
                        >
                          {formatRelativeTimeLabel(item.comment.createdAt, undefined, messages)}
                        </InlineButton>
                      ) : (
                        <span>
                          {formatRelativeTimeLabel(item.comment.createdAt, undefined, messages)}
                        </span>
                      )}
                    </PullRequestMetaLine>
                  </h3>
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
                  <IssueEventText
                    event={item.event}
                    sentence={issueEventSentence(item.event, messages)}
                    onOpen={openEventSource}
                  />
                  <span>{formatRelativeTimeLabel(item.event.createdAt, undefined, messages)}</span>
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
          blocked={canComment ? null : (blocked ?? gt("You cannot comment here."))}
        />
      ) : null}
    </div>
  );
}
