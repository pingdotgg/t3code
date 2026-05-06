import { readFile } from "node:fs/promises";

import { loadAiLoopConfig } from "./config";
import { type CheckRunSummary, GitHubRepoClient, type PullRequestCommitSummary } from "./github";
import {
  normalizeFailedCheckFinding,
  normalizeReviewCommentFinding,
  normalizeReviewSummaryFinding,
  isAutofixTrigger,
  buildFindingSetFingerprint,
} from "./normalize";
import { parseAiLoopPrMetadata } from "./pr-metadata";
import { createDefaultStickyState } from "./state";
import type { AiLoopFinding, StickyAiLoopState } from "./schema";
import {
  calculateDebounceSleepMs,
  isQueuedFresh,
  isRunningFresh,
  shouldBlockRepeatedFindingSet,
  shouldResetForNewGeneration,
} from "./router-logic";

const readEventPayload = async (): Promise<unknown> => {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required.");
  }

  return JSON.parse(await readFile(eventPath, "utf8")) as unknown;
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected event payload to be an object.");
  }

  return value as Record<string, unknown>;
};

const readString = (value: unknown): string => (typeof value === "string" ? value : "");

const readNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const getPullRequestNumber = (eventName: string, payload: Record<string, unknown>): number => {
  if (eventName === "workflow_run") {
    const workflowRun = asRecord(payload.workflow_run);
    const pullRequests = workflowRun.pull_requests;
    if (Array.isArray(pullRequests) && pullRequests[0] && typeof pullRequests[0] === "object") {
      const firstPullRequest = asRecord(pullRequests[0]);
      return readNumber(firstPullRequest.number);
    }

    return 0;
  }

  if (eventName === "issue_comment") {
    const issue = asRecord(payload.issue);
    if (!issue.pull_request) {
      return 0;
    }

    return readNumber(issue.number);
  }

  if (eventName === "pull_request_review" || eventName === "pull_request_review_comment") {
    const pullRequest = asRecord(payload.pull_request);
    return readNumber(pullRequest.number);
  }

  return 0;
};

const getEventTimestamp = (eventName: string, payload: Record<string, unknown>): string => {
  if (eventName === "workflow_run") {
    return readString(asRecord(payload.workflow_run).updated_at);
  }

  if (eventName === "issue_comment") {
    return readString(asRecord(payload.comment).created_at);
  }

  if (eventName === "pull_request_review") {
    return readString(asRecord(payload.review).submitted_at);
  }

  if (eventName === "pull_request_review_comment") {
    return readString(asRecord(payload.comment).created_at);
  }

  return new Date().toISOString();
};

const isActionableEvent = (
  eventName: string,
  payload: Record<string, unknown>,
  prAuthorLogin: string,
  triggerPhrase: string,
  trustedReviewBots: string[],
): boolean => {
  if (eventName === "workflow_run") {
    return readString(asRecord(payload.workflow_run).conclusion) === "failure";
  }

  if (eventName === "issue_comment") {
    const comment = asRecord(payload.comment);
    return (
      readString(asRecord(comment.user).login) === prAuthorLogin &&
      isAutofixTrigger(readString(comment.body), triggerPhrase)
    );
  }

  if (eventName === "pull_request_review") {
    const review = asRecord(payload.review);
    return trustedReviewBots.includes(readString(asRecord(review.user).login));
  }

  if (eventName === "pull_request_review_comment") {
    const comment = asRecord(payload.comment);
    return trustedReviewBots.includes(readString(asRecord(comment.user).login));
  }

  return false;
};

const isFixerChildCommit = (
  latestCommit: PullRequestCommitSummary | undefined,
  expectedBotLogin: string,
): boolean => {
  if (!latestCommit || !expectedBotLogin) {
    return false;
  }

  const committerLogin = latestCommit.committer?.login ?? "";
  const hasTrailer = latestCommit.commit.message.includes("X-Autofix-Executor: claude");
  return committerLogin === expectedBotLogin && hasTrailer;
};

const collectFailedChecks = (
  checks: CheckRunSummary[],
  requiredChecks: string[],
  headSha: string,
): AiLoopFinding[] =>
  checks
    .filter((check) => requiredChecks.includes(check.name) && check.conclusion === "failure")
    .flatMap((check) => {
      const finding = normalizeFailedCheckFinding({
        actor: "github-actions[bot]",
        url: check.html_url,
        name: check.name,
        title: check.output?.title ?? check.name,
        summary: check.output?.summary ?? "",
        headSha,
      });

      return finding ? [finding] : [];
    });

const uniqueByFingerprint = (findings: AiLoopFinding[]): AiLoopFinding[] => {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.fingerprint)) {
      return false;
    }

    seen.add(finding.fingerprint);
    return true;
  });
};

const toBase64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

const updateStateForNewGeneration = (
  state: StickyAiLoopState,
  currentSha: string,
  owner: string,
): StickyAiLoopState => ({
  ...state,
  owner,
  status: "idle",
  generation_sha: currentSha,
  current_sha: currentSha,
  attempts_used: 0,
  last_signal_fingerprint: "",
  last_result_fingerprint: "",
  blocked_reason: null,
  executor_run_id: null,
});

const main = async (): Promise<void> => {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required.");
  }

  const config = await loadAiLoopConfig();
  if (!config.enabled) {
    console.log("[ai-loop] config disabled; exiting.");
    return;
  }

  const payload = asRecord(await readEventPayload());
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const prNumber = getPullRequestNumber(eventName, payload);
  if (!prNumber) {
    console.log("[ai-loop] no pull request context; exiting.");
    return;
  }

  const github = new GitHubRepoClient(repository, token);
  const pullRequest = await github.getPullRequest(prNumber);
  const prMetadata = parseAiLoopPrMetadata(pullRequest.body);
  if (!prMetadata.enabled || prMetadata.owner !== config.executor_owner) {
    console.log("[ai-loop] PR metadata disabled or unsupported owner; exiting.");
    return;
  }

  if (
    !isActionableEvent(
      eventName,
      payload,
      pullRequest.user.login,
      config.human_trigger_phrase,
      config.trusted_review_bots,
    )
  ) {
    console.log("[ai-loop] event is not actionable; exiting.");
    return;
  }

  const fallbackState = createDefaultStickyState(prMetadata.owner, pullRequest.head.sha);
  let state = await github.loadOrCreateStickyState(prNumber, fallbackState);

  const labels = new Set(pullRequest.labels.map((label) => label.name));
  if (labels.has(config.pause_label)) {
    state = {
      ...state,
      status: "paused",
      paused: true,
      current_sha: pullRequest.head.sha,
      last_processed_at: new Date().toISOString(),
    };
    await github.upsertStickyComment(prNumber, state);
    console.log("[ai-loop] pause label present; exiting.");
    return;
  }

  if (state.status === "paused" && !labels.has(config.pause_label)) {
    state = {
      ...state,
      status: "idle",
      paused: false,
      blocked_reason: null,
      last_processed_at: new Date().toISOString(),
    };
    await github.upsertStickyComment(prNumber, state);
  }

  const nowIso = new Date().toISOString();
  if (
    isQueuedFresh(state, nowIso, config.dispatch_grace_seconds) ||
    isRunningFresh(state, nowIso, config.executor_timeout_seconds)
  ) {
    console.log("[ai-loop] fresh queued/running state found; exiting.");
    return;
  }

  if (state.status === "queued" && !state.executor_run_id) {
    state = {
      ...state,
      status: "blocked",
      blocked_reason: "executor_dispatch_failed",
      last_processed_at: nowIso,
    };
    await github.upsertStickyComment(prNumber, state);
  } else if (state.status === "running") {
    state = {
      ...state,
      status: "blocked",
      blocked_reason: "executor_timeout",
      last_processed_at: nowIso,
    };
    await github.upsertStickyComment(prNumber, state);
  }

  const commits = await github.listPullRequestCommits(prNumber);
  const latestCommit = commits.at(-1);
  const latestCommitIsFixerChild = isFixerChildCommit(latestCommit, config.executor_bot_login);
  if (shouldResetForNewGeneration(latestCommitIsFixerChild, pullRequest.head.sha, state)) {
    state = updateStateForNewGeneration(state, pullRequest.head.sha, prMetadata.owner);
    await github.upsertStickyComment(prNumber, state);
  }

  const eventTimestamp = getEventTimestamp(eventName, payload) || nowIso;
  state = {
    ...state,
    current_sha: pullRequest.head.sha,
    last_signal_at: eventTimestamp,
    burst_started_at:
      !state.burst_started_at || state.generation_sha !== pullRequest.head.sha
        ? eventTimestamp
        : state.burst_started_at,
    last_processed_at: nowIso,
  };
  await github.upsertStickyComment(prNumber, state);

  const debounceSleepMs = calculateDebounceSleepMs(
    eventTimestamp,
    state,
    config.debounce_seconds,
    config.debounce_max_seconds,
  );
  if (debounceSleepMs > 0) {
    await github.wait(debounceSleepMs);
  }

  const livePullRequest = await github.getPullRequest(prNumber);
  const liveComments = await github.listReviewComments(prNumber);
  const liveReviews = await github.listReviews(prNumber);
  const liveChecks = await github.listCheckRuns(livePullRequest.head.sha);

  const findings = uniqueByFingerprint([
    ...collectFailedChecks(liveChecks, config.required_ci_checks, livePullRequest.head.sha),
    ...liveComments
      .filter(
        (comment) =>
          config.trusted_review_bots.includes(comment.user.login) &&
          comment.commit_id === livePullRequest.head.sha,
      )
      .flatMap((comment) => {
        const finding = normalizeReviewCommentFinding({
          actor: comment.user.login,
          url: comment.html_url,
          body: comment.body,
          path: comment.path,
          line: comment.line ?? 1,
          headSha: livePullRequest.head.sha,
        });

        return finding ? [finding] : [];
      }),
    ...liveReviews
      .filter(
        (review) =>
          config.trusted_review_bots.includes(review.user.login) &&
          review.commit_id === livePullRequest.head.sha,
      )
      .flatMap((review) => {
        const finding = normalizeReviewSummaryFinding({
          actor: review.user.login,
          url: review.html_url,
          body: review.body,
          headSha: livePullRequest.head.sha,
        });

        return finding ? [finding] : [];
      }),
  ]);

  const findingSetFingerprint = buildFindingSetFingerprint(findings, livePullRequest.head.sha);

  if (findings.length === 0) {
    const requiredChecksGreen = liveChecks
      .filter((check) => config.required_ci_checks.includes(check.name))
      .every((check) => check.conclusion === "success");

    state = {
      ...state,
      status: requiredChecksGreen ? "clean" : "idle",
      current_sha: livePullRequest.head.sha,
      last_signal_fingerprint: "",
      blocked_reason: null,
      last_processed_at: new Date().toISOString(),
      executor_run_id: null,
    };
    await github.upsertStickyComment(prNumber, state);
    return;
  }

  if (shouldBlockRepeatedFindingSet(latestCommitIsFixerChild, state, findingSetFingerprint)) {
    state = {
      ...state,
      status: "blocked",
      current_sha: livePullRequest.head.sha,
      last_signal_fingerprint: findingSetFingerprint,
      blocked_reason: "repeated_failure_same_fingerprint",
      last_processed_at: new Date().toISOString(),
      executor_run_id: null,
    };
    await github.upsertStickyComment(prNumber, state);
    return;
  }

  if (state.attempts_used >= config.attempt_budget_per_generation) {
    state = {
      ...state,
      status: "exhausted",
      current_sha: livePullRequest.head.sha,
      last_signal_fingerprint: findingSetFingerprint,
      blocked_reason: "generation_budget_exhausted",
      last_processed_at: new Date().toISOString(),
      executor_run_id: null,
    };
    await github.upsertStickyComment(prNumber, state);
    return;
  }

  state = {
    ...state,
    status: "queued",
    current_sha: livePullRequest.head.sha,
    last_signal_fingerprint: findingSetFingerprint,
    last_processed_at: new Date().toISOString(),
    executor_run_id: null,
  };
  await github.upsertStickyComment(prNumber, state);

  const dispatchToken = process.env.AI_LOOP_DISPATCH_TOKEN;
  if (!dispatchToken) {
    state = {
      ...state,
      status: "blocked",
      blocked_reason: "missing_dispatch_token",
      last_processed_at: new Date().toISOString(),
    };
    await github.upsertStickyComment(prNumber, state);
    return;
  }

  await github.dispatchWorkflow(
    "ai-fix-executor-claude.yml",
    livePullRequest.head.ref,
    {
      pr_number: String(prNumber),
      head_ref: livePullRequest.head.ref,
      head_sha: livePullRequest.head.sha,
      generation_sha: state.generation_sha,
      finding_set_fingerprint: findingSetFingerprint,
      findings_b64: toBase64(JSON.stringify(findings)),
    },
    dispatchToken,
  );
};

await main();
