import { useGT, T } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  IssueDetail,
  IssueListEntry,
  IssueListState,
  IssueRef,
  IssueScopeRef,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { CircleCheck, CircleDot, Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
import { useState } from "react";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { issueEnvironment } from "~/state/issues";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import {
  ISSUE_SORTS,
  appendIssueContext,
  issueBranchName,
  issueContextForComposer,
  ISSUE_STATE_FILTERS,
  formatCommentCount,
  labelColor,
  narrowIssues,
  sortIssues,
  type IssueSort,
} from "./issuesPanel.logic";

interface IssuesPanelProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly cwd: string;
  /** Where "Add to thread" writes. Absent on a surface with no composer beside it. */
  readonly composerDraftTarget?: ScopedThreadRef | DraftId | undefined;
}

/**
 * The issues of the project the panel is beside.
 *
 * One list and one reading pane rather than two tabs: an issue is short enough to read in place,
 * and going back to the list is a single control. The composer and the state button are shown
 * only where the host said this account may write.
 */
export function IssuesPanel(props: IssuesPanelProps) {
  const gt = useGT();
  const canCreate = useAtomValue(issueEnvironment.create.permissionAtom(props.environmentId));
  const [state, setState] = useState<IssueListState>("open");
  const [sort, setSort] = useState<IssueSort>("recent");
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [openIssue, setOpenIssue] = useState<IssueRef | null>(null);
  const [composing, setComposing] = useState(false);

  const listQuery = useEnvironmentQuery(
    issueEnvironment.list({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        state,
        ...(submittedSearch.length === 0 ? {} : { query: submittedSearch }),
      },
    }),
  );

  const result = listQuery.data;
  const searchesOnHost = result?.trackers.some((tracker) => tracker.capabilities?.search) ?? false;
  const createScopes = (result?.scopes ?? []).filter((scope) =>
    result?.trackers.some(
      (tracker) =>
        tracker.tracker === scope.tracker &&
        (scope.host === undefined || tracker.host === scope.host) &&
        tracker.configured &&
        tracker.capabilities?.create,
    ),
  );
  const sortedEntries = sortIssues(result?.entries ?? [], sort);
  const entries = searchesOnHost ? sortedEntries : narrowIssues(sortedEntries, submittedSearch);

  const submitSearch = () => setSubmittedSearch(search);
  const clearSearch = () => {
    setSearch("");
    setSubmittedSearch("");
  };

  if (openIssue !== null) {
    return (
      <IssueDetailView
        environmentId={props.environmentId}
        reference={openIssue}
        cwd={props.cwd}
        composerDraftTarget={props.composerDraftTarget}
        onBack={() => setOpenIssue(null)}
        onChanged={listQuery.refresh}
      />
    );
  }

  if (composing && createScopes.length > 0) {
    return (
      <NewIssueView
        environmentId={props.environmentId}
        scopes={createScopes}
        projectTitle={props.projectTitle}
        onCancel={() => setComposing(false)}
        onCreated={(issue) => {
          setComposing(false);
          listQuery.refresh();
          setOpenIssue(issue);
        }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <InputGroup className="flex-1">
            <InputGroupAddon>
              <Search aria-hidden className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
                if (event.key === "Escape" && search.length > 0) clearSearch();
              }}
              placeholder={searchesOnHost ? gt("Search issues") : gt("Filter loaded issues")}
              size="compact"
              aria-label={gt("Search issues")}
            />
            {search.length > 0 ? (
              <InputGroupAddon align="inline-end">
                <Button
                  variant="ghost-muted"
                  size="icon-micro"
                  onClick={clearSearch}
                  aria-label={gt("Clear search")}
                >
                  <X className="size-3.5" />
                </Button>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={listQuery.refresh}
            aria-label={gt("Refresh issues")}
          >
            <RefreshCw className={cn("size-3.5", listQuery.isPending && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setComposing(true)}
            aria-label={gt("New issue")}
            disabled={!canCreate || createScopes.length === 0}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
          {ISSUE_STATE_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setState(filter.value)}
              className={cn(
                "rounded px-1.5 py-0.5 text-2xs transition-colors",
                state === filter.value
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {filter.label}
            </button>
          ))}
          <span aria-hidden className="mx-0.5 h-3 w-px bg-border/70" />
          {ISSUE_SORTS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setSort(option.value)}
              className={cn(
                "rounded px-1.5 py-0.5 text-2xs transition-colors",
                sort === option.value
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {listQuery.error !== null ? (
          <PanelMessage title={gt("Issues could not be read.")} detail={listQuery.error} />
        ) : entries.length === 0 ? (
          <PanelMessage
            title={
              listQuery.isPending
                ? gt("Loading issues.")
                : result?.trackers.every((tracker) => !tracker.configured)
                  ? gt("No issue tracker here.")
                  : gt("No issues.")
            }
            detail={
              listQuery.isPending
                ? null
                : // A tracker that is off is a setting, not an empty list, and saying so stops
                  // the reader looking for issues that can never appear.
                  (result?.errors[0]?.message ??
                  result?.trackers.find((tracker) => tracker.detail)?.detail ??
                  (submittedSearch.length > 0
                    ? gt("Nothing matched that search.")
                    : gt("Nothing open in {projectTitle}.", { projectTitle: props.projectTitle })))
            }
          />
        ) : (
          <ul className="divide-y divide-border/40">
            {entries.map((entry) => (
              <IssueRow
                key={`${entry.tracker}:${entry.host}:${entry.scope}:${entry.key}`}
                entry={entry}
                onOpen={() =>
                  setOpenIssue({
                    projectId: entry.projectId,
                    tracker: entry.tracker,
                    host: entry.host,
                    scope: entry.scope,
                    key: entry.key,
                  })
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function IssueRow(props: { readonly entry: IssueListEntry; readonly onOpen: () => void }) {
  const { entry } = props;
  const comments = formatCommentCount(entry.commentCount);
  return (
    <li>
      <button
        type="button"
        onClick={props.onOpen}
        className="flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors hover:bg-muted/50"
      >
        <div className="flex items-start gap-2">
          <StateIcon state={entry.state} />
          <span className="min-w-0 flex-1 text-xs leading-snug text-foreground">{entry.title}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-2xs text-muted-foreground">
          <span>{entry.displayKey}</span>
          {entry.author ? <span>{entry.author.login}</span> : null}
          {comments ? <span>{comments}</span> : null}
          {entry.labels.slice(0, 3).map((label) => (
            <span
              key={label.name}
              className="rounded-full border border-border/60 px-1.5 py-px"
              style={
                labelColor(label.color) === undefined
                  ? undefined
                  : { borderColor: labelColor(label.color), color: labelColor(label.color) }
              }
            >
              {label.name}
            </span>
          ))}
        </div>
      </button>
    </li>
  );
}

function StateIcon(props: { readonly state: IssueDetail["state"] }) {
  // Issue states wear the pull request tones: open matches an open PR, closed (done) a merged one.
  return props.state.category === "closed" ? (
    <CircleCheck
      className={cn(
        "mt-0.5 size-3.5 shrink-0",
        PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
      )}
    />
  ) : (
    <CircleDot
      className={cn("mt-0.5 size-3.5 shrink-0", PULL_REQUEST_STATE_PRESENTATION.open.toneClassName)}
    />
  );
}

function PanelMessage(props: { readonly title: string; readonly detail: string | null }) {
  return (
    <div className="px-3 py-6 text-center">
      <p className="text-xs text-foreground">{props.title}</p>
      {props.detail === null ? null : (
        <p className="mt-1 text-2xs text-muted-foreground">{props.detail}</p>
      )}
    </div>
  );
}

function IssueDetailView(props: {
  readonly environmentId: EnvironmentId;
  readonly reference: IssueRef;
  readonly cwd: string;
  readonly composerDraftTarget?: ScopedThreadRef | DraftId | undefined;
  readonly onBack: () => void;
  readonly onChanged: () => void;
}) {
  const gt = useGT();
  const { reference } = props;
  const detailQuery = useEnvironmentQuery(
    issueEnvironment.detail({ environmentId: props.environmentId, input: reference }),
  );
  const canComment = useAtomValue(issueEnvironment.comment.permissionAtom(props.environmentId));
  const canSetState = useAtomValue(issueEnvironment.setState.permissionAtom(props.environmentId));
  const comment = useAtomCommand(issueEnvironment.comment, { reportFailure: true });
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: true });
  const newThread = useNewThreadHandler();
  const [starting, setStarting] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<"comment" | "state" | null>(null);

  const detail = detailQuery.data;
  const targetState = detail?.states.find((state) => state.category !== detail.state.category);

  const postComment = async () => {
    const body = draft.trim();
    if (!canComment || body.length === 0 || pending !== null) return;
    setPending("comment");
    const result = await comment({
      environmentId: props.environmentId,
      input: { ...reference, body },
    });
    setPending(null);
    // The draft is kept on failure: the reader's words are the one thing worth not losing.
    if (result._tag === "Success") setDraft("");
  };

  const toggleState = async () => {
    if (!canSetState || !targetState || pending !== null) return;
    setPending("state");
    const result = await setState({
      environmentId: props.environmentId,
      input: { ...reference, state: targetState.name },
    });
    setPending(null);
    if (result._tag === "Success") props.onChanged();
  };

  /**
   * Opens a thread on this project, on a branch named for the issue, with the issue already in
   * its composer. Nothing is sent: the reader reads what is there and decides.
   */
  const startWork = async () => {
    if (!detail || starting) return;
    setStarting(true);
    const opened = await newThread(scopeProjectRef(props.environmentId, reference.projectId), {
      branch: issueBranchName(detail),
    }).then(
      (result) => result,
      () => null,
    );
    setStarting(false);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: gt("Could not open a thread"),
        description: gt("Try again from the project, or open a thread first."),
      });
      return;
    }
    const store = useComposerDraftStore.getState();
    const current = store.getComposerDraft(opened.draftId)?.prompt ?? "";
    store.setPrompt(opened.draftId, appendIssueContext(current, issueContextForComposer(detail)));
    toastManager.add({
      type: "success",
      title: gt("Thread opened"),
      description: gt("The issue is in the composer. Read it over, then send."),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
        <Button variant="ghost" size="xs" onClick={props.onBack}>
          <T>Back</T>
        </Button>
        <span className="text-2xs text-muted-foreground">
          {detail?.displayKey ?? reference.key}
        </span>
        <div className="flex-1" />
        {detail !== null ? (
          <Button variant="ghost" size="xs" disabled={starting} onClick={() => void startWork()}>
            {starting ? <Loader2 className="size-3 animate-spin" /> : gt("Start work")}
          </Button>
        ) : null}
        {detail !== null && props.composerDraftTarget !== undefined ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              const store = useComposerDraftStore.getState();
              const target = props.composerDraftTarget;
              if (target === undefined) return;
              const current = store.getComposerDraft(target)?.prompt ?? "";
              store.setPrompt(target, appendIssueContext(current, issueContextForComposer(detail)));
            }}
          >
            <T>Add to thread</T>
          </Button>
        ) : null}
        {detail?.writable && detail.viewerPermissions.setState && targetState ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void toggleState()}
            disabled={!canSetState || pending !== null}
          >
            {detail.state.category === "open" ? gt("Close") : gt("Reopen")}
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {detailQuery.error !== null ? (
          <PanelMessage title={gt("This issue could not be read.")} detail={detailQuery.error} />
        ) : detail === null ? (
          <PanelMessage title={gt("Loading.")} detail={null} />
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-start gap-2">
                <StateIcon state={detail.state} />
                <h2 className="min-w-0 flex-1 text-sm font-medium leading-snug">{detail.title}</h2>
              </div>
              <p className="pl-5 text-2xs text-muted-foreground">
                {detail.author?.login ?? "unknown"} <T>opened this in</T> {detail.scope}
              </p>
            </div>

            {detail.body.trim().length > 0 ? (
              <ChatMarkdown
                text={detail.body}
                cwd={props.cwd}
                environmentId={props.environmentId}
              />
            ) : (
              <p className="text-2xs text-muted-foreground">
                <T>No description.</T>
              </p>
            )}

            {detail.comments.map((entry) => (
              <div key={entry.id} className="rounded border border-border/50 px-2.5 py-2">
                <p className="mb-1 text-2xs text-muted-foreground">
                  {entry.author?.login ?? "unknown"}
                </p>
                <ChatMarkdown
                  text={entry.body}
                  cwd={props.cwd}
                  environmentId={props.environmentId}
                />
              </div>
            ))}

            {detail.commentsCursor !== null ? (
              <p className="text-2xs text-muted-foreground">
                <T>This conversation is longer than what is shown.</T>
              </p>
            ) : null}
          </div>
        )}
      </div>

      {detail?.capabilities.comment && detail.writable && detail.viewerPermissions.comment ? (
        <div className="shrink-0 border-t border-border/60 p-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={gt("Leave a comment")}
            rows={3}
            className="w-full resize-none rounded border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
          />
          <div className="mt-1.5 flex justify-end">
            <Button
              size="xs"
              onClick={() => void postComment()}
              disabled={!canComment || draft.trim().length === 0 || pending !== null}
            >
              {pending === "comment" ? <Loader2 className="size-3 animate-spin" /> : gt("Comment")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NewIssueView(props: {
  readonly environmentId: EnvironmentId;
  readonly scopes: ReadonlyArray<IssueScopeRef>;
  readonly projectTitle: string;
  readonly onCancel: () => void;
  readonly onCreated: (issue: IssueRef) => void;
}) {
  const gt = useGT();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [scopeIndex, setScopeIndex] = useState(0);
  const scope = props.scopes[scopeIndex];
  const canCreate = useAtomValue(issueEnvironment.create.permissionAtom(props.environmentId));
  const create = useAtomCommand(issueEnvironment.create, { reportFailure: true });
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (!canCreate || !scope || trimmed.length === 0 || pending) return;
    setPending(true);
    const result = await create({
      environmentId: props.environmentId,
      input: {
        ...scope,
        title: trimmed,
        body,
        labels: [],
        assignees: [],
      },
    });
    setPending(false);
    // The draft stays on screen where it failed, so nothing typed is thrown away.
    if (result._tag === "Success") props.onCreated({ ...scope, key: result.value.key });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <Button variant="ghost" size="xs" onClick={props.onCancel}>
          <T>Cancel</T>
        </Button>
        <span className="text-2xs text-muted-foreground">
          <T>New issue in</T> {props.projectTitle}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {props.scopes.length > 1 ? (
          <select
            aria-label={gt("Issue tracker")}
            value={scopeIndex}
            onChange={(event) => setScopeIndex(Number(event.target.value))}
          >
            {props.scopes.map((entry, index) => (
              <option key={`${entry.tracker}:${entry.host}:${entry.scope}`} value={index}>
                {entry.host ? `${entry.host}/${entry.scope}` : entry.scope}
              </option>
            ))}
          </select>
        ) : null}
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={gt("Title")}
          size="compact"
          aria-label={gt("Issue title")}
        />
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={gt("Description (optional)")}
          rows={10}
          className="w-full resize-none rounded border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
          aria-label={gt("Issue description")}
        />
      </div>
      <div className="shrink-0 border-t border-border/60 p-2">
        <div className="flex justify-end">
          <Button
            size="xs"
            onClick={() => void submit()}
            disabled={!canCreate || title.trim().length === 0 || pending}
          >
            {pending ? <Loader2 className="size-3 animate-spin" /> : gt("Create")}
          </Button>
        </div>
      </div>
    </div>
  );
}
