import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  TrimmedNonEmptyString,
  type PullRequestCapabilities,
  type PullRequestStackHead,
} from "@t3tools/contracts";
import { type ProviderRepositoryRef } from "@t3tools/source-control-core/server/PullRequestProvider";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as Json from "./gitCafePullRequestJson.ts";
import { definition } from "../shared/definition.ts";

export const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  // Branch updates restack every layer above the target.
  updateMethods: ["rebase"],
  search: true,
  stacks: true,
  stackActions: true,
  reactions: true,
  labels: true,
  // Line comments go through GitCafe's review drafts, which arrive with revision fencing.
  review: {
    inlineComment: false,
    reply: true,
    resolve: true,
    verdicts: ["approve", "request-changes", "comment"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
};

export const PAGE_SIZE = 100;
export const MAX_PAGES = 10;
/**
 * Pages read looking for a GitHub-synced author before a listing filtered by them gives up. The
 * login only appears on their pull requests, so one older than this many is out of reach.
 */
export const AUTHOR_DISCOVERY_PAGES = 5;
/** Bounds the logins remembered from listings; a repository's authors fit many times over. */
export const KNOWN_AUTHORS_LIMIT = 10_000;
/** GitCafe's cap on paths per `/diff-files` read, and so one diff page. */
export const DIFF_FILES_BATCH = 64;
/** Changed-path pages carry no hunks, so they can be read in larger pages. */
export const CHANGES_PAGE_LIMIT = 500;
/** Line totals require hunk reads; omit them for large PRs. */
export const LINE_STATS_MAX_FILES = DIFF_FILES_BATCH * 4;
export const MAX_CHANGE_PAGES = 20;
export const LINE_STATS_CACHE_SIZE = 256;

export const chunk = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

export const detailablePaths = (files: ReadonlyArray<Json.GitCafeDiffFile>) =>
  files.filter((file) => !file.binary && !file.tooLarge).map((file) => file.path);

export const mergeStrategyOpen = (status: typeof Status.Type, strategy: string) =>
  status.merge.permitted !== false &&
  status.merge.strategies.includes(strategy) &&
  !(status.merge.blockers ?? []).some((blocker) =>
    (blocker.blockedStrategies ?? []).includes(strategy),
  );

export const Id = TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u));
export const isId = Schema.is(Id);
export const isApiError = Schema.is(GitCafeApi.GitCafeApiError);
export const Principal = Schema.Struct({
  actorId: TrimmedNonEmptyString,
  handle: TrimmedNonEmptyString,
});
export const User = Schema.Struct({ actorId: TrimmedNonEmptyString });
export const Written = Schema.Struct({ id: Id });
export const Versioned = Schema.Struct({ version: NonNegativeInt });
export const CommentDetail = Schema.Struct({ id: Id, version: NonNegativeInt });
export const Status = Schema.Struct({
  merge: Schema.Struct({
    // The API reference lists "unknown" and "conflicting", but git.cafe also sends "none" and
    // "pending", so any state is read and only the known ones are mapped.
    conflicts: Schema.String,
    fastForward: Schema.NullOr(Schema.Boolean),
    strategies: Schema.Array(Schema.String),
    permitted: Schema.optional(Schema.Boolean),
    reasons: Schema.optional(Schema.Array(Schema.String)),
    blockers: Schema.optional(
      Schema.Array(
        Schema.Struct({ blockedStrategies: Schema.optional(Schema.Array(Schema.String)) }),
      ),
    ),
  }),
  checks: Schema.Struct({
    pending: NonNegativeInt,
    failing: NonNegativeInt,
    total: NonNegativeInt,
  }),
});
/** A merge GitCafe accepted runs on afterwards: on GitHub for a synced pull request, or natively. */
export const MERGE_IN_FLIGHT = new Set(["provider-merge-pending", "native-operation-pending"]);
export const Listed = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString })),
  next: Schema.NullOr(Schema.String),
});
export const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
export const BranchCommit = Schema.Struct({ oid: TrimmedNonEmptyString });
export const CommitOid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
export const isCommitOid = Schema.is(CommitOid);
export const SourceSnapshot = Schema.Struct({
  version: NonNegativeInt,
  headOid: CommitOid,
  comparisonBaseOid: CommitOid,
});
export const SourceBlob = Schema.Struct({
  commit: CommitOid,
  path: Schema.String,
  size: NonNegativeInt,
  binary: Schema.Boolean,
  content: Schema.NullOr(Schema.String),
});
export const MAX_DIFF_FILE_BYTES = 1024 * 1024;

export class GitCafeDiffSourceUnavailableError extends Schema.TaggedError<GitCafeDiffSourceUnavailableError>()(
  "GitCafeDiffSourceUnavailableError",
  {
    path: Schema.String,
    reason: Schema.Literals(["oversized", "binary", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
export const Snapshot = {
  version: NonNegativeInt,
  headOid: TrimmedNonEmptyString,
  comparisonBaseOid: TrimmedNonEmptyString,
};
export const Changes = Schema.Struct({
  ...Snapshot,
  items: Json.GitCafeDiffFiles,
  next: Schema.NullOr(TrimmedNonEmptyString),
});
export const DiffFiles = Schema.Struct({ ...Snapshot, items: Json.GitCafeDiffFiles });
export const DiffCursor = Schema.Struct({
  version: NonNegativeInt,
  headOid: TrimmedNonEmptyString,
  baseOid: TrimmedNonEmptyString,
  after: TrimmedNonEmptyString,
});
export const encodeDiffCursor = Schema.encodeSync(Schema.fromJsonString(DiffCursor));
export const decodeDiffCursor = Schema.decodeEffect(Schema.fromJsonString(DiffCursor));
export const MergeOutcome = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["accepted", "completed", "failed"]),
  reason: Schema.optional(Schema.String),
});
export const StackOutcome = Schema.Struct({ id: Schema.String, state: Schema.String });
export const FAILED_STACK_STATES = new Set([
  "failed",
  "stopped",
  "cancelled",
  "reconciliation_required",
]);

export type PullRef = ProviderRepositoryRef & { readonly number: number };

/** GitHub's merge counts as soon as GitCafe records it, ahead of the sync that reports it. */
export const settledMerge = (pull: Json.GitCafePullDetail) =>
  pull.state === "open" && pull.providerMerge != null
    ? { state: "merged" as const, mergedAt: pull.providerMerge.mergedAt }
    : {};
export type Paged<A> = { readonly items: ReadonlyArray<A>; readonly next: string | null };

export function stackHeadsCurrent(
  stack: Json.GitCafeStack,
  input: { readonly number: number; readonly merge: boolean },
  expected: ReadonlyArray<PullRequestStackHead>,
): boolean {
  const members = stack.members.toSorted((a, b) => a.position - b.position);
  const index = members.findIndex((member) => member.pullRequestNumber === input.number);
  if (index === -1) return false;
  const moved = (input.merge ? members.slice(0, index + 1) : members).filter(
    (member) => member.state !== "merged",
  );
  return (
    moved.length === expected.length &&
    moved.every(
      (member) =>
        member.headOid !== undefined &&
        expected.some(
          (head) => head.number === member.pullRequestNumber && head.headSha === member.headOid,
        ),
    )
  );
}

export const POSITION = /^(.+)~(\d+)$/u;
export const parsePosition = (raw: string | undefined) => {
  const match = raw === undefined ? null : POSITION.exec(raw);
  const created = match === null ? Number.NaN : Date.parse(match[1]!);
  return match === null || Number.isNaN(created) ? null : { created, number: Number(match[2]) };
};

export const withDetails = (
  files: ReadonlyArray<Json.GitCafeDiffFile>,
  details: ReadonlyArray<Json.GitCafeDiffFile>,
) => {
  const byPath = new Map(details.map((file) => [file.path, file]));
  return files.map((file) => byPath.get(file.path) ?? file);
};

/** @public */
