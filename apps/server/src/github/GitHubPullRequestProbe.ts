/**
 * Narrow GitHub CLI adapter used by durable waitpoints.
 *
 * Raw `gh pr view` output is normalized here so registration and scheduling
 * depend on a stable snapshot rather than GitHub's GraphQL-shaped payload.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { GitHubCli, type GitHubCliError } from "../sourceControl/GitHubCli.ts";
import type { GitHubWaitpointCondition } from "../persistence/GitHubWaitpoints.ts";

const WATCH_FIELDS = "headRefOid,state,mergedAt,updatedAt,statusCheckRollup,comments,reviews,url";

const RawCheck = Schema.Struct({
  __typename: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
});
const RawReviewActivity = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.optional(Schema.String),
  submittedAt: Schema.optional(Schema.String),
});
const RawSnapshot = Schema.Struct({
  comments: Schema.Array(RawReviewActivity),
  headRefOid: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
  reviews: Schema.Array(RawReviewActivity),
  state: Schema.String,
  statusCheckRollup: Schema.Array(RawCheck),
  updatedAt: Schema.String,
  url: Schema.String,
});
const decodeRawSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(RawSnapshot));

export const GitHubPullRequestSnapshot = Schema.Struct({
  url: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  headSha: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.Literals(["pending", "completed"]),
      conclusion: Schema.NullOr(Schema.String),
    }),
  ),
  reviewActivity: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      occurredAt: Schema.String,
    }),
  ),
});
export type GitHubPullRequestSnapshot = typeof GitHubPullRequestSnapshot.Type;

export class GitHubPullRequestProbeDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestProbeDecodeError>()(
  "GitHubPullRequestProbeDecodeError",
  {
    repository: Schema.String,
    pullRequestNumber: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `GitHub returned an invalid watch snapshot for ${this.repository}#${this.pullRequestNumber}.`;
  }
}

export type GitHubPullRequestProbeError = GitHubCliError | GitHubPullRequestProbeDecodeError;

export interface GitHubPullRequestProbeInput {
  readonly cwd: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
}

export class GitHubPullRequestProbe extends Context.Service<
  GitHubPullRequestProbe,
  {
    readonly get: (
      input: GitHubPullRequestProbeInput,
    ) => Effect.Effect<GitHubPullRequestSnapshot, GitHubPullRequestProbeError>;
  }
>()("t3/github/GitHubPullRequestProbe") {}

function iso(value: string): string {
  return DateTime.formatIso(DateTime.makeUnsafe(value));
}

function normalizeState(
  state: string,
  mergedAt: string | null,
): GitHubPullRequestSnapshot["state"] {
  if (mergedAt !== null || state.toUpperCase() === "MERGED") return "merged";
  return state.toUpperCase() === "OPEN" ? "open" : "closed";
}

function normalizeCheck(check: typeof RawCheck.Type): GitHubPullRequestSnapshot["checks"][number] {
  const rawStatus = (check.status ?? check.state ?? "PENDING").toUpperCase();
  const completed =
    rawStatus === "COMPLETED" ||
    rawStatus === "SUCCESS" ||
    rawStatus === "FAILURE" ||
    rawStatus === "ERROR";
  const conclusion =
    check.conclusion ?? (completed && rawStatus !== "COMPLETED" ? rawStatus : null);
  return {
    name: check.name ?? check.context ?? "GitHub check",
    status: completed ? "completed" : "pending",
    conclusion: conclusion?.toLowerCase() ?? null,
  };
}

function normalizeActivity(
  activity: typeof RawReviewActivity.Type,
): GitHubPullRequestSnapshot["reviewActivity"][number] | undefined {
  const occurredAt = activity.createdAt ?? activity.submittedAt;
  return occurredAt === undefined ? undefined : { id: activity.id, occurredAt: iso(occurredAt) };
}

function normalizeSnapshot(raw: typeof RawSnapshot.Type): GitHubPullRequestSnapshot {
  const mergedAt = raw.mergedAt === null ? null : iso(raw.mergedAt);
  const reviewActivity = [...raw.comments, ...raw.reviews]
    .map(normalizeActivity)
    .filter((activity) => activity !== undefined)
    .sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id),
    );
  return {
    url: raw.url,
    state: normalizeState(raw.state, mergedAt),
    headSha: raw.headRefOid,
    mergedAt,
    updatedAt: iso(raw.updatedAt),
    checks: raw.statusCheckRollup.map(normalizeCheck),
    reviewActivity,
  };
}

export interface GitHubWaitpointEvaluation {
  readonly satisfied: boolean;
  readonly summary: string;
}

export function evaluateGitHubWaitpoint(
  condition: GitHubWaitpointCondition,
  baseline: GitHubPullRequestSnapshot,
  current: GitHubPullRequestSnapshot,
): GitHubWaitpointEvaluation {
  switch (condition) {
    case "checks_settled": {
      const settled =
        current.checks.length > 0 && current.checks.every((check) => check.status === "completed");
      const failed = current.checks.filter(
        (check) =>
          check.conclusion !== null &&
          !["success", "skipped", "neutral"].includes(check.conclusion),
      ).length;
      return {
        satisfied: settled,
        summary: settled
          ? `${current.checks.length} checks settled (${failed} unsuccessful).`
          : `${current.checks.filter((check) => check.status === "pending").length} checks remain pending.`,
      };
    }
    case "new_review_activity": {
      const baselineIds = new Set(baseline.reviewActivity.map((activity) => activity.id));
      const added = current.reviewActivity.filter((activity) => !baselineIds.has(activity.id));
      return {
        satisfied: added.length > 0,
        summary:
          added.length > 0
            ? `${added.length} new review or comment event${added.length === 1 ? "" : "s"}.`
            : "No new review or comment activity.",
      };
    }
    case "pull_request_closed":
      return {
        satisfied: current.state !== "open",
        summary:
          current.state === "merged"
            ? "Pull request merged."
            : current.state === "closed"
              ? "Pull request closed without merging."
              : "Pull request remains open.",
      };
  }
}

export const make = Effect.gen(function* () {
  const gitHubCli = yield* GitHubCli;
  return GitHubPullRequestProbe.of({
    get: Effect.fn("GitHubPullRequestProbe.get")(function* (input) {
      const output = yield* gitHubCli.execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          String(input.pullRequestNumber),
          "--repo",
          input.repository,
          "--json",
          WATCH_FIELDS,
        ],
      });
      const raw = yield* decodeRawSnapshot(output.stdout).pipe(
        Effect.mapError(
          (cause) =>
            new GitHubPullRequestProbeDecodeError({
              repository: input.repository,
              pullRequestNumber: input.pullRequestNumber,
              cause,
            }),
        ),
      );
      return normalizeSnapshot(raw);
    }),
  });
});

export const layer = Layer.effect(GitHubPullRequestProbe, make);
