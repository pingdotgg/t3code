import {
  ownPullRequestRepositories,
  pullRequestSyncKey,
} from "../../../pullRequest/pullRequestSyncKey.ts";
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
  type PullRequestReadTarget,
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
import * as PullRequestOracle from "../../../pullRequest/PullRequestOracle.ts";
import * as PullRequestWatchService from "../../../pullRequest/PullRequestWatchService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import {
  PullRequestProjectNotFoundError,
  resolvePullRequestTarget,
  type ResolvedPullRequestTarget,
} from "../../../pullRequest/pullRequestTargets.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import { reviewPositionInPatch } from "../../../pullRequest/pullRequestReviewPosition.ts";
import { sourceControlDefinitions } from "../../../sourceControl/sourceControlDefinitions.ts";
import {
  normalizeThreadPullRequestKey,
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "../../../sourceControl/threadPullRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as TaskFolders from "../../../workspace/TaskFolders.ts";
import * as McpClientInput from "../../McpClientInput.ts";
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

const PUSH_HOOKS_DECLINED =
  "The person declined to run this repository's push hooks. Nothing was pushed and no PR was opened.";
const PUSH_HOOKS_UNCONFIRMED =
  "T3 Code has no approval from the person for this repository's push hooks. Nothing was pushed and no PR was opened. Call again to ask.";
const PUSH_HOOKS_KEPT_CHANGING =
  "This repository's push hooks kept changing while approval was asked. Nothing was pushed.";
const PUSH_HOOKS_SKIPPED =
  "The repository's push hooks were not run, because this client cannot ask a person to approve them.";

// Each request is followed by one push, so the last approval is tried too.
const PUSH_HOOKS_MAX_REQUESTS = 3;

/**
 * A request's state: the digest it asks about and which request of its call this is. A client
 * asked by a call's answer sends it back with the reply, so the count goes on where it stopped.
 * A client that sends back another count changes only how often its person is asked.
 */
const pushHooksRequestState = (hooks: GitManager.GitPushHooksUnapprovedError, request: number) =>
  `${pushHooksApprovalKey(hooks).join(" ")} ${request}`;
const pushHooksRequestOf = (state: string) => {
  const match = /^(.+) ([1-9]\d*)$/.exec(state);
  return match === null ? undefined : { digest: match[1]!, request: Number(match[2]) };
};

/**
 * What one approval is given for, and so what a client that remembers approvals remembers it by:
 * the contents of the named files. The request's state carries these whole and its text the
 * start of each, so edited files read differently and are asked about again.
 */
const pushHooksApprovalKey = (hooks: GitManager.GitPushHooksUnapprovedError) => [hooks.digest];

/** The branch and hooks one approval names, for a client that shows them as details. */
const pushHooksNamed = (
  cwd: string,
  hooks: GitManager.GitPushHooksUnapprovedError,
): ProviderApprovalPushHooks => ({
  branch: hooks.branch,
  // Hooks kept in the checkout read as the person knows them, such as `.husky/pre-push`.
  files: hooks.files.map((file) =>
    file.startsWith(cwd) && /^[\\/]/.test(file.slice(cwd.length))
      ? file.slice(cwd.length + 1)
      : file,
  ),
  commands: hooks.commands,
});

/** What the person approves: the push, the hooks named, and the start of the approval's key. */
const pushHooksQuestion = (
  { branch, files, commands: configured }: ProviderApprovalPushHooks,
  hooks: GitManager.GitPushHooksUnapprovedError,
) => {
  const list = (one: string, many: string, items: ReadonlyArray<string>) =>
    items.length === 0
      ? []
      : items.length === 1
        ? [`${one} ${items[0]}`]
        : [`${many} ${items.slice(0, -1).join(", ")} and ${items.at(-1)}`];
  // A command is quoted whole on one line, so it cannot read as part of the question.
  const commands = configured.map(({ name, command }) => `${name} (${JSON.stringify(command)})`);
  const named = [
    ...list("hook file", "hook files", files),
    ...list("configured hook", "configured hooks", commands),
  ].join(" and its ");
  const key = pushHooksApprovalKey(hooks)
    .map((part) => part.slice(0, 8))
    .join(" ");
  return `Push ${branch} and run this repository's ${named} (contents ${key})?`;
};

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;
  const oracle = yield* PullRequestOracle.PullRequestOracle;
  const watches = yield* PullRequestWatchService.PullRequestWatchService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const git = yield* GitManager.GitManager;

  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  // The administrator's limit, fixed for the server's life as it is where turns start.
  const maxRuntimeMode = (yield* ServerSettings.ServerSettingsService).managedPolicy?.limits
    ?.maxRuntimeMode;

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
    targets: ReadonlyArray<PullRequestReadTarget>,
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
      .listShells({ resolveRepositoryIdentity: true })
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
      resolvePullRequestTarget(input, urlProject(input)).pipe(
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

  const caller = McpInvocationContext.requireMcpCapability("pull-requests").pipe(
    Effect.map((scope) => ({ threadId: scope.thread?.threadId ?? null })),
  );

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
    const target = yield* resolvePullRequestTarget(named, project);
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

  const identityOf = (target: ResolvedPullRequestTarget) => ({
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
    target: ResolvedPullRequestTarget,
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
        const target = yield* resolvePullRequestTarget(input, project);
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
        const targets: Array<ResolvedPullRequestTarget> = [];
        const invalidUrls: Array<string> = [];
        for (const url of input.urls) {
          const target = yield* resolvePullRequestTarget({ url }, undefined).pipe(Effect.option);
          if (Option.isNone(target)) invalidUrls.push(url);
          else if (!targets.some((seen) => threadPullRequestKeysEqual(seen, target.value)))
            targets.push(target.value);
        }
        const links = threadPullRequestsOf(thread);
        const isLinked = (target: ResolvedPullRequestTarget) =>
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
        const byRepository = (prs: ReadonlyArray<ResolvedPullRequestTarget>) =>
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
        const target = yield* resolvePullRequestTarget(input, project);
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
          return yield* new PullRequestGuideFailedError({ detail: entry.failure });
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
    pull_request_status: McpToolAccess.reads((input) =>
      caller.pipe(
        Effect.flatMap((caller) => oracle.status({ caller, pullRequests: input.pullRequests })),
      ),
    ),
    pull_request_failures: McpToolAccess.reads((input) =>
      caller.pipe(
        Effect.flatMap((caller) =>
          oracle.failures({ caller, pullRequests: input.pullRequests, checks: input.checks }),
        ),
      ),
    ),
    pull_request_feedback: McpToolAccess.reads((input) =>
      caller.pipe(
        Effect.flatMap((caller) => oracle.feedback({ caller, pullRequests: input.pullRequests })),
      ),
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
    pull_request_create: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestForgeError, undefined);
        const project = yield* projectOf(thread, PullRequestForgeError);
        if (project === undefined) {
          return yield* new PullRequestProjectNotFoundError({ repository: "" });
        }
        const cwd = thread.worktreePath ?? project.workspaceRoot;
        const create = (
          pushHooks?: Parameters<
            GitManager.GitManager["Service"]["createPullRequest"]
          >[0]["pushHooks"],
        ) =>
          git
            .createPullRequest({
              cwd,
              projectId: project.id,
              title: input.title,
              body: input.body,
              baseBranch: input.base,
              draft: input.draft,
              private: input.private,
              pushHooks,
            })
            .pipe(
              Effect.mapError((error) =>
                isPushHooksUnapproved(error) ? error : forgeFailure(error),
              ),
            );
        // The repository's push hooks are its owner's code. Below Full access the agent's own
        // commands wait for a person, so these do too: by the rule a worktree's commands follow.
        const fullAccess =
          TaskFolders.projectCommandsForAgent(thread.linkOrigin, thread, maxRuntimeMode) ===
          "permitted";
        let hooksSkipped = false;
        const createOnceApproved = Effect.gen(function* () {
          // A client asked by the last call's answer is back with the reply. It is read before
          // any push: a decline pushes nothing, whatever the hooks are by now.
          const reply = yield* McpClientInput.answered("push-hooks");
          if (reply !== undefined && reply.answer !== "accepted") {
            return yield* new PullRequestForgeError({
              detail: reply.answer === "declined" ? PUSH_HOOKS_DECLINED : PUSH_HOOKS_UNCONFIRMED,
            });
          }
          const approved = reply === undefined ? undefined : pushHooksRequestOf(reply.state);
          let approvedDigest: string | null = approved?.digest ?? null;
          // A hook edited while the person reads the question is asked about again; the limit
          // bounds one that keeps changing.
          for (let requests = approved?.request ?? 0; ; requests++) {
            const outcome:
              | GitManager.GitCreatePullRequestResult
              | GitManager.GitPushHooksUnapprovedError = yield* create({ approvedDigest }).pipe(
              Effect.catchTags({
                GitPushHooksUnapprovedError: (unapproved) => Effect.succeed(unapproved),
              }),
            );
            if (!isPushHooksUnapproved(outcome)) return outcome;
            if (requests >= PUSH_HOOKS_MAX_REQUESTS) {
              return yield* new PullRequestForgeError({ detail: PUSH_HOOKS_KEPT_CHANGING });
            }
            const pushHooks = pushHooksNamed(cwd, outcome);
            const answer = yield* McpClientInput.askApproval({
              key: "push-hooks",
              state: pushHooksRequestState(outcome, requests + 1),
              message: pushHooksQuestion(pushHooks, outcome),
              pushHooks,
            });
            if (answer === "accepted") {
              approvedDigest = outcome.digest;
              continue;
            }
            if (answer === "unavailable") {
              hooksSkipped = true;
              return yield* create("off").pipe(
                Effect.catchTags({ GitPushHooksUnapprovedError: forgeFailure }),
              );
            }
            return yield* new PullRequestForgeError({
              detail:
                answer === "declined"
                  ? PUSH_HOOKS_DECLINED
                  : answer === "unconfirmed"
                    ? PUSH_HOOKS_UNCONFIRMED
                    : // Never read: the question is this call's answer.
                      "Waiting for approval.",
            });
          }
        });
        const created = yield* fullAccess
          ? create().pipe(Effect.catchTags({ GitPushHooksUnapprovedError: forgeFailure }))
          : createOnceApproved;
        if (created.url === undefined) {
          return yield* new PullRequestForgeError({
            detail:
              "The host accepted the PR but does not list it yet. Find it with pull_request_list.",
          });
        }
        const target = yield* resolvePullRequestTarget({ url: created.url }, project);
        yield* linkToThread(thread, target);
        return {
          ...identityOf(target),
          created: created.status === "created",
          ...(hooksSkipped ? { note: PUSH_HOOKS_SKIPPED } : {}),
          ...(thread.lineage.relationshipToParent === "subagent"
            ? { next: CHILD_PULL_REQUEST_REPORT_NEXT }
            : {}),
        };
      }),
    ),
    pull_request_update: McpToolAccess.writesWithCapability((input) =>
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
        const { target, ref } = yield* locate(input);
        if (input.title !== undefined || input.body !== undefined) {
          yield* pullRequests
            .update({
              ...ref,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.body === undefined ? {} : { body: input.body }),
            })
            .pipe(Effect.mapError(forgeFailure));
        }
        for (const [labels, applied] of [
          [input.addLabels, true],
          [input.removeLabels, false],
        ] as const) {
          if (labels !== undefined) {
            yield* pullRequests
              .setLabels({ ...ref, labels, applied })
              .pipe(Effect.mapError(forgeFailure));
          }
        }
        if (input.requestReviewers !== undefined) {
          const reviewers = yield* Effect.forEach(input.requestReviewers, (name) =>
            reviewerNamed(ref, name),
          );
          yield* pullRequests
            .requestReviewers({ ...ref, reviewers, requested: true })
            .pipe(Effect.mapError(forgeFailure));
        }
        if (input.ready !== undefined) {
          yield* pullRequests
            .runAction({ ...ref, action: input.ready ? "ready" : "draft" })
            .pipe(Effect.mapError(forgeFailure));
        }
        if (input.state !== undefined) {
          yield* pullRequests
            .runAction({ ...ref, action: input.state === "closed" ? "close" : "reopen" })
            .pipe(Effect.mapError(forgeFailure));
        }
        return identityOf(target);
      }),
    ),
    pull_request_respond: McpToolAccess.writesWithCapability((input) =>
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
        const { target, ref } = yield* locate(input);
        const reviewThreadId = input.reviewThreadId;
        if (input.body !== undefined) {
          yield* (
            reviewThreadId === undefined
              ? pullRequests.comment({ ...ref, body: input.body })
              : pullRequests.replyToThread({ ...ref, threadId: reviewThreadId, body: input.body })
          ).pipe(Effect.mapError(forgeFailure));
        }
        if (reviewThreadId !== undefined && input.resolved !== undefined) {
          yield* pullRequests
            .setThreadResolution({ ...ref, threadId: reviewThreadId, resolved: input.resolved })
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
      }),
    ),
    pull_request_review: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        if (input.verdict === "approve" && input.expectedHeadSha === undefined) {
          return yield* new PullRequestForgeError({
            detail:
              "Approving needs expectedHeadSha: the headSha pull_request_read reported for the commits you reviewed.",
          });
        }
        const { target, ref } = yield* locate(input);
        const comments = yield* reviewComments(ref, input.comments ?? []);
        yield* pullRequests
          .submitReview({
            ...ref,
            verdict: input.verdict,
            body: input.body ?? "",
            comments,
            ...(input.expectedHeadSha === undefined
              ? {}
              : { expectedHeadSha: input.expectedHeadSha }),
          })
          .pipe(Effect.mapError(forgeFailure));
        return identityOf(target);
      }),
    ),
    pull_request_merge: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const { target, ref } = yield* locate(input);
        const stack = input.stack === true ? yield* stackMergeScope(ref, input) : {};
        yield* pullRequests
          .runAction({
            ...ref,
            action: input.auto === true ? "enable-auto-merge" : "merge",
            expectedHeadSha: input.expectedHeadSha,
            ...(input.method === undefined ? {} : { mergeMethod: input.method }),
            ...stack,
          })
          .pipe(Effect.mapError(forgeFailure));
        const after = yield* pullRequests
          .summary({ ...ref, allowStale: false })
          .pipe(Effect.mapError(forgeFailure));
        return { ...identityOf(target), state: after.state };
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
    ci_rerun: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const { thread, target, ref } = yield* locate(input);
        const checks = yield* pullRequests
          .rerunChecks({ ...ref, ...(input.check === undefined ? {} : { check: input.check }) })
          .pipe(Effect.mapError(forgeFailure));
        // Like a push, a rerun makes a watch's finished checks stale, so the thread keeps working
        // until a read sees them run. The rerun already happened, so a failed reopen only logs.
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
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof PullRequestsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(PullRequestsToolkit, make);
