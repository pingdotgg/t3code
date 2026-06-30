import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";

import {
  GitHubCli,
  GitHubCliError,
  type GitHubPullRequestCheck,
} from "../../sourceControl/GitHubCli.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  GitHubPort,
  type GitHubPortShape,
  type GitHubPrDetail,
  type GitHubReviewItem,
} from "../Services/GitHubPort.ts";
import { MergeGitPort } from "../Services/TicketMergeService.ts";

const FAILING_CHECK_LOG_CAP = 10_000;

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

const eventStoreError = (message: string, cause?: unknown): WorkflowEventStoreError =>
  new WorkflowEventStoreError(cause === undefined ? { message } : { message, cause });

/**
 * `gh` reports a missing binary or a logged-out account through the
 * GitHubCli error-normalization layer. Those two conditions are expected
 * infrastructure states the caller handles (step blocked), not bugs — so
 * `preflight` returns `{ ok: false }` for them. Anything else is a real fault.
 */
const isExpectedAuthFailure = (error: GitHubCliError): boolean => {
  const detail = error.detail.toLowerCase();
  return (
    detail.includes("not authenticated") ||
    detail.includes("not available on path") ||
    detail.includes("gh auth login")
  );
};

// Phrases gh prints when a merge is blocked by a human-fixable mergeability
// state (branch protection / review / conflict). Kept specific so a transient
// infra fault whose message merely *contains* a bare word like "checks" or
// "conflict" — e.g. "could not query required status checks: API unavailable",
// or "merge conflict resolution service timed out" — is NOT silently
// reclassified as a blocked merge and is instead surfaced on the error channel.
const NOT_MERGEABLE_PATTERNS = [
  "not mergeable",
  "not in a mergeable state",
  "branch protection",
  "protected branch",
  // NB: a bare "merge conflict" substring is deliberately NOT listed — it matches
  // infra faults like "merge conflict resolution service timed out". A genuine
  // conflict block surfaces as "not mergeable" / "has conflicts that must be
  // resolved", both covered above/below.
  "has conflicts",
  "review required",
  "review is required",
  "changes requested",
  "approving review",
  "changes to the base branch",
  // "...status checks are expected" / "...status checks have not succeeded" are
  // genuine block reasons, but match the FULL phrase so an infra fault like
  // "could not query required status checks: API unavailable" is not swept in.
  "status checks are expected",
  "status checks have not succeeded",
  "required status checks have not passed",
];

const looksNotMergeable = (text: string): boolean => {
  const lower = text.toLowerCase();
  return NOT_MERGEABLE_PATTERNS.some((pattern) => lower.includes(pattern));
};

/**
 * Extract the real gh stderr text from a GitHubCliError's cause.
 *
 * Upstream's GitHubCliCommandError intentionally redacts stderr in its
 * `detail` getter (returns the constant "GitHub CLI command failed.").  The
 * real stderr is stored in `error.cause` — either as a VcsProcessExitError
 * (which exposes it via `.detail`) or, in tests, as a plain Error (exposed
 * via `.message`).  Fall back to `error.detail` for errors whose cause is
 * absent or opaque.
 */
const ghStderr = (error: GitHubCliError): string => {
  const cause = (error as { readonly cause?: unknown }).cause;
  if (cause !== null && cause !== undefined && typeof cause === "object") {
    // VcsProcessExitError (and similar tagged errors) expose `.detail`
    const detail = (cause as { readonly detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim().length > 0) return detail;
    // Plain Error objects used in tests
    if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  }
  return error.detail;
};

const normalizeReviewDecision = (value: string | null): GitHubPrDetail["reviewDecision"] => {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "CHANGES_REQUESTED") return "changes_requested";
  if (normalized === "APPROVED") return "approved";
  return "none";
};

const normalizeState = (input: {
  state: string;
  mergedAt: string | null;
}): GitHubPrDetail["state"] => {
  const normalized = input.state.trim().toUpperCase();
  if (normalized === "MERGED" || (input.mergedAt !== null && input.mergedAt.trim().length > 0)) {
    return "merged";
  }
  if (normalized === "CLOSED") return "closed";
  return "open";
};

/**
 * Reduce gh's per-check buckets to a single CI signal:
 * - any failed/cancelled check → "failure"
 * - any still-pending check → "pending"
 * - otherwise (all pass/skip) → "success"
 *
 * An EMPTY checks list maps to "success": a repository with no CI configured
 * has nothing to wait on, so boards gating on `ci.passed` get an immediate
 * pass rather than stalling forever on a check that never fires.
 */
const ciStateFromChecks = (
  checks: ReadonlyArray<GitHubPullRequestCheck>,
): GitHubPrDetail["ciState"] => {
  if (checks.length === 0) return "success";
  let pending = false;
  for (const check of checks) {
    const bucket = check.bucket.trim().toLowerCase();
    if (bucket === "fail" || bucket === "cancel") return "failure";
    if (bucket === "pending") pending = true;
  }
  return pending ? "pending" : "success";
};

const make = Effect.gen(function* () {
  const gh = yield* GitHubCli;
  const git = yield* MergeGitPort;
  const registry = yield* SourceControlProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;

  const mapGhError =
    (message: string) =>
    (error: GitHubCliError): WorkflowEventStoreError =>
      eventStoreError(`${message}: ${error.detail}`, error);

  const resolveRemote: GitHubPortShape["resolveRemote"] = (cwd) =>
    registry.resolveHandle({ cwd }).pipe(
      Effect.mapError((error) => eventStoreError("failed to resolve source control remote", error)),
      Effect.flatMap((handle) => {
        const context = handle.context;
        if (context === null) {
          return Effect.fail(eventStoreError(`no source control remote detected for ${cwd}`));
        }
        const parsed = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(context.remoteUrl);
        if (parsed !== null) {
          return Effect.succeed({ remoteName: context.remoteName, repo: parsed });
        }
        // Self-hosted / non-canonical URLs the parser cannot read: ask gh for
        // the canonical nameWithOwner of the configured remote.
        return gh.getRepositoryCloneUrls({ cwd, repository: context.remoteName }).pipe(
          Effect.map((urls) => ({ remoteName: context.remoteName, repo: urls.nameWithOwner })),
          Effect.mapError(mapGhError("failed to resolve repository name")),
        );
      }),
    );

  const preflight: GitHubPortShape["preflight"] = (cwd) =>
    gh.execute({ cwd, args: ["auth", "status"] }).pipe(
      Effect.as({ ok: true } as { ok: true } | { ok: false; reason: string }),
      Effect.catch((error: GitHubCliError) =>
        isExpectedAuthFailure(error)
          ? Effect.succeed({ ok: false, reason: error.detail } as
              | { ok: true }
              | { ok: false; reason: string })
          : Effect.fail(eventStoreError("github preflight failed", error)),
      ),
    );

  const defaultBranch: GitHubPortShape["defaultBranch"] = (cwd) =>
    gh.getDefaultBranch({ cwd }).pipe(
      Effect.mapError(mapGhError("failed to resolve default branch")),
      Effect.flatMap((branch) =>
        branch === null
          ? Effect.fail(eventStoreError("github returned no default branch"))
          : Effect.succeed(branch),
      ),
    );

  const findPr = (input: { cwd: string; branch: string }) =>
    gh
      .listOpenPullRequests({ cwd: input.cwd, headSelector: input.branch })
      .pipe(Effect.mapError(mapGhError("failed to list open pull requests")));

  const openPr: GitHubPortShape["openPr"] = (input) =>
    Effect.gen(function* () {
      // Push the worktree branch to the resolved remote. A rejected push means
      // the remote moved ahead of us — surface it as "branch diverged" so the
      // open action can map it to a blocked outcome.
      const remote = yield* resolveRemote(input.cwd);
      const push = yield* git
        .run({
          cwd: input.cwd,
          args: ["push", "-u", remote.remoteName, `HEAD:refs/heads/${input.branch}`],
          allowNonZeroExit: true,
        })
        .pipe(Effect.mapError((error) => eventStoreError("failed to push branch", error)));
      if (push.exitCode !== 0) {
        const combined = `${push.stderr}\n${push.stdout}`.toLowerCase();
        if (
          combined.includes("non-fast-forward") ||
          combined.includes("fetch first") ||
          (combined.includes("[rejected]") && !combined.includes("[remote rejected]"))
        ) {
          return yield* eventStoreError(
            `branch diverged: ${firstLine(push.stderr) || firstLine(push.stdout) || "remote push rejected"}`,
          );
        }
        return yield* eventStoreError(
          `failed to push branch: ${firstLine(push.stderr) || firstLine(push.stdout) || "push exited non-zero"}`,
        );
      }

      // Idempotency: adopt an existing PR for this branch rather than creating
      // a duplicate (recovery / retry safe).
      const existing = yield* findPr({ cwd: input.cwd, branch: input.branch });
      const adoptedPr = existing[0];
      if (adoptedPr !== undefined) {
        return { number: adoptedPr.number, url: adoptedPr.url, adopted: true };
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const bodyFile = yield* fileSystem.makeTempFileScoped({ prefix: "t3-pr-body-" }).pipe(
            Effect.tap((path) => fileSystem.writeFileString(path, input.body)),
            Effect.mapError((cause) => eventStoreError("failed to write PR body file", cause)),
          );
          yield* gh
            .createPullRequest({
              cwd: input.cwd,
              baseBranch: input.base,
              headSelector: input.branch,
              title: input.title,
              bodyFile,
              draft: input.draft,
            })
            .pipe(Effect.mapError(mapGhError("failed to create pull request")));
        }),
      );

      const created = yield* findPr({ cwd: input.cwd, branch: input.branch });
      const createdPr = created[0];
      if (createdPr === undefined) {
        return yield* eventStoreError("pull request created but could not be located by branch");
      }
      return { number: createdPr.number, url: createdPr.url, adopted: false };
    });

  const findPrForBranch: GitHubPortShape["findPrForBranch"] = (input) =>
    findPr({ cwd: input.cwd, branch: input.branch }).pipe(
      Effect.map((prs) => {
        const pr = prs[0];
        return pr === undefined ? null : { number: pr.number, url: pr.url };
      }),
    );

  const prDetail: GitHubPortShape["prDetail"] = (input) =>
    Effect.gen(function* () {
      const detail = yield* gh
        .getPullRequestDetail({ cwd: input.cwd, number: input.prNumber })
        .pipe(Effect.mapError(mapGhError("failed to read pull request detail")));
      const checks = yield* gh
        .listPullRequestChecks({ cwd: input.cwd, number: input.prNumber })
        .pipe(Effect.mapError(mapGhError("failed to read pull request checks")));

      return {
        number: input.prNumber,
        url: detail.url,
        state: normalizeState({ state: detail.state, mergedAt: detail.mergedAt }),
        headSha: detail.headRefOid.trim().length > 0 ? detail.headRefOid : null,
        reviewDecision: normalizeReviewDecision(detail.reviewDecision),
        ciState: ciStateFromChecks(checks),
      } satisfies GitHubPrDetail;
    });

  const mergePr: GitHubPortShape["mergePr"] = (input) =>
    gh.mergePullRequest({ cwd: input.cwd, number: input.prNumber, strategy: input.strategy }).pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          const stderr = ghStderr(error);
          return looksNotMergeable(stderr)
            ? Effect.succeed({ ok: false, reason: firstLine(stderr) } as
                | { ok: true }
                | { ok: false; reason: string })
            : Effect.fail(eventStoreError("failed to merge pull request", error));
        },
        onSuccess: () =>
          Effect.gen(function* () {
            if (input.deleteBranch) {
              // Best-effort remote-branch cleanup. NEVER `gh --delete-branch`:
              // the local branch backs a live worktree.
              yield* git
                .run({
                  cwd: input.cwd,
                  args: ["push", input.remoteName, "--delete", input.branch],
                  allowNonZeroExit: true,
                })
                .pipe(Effect.ignore);
            }
            return { ok: true } as { ok: true } | { ok: false; reason: string };
          }),
      }),
    );

  const failingCheckLogs: GitHubPortShape["failingCheckLogs"] = (input) =>
    Effect.gen(function* () {
      const checks = yield* gh
        .listPullRequestChecks({ cwd: input.cwd, number: input.prNumber })
        .pipe(Effect.mapError(mapGhError("failed to read pull request checks")));
      const failing = checks.filter((check) => {
        const bucket = check.bucket.trim().toLowerCase();
        return bucket === "fail" || bucket === "cancel";
      });
      if (failing.length === 0) {
        return null;
      }

      const firstFailing = failing[0]!;
      const runIdMatch = /\/actions\/runs\/(\d+)/.exec(firstFailing.link);
      const runId = runIdMatch?.[1];
      if (runId === undefined) {
        // No parseable run id — return the failed check names as a summary.
        return failing
          .map((check) => check.name)
          .filter((name) => name.length > 0)
          .join(", ");
      }

      const output = yield* gh
        .execute({ cwd: input.cwd, args: ["run", "view", runId, "--log-failed"] })
        .pipe(Effect.mapError(mapGhError("failed to read failing check logs")));
      const stdout = output.stdout;
      return stdout.length > FAILING_CHECK_LOG_CAP
        ? stdout.slice(stdout.length - FAILING_CHECK_LOG_CAP)
        : stdout;
    });

  const listReviewFeedback: GitHubPortShape["listReviewFeedback"] = (input) =>
    Effect.gen(function* () {
      const reviews = yield* gh
        .listPullRequestReviews({ cwd: input.cwd, number: input.prNumber })
        .pipe(Effect.mapError(mapGhError("failed to read pull request reviews")));
      const comments = yield* gh
        .listPullRequestReviewComments({
          cwd: input.cwd,
          repo: input.repo,
          number: input.prNumber,
        })
        .pipe(Effect.mapError(mapGhError("failed to read pull request review comments")));

      const items: Array<GitHubReviewItem & { sortKey: string }> = [];
      for (const review of reviews) {
        if (review.body.trim().length === 0) continue;
        items.push({
          id: review.id,
          author: review.author,
          body: review.body,
          submittedAt: review.submittedAt,
          sortKey: review.submittedAt,
        });
      }
      for (const comment of comments) {
        if (comment.body.trim().length === 0) continue;
        items.push({
          id: `comment:${comment.id}`,
          author: comment.user,
          body: comment.body,
          submittedAt: comment.createdAt,
          sortKey: comment.createdAt,
        });
      }

      items.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
      return items.map(({ sortKey: _sortKey, ...item }) => item);
    });

  return {
    preflight,
    resolveRemote,
    defaultBranch,
    openPr,
    findPrForBranch,
    prDetail,
    mergePr,
    failingCheckLogs,
    listReviewFeedback,
  } satisfies GitHubPortShape;
});

export const GitHubPortLive = Layer.effect(GitHubPort, make);
