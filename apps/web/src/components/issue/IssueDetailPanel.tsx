import { useAtomValue } from "@effect/atom-react";
import { reportIssueResult } from "./issueMutation";
import { IssueLabelPicker } from "./IssueLabelPicker";
import { IssueAssigneePicker } from "./IssueAssigneePicker";
import { PullRequestCommentBody } from "../pullRequest/PullRequestCommentBody";
import { issueEntryKey } from "@t3tools/client-runtime/state/issues";
import { AuthOrchestrationOperateScope, threadIssueKeysEqual } from "@t3tools/contracts";
import type {
  EnvironmentId,
  IssueActor,
  IssueComment,
  IssueDetail,
  IssueEvent,
  IssueLinkedPullRequest,
  IssueCommentsPageInput,
  IssueListOrder,
  IssueLabel,
  IssueReaction,
  IssueReactionContent,
  IssueRef,
  IssueState,
  IssueFieldValues,
  IssueRichBody,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  BotIcon,
  ChevronDownIcon,
  CircleDotIcon,
  CopyIcon,
  ExternalLinkIcon,
  Link2Icon,
  Link2OffIcon,
  MinusIcon,
  PlusIcon,
  SendIcon,
  SmilePlusIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useIssueViewRefresh } from "~/hooks/useIssueViewRefresh";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useIssueThreadHandoff } from "./useIssueThreadHandoff";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { issueEnvironment, useIssueComments, useIssueLinkedPullRequests } from "~/state/issues";
import { IssueScrollSentinel } from "./IssueLoadMore";
import { IssueHistory, IssueOrderControl } from "./IssueHistory";
import { IssueDependencies } from "./IssueDependencies";
import { IssueHierarchySection } from "./IssueRelations";
import { IssueCommentContent, IssueEventRow } from "./IssueConversation";
import { IssueRichBodyEditor, IssueRichBodyView } from "./IssueRichBodyEditor";
import { isEditableIssueRichBody, safeIssueExternalUrl } from "./issueAdf";
import { IssueStateFieldsDialog } from "./IssueStateFieldsDialog";
import { IssueCreateDialog } from "./IssueCreateDialog";
import { ISSUES_PANEL_REF, useRightPanelStore } from "~/rightPanelStore";
import { useProjects, useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PullRequestDetailTitleRow,
  PullRequestDetailTabBar,
} from "../pullRequest/PullRequestDetailLayout";
import { PullRequestEditButton } from "../pullRequest/PullRequestEditButton";
import { PullRequestDetailGhost } from "../pullRequest/PullRequestGhosts";
import { PullRequestMarkdownEditor } from "../pullRequest/PullRequestMarkdownEditor";
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
  IssueGlyph,
  IssueStateGlyph,
  issueTrackerPresentation,
} from "./issuePresentation";
import {
  issueAssigneeId,
  issueDisplayLabel,
  issueLabelId,
  heldIssuePicker,
  issuePickerIds,
  type IssuePickerConfirmed,
  issueStateActionLabel,
  sameIssueState,
  issueSupportsReactions,
  offeredIssueReactionContents,
  retainUnacknowledgedIssueReactions,
  linkedPullRequestTarget,
  type IssueLinkedPullRequestTarget,
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
    reportIssueResult(
      result,
      linked ? "Could not unlink the issue" : "Could not link the issue",
      "The server refused it.",
    );
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

/** The pull-request reaction bar's shape, routed to the issue tracker instead of the host. */
export function IssueReactionBar({
  viewer,
  reactions,
  canReact,
  contents,
  subjectId,
  environmentId,
  reference,
}: {
  viewer: string | null;
  reactions: ReadonlyArray<IssueReaction> | undefined;
  canReact: boolean;
  contents: ReadonlyArray<IssueReactionContent> | undefined;
  subjectId?: string | undefined;
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
      : viewer === null && reactions !== undefined
        ? new Map<IssueReactionContent, boolean>()
        : retainUnacknowledgedIssueReactions(reactions ?? [], pending.values);
  if (pending.native !== reactions) setPending({ native: reactions, values });
  const shown = applyPendingPullRequestReactions(reactions ?? [], values);
  const offered = offeredIssueReactionContents(contents);

  const toggle = async (content: IssueReactionContent, reacted: boolean) => {
    if (busy.has(content)) return;
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
        if (viewer === null && current.native !== undefined && current.native !== reactions)
          return current;
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
              <Button
                size="xs"
                variant={reaction.viewerHasReacted ? "secondary" : "outline"}
                aria-pressed={reaction.viewerHasReacted}
                aria-label={`${pullRequestReactionName(reaction.content)}, ${reaction.count}`}
                disabled={
                  !canReact || !offered.includes(reaction.content) || busy.has(reaction.content)
                }
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
            render={<Button size="icon-xs" variant="outline" aria-label="Add a reaction" />}
          >
            <SmilePlusIcon aria-hidden className="size-3.5" />
          </PopoverTrigger>
          <PopoverPopup align="start" side="top" padding="compact">
            <div className="flex items-center gap-0.5">
              {offered.map((content) => {
                const reacted =
                  shown.find((reaction) => reaction.content === content)?.viewerHasReacted ?? false;
                return (
                  <Button
                    key={content}
                    size="icon-sm"
                    variant={reacted ? "secondary" : "ghost"}
                    aria-pressed={reacted}
                    disabled={busy.has(content)}
                    aria-label={pullRequestReactionName(content)}
                    onClick={() => {
                      setPickerOpen(false);
                      void toggle(content, !reacted);
                    }}
                  >
                    <span aria-hidden>{pullRequestReactionEmoji(content)}</span>
                  </Button>
                );
              })}
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
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
        <PullRequestStateGlyph state={link.state} isDraft={link.isDraft === true} />
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
    "flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 text-left hover:bg-accent/60";
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

type IssueDetailPanelProps = {
  environmentId: EnvironmentId;
  reference: IssueRef;
  threadRef?: ScopedThreadRef | null;
  /** Opens a linked change request beside this one; absent, the link goes to the host. */
  onSelectPullRequest?: ((target: IssueLinkedPullRequestTarget) => void) | undefined;
  onUpdated?: (() => void) | undefined;
};

export function IssueDetailPanel(props: IssueDetailPanelProps) {
  const ref = props.reference;
  return (
    <IssueDetailContent
      key={JSON.stringify([
        props.environmentId,
        ref.projectId,
        ref.tracker,
        ref.host,
        ref.scope,
        ref.key,
        ...(ref.connectionId === undefined ? [] : [ref.connectionId]),
      ])}
      {...props}
    />
  );
}

function IssueDetailContent({
  environmentId,
  reference,
  threadRef = null,
  onSelectPullRequest,
  onUpdated,
}: IssueDetailPanelProps) {
  const detailQuery = useEnvironmentQuery(
    issueEnvironment.detail({ environmentId, input: reference }),
  );
  useIssueViewRefresh(
    detailQuery.refresh,
    [{ environmentId, input: reference }],
    JSON.stringify([environmentId, reference]),
  );
  const handoff = useIssueThreadHandoff(environmentId, reference);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const detail = detailQuery.data;
  const canWrite = useAtomValue(issueEnvironment.comment.permissionAtom(environmentId));
  const projects = useProjects();
  const project = projects.find(
    (p) => p.environmentId === environmentId && p.id === reference.projectId,
  );
  const cwd = project?.workspaceRoot ?? "";
  const { copyToClipboard: copyLink } = useCopyToClipboard<string>({
    target: "issue link",
    onCopy: (url) =>
      toastManager.add({ type: "success", title: "Issue link copied", description: url }),
    onError: () => toastManager.add({ type: "error", title: "The issue link could not be copied" }),
  });

  const [tab, setTab] = useState<"summary" | "history">("summary");
  const [createSubIssue, setCreateSubIssue] = useState(false);
  const [dependenciesRevision, setDependenciesRevision] = useState(0);
  const refreshedDependenciesRevision = useRef(dependenciesRevision);
  useEffect(() => {
    if (refreshedDependenciesRevision.current === dependenciesRevision) return;
    refreshedDependenciesRevision.current = dependenciesRevision;
    appAtomRegistry.update(
      issueEnvironment.historyRefresh({ environmentId, input: reference }),
      (revision) => revision + 1,
    );
  }, [dependenciesRevision, environmentId, reference]);
  const linkedPages = useIssueLinkedPullRequests(
    environmentId,
    detail?.capabilities.linkedPullRequests ? reference : null,
  );
  const [linkedExpansion, setLinkedExpansion] = useState({
    viewer: detail?.viewer,
    expanded: false,
  });
  const linkedExpanded = linkedExpansion.viewer === detail?.viewer && linkedExpansion.expanded;
  useEffect(() => {
    if (linkedPages.hasMore && !linkedPages.isPending && linkedPages.error === null)
      linkedPages.loadMore();
  }, [linkedPages]);
  const [requestedOrder, setRequestedOrder] = useState<IssueListOrder>("desc");
  const comment = useAtomCommand(issueEnvironment.comment, { reportFailure: false });
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  const stateAllowed = useAtomValue(issueEnvironment.setState.permissionAtom(environmentId));
  const updateAllowed = useAtomValue(issueEnvironment.update.permissionAtom(environmentId));
  const [stateAction, setStateAction] = useState<{
    state: IssueState;
    closeReason?: string;
    withComment: boolean;
    commentPosted: boolean;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState<"comment" | "close" | null>(null);
  const [editing, setEditing] = useState<"title" | "body" | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [changingState, setChangingState] = useState(false);
  const [updatingMetadata, setUpdatingMetadata] = useState(false);
  const [confirmedLabels, setConfirmedLabels] = useState<
    (IssuePickerConfirmed & { items: ReadonlyArray<IssueLabel> }) | null
  >(null);
  const [confirmedAssignees, setConfirmedAssignees] = useState<
    (IssuePickerConfirmed & { items: ReadonlyArray<IssueActor> }) | null
  >(null);
  const [stateMenuOpen, setStateMenuOpen] = useState(false);
  const [closeCommentMenuOpen, setCloseCommentMenuOpen] = useState(false);
  const needsStateCandidates =
    (detail?.tracker === "jira" || detail?.capabilities.stateFields === true) &&
    (detail.states?.length ?? 0) <= 1;
  const stateCandidates = useEnvironmentQuery(
    (stateMenuOpen || closeCommentMenuOpen) &&
      needsStateCandidates &&
      canWrite &&
      detail?.writable &&
      detail.viewerPermissions.setState &&
      detail.capabilities.states.length > 0
      ? issueEnvironment.candidates({
          environmentId,
          input: reference,
        })
      : null,
  );

  if (detail === null) {
    if (detailQuery.error !== null && !detailQuery.isPending) {
      return (
        <PullRequestsUnavailableState
          title="Could not load this issue"
          error={detailQuery.error}
          onRetry={detailQuery.refresh}
          icon={<IssueGlyph.issue />}
        />
      );
    }
    return <PullRequestDetailGhost />;
  }

  const activeTab = detail.capabilities.events ? tab : "summary";
  const heldLabels = heldIssuePicker(detail, "labels", confirmedLabels, environmentId);
  const heldAssignees = heldIssuePicker(detail, "assignees", confirmedAssignees, environmentId);
  if (heldLabels === null && confirmedLabels !== null) setConfirmedLabels(null);
  if (heldAssignees === null && confirmedAssignees !== null) setConfirmedAssignees(null);
  const labelObjects = new Map(
    [...(confirmedLabels?.items ?? []), ...detail.labels].map((label) => [
      issueLabelId(label),
      label,
    ]),
  );
  const actorObjects = new Map(
    [...(confirmedAssignees?.items ?? []), ...detail.assignees].map((actor) => [
      issueAssigneeId(actor),
      actor,
    ]),
  );
  const labels = issuePickerIds(detail, "labels", heldLabels, environmentId).map((id) =>
    labelObjects.get(id)!,
  );
  const assignees = issuePickerIds(detail, "assignees", heldAssignees, environmentId).map((id) =>
    actorObjects.get(id)!,
  );
  const commentOrders = detail.capabilities.commentOrders ?? ["desc", "asc"];
  const historyOrders = detail.capabilities.historyOrders ?? ["desc", "asc"];
  const partialHistory = detail.capabilities.events && historyOrders.length === 0;
  const activityOrders = detail.capabilities.events
    ? commentOrders.filter((order) => historyOrders.includes(order))
    : commentOrders;
  const orders = activityOrders.length > 0 ? activityOrders : commentOrders;
  const order = orders.includes(requestedOrder) ? requestedOrder : (orders[0] ?? "desc");
  const commentsInput: IssueCommentsPageInput | null =
    commentOrders.length === 0 || (order === "desc" && detail.commentsCursor === null)
      ? null
      : {
          ...reference,
          order,
          ...(detail.viewer === null ? {} : { viewer: detail.viewer }),
          ...(order === "desc" && detail.commentsCursor !== null
            ? { cursor: detail.commentsCursor }
            : {}),
        };

  const blocked = writeBlockReason(detail, canWrite);
  const may = (capability: boolean, permission: boolean) =>
    blocked === null && capability && permission;
  const canComment = may(detail.capabilities.comment, detail.viewerPermissions.comment);
  const canEdit = may(detail.capabilities.edit, detail.viewerPermissions.edit) && updateAllowed;
  const nativeRichBody =
    detail.capabilities.richText === true && isEditableIssueRichBody(detail.richBody)
      ? detail.richBody
      : undefined;
  const canEditBody =
    canEdit &&
    (nativeRichBody !== undefined ||
      (detail.richBody === undefined && detail.bodyEditable !== false));
  const canLabel =
    may(detail.capabilities.labels, detail.viewerPermissions.labels) && updateAllowed;
  const canAssign =
    may(detail.capabilities.assignees, detail.viewerPermissions.assignees) && updateAllowed;
  const canReact = blocked === null && detail.capabilities.reactions;
  const canSetState =
    may(detail.capabilities.states.length > 0, detail.viewerPermissions.setState) && stateAllowed;
  const tracker = issueTrackerPresentation(detail.tracker);
  const states = needsStateCandidates
    ? stateCandidates.error === null
      ? (stateCandidates.data?.states ?? [])
      : []
    : (detail.states ?? detail.capabilities.states);
  const otherStates = states.filter(
    (state) => state.transitionId !== undefined || !sameIssueState(state, detail.state),
  );
  const closingStates = otherStates.filter((state) => state.category === "closed");
  const openingStates = otherStates.filter((state) => state.category === "open");

  const submitComment = async (
    closeTo?: IssueState,
    fieldValues?: IssueFieldValues,
    commentPosted = false,
  ) => {
    const body = draft.trim();
    if (
      (!commentPosted && !canComment) ||
      (!commentPosted && body.length === 0) ||
      submitting !== null ||
      (closeTo !== undefined && (!canSetState || changingState))
    )
      return;
    if (closeTo && fieldValues === undefined && (closeTo.fields?.length ?? 0) > 0) {
      setStateAction({ state: closeTo, withComment: true, commentPosted: false });
      return;
    }
    setSubmitting(closeTo === undefined ? "comment" : "close");
    if (!commentPosted) {
      const result = await comment({ environmentId, input: { ...reference, body: draft } });
      if (
        !reportIssueResult(result, "The comment could not be posted", "The tracker refused it.")
      ) {
        setSubmitting(null);
        return;
      }
      setDraft("");
      setStateAction((held) => (held ? { ...held, commentPosted: true } : null));
    }
    if (closeTo !== undefined) {
      const closeReason =
        detail.tracker === "github" && closeTo.id === undefined && closeTo.name === "closed"
          ? (detail.capabilities.closeReasons.find((reason) => reason === "completed") ??
            detail.capabilities.closeReasons[0])
          : undefined;
      const closed = await setState({
        environmentId,
        input: {
          ...reference,
          state: closeTo.id ?? closeTo.name,
          ...(closeTo.transitionId === undefined ? {} : { transitionId: closeTo.transitionId }),
          ...(fieldValues === undefined ? {} : { fieldValues }),
          ...(closeReason === undefined ? {} : { closeReason }),
        },
      });
      if (reportIssueResult(closed, "The comment was posted, but the issue could not be closed"))
        setStateAction(null);
    }
    setSubmitting(null);
    onUpdated?.();
  };

  const save = async (patch: { title?: string; body?: string; richBody?: IssueRichBody }) => {
    if (!canEdit || (patch.richBody !== undefined && !nativeRichBody)) return;
    setSaving(true);
    const result = await update({ environmentId, input: { ...reference, ...patch } });
    setSaving(false);
    if (!reportIssueResult(result, "The issue could not be updated", "The tracker refused it."))
      return;
    setEditing(null);
    onUpdated?.();
  };

  const moveTo = async (
    state: IssueState,
    closeReason?: string,
    fieldValues?: IssueFieldValues,
  ) => {
    if (!canSetState) return;
    if (fieldValues === undefined && (state.fields?.length ?? 0) > 0) {
      setStateAction({
        state,
        ...(closeReason === undefined ? {} : { closeReason }),
        withComment: false,
        commentPosted: false,
      });
      return;
    }
    if (changingState || submitting === "close") return;
    setChangingState(true);
    const result = await setState({
      environmentId,
      input: {
        ...reference,
        state: state.id ?? state.name,
        ...(state.transitionId === undefined ? {} : { transitionId: state.transitionId }),
        ...(fieldValues === undefined ? {} : { fieldValues }),
        ...(closeReason === undefined ? {} : { closeReason }),
      },
    });
    setChangingState(false);
    if (!reportIssueResult(result, "The state could not be changed", "The tracker refused it."))
      return;
    setStateAction(null);
    onUpdated?.();
  };

  const updateMetadata = async (
    patch: { labels?: ReadonlyArray<IssueLabel>; assignees?: ReadonlyArray<IssueActor> },
    title: string,
  ) => {
    if (
      updatingMetadata ||
      !updateAllowed ||
      (patch.labels !== undefined && !canLabel) ||
      (patch.assignees !== undefined && !canAssign)
    )
      return;
    setUpdatingMetadata(true);
    const result = await update({
      environmentId,
      input: {
        ...reference,
        ...(patch.labels === undefined ? {} : { labels: patch.labels.map(issueLabelId) }),
        ...(patch.assignees === undefined
          ? {}
          : { assignees: patch.assignees.map(issueAssigneeId) }),
      },
    });
    setUpdatingMetadata(false);
    if (!reportIssueResult(result, title)) return;
    if (patch.labels !== undefined)
      setConfirmedLabels({
        base: detail,
        environmentId,
        kind: "labels",
        ids: patch.labels.map(issueLabelId),
        items: patch.labels,
      });
    if (patch.assignees !== undefined)
      setConfirmedAssignees({
        base: detail,
        environmentId,
        kind: "assignees",
        ids: patch.assignees.map(issueAssigneeId),
        items: patch.assignees,
      });
    onUpdated?.();
  };

  const stateControl: ReactNode = canSetState ? (
    <span className="flex shrink-0 items-center gap-1">
      {!needsStateCandidates && openingStates.length === 1 && closingStates.length === 0 ? (
        <Button
          size="xs"
          variant="outline"
          disabled={changingState || submitting === "close"}
          onClick={() => void moveTo(openingStates[0]!)}
        >
          {issueStateActionLabel(openingStates[0]!)}
        </Button>
      ) : null}
      {!needsStateCandidates &&
      closingStates.length === 1 &&
      detail.capabilities.closeReasons.length === 0 &&
      openingStates.length === 0 ? (
        <Button
          size="xs"
          variant="outline"
          disabled={changingState || submitting === "close"}
          onClick={() => void moveTo(closingStates[0]!)}
        >
          {issueStateActionLabel(closingStates[0]!)}
        </Button>
      ) : null}
      {needsStateCandidates ||
      (closingStates.length > 0 && detail.capabilities.closeReasons.length > 0) ||
      otherStates.length > 1 ? (
        <Menu open={stateMenuOpen} onOpenChange={setStateMenuOpen}>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                disabled={changingState || submitting === "close"}
              />
            }
          >
            {!needsStateCandidates && otherStates.every((state) => state.name === "closed")
              ? "Close"
              : "Change state"}
            <ChevronDownIcon aria-hidden className="size-3" />
          </MenuTrigger>
          <MenuPopup align="end">
            {needsStateCandidates && stateCandidates.error !== null ? (
              <>
                <MenuItem disabled>States could not be read. {stateCandidates.error}</MenuItem>
                <MenuItem closeOnClick={false} onClick={stateCandidates.refresh}>
                  Retry
                </MenuItem>
              </>
            ) : needsStateCandidates &&
              (stateCandidates.isPending || stateCandidates.data === null) ? (
              <MenuItem disabled>Loading states…</MenuItem>
            ) : needsStateCandidates && otherStates.length === 0 ? (
              <MenuItem disabled>No other states are available.</MenuItem>
            ) : null}
            {otherStates.flatMap((state) =>
              state.category === "closed" &&
              state.id === undefined &&
              state.name === "closed" &&
              detail.capabilities.closeReasons.length > 0
                ? detail.capabilities.closeReasons.map((reason) => (
                    <MenuItem
                      key={`${state.transitionId ?? state.id ?? state.name}:${reason}`}
                      onClick={() => void moveTo(state, reason)}
                    >
                      {state.name === "closed" ? "Close" : state.name} as{" "}
                      {issueCloseReasonLabel(reason).toLowerCase()}
                    </MenuItem>
                  ))
                : [
                    <MenuItem
                      key={state.transitionId ?? state.id ?? state.name}
                      onClick={() => void moveTo(state)}
                    >
                      {issueStateActionLabel(state)}
                    </MenuItem>,
                  ],
            )}
          </MenuPopup>
        </Menu>
      ) : null}
    </span>
  ) : null;

  const closeCommentNeedsMenu = needsStateCandidates || closingStates.length > 1;
  const closeCommentButton = (
    <Button
      type="button"
      size="sm"
      variant="destructive-outline"
      disabled={submitting !== null || changingState || draft.trim().length === 0}
      onClick={closeCommentNeedsMenu ? undefined : () => void submitComment(closingStates[0])}
    >
      {submitting === "close" ? "Closing..." : "Close with comment"}
    </Button>
  );
  const closeCommentControl =
    canComment &&
    canSetState &&
    detail.state.category === "open" &&
    (needsStateCandidates || closingStates.length > 0) ? (
      closeCommentNeedsMenu ? (
        <Menu open={closeCommentMenuOpen} onOpenChange={setCloseCommentMenuOpen}>
          <MenuTrigger render={closeCommentButton} />
          <MenuPopup align="end">
            {needsStateCandidates && stateCandidates.error !== null ? (
              <>
                <MenuItem disabled>States could not be read. {stateCandidates.error}</MenuItem>
                <MenuItem closeOnClick={false} onClick={stateCandidates.refresh}>
                  Retry
                </MenuItem>
              </>
            ) : needsStateCandidates &&
              (stateCandidates.isPending || stateCandidates.data === null) ? (
              <MenuItem disabled>Loading states…</MenuItem>
            ) : closingStates.length === 0 ? (
              <MenuItem disabled>No closing states are available.</MenuItem>
            ) : null}
            {closingStates.map((state) => (
              <MenuItem
                key={state.transitionId ?? state.id ?? state.name}
                onClick={() => void submitComment(state)}
              >
                {state.name}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : (
        closeCommentButton
      )
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 px-4 pt-3 pb-4">
          <PullRequestDetailTitleRow className="gap-2">
            <IssueStateGlyph state={detail.state} />
            <span className="text-xs text-muted-foreground">
              {detail.state.name}
              {detail.state.closeReason
                ? ` · ${detail.state.closeReason.replaceAll("-", " ")}`
                : null}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              <tracker.Icon aria-hidden className="mr-1 inline size-3 align-[-2px]" />
              {issueDisplayLabel(detail.scope, detail.displayKey)}
            </span>
            {project && canOperate ? (
              <Button
                size="xs"
                variant="outline"
                disabled={handoff.pending}
                onClick={() => void handoff.start(detail)}
              >
                <BotIcon aria-hidden className="size-3" />
                Solve
              </Button>
            ) : null}
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
              onClick={() => {
                if (activeTab === "summary" && commentsInput?.cursor !== undefined)
                  appAtomRegistry.refresh(
                    issueEnvironment.commentPages({ environmentId, input: commentsInput }),
                  );
                detailQuery.refresh();
                setLinkedExpansion({ viewer: detail.viewer, expanded: false });
                setDependenciesRevision((revision) => revision + 1);
                linkedPages.refresh();
                if (activeTab === "summary" && detail.capabilities.subIssues)
                  appAtomRegistry.refresh(
                    issueEnvironment.hierarchy({ environmentId, input: reference }),
                  );
              }}
            >
              <RefreshIcon size="sm" refreshing={detailQuery.isPending} />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Copy issue link"
              onClick={() => copyLink(detail.url, detail.url)}
            >
              <CopyIcon aria-hidden className="size-3.5" />
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
            <span>updated {formatRelativeTimeLabel(detail.updatedAt)}</span>
            {detail.closedAt ? (
              <span>closed {formatRelativeTimeLabel(detail.closedAt)}</span>
            ) : null}
            {detail.writable ? null : <span>Read-only</span>}
          </PullRequestMetaLine>

          <div className="flex flex-wrap items-center gap-1.5">
            {labels.map((label) => (
              <PullRequestLabelChip key={issueLabelId(label)} label={label} />
            ))}
            {detail.capabilities.labels ? (
              <IssueLabelPicker
                environmentId={environmentId}
                source={reference}
                selected={labels}
                disabled={updatingMetadata}
                allowed={canLabel && detail.labelsTruncated !== true}
                disabledReason={
                  blocked ??
                  (detail.labelsTruncated === true
                    ? `Not every label is shown here, so change them on ${tracker.providerName}.`
                    : "Changing labels needs triage access on this tracker.")
                }
                onChange={(next) =>
                  void updateMetadata({ labels: next }, "Could not change labels")
                }
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
            {assignees.length === 0 ? <span>none</span> : null}
            {assignees.map((actor) => (
              <PullRequestActorLabel key={issueAssigneeId(actor)} actor={actor} />
            ))}
            {detail.capabilities.assignees ? (
              <IssueAssigneePicker
                environmentId={environmentId}
                source={reference}
                selected={assignees}
                max={detail.capabilities.maxAssignees ?? 100}
                disabled={updatingMetadata}
                allowed={canAssign}
                disabledReason={
                  blocked ?? "Changing assignees needs triage access on this tracker."
                }
                onChange={(next) =>
                  void updateMetadata({ assignees: next }, "Could not change assignees")
                }
              />
            ) : null}
          </div>

          {detail.milestone ? (
            <PullRequestMetaLine className="text-xs text-muted-foreground">
              <CircleDotIcon aria-hidden className="size-3.5" />
              <span>Milestone</span>
              <span>{detail.milestone}</span>
            </PullRequestMetaLine>
          ) : null}

          <section className="group flex flex-col gap-2 rounded-lg border border-border/60 p-3">
            <div className="flex items-start gap-1">
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">Description</span>
              {canEditBody && editing !== "body" ? (
                <PullRequestEditButton
                  aria-label="Edit description"
                  onClick={() => setEditing("body")}
                />
              ) : null}
            </div>
            {editing === "body" && canEditBody && nativeRichBody ? (
              <IssueRichBodyEditor
                value={nativeRichBody}
                label="Description"
                saving={saving}
                onSave={(richBody) => void save({ richBody })}
                onCancel={() => setEditing(null)}
              />
            ) : editing === "body" && canEditBody ? (
              <PullRequestMarkdownEditor
                value={detail.body}
                cwd={cwd}
                environmentId={environmentId}
                threadRef={threadRef}
                issueLinkContext={{
                  ...reference,
                  host: reference.host ?? detail.host,
                  environmentId,
                }}
                pullRequestPanelRef={threadRef ?? ISSUES_PANEL_REF}
                label="Description"
                saving={saving}
                allowEmpty
                onSave={(next) => void save({ body: next })}
                onCancel={() => setEditing(null)}
              />
            ) : nativeRichBody ? (
              <IssueRichBodyView value={nativeRichBody} />
            ) : detail.body.trim().length > 0 ? (
              <PullRequestCommentBody
                text={detail.body}
                cwd={cwd}
                environmentId={environmentId}
                threadRef={threadRef}
                issueLinkContext={{
                  ...reference,
                  host: reference.host ?? detail.host,
                  environmentId,
                }}
                pullRequestPanelRef={threadRef ?? ISSUES_PANEL_REF}
              />
            ) : (
              <p className="text-sm text-muted-foreground italic">No description.</p>
            )}
          </section>
          {detail.reactions !== undefined ? (
            <IssueReactionBar
              key={JSON.stringify([issueEntryKey(detail), detail.viewer ?? null])}
              viewer={detail.viewer}
              reactions={detail.reactions}
              canReact={canReact}
              contents={detail.capabilities.reactionContents}
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

          {detail.capabilities.events ? (
            <div className="-mx-4">
              <PullRequestDetailTabBar
                tabs={[
                  { value: "summary" as const, label: "Summary" },
                  { value: "history" as const, label: "History" },
                ]}
                value={activeTab}
                onValueChange={setTab}
                aria-label="Issue tabs"
              >
                {activeTab === "history" ? (
                  <div className="ml-auto">
                    <IssueOrderControl
                      order={requestedOrder}
                      orders={historyOrders}
                      onChange={setRequestedOrder}
                    />
                  </div>
                ) : null}
              </PullRequestDetailTabBar>
            </div>
          ) : null}
          {activeTab === "history" ? (
            <IssueHistory
              environmentId={environmentId}
              reference={reference}
              order={requestedOrder}
              orders={historyOrders}
              url={detail.url}
            />
          ) : (
            <>
              {detail.capabilities.subIssues ? (
                <IssueHierarchySection
                  key={issueEntryKey(detail)}
                  environmentId={environmentId}
                  reference={reference}
                  detail={detail}
                  onSelectIssue={(ref, _displayKey, url) =>
                    useRightPanelStore.getState().openIssue(threadRef ?? ISSUES_PANEL_REF, {
                      ...ref,
                      host: ref.host ?? detail.host,
                      environmentId,
                      ...(url ? { url } : {}),
                    })
                  }
                  onCreateSubIssue={
                    detail.writable && canWrite && detail.capabilities.createSubIssue
                      ? () => setCreateSubIssue(true)
                      : null
                  }
                />
              ) : null}
              {detail.capabilities.dependencies === true ? (
                <IssueDependencies
                  key={JSON.stringify([issueEntryKey(detail), dependenciesRevision])}
                  environmentId={environmentId}
                  reference={reference}
                  detail={detail}
                  onSelectIssue={(ref, _displayKey, url) =>
                    useRightPanelStore.getState().openIssue(threadRef ?? ISSUES_PANEL_REF, {
                      ...ref,
                      host: ref.host ?? detail.host,
                      environmentId,
                      ...(url ? { url } : {}),
                    })
                  }
                />
              ) : null}
              {detail.externalLinks?.some((link) => safeIssueExternalUrl(link.url) !== null) ? (
                <section className="flex flex-col gap-1" aria-label="Links">
                  <h3 className="text-xs text-muted-foreground">Links</h3>
                  {detail.externalLinks?.map((link) => {
                    const url = safeIssueExternalUrl(link.url);
                    return url ? (
                      <InlineButton
                        key={url}
                        render={<a href={url} target="_blank" rel="noopener noreferrer" />}
                      >
                        {link.title}
                        <ExternalLinkIcon aria-hidden className="size-3" />
                      </InlineButton>
                    ) : null;
                  })}
                </section>
              ) : null}
              {detail.capabilities.linkedPullRequests &&
              (linkedPages.items.length > 0 ||
                linkedPages.hasMore ||
                linkedPages.isPending ||
                linkedPages.error) ? (
                <section className="flex flex-col gap-1" aria-label="Linked pull requests">
                  <h3 className="text-xs text-muted-foreground">Linked pull requests</h3>
                  {(linkedExpanded ? linkedPages.items : linkedPages.items.slice(0, 3)).map(
                    (link) => {
                      const target = linkedPullRequestTarget(
                        link,
                        reference,
                        environmentId,
                        projects,
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
                    },
                  )}
                  {linkedPages.items.length > 3 ? (
                    <div className="flex">
                      <Button
                        size="sm"
                        variant="ghost-muted"
                        aria-expanded={linkedExpanded}
                        onClick={() =>
                          setLinkedExpansion({ viewer: detail.viewer, expanded: !linkedExpanded })
                        }
                      >
                        {linkedExpanded ? (
                          <MinusIcon aria-hidden className="size-4" />
                        ) : (
                          <PlusIcon aria-hidden className="size-4" />
                        )}
                        {linkedExpanded ? "Show less" : `Show ${linkedPages.items.length - 3} more`}
                      </Button>
                    </div>
                  ) : null}
                  {linkedPages.isPending ? (
                    <p role="status" className="text-xs text-muted-foreground">
                      Loading linked pull requests…
                    </p>
                  ) : null}
                  {linkedPages.error !== null ? (
                    <div className="flex flex-col items-start gap-2">
                      <p role="alert" className="text-xs text-muted-foreground">
                        Linked pull requests could not be read. {linkedPages.error}
                      </p>
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={linkedPages.isPending}
                        onClick={!linkedPages.hasMore ? linkedPages.refresh : linkedPages.loadMore}
                      >
                        Retry linked pull requests
                      </Button>
                    </div>
                  ) : null}
                </section>
              ) : null}

              <IssueActivity
                key={JSON.stringify([
                  issueEntryKey(detail),
                  detail.viewer,
                  order,
                  detail.commentsCursor,
                  dependenciesRevision,
                ])}
                environmentId={environmentId}
                reference={reference}
                detail={detail}
                input={commentsInput}
                order={order}
                orders={orders}
                includeEvents={activityOrders.length > 0 || partialHistory}
                partialHistory={partialHistory}
                cwd={cwd}
                threadRef={threadRef}
                canWrite={canWrite}
                onOrderChange={setRequestedOrder}
                onUpdated={onUpdated}
              />
            </>
          )}
        </div>
      </div>
      {stateAction ? (
        <IssueStateFieldsDialog
          key={stateAction.state.transitionId ?? stateAction.state.id ?? stateAction.state.name}
          state={stateAction.state}
          pending={changingState || submitting !== null}
          allowed={
            canSetState && (!stateAction.withComment || stateAction.commentPosted || canComment)
          }
          commentPosted={stateAction.commentPosted}
          onCancel={() => setStateAction(null)}
          onSubmit={(values) => {
            if (stateAction.withComment)
              void submitComment(stateAction.state, values, stateAction.commentPosted);
            else void moveTo(stateAction.state, stateAction.closeReason, values);
          }}
        />
      ) : null}
      <IssueCreateDialog
        open={createSubIssue}
        onOpenChange={setCreateSubIssue}
        parent={{
          key: detail.key,
          displayKey: detail.displayKey,
          noun: detail.capabilities.subIssueNoun,
        }}
        scopes={[
          {
            environmentId,
            projectTitle: detail.projectTitle,
            scope: reference,
            templates: detail.capabilities.templates,
            createIssueTypes: detail.capabilities.createIssueTypes,
            createFields: detail.capabilities.createFields,
            labels: detail.capabilities.labels,
            assignees: detail.capabilities.assignees,
            maxAssignees: detail.capabilities.maxAssignees,
          },
        ]}
        onCreated={(_scope, result) => {
          detailQuery.refresh();
          setCreateSubIssue(false);
          if (result.parentLinked === false)
            toastManager.add({
              type: "warning",
              title: "The issue was created, but its parent could not be set",
            });
        }}
      />
      {activeTab === "summary" && detail.capabilities.comment ? (
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
            disabled={!canComment || submitting !== null}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
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
          <div className="flex flex-wrap justify-end gap-2">
            {closeCommentControl}
            <Button
              type="submit"
              size="sm"
              disabled={!canComment || submitting !== null || draft.trim().length === 0}
            >
              <SendIcon aria-hidden className="size-3.5" />
              {submitting === "comment" ? "Posting…" : "Comment"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function IssueActivity({
  environmentId,
  reference,
  detail,
  input,
  order,
  orders,
  includeEvents,
  partialHistory,
  cwd,
  threadRef,
  canWrite,
  onOrderChange,
  onUpdated,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  detail: IssueDetail;
  input: IssueCommentsPageInput | null;
  order: IssueListOrder;
  orders: ReadonlyArray<IssueListOrder>;
  includeEvents: boolean;
  partialHistory: boolean;
  cwd: string;
  threadRef: ScopedThreadRef | null;
  canWrite: boolean;
  onOrderChange: (order: IssueListOrder) => void;
  onUpdated?: (() => void) | undefined;
}) {
  const pages = useIssueComments(environmentId, input);
  const source =
    detail.viewer === null
      ? detail.comments
      : JSON.stringify(detail.comments.map((comment) => comment.id));
  const previousSource = useRef(source);
  const [heldSource, setHeldSource] = useState({ source, staleItems: new Set<IssueComment>() });
  const sourceChanged = heldSource.source !== source;
  if (sourceChanged) setHeldSource({ source, staleItems: new Set(pages.items) });
  const staleSource =
    sourceChanged || pages.items.some((comment) => heldSource.staleItems.has(comment));
  if (!staleSource && heldSource.staleItems.size > 0)
    setHeldSource({ source, staleItems: new Set() });
  const refreshComments = pages.refresh;
  useEffect(() => {
    if (previousSource.current === source) return;
    previousSource.current = source;
    refreshComments();
  }, [source, refreshComments]);
  const comments = new Map<string, IssueComment>();
  if (!staleSource) for (const comment of pages.items) comments.set(comment.id, comment);
  if (order === "desc") for (const comment of detail.comments) comments.set(comment.id, comment);
  const timeline: ReadonlyArray<TimelineItem> = [
    ...[...comments.values()].map((comment): TimelineItem => ({
      kind: "comment",
      at: comment.createdAt,
      comment,
    })),
    ...(includeEvents ? detail.events : []).map((event): TimelineItem => ({
      kind: "event",
      at: event.createdAt,
      event,
    })),
  ].sort((a, b) => (Date.parse(a.at) - Date.parse(b.at)) * (order === "desc" ? -1 : 1));
  const blocked = writeBlockReason(detail, canWrite);
  const canReactToComment = blocked === null && issueSupportsReactions(detail.capabilities, true);
  const tracker = issueTrackerPresentation(detail.tracker);
  return (
    <section className="flex flex-col gap-3" aria-label="Activity">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs text-muted-foreground">
          Activity
          {detail.commentCount !== null && detail.commentCount > 0
            ? ` · ${detail.commentCount} ${detail.commentCount === 1 ? "comment" : "comments"}`
            : ""}
        </h3>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {partialHistory ? (
            <span className="text-xs text-muted-foreground">Comment order</span>
          ) : null}
          <IssueOrderControl order={order} orders={orders} onChange={onOrderChange} />
        </div>
      </div>
      {partialHistory ? (
        <IssueTruncatedNote
          text="History is incomplete and its global order is unavailable. Comments use the selected order."
          url={detail.url}
          providerName={tracker.providerName}
        />
      ) : null}
      {!partialHistory && !includeEvents && detail.capabilities.events ? (
        <IssueTruncatedNote
          text="Activity history is not available in this order. Comments use the selected order."
          url={detail.url}
          providerName={tracker.providerName}
        />
      ) : null}
      {!partialHistory && detail.historyTruncated === true && includeEvents ? (
        <IssueTruncatedNote
          text="Some activity is not shown here."
          url={detail.url}
          providerName={tracker.providerName}
        />
      ) : null}
      {timeline.length === 0 &&
      !pages.isPending &&
      pages.error === null &&
      detail.historyTruncated !== true &&
      !partialHistory &&
      includeEvents ? (
        <p className="text-sm text-muted-foreground">Nothing has happened here yet.</p>
      ) : null}
      {timeline.map((item) =>
        item.kind === "comment" ? (
          <article
            key={`c:${issueEntryKey(detail)}:${detail.viewer}:${item.comment.id}`}
            className="flex flex-col gap-2 rounded-lg border border-border/60 p-3 [contain-intrinsic-block-size:160px] [content-visibility:auto]"
          >
            <IssueCommentContent
              environmentId={environmentId}
              reference={{ ...reference, host: reference.host ?? detail.host }}
              comment={item.comment}
              cwd={cwd}
              threadRef={threadRef}
              richText={detail.capabilities.richText === true}
              canEdit={blocked === null && detail.capabilities.editComment === true}
              onChanged={() => onUpdated?.()}
            />
            {item.comment.reactions !== undefined ||
            issueSupportsReactions(detail.capabilities, true) ? (
              <IssueReactionBar
                key={JSON.stringify([
                  issueEntryKey(detail),
                  item.comment.id,
                  detail.viewer ?? null,
                ])}
                viewer={detail.viewer}
                reactions={item.comment.reactions}
                canReact={canReactToComment}
                contents={detail.capabilities.reactionContents}
                subjectId={item.comment.id}
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
          <IssueEventRow key={`e:${item.event.id}`} event={item.event} />
        ),
      )}
      <IssueScrollSentinel
        key={JSON.stringify([environmentId, reference, input, order])}
        hasMore={pages.hasMore || pages.error !== null}
        isPending={pages.isPending}
        error={pages.error}
        loadMore={!pages.hasMore ? pages.refresh : pages.loadMore}
      />
    </section>
  );
}
