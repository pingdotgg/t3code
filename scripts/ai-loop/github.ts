import { setTimeout as sleep } from "node:timers/promises";

import { AI_LOOP_STATE_MARKER, parseStickyState, renderStickyState } from "./state";
import type { StickyAiLoopState } from "./schema";

export interface PullRequestSummary {
  number: number;
  body: string;
  head: {
    sha: string;
    ref: string;
  };
  user: {
    login: string;
  };
  labels: Array<{ name: string }>;
}

export interface IssueCommentSummary {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  user: {
    login: string;
  };
}

export interface ReviewCommentSummary {
  id: number;
  body: string;
  path: string;
  line: number | null;
  commit_id: string;
  html_url: string;
  created_at: string;
  user: {
    login: string;
  };
}

export interface ReviewSummary {
  id: number;
  body: string;
  state: string;
  html_url: string;
  submitted_at: string;
  commit_id: string | null;
  user: {
    login: string;
  };
}

export interface CheckRunSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  output?: {
    title?: string;
    summary?: string;
  };
}

export interface PullRequestCommitSummary {
  sha: string;
  commit: {
    message: string;
  };
  committer: {
    login: string;
  } | null;
}

const GITHUB_API_BASE_URL = "https://api.github.com";

export class GitHubRepoClient {
  private readonly repository: string;

  private readonly token: string;

  constructor(repository: string, token: string) {
    this.repository = repository;
    this.token = token;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API ${path} failed with ${response.status} ${response.statusText}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  async getPullRequest(number: number): Promise<PullRequestSummary> {
    return this.request<PullRequestSummary>(`/repos/${this.repository}/pulls/${number}`);
  }

  async listIssueComments(number: number): Promise<IssueCommentSummary[]> {
    return this.request<IssueCommentSummary[]>(
      `/repos/${this.repository}/issues/${number}/comments?per_page=100`,
    );
  }

  async listReviewComments(number: number): Promise<ReviewCommentSummary[]> {
    return this.request<ReviewCommentSummary[]>(
      `/repos/${this.repository}/pulls/${number}/comments?per_page=100`,
    );
  }

  async listReviews(number: number): Promise<ReviewSummary[]> {
    return this.request<ReviewSummary[]>(
      `/repos/${this.repository}/pulls/${number}/reviews?per_page=100`,
    );
  }

  async listCheckRuns(sha: string): Promise<CheckRunSummary[]> {
    const payload = await this.request<{ check_runs: CheckRunSummary[] }>(
      `/repos/${this.repository}/commits/${sha}/check-runs?per_page=100`,
    );
    return payload.check_runs;
  }

  async listPullRequestCommits(number: number): Promise<PullRequestCommitSummary[]> {
    return this.request<PullRequestCommitSummary[]>(
      `/repos/${this.repository}/pulls/${number}/commits?per_page=100`,
    );
  }

  async dispatchWorkflow(
    workflowId: string,
    ref: string,
    inputs: Record<string, string>,
    tokenOverride?: string,
  ): Promise<void> {
    const token = tokenOverride ?? this.token;
    const response = await fetch(
      `${GITHUB_API_BASE_URL}/repos/${this.repository}/actions/workflows/${workflowId}/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref, inputs }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Workflow dispatch for ${workflowId} failed with ${response.status} ${response.statusText}`,
      );
    }
  }

  async upsertStickyComment(
    prNumber: number,
    nextState: StickyAiLoopState,
  ): Promise<IssueCommentSummary> {
    const comments = await this.listIssueComments(prNumber);
    const stickyComment = comments.find((comment) => comment.body.includes(AI_LOOP_STATE_MARKER));
    const body = renderStickyState(nextState);

    if (!stickyComment) {
      return this.request<IssueCommentSummary>(
        `/repos/${this.repository}/issues/${prNumber}/comments`,
        {
          method: "POST",
          body: JSON.stringify({ body }),
        },
      );
    }

    return this.request<IssueCommentSummary>(
      `/repos/${this.repository}/issues/comments/${stickyComment.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ body }),
      },
    );
  }

  async loadOrCreateStickyState(
    prNumber: number,
    fallback: StickyAiLoopState,
  ): Promise<StickyAiLoopState> {
    const comments = await this.listIssueComments(prNumber);
    const stickyComment = comments.find((comment) => comment.body.includes(AI_LOOP_STATE_MARKER));
    if (!stickyComment) {
      await this.upsertStickyComment(prNumber, fallback);
      return fallback;
    }

    const state = parseStickyState(stickyComment.body, fallback);
    if (!state) {
      await this.upsertStickyComment(prNumber, fallback);
      return fallback;
    }

    return state;
  }

  async wait(milliseconds: number): Promise<void> {
    await sleep(milliseconds);
  }
}
