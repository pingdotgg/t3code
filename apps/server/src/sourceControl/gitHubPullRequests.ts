import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  type ChangeRequestChecks,
  type ChangeRequestChecksState,
} from "@t3tools/contracts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";

export interface NormalizedGitHubPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

const GitHubPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  isCrossRepository: Schema.optional(Schema.Boolean),
  // gh < 2.47 exports headRepository as {id, name} only; nameWithOwner was
  // added later. Both fields stay optional so a version-drifted gh CLI can
  // never fail the decode and silently drop the PR from the list.
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.optional(Schema.NullOr(Schema.String)),
        name: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGitHubPullRequestState(input: {
  state?: string | null | undefined;
  mergedAt?: string | null | undefined;
}): "open" | "closed" | "merged" {
  const normalizedState = input.state?.trim().toUpperCase();
  if (
    (typeof input.mergedAt === "string" && input.mergedAt.trim().length > 0) ||
    normalizedState === "MERGED"
  ) {
    return "merged";
  }
  if (normalizedState === "CLOSED") {
    return "closed";
  }
  return "open";
}

function normalizeGitHubPullRequestRecord(
  raw: Schema.Schema.Type<typeof GitHubPullRequestSchema>,
): NormalizedGitHubPullRequestRecord {
  const explicitNameWithOwner = trimOptionalString(raw.headRepository?.nameWithOwner);
  const headRepositoryName = trimOptionalString(raw.headRepository?.name);
  const headRepositoryOwnerLogin =
    trimOptionalString(raw.headRepositoryOwner?.login) ??
    (explicitNameWithOwner?.includes("/") ? (explicitNameWithOwner.split("/")[0] ?? null) : null);
  const headRepositoryNameWithOwner =
    explicitNameWithOwner ??
    (headRepositoryOwnerLogin && headRepositoryName
      ? `${headRepositoryOwnerLogin}/${headRepositoryName}`
      : null);

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    state: normalizeGitHubPullRequestState(raw),
    updatedAt: raw.updatedAt ?? Option.none(),
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

/**
 * `gh` returns a heterogeneous rollup: GitHub Actions and most apps report as
 * `CheckRun` (status + conclusion), while older commit statuses report as
 * `StatusContext` (state only). Every field is optional so an unrecognized
 * entry shape degrades to "neutral" instead of failing the whole decode and
 * costing us the indicator.
 */
const GitHubCheckRollupEntrySchema = Schema.Struct({
  typename: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
});

type GitHubCheckRollupEntry = Schema.Schema.Type<typeof GitHubCheckRollupEntrySchema>;

/**
 * Conclusions and states that mean the check is done and unhappy. This covers
 * every non-success `CheckConclusionState` except the two GitHub treats as
 * "no opinion" (NEUTRAL, SKIPPED). STALE belongs here: GitHub marks a stuck run
 * stale, it is not a success, and it can block merge — so it must not read as
 * green.
 */
const FAILED_CHECK_RESULTS = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
  "STALE",
]);
/** States that mean the check has not reached a verdict yet. */
const PENDING_CHECK_RESULTS = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING"]);

type CheckBucket = "passed" | "failed" | "pending" | "neutral";

/**
 * Buckets one rollup entry. `SKIPPED` and `NEUTRAL` are deliberately neutral
 * rather than passing: a repo whose checks all skip should not read as green.
 * Anything unrecognized is neutral too, so a new GitHub conclusion string
 * can never turn the indicator red on its own.
 */
function bucketCheckRollupEntry(entry: GitHubCheckRollupEntry): CheckBucket {
  // CheckRun carries the verdict in `conclusion`, but only once `status` says
  // it is COMPLETED; before that the conclusion is null and it is still running.
  const isCheckRun = entry.typename?.trim() === "CheckRun";
  if (isCheckRun) {
    const status = entry.status?.trim().toUpperCase();
    if (status !== undefined && status !== "COMPLETED") {
      return "pending";
    }
  }

  const result = (entry.conclusion ?? entry.state)?.trim().toUpperCase();
  if (result === undefined || result.length === 0) {
    // Nothing actionable: a StatusContext with no state, a completed CheckRun
    // with no conclusion, or an entry shape we don't recognize at all. Reading
    // these as pending would strand the indicator on amber indefinitely.
    return "neutral";
  }
  if (FAILED_CHECK_RESULTS.has(result)) return "failed";
  if (PENDING_CHECK_RESULTS.has(result)) return "pending";
  if (result === "SUCCESS") return "passed";
  return "neutral";
}

/**
 * Rolls check entries into the single state the sidebar renders. Returns null
 * when there is nothing to say — no CI configured, or a suite that reached no
 * verdict at all (every check skipped, neutral, or an unrecognized shape) —
 * which the UI reads as "draw no dot". A suite that nothing passed must not
 * render green just because nothing failed either.
 */
export function summarizeGitHubCheckRollup(
  entries: ReadonlyArray<GitHubCheckRollupEntry>,
): ChangeRequestChecks | null {
  if (entries.length === 0) {
    return null;
  }

  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const entry of entries) {
    switch (bucketCheckRollupEntry(entry)) {
      case "passed":
        passed += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "pending":
        pending += 1;
        break;
      case "neutral":
        break;
    }
  }

  if (failed === 0 && pending === 0 && passed === 0) {
    return null;
  }

  // A failure is the actionable signal, so it outranks work still in flight.
  const state: ChangeRequestChecksState =
    failed > 0 ? "failure" : pending > 0 ? "pending" : "success";

  return { state, total: entries.length, passed, failed, pending };
}

const decodeGitHubPullRequestList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeGitHubPullRequest = decodeJsonResult(GitHubPullRequestSchema);
const decodeGitHubPullRequestEntry = Schema.decodeUnknownExit(GitHubPullRequestSchema);
const decodeGitHubCheckRollupList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeGitHubCheckRollupEntry = Schema.decodeUnknownExit(GitHubCheckRollupEntrySchema);

export const formatGitHubJsonDecodeError = formatSchemaError;

export function decodeGitHubPullRequestListJson(
  raw: string,
): Result.Result<
  ReadonlyArray<NormalizedGitHubPullRequestRecord>,
  Cause.Cause<Schema.SchemaError>
> {
  const result = decodeGitHubPullRequestList(raw);
  if (Result.isSuccess(result)) {
    const pullRequests: NormalizedGitHubPullRequestRecord[] = [];
    for (const entry of result.success) {
      const decodedEntry = decodeGitHubPullRequestEntry(entry);
      if (Exit.isFailure(decodedEntry)) {
        continue;
      }
      pullRequests.push(normalizeGitHubPullRequestRecord(decodedEntry.value));
    }
    return Result.succeed(pullRequests);
  }
  return Result.fail(result.failure);
}

export function decodeGitHubPullRequestJson(
  raw: string,
): Result.Result<NormalizedGitHubPullRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubPullRequest(raw);
  if (Result.isSuccess(result)) {
    return Result.succeed(normalizeGitHubPullRequestRecord(result.success));
  }
  return Result.fail(result.failure);
}

/**
 * Decodes the projected `statusCheckRollup` array (see GitHubCli's --jq filter)
 * into a rolled-up summary. Individual entries that fail to decode are skipped
 * rather than failing the batch, matching how the PR list decode degrades.
 */
export function decodeGitHubCheckRollupJson(
  raw: string,
): Result.Result<ChangeRequestChecks | null, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubCheckRollupList(raw);
  if (!Result.isSuccess(result)) {
    return Result.fail(result.failure);
  }

  const entries: GitHubCheckRollupEntry[] = [];
  for (const entry of result.success) {
    const decodedEntry = decodeGitHubCheckRollupEntry(entry);
    if (Exit.isFailure(decodedEntry)) {
      continue;
    }
    entries.push(decodedEntry.value);
  }
  return Result.succeed(summarizeGitHubCheckRollup(entries));
}
