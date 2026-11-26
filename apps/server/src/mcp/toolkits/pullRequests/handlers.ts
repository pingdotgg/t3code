import {
  CommandId,
  NonNegativeInt,
  type ProviderApprovalPushHooks,
  type PullRequestActivity,
  PullRequestListCursors,
  type PullRequestRef,
  type PullRequestReviewCommentDraft,
  type PullRequestCheck,
  type PullRequestReviewThread,
  type OrchestrationProjectShell,
  type PullRequestState,
  type PullRequestWatchUntil,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadPullRequestLink,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitManager from "../../../git/GitManager.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestWatchService from "../../../pullRequest/PullRequestWatchService.ts";
import { resolveTarget, type ResolvedTarget } from "../../../pullRequest/pullRequestTarget.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import { reviewPositionInPatch } from "../../../pullRequest/pullRequestReviewPosition.ts";
import {
  ownPullRequestRepositories,
  pullRequestSyncKey,
} from "../../../pullRequest/pullRequestSyncKey.ts";
import { sourceControlDefinitions } from "../../../sourceControl/sourceControlDefinitions.ts";
import {
  normalizeThreadPullRequestKey,
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "../../../sourceControl/threadPullRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { threadNotFound } from "../../threadAccess.ts";
import {
  type ListThreadPullRequestsResult,
  PullRequestBranchHasNoneError,
  PullRequestCursorInvalidError,
  PullRequestForgeError,
  PullRequestNothingToDoError,
  type PullRequestReadSection,
  type ReadPullRequestResult,
  type ReviewLineComment,
  type ThreadPullRequestInput,
  PullRequestLinkFailedError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  type PullRequestTargetInput,
  PullRequestThreadRequiredError,
  PullRequestGuideFailedError,
  PullRequestProjectNotFoundError,
  PullRequestsToolkit,
  type ThreadPullRequestEntry,
  alreadyEndedWatchNext,
  CHECKS_ALREADY_PASSED_WATCH_NEXT,
  CHILD_PULL_REQUEST_REPORT_NEXT,
} from "./tools.ts";

const ReadCursor = Schema.Union([
  Schema.Struct({ diff: TrimmedNonEmptyString }),
  // Null marks a list the read did not ask for.
  Schema.Struct({
    threads: Schema.NullOr(NonNegativeInt),
    comments: Schema.NullOr(NonNegativeInt),
    includeResolved: Schema.Boolean,
  }),
]);
type ReadCursor = typeof ReadCursor.Type;

const ReadCursorJson = Schema.fromJsonString(ReadCursor);
const ListCursorsJson = Schema.fromJsonString(PullRequestListCursors);
const encodeReadCursorJson = Schema.encodeSync(ReadCursorJson);
const encodeListCursorsJson = Schema.encodeSync(ListCursorsJson);
const decodeReadCursorJson = Schema.decodeUnknownEffect(ReadCursorJson);
const decodeListCursorsJson = Schema.decodeUnknownEffect(ListCursorsJson);

const decodeCursorText = (cursor: string) =>
  Effect.fromResult(Base64Url.decodeString(cursor)).pipe(
    Effect.mapError(() => new PullRequestCursorInvalidError({})),
  );

const readCursors = {
  encode: (value: ReadCursor) => Base64Url.encode(encodeReadCursorJson(value)),
  decode: (cursor: string) =>
    decodeCursorText(cursor).pipe(
      Effect.flatMap(decodeReadCursorJson),
      Effect.mapError(() => new PullRequestCursorInvalidError({})),
    ),
};

const listCursors = {
  encode: (value: PullRequestListCursors) => Base64Url.encode(encodeListCursorsJson(value)),
  decode: (cursor: string) =>
    decodeCursorText(cursor).pipe(
      Effect.flatMap(decodeListCursorsJson),
      Effect.mapError(() => new PullRequestCursorInvalidError({})),
    ),
};

/** Keeps one conversation page near the size of a capped CI log. */
const CONVERSATION_PAGE_CHARS = 32_000;
const THREAD_COMMENT_PAGES = 4;
/** Diff pages searched for review comment lines; a PR past this is too big to review by line. */
const REVIEW_DIFF_PAGES = 10;

function conversationPage(
  activity: PullRequestActivity,
  start: { readonly threads: number | null; readonly comments: number | null },
  includeResolved: boolean,
) {
  // Offsets index the unfiltered lists, whose order resolving a thread does not change.
  const { reviewThreads, comments } = activity;
  const pageThreads: Array<PullRequestReviewThread> = [];
  const pageComments: Array<PullRequestActivity["comments"][number]> = [];
  let size = 0;
  let thread = start.threads === null ? null : Math.min(start.threads, reviewThreads.length);
  let comment = start.comments === null ? null : Math.min(start.comments, comments.length);
  const fits = (item: unknown) => {
    const next = size + JSON.stringify(item).length;
    if (next > CONVERSATION_PAGE_CHARS && pageThreads.length + pageComments.length > 0) {
      return false;
    }
    size = next;
    return true;
  };
  // Review threads come first: they hold the feedback an agent acts on.
  while (thread !== null && thread < reviewThreads.length) {
    const next = reviewThreads[thread]!;
    if (includeResolved || !next.isResolved) {
      if (!fits(next)) break;
      pageThreads.push(next);
    }
    thread += 1;
  }
  const threadsDone = thread === null || thread === reviewThreads.length;
  if (threadsDone) {
    while (comment !== null && comment < comments.length && fits(comments[comment])) {
      pageComments.push(comments[comment++]!);
    }
  }
  const done = threadsDone && (comment === null || comment === comments.length);
  return {
    threads: pageThreads,
    comments: pageComments,
    next: done ? null : { threads: thread, comments: comment, includeResolved },
  };
}

function checksSummary(checks: ReadonlyArray<PullRequestCheck>) {
  let passed = 0;
  let pending = 0;
  let incomplete = false;
  const failed: Array<string> = [];
  for (const check of checks) {
    if (check.placeholder === true) incomplete = true;
    else if (check.status === "failure" || check.status === "cancelled") failed.push(check.name);
    else if (check.status === "pending" || check.status === "action-required") pending += 1;
    else passed += 1;
  }
  return { passed, pending, failed, ...(incomplete ? { incomplete: true as const } : {}) };
}

function entryOf(
  link: ThreadPullRequestLink,
  chains: ReturnType<typeof resolveThreadPullRequestChains>,
): ThreadPullRequestEntry {
  const key = threadPullRequestKeyOf(link);
  let stack: ThreadPullRequestEntry["stack"] = null;
  for (const chain of chains) {
    if (chain.layers.length < 2) continue;
    const index = chain.layers.findIndex((layer) => threadPullRequestKeyOf(layer) === key);
    if (index !== -1) {
      stack = { kind: chain.kind, position: chain.depths[index]! + 1, size: chain.layers.length };
      break;
    }
  }
  return {
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
    url: link.url,
    source: link.source,
    watching: link.watch !== undefined,
    state: link.snapshot?.state ?? null,
    title: link.snapshot?.title ?? null,
    headBranch: link.snapshot?.headBranch ?? null,
    baseBranch: link.snapshot?.baseBranch ?? null,
    isDraft: link.snapshot?.isDraft ?? null,
    stack,
  };
}

const PULL_REQUEST_LIST_PAGE_SIZE = 50;

// A total order that survives unlinking: the cursor names a position, not an index, so removing
// PRs already returned cannot skip later ones. PRs linked in one call share `linkedAt`.
function pullRequestListPosition(link: ThreadPullRequestLink): string {
  return [link.linkedAt, link.host, link.repository, String(link.number).padStart(10, "0")].join(
    " ",
  );
}

export function listThreadPullRequests(
  thread: Pick<OrchestrationV2ThreadShell, "pullRequests">,
  cursor?: string,
  states?: ReadonlyArray<PullRequestState>,
): ListThreadPullRequestsResult {
  const chains = resolveThreadPullRequestChains(thread.pullRequests ?? []);
  const after = visibleThreadPullRequests(thread.pullRequests ?? [])
    .filter((link) => states === undefined || states.includes(link.snapshot?.state ?? "open"))
    .map((link) => ({ link, position: pullRequestListPosition(link) }))
    .filter(({ position }) => cursor === undefined || position > cursor)
    .toSorted((left, right) => (left.position < right.position ? -1 : 1));
  const page = after.slice(0, PULL_REQUEST_LIST_PAGE_SIZE);
  const pageKeys = new Set(page.map(({ link }) => threadPullRequestKeyOf(link)));
  return {
    pullRequests: page.map(({ link }) => entryOf(link, chains)),
    // Stacks with a pull request on this page, whole.
    chains: chains
      .filter((chain) => chain.layers.some((layer) => pageKeys.has(threadPullRequestKeyOf(layer))))
      .map((chain) => ({
        kind: chain.kind,
        numbers: chain.layers.map((layer) => layer.number),
      })),
    nextCursor: after.length > page.length ? page.at(-1)!.position : null,
  };
}

function projectForPullRequest(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  target: { readonly host: string; readonly repository: string },
  preferred: OrchestrationProjectShell | undefined,
): OrchestrationProjectShell | undefined {
  // Match the guide service's host-level repository key, including Azure DevOps org/project/_git/repo.
  const matches = (project: OrchestrationProjectShell) => {
    const own = pullRequestSyncKey(
      { projectId: project.id, host: target.host, repository: target.repository, number: 1 },
      project.repositoryIdentity ?? undefined,
    );
    return (
      own !== null &&
      ownPullRequestRepositories(project.repositoryIdentity).some(
        ({ key }) => own.host === key.host && own.repository === key.repository,
      )
    );
  };
  if (preferred !== undefined && matches(preferred)) return preferred;
  return projects.find(matches);
}

const isPushHooksUnapproved = Schema.is(GitManager.GitPushHooksUnapprovedError);

const PUSH_HOOKS_CHANGED =
  "This repository's push hooks changed while the user was asked. Nothing was pushed. Call again to ask.";

/**
 * What one approval is given for, and so what a client that remembers approvals remembers it by:
 * the contents of the named files. The request's state carries these whole and its text the
 * start of each, so edited files read differently and are asked about again.
 */
const pushHooksApprovalKey = (hooks: { readonly digest: string }) => [hooks.digest];

type NamedPushHooks = Pick<GitManager.GitPushHooksUnapprovedError, "files" | "commands" | "digest">;

/** The branch and hooks one approval names, for a client that shows them as details. */
const pushHooksNamed = (
  cwd: string,
  branch: string,
  hooks: NamedPushHooks,
): ProviderApprovalPushHooks => ({
  branch,
  // Hooks kept in the checkout read as the person knows them, such as `.husky/pre-push`.
  files: hooks.files.map((file) =>
    file.startsWith(cwd) && /^[\\/]/.test(file.slice(cwd.length))
      ? file.slice(cwd.length + 1)
      : file,
  ),
  commands: hooks.commands,
});

/** The hooks a push would run, ending its question: each one named, and the start of the key. */
const pushHooksClause = (
  { files, commands: configured }: ProviderApprovalPushHooks,
  hooks: NamedPushHooks,
) => {
  const list = (one: string, many: string, items: ReadonlyArray<string>) =>
    items.length === 0
      ? []
      : items.length === 1
        ? [`${one} ${items[0]}`]
        : [`${many} ${items.slice(0, -1).join(", ")} and ${items.at(-1)}`];
  // File names and commands are the repository's, so each is shown as data.
  const commands = configured.map(
    ({ name, command }) => `${McpToolAccess.quoted(name)} (${McpToolAccess.quoted(command, 300)})`,
  );
  const named = [
    ...list(
      "hook file",
      "hook files",
      files.map((file) => McpToolAccess.quoted(file, 300)),
    ),
    ...list("configured hook", "configured hooks", commands),
  ].join(" and its ");
  const key = pushHooksApprovalKey(hooks)
    .map((part) => part.slice(0, 8))
    .join(" ");
  return `, running this repository's ${named} (contents ${key})`;
};

/** A commit as a person reads one: the start of its id. The whole id is what the approval binds. */
const shortCommit = (sha: string) => McpToolAccess.quoted(sha.slice(0, 10));

/** What opening a pull request asks a person: what is pushed where, and what is opened against what. */
const openingAsks = (opening: GitManager.PullRequestOpening, isPrivate: boolean) => {
  const branch = `${McpToolAccess.quoted(opening.branch)} at ${shortCommit(opening.head)}`;
  const base = `into ${McpToolAccess.quoted(opening.baseBranch)}`;
  const { push } = opening;
  if (push === null) {
    // Nothing is pushed, so the pull request is of the branch as its remote has it.
    // On a branch behind its remote, the pull request shows the remote's commits.
    const at =
      opening.headRefCommit === null || opening.headRefCommit === opening.head
        ? ""
        : ` at ${shortCommit(opening.headRefCommit)}`;
    const on = opening.headRef === null ? "" : ` (${McpToolAccess.quoted(opening.headRef)}${at})`;
    return { action: "Open", target: `a pull request for ${branch}${on} ${base}` };
  }
  const to =
    push.remoteName === null
      ? // Its host makes the companion when first asked to, so it has no name to show yet.
        "this repository's private companion, a separate repository on its host"
      : `${McpToolAccess.quoted(push.remoteName)} (${push.urls
          .map((url) => McpToolAccess.quoted(url, 200))
          .join(", ")})`;
  const as =
    push.remoteBranch === opening.branch ? "" : ` as ${McpToolAccess.quoted(push.remoteBranch)}`;
  return {
    action: `Push ${branch} to ${to}${as} and open`,
    target: `a${isPrivate ? " private" : ""} pull request ${base}`,
  };
};

const updateAction = (input: {
  readonly title?: unknown;
  readonly body?: unknown;
  readonly ready?: unknown;
  readonly state?: "open" | "closed" | undefined;
  readonly addLabels?: unknown;
  readonly removeLabels?: unknown;
  readonly requestReviewers?: unknown;
}) => {
  // The kinds of edit are named, never their text: some notify people and some do not.
  const edits = [
    ...(input.title === undefined ? [] : ["the title"]),
    ...(input.body === undefined ? [] : ["the description"]),
    ...(input.addLabels === undefined && input.removeLabels === undefined ? [] : ["the labels"]),
    ...(input.ready === undefined
      ? []
      : [`the draft status (to ${input.ready === true ? "ready for review" : "draft"})`]),
    ...(input.requestReviewers === undefined ? [] : ["the reviewers (requesting review)"]),
  ];
  const changes =
    edits.length === 0
      ? undefined
      : `Change ${edits.length === 1 ? edits[0] : `${edits.slice(0, -1).join(", ")} and ${edits.at(-1)}`} of`;
  if (input.state === undefined) return changes ?? "Update";
  const ends = input.state === "closed" ? "close" : "reopen";
  return changes === undefined
    ? input.state === "closed"
      ? "Close"
      : "Reopen"
    : `${changes} and ${ends}`;
};

const respondAction = (input: {
  readonly body?: unknown;
  readonly reviewThreadId?: unknown;
  readonly resolved?: boolean | undefined;
}) => {
  if (input.reviewThreadId === undefined) return "Comment on";
  const resolves = input.resolved === true ? "resolve" : "reopen";
  if (input.body === undefined)
    return `${input.resolved === true ? "Resolve" : "Reopen"} a review thread on`;
  return input.resolved === undefined
    ? "Reply in a review thread on"
    : `Reply in and ${resolves} a review thread on`;
};

const reviewAction = (input: { readonly verdict: "comment" | "approve" | "request-changes" }) =>
  input.verdict === "approve"
    ? "Approve"
    : input.verdict === "request-changes"
      ? "Request changes on"
      : "Review";

const mergeAction = (input: { readonly auto?: boolean | undefined }) =>
  input.auto === true ? "Enable auto-merge on" : "Merge";

/** The pull requests one stack merge covers, bottom to top, each at the head it is pinned to. */
const stackNamed = (layers: ReadonlyArray<{ readonly number: number; readonly headSha: string }>) =>
  `the stack of ${layers
    .map((layer) => `#${layer.number} at ${shortCommit(layer.headSha)}`)
    .join(", ")}, up to`;

const CHECK_NAME_SHOWN = 80;

/** The checks a rerun would act on, as the question names them: every one, by its whole name. */
const checksNamed = (checks: ReadonlyArray<PullRequestService.RerunnableCheck>) =>
  `${checks.length === 1 ? "check" : `${checks.length} checks:`} ${checks
    .map((check) => McpToolAccess.quoted(check.name, CHECK_NAME_SHOWN))
    .join(", ")}`;

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;
  const watches = yield* PullRequestWatchService.PullRequestWatchService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const git = yield* GitManager.GitManager;

  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const commandId = (tag: string, threadId: ThreadId) =>
    random.uuidV4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  const requireThread = Effect.fn("PullRequestsToolkit.requireThread")(function* (
    Failure:
      | typeof PullRequestLinkFailedError
      | typeof PullRequestUnlinkFailedError
      | typeof PullRequestListFailedError
      | typeof PullRequestForgeError,
    requested: ThreadId | undefined,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* new PullRequestThreadRequiredError();
    }
    const thread = yield* engine.getThreadShell(threadId).pipe(
      Effect.map(Option.fromNullishOr),
      Effect.mapError((cause) => new Failure({ cause })),
    );
    if (Option.isNone(thread) || thread.value.deletedAt !== null) {
      return yield* threadNotFound(engine, scope, threadId, `Thread ${threadId} was not found.`);
    }
    return thread.value;
  });

  const projectOf = (
    thread: OrchestrationV2ThreadShell,
    Failure:
      | typeof PullRequestLinkFailedError
      | typeof PullRequestUnlinkFailedError
      | typeof PullRequestForgeError,
  ) =>
    pullRequests
      .addressedProject(thread.projectId)
      .pipe(Effect.mapError((cause) => new Failure({ cause })));

  const dispatchFailure =
    (Failure: typeof PullRequestLinkFailedError | typeof PullRequestUnlinkFailedError) =>
    <E>(
      cause: Cause.Cause<E>,
    ): Effect.Effect<never, PullRequestLinkFailedError | PullRequestUnlinkFailedError> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new Failure({ cause }));

  // The domain service owns the registration span.
  const setWatching = Effect.fnUntraced(function* (
    input: PullRequestTargetInput & { readonly until?: PullRequestWatchUntil | undefined },
    watching: boolean,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const threadId = input.threadId ?? scope.thread?.threadId;
    if (threadId === undefined) return yield* new PullRequestThreadRequiredError();
    return yield* watches
      .setWatching({ threadId, target: input, watching, until: input.until })
      .pipe(
        Effect.map((result) =>
          result.state !== undefined
            ? { ...result, next: alreadyEndedWatchNext(result.state) }
            : result.checksState === "passing"
              ? { ...result, next: CHECKS_ALREADY_PASSED_WATCH_NEXT }
              : result,
        ),
        Effect.catchTags({
          PullRequestWatchThreadNotFoundError: (error) =>
            threadNotFound(engine, scope, error.threadId, error.message),
        }),
      );
  });

  const locateAll = Effect.fn("PullRequestsToolkit.locateAll")(function* (
    targets: ReadonlyArray<Omit<PullRequestTargetInput, "threadId">>,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const callerThread =
      scope.thread === undefined
        ? undefined
        : yield* engine.getThreadShell(scope.thread.threadId).pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((shell) => shell ?? undefined),
          );
    const known = yield* projects
      .listShells()
      .pipe(Effect.mapError((cause) => new PullRequestListFailedError({ cause })));
    const callerProject =
      callerThread === undefined
        ? undefined
        : yield* pullRequests
            .addressedProject(callerThread.projectId)
            .pipe(Effect.mapError((cause) => new PullRequestListFailedError({ cause })));
    // A pull request named by host and repository builds its URL through the project that holds
    // it, which need not be the caller's.
    const urlProject = (input: PullRequestTargetInput) =>
      input.url === undefined && input.host !== undefined && input.repository !== undefined
        ? (projectForPullRequest(
            known,
            { host: input.host, repository: input.repository },
            callerProject,
          ) ?? callerProject)
        : callerProject;
    return yield* Effect.forEach(targets, (input) =>
      resolveTarget(input, urlProject(input)).pipe(
        Effect.map((target) => ({
          input,
          target,
          project: projectForPullRequest(known, target, callerProject),
          callerProject,
          failure: null,
        })),
        Effect.catch((error) =>
          Effect.succeed({
            input,
            target: null,
            project: undefined,
            callerProject,
            failure: error.message,
          }),
        ),
      ),
    );
  });

  const guideReference = (
    project: OrchestrationProjectShell,
    target: { readonly host: string; readonly repository: string; readonly number: number },
  ) => ({
    projectId: project.id,
    host: target.host,
    repository: target.repository,
    number: target.number,
  });

  const guideFailureDetail = (error: { readonly message: string }) =>
    "detail" in error && typeof error.detail === "string" ? error.detail : error.message;

  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  const forgeFailure = (error: { readonly message: string }) =>
    new PullRequestForgeError({ detail: error.message, cause: error });

  // Layers below the target are pinned to the heads read here; the host refuses if any moved.
  const stackMergeScope = Effect.fnUntraced(function* (
    ref: PullRequestRef,
    input: { readonly expectedHeadSha: string },
  ) {
    const stack = yield* pullRequests
      .stack(ref, { bypassCache: true })
      .pipe(Effect.mapError(forgeFailure));
    const end = stack?.layers.findIndex((layer) => layer.number === ref.number) ?? -1;
    if (stack === null || end === -1)
      return yield* new PullRequestForgeError({
        detail: `PR #${ref.number} is not in a stack this host can merge. Merge it without stack.`,
      });
    const expectedStackHeads: Array<{ readonly number: number; readonly headSha: string }> = [];
    for (const layer of stack.layers.slice(0, end + 1)) {
      if (layer.state === "merged") continue;
      const headSha =
        layer.number !== ref.number
          ? layer.headSha
          : layer.headSha !== undefined &&
              PullRequestService.isHeadSha(layer.headSha, input.expectedHeadSha)
            ? layer.headSha
            : input.expectedHeadSha;
      if (headSha === undefined)
        return yield* new PullRequestForgeError({
          detail: `The host did not report PR #${layer.number}'s head, so the stack cannot be pinned. Try again.`,
        });
      expectedStackHeads.push({ number: layer.number, headSha });
    }
    return { stackNumber: stack.number, expectedStackHeads };
  });

  /** A login or org/team, matched to the host's own reviewer id. */
  const reviewerNamed = (ref: PullRequestRef, name: string) =>
    pullRequests.reviewerCandidates({ ...ref, query: name }).pipe(
      Effect.mapError(forgeFailure),
      Effect.flatMap(({ candidates }) => {
        const wanted = name.toLowerCase();
        const match = candidates.find(
          (candidate) =>
            candidate.login.toLowerCase() === wanted || candidate.id.toLowerCase() === wanted,
        );
        return match === undefined
          ? Effect.fail(
              new PullRequestForgeError({
                detail: `No reviewer named ${name} can be requested on this PR.`,
              }),
            )
          : Effect.succeed({ id: match.id, kind: match.kind });
      }),
    );

  /** Line comments placed by the PR's diff, which says whether each line was added, removed, or kept. */
  const reviewComments = Effect.fn("PullRequestsToolkit.reviewComments")(function* (
    ref: PullRequestRef,
    comments: ReadonlyArray<ReviewLineComment>,
  ) {
    const placed = new Map<ReviewLineComment, PullRequestReviewCommentDraft>();
    // Comments whose end line some page showed, so a failure names the line that is missing.
    const lineShown = new Set<ReviewLineComment>();
    const unplaced = () => comments.filter((comment) => !placed.has(comment));
    let cursor: string | undefined;
    for (let page = 0; page < REVIEW_DIFF_PAGES && unplaced().length > 0; page += 1) {
      const diff = yield* pullRequests
        .diff({ ...ref, ...(cursor === undefined ? {} : { cursor }) })
        .pipe(Effect.mapError(forgeFailure));
      for (const comment of unplaced()) {
        const side = comment.side ?? "new";
        const position = reviewPositionInPatch(diff.patch, comment.path, comment.line, side);
        const start =
          comment.startLine === undefined
            ? undefined
            : reviewPositionInPatch(diff.patch, comment.path, comment.startLine, side);
        if (position !== null) lineShown.add(comment);
        if (position === null || start === null) continue;
        placed.set(comment, {
          path: comment.path,
          position,
          ...(start === undefined ? {} : { startPosition: start }),
          body: comment.body,
        });
      }
      if (diff.nextCursor === null) break;
      cursor = diff.nextCursor;
    }
    const missing = unplaced()[0];
    if (missing !== undefined) {
      const missingLine =
        missing.startLine !== undefined && lineShown.has(missing)
          ? missing.startLine
          : missing.line;
      return yield* new PullRequestForgeError({
        detail: `${missing.path} line ${missingLine} (${missing.side ?? "new"} side) is not in this PR's diff. Comment on a changed line or one shown around it.`,
      });
    }
    return comments.map((comment) => placed.get(comment)!);
  });

  /** The thread's checkout, its project, and the PR the input names (default: the branch's). */
  const locate = Effect.fn("PullRequestsToolkit.locate")(function* (input: ThreadPullRequestInput) {
    const thread = yield* requireThread(PullRequestForgeError, undefined);
    const project = yield* projectOf(thread, PullRequestForgeError);
    if (project === undefined) {
      return yield* new PullRequestProjectNotFoundError({ repository: input.repository ?? "" });
    }
    // Status sync sets branchPullRequest later, so a PR this thread just opened counts too,
    // unless it is another branch's.
    const opened =
      thread.branchPullRequest === null || thread.branchPullRequest === undefined
        ? threadPullRequestsOf(thread).findLast(
            (link) =>
              link.source === "created" &&
              (link.snapshot === null || link.snapshot.headBranch === thread.branch),
          )
        : undefined;
    const branchPullRequest = thread.branchPullRequest ?? opened ?? null;
    const branchRepository =
      project.repositoryIdentity == null
        ? undefined
        : (sourceControlDefinitions.repositorySelector(project.repositoryIdentity) ?? undefined);
    const named =
      input.number !== undefined
        ? { number: input.number, repository: input.repository ?? branchRepository }
        : branchPullRequest === null
          ? null
          : { number: branchPullRequest.number, repository: branchPullRequest.repository };
    if (named === null) return yield* new PullRequestBranchHasNoneError();
    const target = yield* resolveTarget(named, project);
    const ref: PullRequestRef = {
      projectId: project.id,
      host: target.host,
      repository: target.repository,
      number: target.number,
    };
    if (input.number === undefined && opened !== undefined && opened.snapshot === null) {
      // Not synced yet, so only the host knows which branch it was opened from.
      const summary = yield* pullRequests.summary(ref).pipe(Effect.mapError(forgeFailure));
      if (summary.headBranch !== thread.branch) return yield* new PullRequestBranchHasNoneError();
    }
    return { thread, project, target, ref };
  });

  /** What a write to `target` asks a person: the pull request, where it is, and whose it is. */
  const asksOf = (
    action: string,
    {
      project,
      target,
    }: { readonly project: OrchestrationProjectShell; readonly target: ResolvedTarget },
  ): McpToolAccess.OutsideAction => ({
    action,
    target: `pull request #${target.number}`,
    repository: target.repository,
    host: target.host,
    ...(projectForPullRequest([project], target, undefined) === undefined
      ? { otherRepository: true }
      : {}),
  });

  const identityOf = (target: ResolvedTarget) => ({
    host: target.host,
    repository: target.repository,
    number: target.number,
    url: target.url,
  });

  /** The thread's comments past its first page, when the host pages them. */
  const restOfThread = Effect.fn("PullRequestsToolkit.restOfThread")(function* (
    ref: PullRequestRef,
    thread: PullRequestReviewThread,
  ) {
    const comments: Array<PullRequestReviewThread["comments"][number]> = [];
    let cursor = thread.nextCommentsCursor;
    for (let page = 0; cursor !== undefined && page < THREAD_COMMENT_PAGES; page += 1) {
      const read = yield* pullRequests
        .threadComments({ ...ref, threadId: thread.id, cursor })
        .pipe(Effect.option);
      if (Option.isNone(read)) break;
      comments.push(...read.value.comments);
      cursor = read.value.nextCursor ?? undefined;
    }
    return { comments, moreComments: cursor !== undefined };
  });

  const readSections = Effect.fn("PullRequestsToolkit.readSections")(function* (
    ref: PullRequestRef,
    sections: ReadonlyArray<PullRequestReadSection>,
    includeResolved: boolean,
    cursor: ReadCursor | undefined,
  ) {
    const wants = (section: PullRequestReadSection) => sections.includes(section);
    const diffCursor = cursor !== undefined && "diff" in cursor ? cursor.diff : undefined;
    const [detail, activity, diff] = yield* Effect.all(
      [
        // Agents pin merges to this headSha, so it must not come from a stale snapshot.
        pullRequests.detail({ ...ref, allowStale: false }),
        pullRequests.activity(ref),
        wants("diff")
          ? pullRequests
              .diff({ ...ref, ...(diffCursor === undefined ? {} : { cursor: diffCursor }) })
              .pipe(Effect.asSome)
          : Effect.succeedNone,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError(forgeFailure));
    const wantsThreads = wants("threads");
    const wantsComments = wants("comments");
    const page =
      wantsThreads || wantsComments
        ? Option.some(
            conversationPage(
              activity,
              cursor !== undefined && "threads" in cursor
                ? cursor
                : { threads: wantsThreads ? 0 : null, comments: wantsComments ? 0 : null },
              includeResolved,
            ),
          )
        : Option.none();
    const threadRests = Option.isSome(page)
      ? yield* Effect.forEach(page.value.threads, (thread) => restOfThread(ref, thread), {
          concurrency: 4,
        })
      : [];
    const result: Omit<ReadPullRequestResult, "host" | "repository" | "number" | "url"> = {
      title: detail.title,
      state: detail.state,
      isDraft: detail.isDraft,
      ...(detail.visibility === undefined ? {} : { visibility: detail.visibility }),
      author: detail.author?.login ?? null,
      headBranch: detail.headBranch,
      baseBranch: detail.baseBranch,
      headSha: detail.headSha ?? null,
      mergeability: detail.mergeability,
      behindBy: detail.behindBy ?? null,
      autoMergeEnabled: detail.autoMergeEnabled ?? null,
      checks: checksSummary(detail.checks),
      unresolvedThreads: activity.reviewThreads.filter((thread) => !thread.isResolved).length,
      ...(activity.reviewThreadsTruncated === true ? { unresolvedThreadsTruncated: true } : {}),
      ...(wants("body") ? { body: detail.body } : {}),
      ...(wants("checks") ? { checkRuns: detail.checks } : {}),
      ...(Option.isSome(page)
        ? {
            conversation: {
              ...(wantsThreads
                ? {
                    reviewThreads: page.value.threads.map((thread, index) => ({
                      id: thread.id,
                      path: thread.path,
                      line: thread.line,
                      isResolved: thread.isResolved,
                      isOutdated: thread.isOutdated,
                      comments: [...thread.comments, ...threadRests[index]!.comments].map(
                        (comment) => ({
                          author: comment.author?.login ?? null,
                          body: comment.body,
                          createdAt: comment.createdAt,
                        }),
                      ),
                      moreComments: threadRests[index]!.moreComments,
                    })),
                  }
                : {}),
              ...(wantsComments
                ? {
                    comments: page.value.comments.map((comment) => ({
                      id: comment.id,
                      kind: comment.kind,
                      author: comment.author?.login ?? null,
                      body: comment.body,
                      createdAt: comment.createdAt,
                      path: comment.path,
                      reviewState: comment.reviewState,
                    })),
                  }
                : {}),
              truncated:
                (wantsComments && activity.commentsTruncated) ||
                (wantsThreads && activity.reviewThreadsTruncated === true),
              nextCursor: page.value.next === null ? null : readCursors.encode(page.value.next),
            },
          }
        : {}),
      ...(Option.isSome(diff)
        ? {
            diff: {
              patch: diff.value.patch,
              truncated: diff.value.truncated,
              nextCursor:
                diff.value.nextCursor === null
                  ? null
                  : readCursors.encode({ diff: diff.value.nextCursor }),
            },
          }
        : {}),
    };
    return result;
  });

  const linkToThread = Effect.fn("PullRequestsToolkit.linkToThread")(function* (
    thread: OrchestrationV2ThreadShell,
    target: ResolvedTarget,
  ) {
    if (
      threadPullRequestsOf(thread).some(
        (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
      )
    ) {
      return;
    }
    yield* engine
      .dispatch({
        type: "thread.pull-request.link",
        commandId: yield* commandId("mcp-pr-create", thread.id),
        threadId: thread.id,
        host: target.host,
        repository: target.repository,
        number: target.number,
        url: target.url,
        source: "created",
      })
      .pipe(Effect.catchCause(dispatchFailure(PullRequestLinkFailedError)));
  });

  return {
    link_pull_request: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestLinkFailedError, input.threadId);
        const next =
          thread.lineage.relationshipToParent === "subagent"
            ? { next: CHILD_PULL_REQUEST_REPORT_NEXT }
            : {};
        const project = yield* projectOf(thread, PullRequestLinkFailedError);
        const target = yield* resolveTarget(input, project);
        const existing = threadPullRequestsOf(thread).find((link) =>
          threadPullRequestKeysEqual(link, target),
        );
        if (existing && existing.source !== "stack-dismissed")
          return { ...target, alreadyLinked: true, ...next };
        const alreadyLinked = yield* engine
          .dispatch({
            type: "thread.pull-request.link",
            commandId: yield* commandId("mcp-pr-link", thread.id),
            threadId: thread.id,
            host: target.host,
            repository: target.repository,
            number: target.number,
            url: target.url,
            source: "agent",
          })
          .pipe(
            Effect.as(false),

            Effect.catchCause(dispatchFailure(PullRequestLinkFailedError)),
          );
        return { ...target, alreadyLinked, ...next };
      }),
    ),
    link_pull_requests: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestLinkFailedError, input.threadId);
        const targets: Array<ResolvedTarget> = [];
        const invalidUrls: Array<string> = [];
        for (const url of input.urls) {
          const target = yield* resolveTarget({ url }, undefined).pipe(Effect.option);
          if (Option.isNone(target)) invalidUrls.push(url);
          else if (!targets.some((seen) => threadPullRequestKeysEqual(seen, target.value)))
            targets.push(target.value);
        }
        const links = threadPullRequestsOf(thread);
        const isLinked = (target: ResolvedTarget) =>
          links.some(
            (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
          );
        const fresh = targets.filter((target) => !isLinked(target));
        const alreadyLinked = targets.filter(isLinked);
        yield* Effect.forEach(fresh, (target) =>
          Effect.gen(function* () {
            yield* engine.dispatch({
              type: "thread.pull-request.link",
              commandId: yield* commandId("mcp-pr-link", thread.id),
              threadId: thread.id,
              host: target.host,
              repository: target.repository,
              number: target.number,
              url: target.url,
              source: "agent",
            });
          }).pipe(Effect.catchCause(dispatchFailure(PullRequestLinkFailedError))),
        );
        const byRepository = (prs: ReadonlyArray<ResolvedTarget>) =>
          [...Map.groupBy(prs, (pr) => `${pr.host}/${pr.repository}`).values()].map((group) => ({
            host: group[0]!.host,
            repository: group[0]!.repository,
            numbers: group.map((pr) => pr.number),
          }));
        return {
          linked: byRepository(fresh),
          alreadyLinked: byRepository(alreadyLinked),
          linkedCount: targets.length,
          ...(invalidUrls.length > 0 ? { invalidUrls } : {}),
          ...(thread.lineage.relationshipToParent === "subagent"
            ? { next: CHILD_PULL_REQUEST_REPORT_NEXT }
            : {}),
        };
      }),
    ),
    unlink_pull_request: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestUnlinkFailedError, input.threadId);
        const project = yield* projectOf(thread, PullRequestUnlinkFailedError);
        const target = yield* resolveTarget(input, project);
        if (
          !threadPullRequestsOf(thread).some(
            (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
          )
        )
          return {
            host: target.host,
            repository: target.repository,
            number: target.number,
            wasLinked: false,
          };
        const wasLinked = yield* engine
          .dispatch({
            type: "thread.pull-request.unlink",
            commandId: yield* commandId("mcp-pr-unlink", thread.id),
            threadId: thread.id,
            host: target.host,
            repository: target.repository,
            number: target.number,
          })
          .pipe(
            Effect.as(true),

            Effect.catchCause(dispatchFailure(PullRequestUnlinkFailedError)),
          );
        return {
          host: target.host,
          repository: target.repository,
          number: target.number,
          wasLinked,
        };
      }),
    ),
    unlink_pull_requests: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestUnlinkFailedError, input.threadId);
        const visible = visibleThreadPullRequests(threadPullRequestsOf(thread));
        const matching = visible.flatMap((link) => {
          const state = link.snapshot?.state;
          return state !== undefined && input.states.includes(state)
            ? [{ ...normalizeThreadPullRequestKey(link), state }]
            : [];
        });
        yield* Effect.forEach(matching, ({ host, repository, number }) =>
          Effect.gen(function* () {
            yield* engine.dispatch({
              type: "thread.pull-request.unlink",
              commandId: yield* commandId("mcp-pr-unlink", thread.id),
              threadId: thread.id,
              host,
              repository,
              number,
            });
          }).pipe(Effect.catchCause(dispatchFailure(PullRequestUnlinkFailedError))),
        );
        // Numbers grouped by repository and state keep a large batch's result small.
        const groups = Map.groupBy(matching, (pr) => `${pr.host}/${pr.repository}/${pr.state}`);
        return {
          unlinked: [...groups.values()].map((prs) => ({
            host: prs[0]!.host,
            repository: prs[0]!.repository,
            state: prs[0]!.state,
            numbers: prs.map((pr) => pr.number),
          })),
          unlinkedCount: matching.length,
          remaining: visible.length - matching.length,
        };
      }),
    ),
    list_thread_pull_requests: McpToolAccess.reads((input) =>
      requireThread(PullRequestListFailedError, input.threadId).pipe(
        Effect.map((thread) => listThreadPullRequests(thread, input.cursor, input.states)),
      ),
    ),
    watch_pull_request: writesThread((input) => setWatching(input, true)),
    unwatch_pull_request: writesThread((input) => setWatching(input, false)),
    write_pull_request_guides: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const located = yield* locateAll(input.pullRequests);
        const guides = yield* Effect.forEach(
          located,
          (entry) =>
            Effect.gen(function* () {
              if (entry.target === null) {
                return {
                  host: entry.input.host ?? "",
                  repository: entry.input.repository ?? "",
                  number: entry.input.number ?? 0,
                  url: entry.input.url ?? "",
                  outcome: "failed" as const,
                  detail: entry.failure,
                };
              }
              const identity = {
                host: entry.target.host,
                repository: entry.target.repository,
                number: entry.target.number,
                url: entry.target.url,
              };
              if (entry.project === undefined) {
                return {
                  ...identity,
                  outcome: "failed" as const,
                  detail: new PullRequestProjectNotFoundError({
                    repository: entry.target.repository,
                  }).message,
                };
              }
              return yield* reviewGuides.generate(guideReference(entry.project, entry.target)).pipe(
                Effect.map((result) => ({
                  ...identity,
                  outcome: result.started ? ("started" as const) : ("running" as const),
                  detail: null,
                })),
                Effect.catch((error) =>
                  Effect.succeed({
                    ...identity,
                    outcome: "failed" as const,
                    detail: guideFailureDetail(error),
                  }),
                ),
              );
            }),
          { concurrency: 4 },
        );
        return { guides };
      }),
    ),
    read_pull_request_guide: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const [entry] = yield* locateAll([input]);
        if (entry !== undefined && entry.target === null) {
          return yield* new PullRequestGuideFailedError({ detail: entry.failure ?? "" });
        }
        // Hosts readable without a checkout (GitHub, Bitbucket, Forgejo) are read through the
        // caller's project; PullRequestService decides whether the host allows that.
        const project = entry?.project ?? entry?.callerProject;
        if (entry === undefined || entry.target === null || project === undefined) {
          return yield* new PullRequestProjectNotFoundError({
            repository: entry?.target.repository ?? input.repository ?? "",
          });
        }
        const target = entry.target;
        const result = yield* reviewGuides.get(guideReference(project, target)).pipe(
          Effect.mapError((error) =>
            entry.project === undefined &&
            error._tag === "PullRequestUnavailableError" &&
            (error.reason === "provider-unsupported" ||
              error.reason === "repository-without-project")
              ? new PullRequestProjectNotFoundError({ repository: target.repository })
              : new PullRequestGuideFailedError({
                  detail: guideFailureDetail(error),
                  cause: error,
                }),
          ),
        );
        return {
          host: entry.target.host,
          repository: entry.target.repository,
          number: entry.target.number,
          url: entry.target.url,
          guide: result.guide,
          run: result.run,
          currentHeadSha: result.currentHeadSha,
          stale:
            result.guide !== null &&
            result.currentHeadSha !== null &&
            result.guide.headSha !== result.currentHeadSha,
        };
      }),
    ),
    pull_request_read: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const cursor =
          input.cursor === undefined ? undefined : yield* readCursors.decode(input.cursor);
        const { target, ref } = yield* locate(input);
        // A cursor continues the one section it came from, with that read's options.
        const sections: ReadonlyArray<PullRequestReadSection> =
          cursor === undefined
            ? (input.include ?? [])
            : "diff" in cursor
              ? ["diff"]
              : [
                  ...(cursor.threads === null ? [] : (["threads"] as const)),
                  ...(cursor.comments === null ? [] : (["comments"] as const)),
                ];
        const includeResolved =
          cursor !== undefined && "includeResolved" in cursor
            ? cursor.includeResolved
            : input.includeResolved === true;
        return {
          ...identityOf(target),
          ...(yield* readSections(ref, sections, includeResolved, cursor)),
        };
      }),
    ),
    pull_request_list: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestForgeError, undefined);
        const listed = yield* pullRequests
          .list({
            projectId: thread.projectId,
            state: input.state ?? "open",
            involvement: input.involvement ?? "all",
            limit: input.limit ?? 30,
            ...(input.query === undefined ? {} : { query: input.query }),
            ...(input.cursor === undefined
              ? {}
              : { cursors: yield* listCursors.decode(input.cursor) }),
          })
          .pipe(Effect.mapError(forgeFailure));
        const failure = listed.errors[0];
        if (listed.entries.length === 0 && failure !== undefined) {
          return yield* new PullRequestForgeError({ detail: failure.message });
        }
        return {
          pullRequests: listed.entries.map((entry) => ({
            number: entry.number,
            title: entry.title,
            url: entry.url,
            author: entry.author?.login ?? null,
            headBranch: entry.headBranch,
            baseBranch: entry.baseBranch,
            state: entry.state,
            isDraft: entry.isDraft,
            reviewDecision: entry.reviewDecision ?? null,
            checksState: entry.checksState ?? null,
            updatedAt: entry.updatedAt,
          })),
          truncated: listed.truncated,
          nextCursor:
            Object.keys(listed.nextCursors).length === 0
              ? null
              : listCursors.encode(listed.nextCursors),
        };
      }),
    ),
    pull_request_create: McpToolAccess.actsOutsideThread(
      "pull_request_create",
      (input, { asked }) =>
        Effect.gen(function* () {
          const thread = yield* requireThread(PullRequestForgeError, undefined);
          const project = yield* projectOf(thread, PullRequestForgeError);
          if (project === undefined) {
            return yield* new PullRequestProjectNotFoundError({ repository: "" });
          }
          const cwd = thread.worktreePath ?? project.workspaceRoot;
          // Below Full access the agent's own commands wait for a person, so the push and the
          // repository's push hooks, which are its owner's code, do too. One question names all
          // of it as the checkout has it now, and `run` does that or nothing.
          const opening = asked
            ? yield* git
                .pullRequestOpening({ cwd, baseBranch: input.base, private: input.private })
                .pipe(Effect.mapError(forgeFailure))
            : undefined;
          // Each address a push writes to is part of what the person approves, so each is
          // shown whole or the push is not asked about at all.
          if (opening?.push?.urls.some((url) => !McpToolAccess.quotedWhole(url, 200)) === true) {
            return yield* new PullRequestForgeError({
              detail:
                "This push goes to an address too long to show the user in full, so they cannot be asked to approve it. Nothing was pushed. Tell the user; they can push the branch themselves.",
            });
          }
          const hooks = opening?.push?.hooks ?? undefined;
          const pushHooks =
            opening === undefined || hooks === undefined
              ? undefined
              : pushHooksNamed(cwd, opening.branch, hooks);
          const identity = project.repositoryIdentity ?? undefined;
          const repository =
            identity === undefined
              ? undefined
              : (sourceControlDefinitions.repositorySelector(identity) ?? undefined);
          const host =
            identity === undefined
              ? undefined
              : (sourceControlDefinitions.changeRequestHost(identity, identity.provider) ??
                undefined);
          const asks: McpToolAccess.OutsideAction = {
            // A Full access call asks nobody, so it reads nothing to name.
            ...(opening === undefined
              ? { action: "Open", target: "a pull request" }
              : { ...openingAsks(opening, input.private === true), binds: opening.key }),
            ...(repository === undefined ? {} : { repository }),
            ...(host === undefined ? {} : { host }),
            ...(pushHooks === undefined || hooks === undefined
              ? {}
              : { pushHooks, also: pushHooksClause(pushHooks, hooks) }),
          };
          const run = Effect.gen(function* () {
            const created = yield* git
              .createPullRequest({
                cwd,
                projectId: project.id,
                title: input.title,
                body: input.body,
                baseBranch: input.base,
                draft: input.draft,
                private: input.private,
                ...(opening === undefined ? {} : { approved: opening }),
              })
              .pipe(
                Effect.mapError((error) =>
                  isPushHooksUnapproved(error)
                    ? new PullRequestForgeError({ detail: PUSH_HOOKS_CHANGED, cause: error })
                    : error._tag === "GitManagerError" &&
                        GitManager.isPullRequestOpeningChanged(error.detail)
                      ? new PullRequestForgeError({ detail: error.detail, cause: error })
                      : forgeFailure(error),
                ),
              );
            if (created.url === undefined) {
              return yield* new PullRequestForgeError({
                detail:
                  "The host accepted the PR but does not list it yet. Find it with pull_request_list.",
              });
            }
            const target = yield* resolveTarget({ url: created.url }, project);
            yield* linkToThread(thread, target);
            return {
              ...identityOf(target),
              created: created.status === "created",
              ...(thread.lineage.relationshipToParent === "subagent"
                ? { next: CHILD_PULL_REQUEST_REPORT_NEXT }
                : {}),
            };
          });
          return { asks, run };
        }),
    ),
    pull_request_update: McpToolAccess.actsOutsideThread("pull_request_update", (input) =>
      Effect.gen(function* () {
        if (
          input.title === undefined &&
          input.body === undefined &&
          input.ready === undefined &&
          input.state === undefined &&
          input.addLabels === undefined &&
          input.removeLabels === undefined &&
          input.requestReviewers === undefined
        ) {
          return yield* new PullRequestNothingToDoError({
            detail: "Pass title, body, ready, state, addLabels, removeLabels, or requestReviewers.",
          });
        }
        const located = yield* locate(input);
        const { target, ref } = located;
        // Before anything is asked or written: a name that matches nobody ends the call here,
        // and who a name resolved to is part of what is approved.
        const reviewers =
          input.requestReviewers === undefined
            ? undefined
            : yield* Effect.forEach(input.requestReviewers, (name) => reviewerNamed(ref, name));
        const run = Effect.gen(function* () {
          if (input.title !== undefined || input.body !== undefined) {
            yield* pullRequests.update({
              ...ref,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.body === undefined ? {} : { body: input.body }),
            });
          }
          for (const [labels, applied] of [
            [input.addLabels, true],
            [input.removeLabels, false],
          ] as const) {
            if (labels !== undefined) yield* pullRequests.setLabels({ ...ref, labels, applied });
          }
          if (reviewers !== undefined) {
            yield* pullRequests.requestReviewers({ ...ref, reviewers, requested: true });
          }
          if (input.ready !== undefined) {
            yield* pullRequests.runAction({ ...ref, action: input.ready ? "ready" : "draft" });
          }
          if (input.state !== undefined) {
            yield* pullRequests.runAction({
              ...ref,
              action: input.state === "closed" ? "close" : "reopen",
            });
          }
          return identityOf(target);
        }).pipe(Effect.mapError(forgeFailure));
        return {
          asks: {
            ...asksOf(updateAction(input), located),
            ...(reviewers === undefined ? {} : { binds: reviewers }),
          },
          run,
        };
      }),
    ),
    pull_request_respond: McpToolAccess.actsOutsideThread("pull_request_respond", (input) =>
      Effect.gen(function* () {
        if (
          input.body === undefined &&
          (input.reviewThreadId === undefined || input.resolved === undefined)
        ) {
          return yield* new PullRequestNothingToDoError({
            detail: "Pass body, or reviewThreadId with resolved.",
          });
        }
        if (input.reviewThreadId === undefined && input.resolved !== undefined) {
          return yield* new PullRequestNothingToDoError({
            detail: "resolved needs reviewThreadId.",
          });
        }
        const located = yield* locate(input);
        const { target, ref } = located;
        const reviewThreadId = input.reviewThreadId;
        const run = Effect.gen(function* () {
          if (input.body !== undefined) {
            yield* (
              reviewThreadId === undefined
                ? pullRequests.comment({ ...ref, body: input.body })
                : pullRequests.replyToThread({
                    ...ref,
                    threadId: reviewThreadId,
                    body: input.body,
                  })
            ).pipe(Effect.mapError(forgeFailure));
          }
          if (reviewThreadId !== undefined && input.resolved !== undefined) {
            yield* pullRequests
              .setThreadResolution({
                ...ref,
                threadId: reviewThreadId,
                resolved: input.resolved,
              })
              .pipe(
                Effect.mapError((error) =>
                  input.body === undefined
                    ? forgeFailure(error)
                    : new PullRequestForgeError({
                        // A retry with the body would post the reply twice.
                        detail: `The reply was posted, but setting resolved failed: ${error.message} Retry without body.`,
                        cause: error,
                      }),
                ),
              );
          }
          return {
            ...identityOf(target),
            replied: input.body !== undefined,
            resolved: input.resolved ?? null,
          };
        });
        return { asks: asksOf(respondAction(input), located), run };
      }),
    ),
    pull_request_review: McpToolAccess.actsOutsideThread(
      "pull_request_review",
      (input, { asked }) =>
        Effect.gen(function* () {
          if (input.verdict === "approve" && input.expectedHeadSha === undefined) {
            return yield* new PullRequestForgeError({
              detail:
                "Approving needs expectedHeadSha: the headSha pull_request_read reported for the commits you reviewed.",
            });
          }
          const located = yield* locate(input);
          const { target, ref } = located;
          // Line comments are placed in the diff as it is now. When the person is asked, the
          // head those lines belong to is read first and goes with the review, so the host
          // takes the comments only for the commits they were placed on.
          const head =
            input.expectedHeadSha ??
            (asked && (input.comments ?? []).length > 0
              ? (yield* pullRequests
                  .summary({ ...ref, allowStale: false })
                  .pipe(Effect.mapError(forgeFailure))).headSha
              : undefined);
          const comments = yield* reviewComments(ref, input.comments ?? []);
          const run = pullRequests
            .submitReview({
              ...ref,
              verdict: input.verdict,
              body: input.body ?? "",
              comments,
              ...(head === undefined ? {} : { expectedHeadSha: head }),
            })
            .pipe(Effect.mapError(forgeFailure), Effect.as(identityOf(target)));
          // A diff that has moved on by the time the person answers is another request.
          return {
            asks: { ...asksOf(reviewAction(input), located), binds: { comments, head } },
            run,
          };
        }),
    ),
    pull_request_merge: McpToolAccess.actsOutsideThread("pull_request_merge", (input) =>
      Effect.gen(function* () {
        const located = yield* locate(input);
        const { target, ref } = located;
        const stack = input.stack === true ? yield* stackMergeScope(ref, input) : undefined;
        const run = Effect.gen(function* () {
          yield* pullRequests.runAction({
            ...ref,
            action: input.auto === true ? "enable-auto-merge" : "merge",
            expectedHeadSha: input.expectedHeadSha,
            ...(input.method === undefined ? {} : { mergeMethod: input.method }),
            ...stack,
          });
          const after = yield* pullRequests.summary({ ...ref, allowStale: false });
          return { ...identityOf(target), state: after.state };
        }).pipe(Effect.mapError(forgeFailure));
        const asks = asksOf(mergeAction(input), located);
        // A stack merge is approved as the layers read here: their numbers and heads. `run`
        // pins the host to the same ones, so a layer added or moved since is not merged.
        return {
          asks:
            stack === undefined
              ? asks
              : {
                  ...asks,
                  action: `${asks.action} ${stackNamed(stack.expectedStackHeads)}`,
                  binds: stack,
                },
          run,
        };
      }),
    ),
    ci_logs: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { target, ref } = yield* locate(input);
        const checks = yield* pullRequests
          .checkLogs({
            ...ref,
            tailLines: input.tailLines ?? 200,
            ...(input.check === undefined ? {} : { check: input.check }),
          })
          .pipe(Effect.mapError(forgeFailure));
        return { ...identityOf(target), checks };
      }),
    ),
    ci_rerun: McpToolAccess.actsOutsideThread("ci_rerun", (input, { asked }) =>
      Effect.gen(function* () {
        const located = yield* locate(input);
        const { thread, target, ref } = located;
        const selected = { ...ref, ...(input.check === undefined ? {} : { check: input.check }) };
        // The person approves the checks that would be rerun as read here, by name, and the
        // rerun acts on exactly those: one that fails or is added while they read is not theirs.
        const approved = asked
          ? yield* pullRequests.rerunnableChecks(selected).pipe(Effect.mapError(forgeFailure))
          : undefined;
        const run = Effect.gen(function* () {
          const checks = yield* pullRequests
            .rerunChecks({ ...selected, ...(approved === undefined ? {} : { approved }) })
            .pipe(
              Effect.mapError((error) =>
                "detail" in error && error.detail === PullRequestService.RERUN_CHECKS_CHANGED
                  ? new PullRequestForgeError({ detail: error.detail, cause: error })
                  : forgeFailure(error),
              ),
            );
          // Like a push, a rerun makes a watch's finished checks stale, so the thread keeps
          // working until a read sees them run. The rerun already happened, so a failed reopen
          // only logs.
          if (
            checks.some((check) => check.rerun) &&
            threadPullRequestsOf(thread).some((link) => link.watch?.checksPending !== undefined)
          ) {
            yield* engine
              .dispatch({
                type: "thread.pull-request-watch.checks-reopen",
                commandId: yield* commandId("mcp-ci-rerun-checks", thread.id),
                threadId: thread.id,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("reopening a watch's checks after a rerun failed", cause),
                ),
              );
          }
          return { ...identityOf(target), checks };
        });
        // With nothing to rerun the call does nothing outside, so there is nothing to ask.
        if (approved?.length === 0) return { asks: undefined, run };
        // Each check is part of what the person approves, so each is named whole. A list too
        // long for the question is refused where every question is checked.
        if (
          approved?.some((check) => !McpToolAccess.quotedWhole(check.name, CHECK_NAME_SHOWN)) ===
          true
        ) {
          return yield* new PullRequestForgeError({
            detail:
              "A check this would rerun has a name too long to show the user in full, so they cannot be asked to approve it. Nothing was rerun. Tell the user; they can rerun it themselves.",
          });
        }
        return {
          asks:
            approved === undefined
              ? asksOf("Rerun checks on", located)
              : { ...asksOf(`Rerun ${checksNamed(approved)} on`, located), binds: approved },
          run,
        };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof PullRequestsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(PullRequestsToolkit, make);
