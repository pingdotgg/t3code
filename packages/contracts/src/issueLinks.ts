import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Fork-owned links between threads and GitHub Issues. Only links that cannot be derived are
 * stored (`fork_thread_issue_links`); branch and closing-reference links are computed when read.
 */

/** Who or what links a thread to an Issue. */
export const ThreadIssueLinkSource = Schema.Literals([
  "manual",
  "agent",
  "started",
  "branch",
  "closing-reference",
]);
export type ThreadIssueLinkSource = typeof ThreadIssueLinkSource.Type;

/** A GitHub Issue's host-level identity. Repository is lowercase `owner/name`. */
export const IssueKey = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type IssueKey = typeof IssueKey.Type;

export const ThreadIssueLink = Schema.Struct({
  ...IssueKey.fields,
  url: TrimmedNonEmptyString,
  /** Every reason the link holds, stored first; the first entry is the one to show. */
  sources: Schema.Array(ThreadIssueLinkSource),
  /** When a stored link was made; null for purely derived links. */
  linkedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadIssueLink = typeof ThreadIssueLink.Type;

/** Either the Issue's URL or its repository and number, like `link_pull_request`. */
export const IssueTarget = Schema.Struct({
  url: Schema.optional(TrimmedNonEmptyString),
  repository: Schema.optional(TrimmedNonEmptyString),
  number: Schema.optional(PositiveInt),
  host: Schema.optional(TrimmedNonEmptyString),
});
export type IssueTarget = typeof IssueTarget.Type;

export class IssueLinkError extends Schema.TaggedError<IssueLinkError>()("IssueLinkError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const IssueLinksRpcError = Schema.Union([IssueLinkError, EnvironmentAuthorizationError]);

export const ThreadIssueLinksResult = Schema.Struct({ links: Schema.Array(ThreadIssueLink) });
export type ThreadIssueLinksResult = typeof ThreadIssueLinksResult.Type;

export const IssueLinkedThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  archivedAt: Schema.NullOr(IsoDateTime),
  sources: Schema.Array(ThreadIssueLinkSource),
  /** The thread's own linked pull requests (#29 counts them toward the Issue's status). */
  pullRequests: Schema.Array(IssueKey),
});
export type IssueLinkedThread = typeof IssueLinkedThread.Type;

/** A pull request closing an Issue, on the Issue's host; the Issues list already reads these. */
export const IssueClosingPullRequest = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type IssueClosingPullRequest = typeof IssueClosingPullRequest.Type;

/** @public Issue rows (#29) chunk their batched reads to this size. */
export const ISSUE_LINKS_BATCH_MAX = 100;

/**
 * Threads for a page of Issues in one read. Closing pull requests come from the caller, so the
 * server reads nothing from GitHub here.
 */
export const ThreadsForIssuesInput = Schema.Struct({
  issues: Schema.Array(
    Schema.Struct({
      ...IssueKey.fields,
      closingPullRequests: Schema.Array(IssueClosingPullRequest),
    }),
  ).check(Schema.isMaxLength(ISSUE_LINKS_BATCH_MAX)),
});
export type ThreadsForIssuesInput = typeof ThreadsForIssuesInput.Type;

export const ThreadsForIssuesResult = Schema.Struct({
  issues: Schema.Array(
    Schema.Struct({ ...IssueKey.fields, threads: Schema.Array(IssueLinkedThread) }),
  ),
});
export type ThreadsForIssuesResult = typeof ThreadsForIssuesResult.Type;

/** A stored link change: the thread and the Issues whose links it touched. */
export const IssueLinkChange = Schema.Struct({
  threadId: ThreadId,
  issues: Schema.Array(IssueKey),
});
export type IssueLinkChange = typeof IssueLinkChange.Type;

export const IssueLinkInput = Schema.Struct({
  threadId: ThreadId,
  target: IssueTarget,
  source: Schema.Literals(["manual", "started"]),
});
export type IssueLinkInput = typeof IssueLinkInput.Type;

export const IssueUnlinkInput = Schema.Struct({ threadId: ThreadId, ...IssueKey.fields });
export type IssueUnlinkInput = typeof IssueUnlinkInput.Type;

export const ISSUE_LINKS_WS_METHODS = {
  forThread: "issueLinks.forThread",
  threadsForIssues: "issueLinks.threadsForIssues",
  link: "issueLinks.link",
  unlink: "issueLinks.unlink",
  subscribeChanges: "issueLinks.subscribeChanges",
} as const;

export const IssueLinksRpcGroup = RpcGroup.make(
  Rpc.make(ISSUE_LINKS_WS_METHODS.forThread, {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: ThreadIssueLinksResult,
    error: IssueLinksRpcError,
  }),
  Rpc.make(ISSUE_LINKS_WS_METHODS.threadsForIssues, {
    payload: ThreadsForIssuesInput,
    success: ThreadsForIssuesResult,
    error: IssueLinksRpcError,
  }),
  Rpc.make(ISSUE_LINKS_WS_METHODS.link, {
    payload: IssueLinkInput,
    success: Schema.Struct({ link: IssueKey, alreadyLinked: Schema.Boolean }),
    error: IssueLinksRpcError,
  }),
  Rpc.make(ISSUE_LINKS_WS_METHODS.unlink, {
    payload: IssueUnlinkInput,
    success: Schema.Struct({ wasLinked: Schema.Boolean }),
    error: IssueLinksRpcError,
  }),
  /** Emits each change to stored links, so clients refresh only the thread and Issues it names. */
  Rpc.make(ISSUE_LINKS_WS_METHODS.subscribeChanges, {
    payload: Schema.Struct({}),
    success: IssueLinkChange,
    error: EnvironmentAuthorizationError,
    stream: true,
  }),
);

/**
 * The Issue a task branch `<type>/<number>-<slug>` names, or null. The type is a conventional
 * commit type and the slug starts with a letter, so `release/2026-09` or `hotfix/1-2-3` name none.
 */
export function issueNumberFromBranch(branch: string | null | undefined): number | null {
  const match =
    /^(?:feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)\/(\d+)-[a-z][^/\s]*$/iu.exec(
      branch ?? "",
    );
  if (match === null) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** A GitHub Issue URL (`https://host/owner/name/issues/N`) as a key, or null. */
export function parseIssueUrl(url: string): IssueKey | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/u.exec(parsed.pathname);
  if (match === null) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return {
    host: parsed.host.toLowerCase(),
    repository: `${match[1]}/${match[2]}`.toLowerCase(),
    number,
  };
}

export function issueUrlFor(key: IssueKey): string {
  return `https://${key.host}/${key.repository}/issues/${key.number}`;
}

/** The GitHub repository a project's identity names, or null for other forges. */
export function gitHubRepositoryOf(
  identity:
    | { readonly canonicalKey: string; readonly provider?: string | undefined }
    | null
    | undefined,
): { readonly host: string; readonly repository: string } | null {
  if (identity?.provider !== "github") return null;
  const [host, ...rest] = identity.canonicalKey.toLowerCase().split("/");
  if (host === undefined || host.length === 0 || rest.length < 2) return null;
  return { host, repository: rest.join("/") };
}

export function issueKeysEqual(left: IssueKey, right: IssueKey): boolean {
  return (
    left.number === right.number &&
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.repository.toLowerCase() === right.repository.toLowerCase()
  );
}

export function issueKeyString(key: IssueKey): string {
  return `${key.host.toLowerCase()}/${key.repository.toLowerCase()}#${key.number}`;
}
