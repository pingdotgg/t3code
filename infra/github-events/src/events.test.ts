import { describe, expect, it } from "vite-plus/test";

import { normalizeWebhook } from "./events.ts";

const repository = {
  id: 1,
  full_name: "pingdotgg/t3code",
  html_url: "https://github.com/pingdotgg/t3code",
};

const actor = {
  id: 2,
  login: "contributor",
  avatar_url: "https://avatars.example/contributor",
};

function ciPullRequest(number: number) {
  return {
    url: `https://api.github.com/repos/pingdotgg/t3code/pulls/${number}`,
    id: 1_000 + number,
    number,
    head: {
      ref: "fix/thing",
      sha: "head-sha",
      repo: {
        id: 2,
        url: "https://api.github.com/repos/contributor/t3code",
        name: "t3code",
      },
    },
    base: {
      ref: "main",
      sha: "base-sha",
      repo: {
        id: 1,
        url: "https://api.github.com/repos/pingdotgg/t3code",
        name: "t3code",
      },
    },
  };
}

describe("normalizeWebhook", () => {
  it("includes pull request state and comment content", () => {
    const event = normalizeWebhook({
      deliveryId: "delivery-1",
      eventName: "issue_comment",
      payload: {
        action: "created",
        repository,
        sender: actor,
        issue: {
          number: 42,
          title: "fix the thing",
          state: "open",
          locked: false,
          html_url: "https://github.com/pingdotgg/t3code/pull/42",
          user: actor,
          labels: [{ name: "bug" }],
          pull_request: {
            url: "https://api.github.com/repos/pingdotgg/t3code/pulls/42",
            html_url: "https://github.com/pingdotgg/t3code/pull/42",
          },
        },
        comment: {
          id: 99,
          body: "please add a regression test",
          html_url: "https://github.com/pingdotgg/t3code/pull/42#issuecomment-99",
          created_at: "2026-08-18T12:00:00Z",
          updated_at: "2026-08-18T12:00:00Z",
          user: actor,
        },
      },
    });

    expect(event).toMatchObject({
      version: 1,
      deliveryId: "delivery-1",
      event: "issue_comment",
      action: "created",
      repository: {
        fullName: "pingdotgg/t3code",
      },
      pullRequestNumbers: [42],
      actor: {
        login: "contributor",
      },
      details: {
        issue: {
          number: 42,
          title: "fix the thing",
          state: "open",
          labels: ["bug"],
        },
        comment: {
          id: 99,
          body: "please add a regression test",
          author: {
            login: "contributor",
          },
        },
      },
    });
  });

  it("ignores comments that are not on pull requests", () => {
    expect(
      normalizeWebhook({
        deliveryId: "delivery-2",
        eventName: "issue_comment",
        payload: {
          action: "created",
          repository,
          sender: actor,
          issue: { number: 7 },
          comment: {
            id: 100,
            body: "ordinary issue comment",
            user: actor,
          },
        },
      }),
    ).toBeNull();
  });

  it("includes pull request state, refs, and mergeability", () => {
    const event = normalizeWebhook({
      deliveryId: "delivery-3",
      eventName: "pull_request",
      receivedAt: "2026-08-18T12:01:01Z",
      payload: {
        action: "synchronize",
        number: 42,
        before: "old-head-sha",
        after: "head-sha",
        repository,
        sender: actor,
        pull_request: {
          number: 42,
          title: "fix the thing",
          state: "open",
          draft: false,
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
          html_url: "https://github.com/pingdotgg/t3code/pull/42",
          user: actor,
          created_at: "2026-08-17T12:00:00Z",
          updated_at: "2026-08-18T12:01:00Z",
          head: {
            ref: "fix/thing",
            sha: "head-sha",
            repo: {
              id: 2,
              name: "t3code",
              full_name: "contributor/t3code",
              html_url: "https://github.com/contributor/t3code",
            },
          },
          base: {
            ref: "main",
            sha: "base-sha",
            repo: {
              id: 1,
              name: "t3code",
              full_name: "pingdotgg/t3code",
              html_url: "https://github.com/pingdotgg/t3code",
            },
          },
        },
      },
    });

    expect(event).toMatchObject({
      pullRequestNumbers: [42],
      headSha: "head-sha",
      occurredAt: "2026-08-18T12:01:01Z",
      details: {
        pullRequest: {
          number: 42,
          title: "fix the thing",
          state: "open",
          draft: false,
          merged: false,
          mergeable: true,
          mergeableState: "clean",
          head: {
            ref: "fix/thing",
            sha: "head-sha",
            repository: { id: 2, fullName: "contributor/t3code" },
          },
          base: {
            ref: "main",
            sha: "base-sha",
            repository: { id: 1, fullName: "pingdotgg/t3code" },
          },
        },
        action: {
          beforeSha: "old-head-sha",
          afterSha: "head-sha",
        },
      },
    });
  });

  it("includes review state and body", () => {
    const event = normalizeWebhook({
      deliveryId: "delivery-4",
      eventName: "pull_request_review",
      payload: {
        action: "submitted",
        repository,
        sender: actor,
        pull_request: {
          number: 42,
          title: "fix the thing",
          state: "open",
          user: actor,
          head: { ref: "fix/thing", sha: "head-sha" },
          base: { ref: "main", sha: "base-sha", repo: { id: 1 } },
        },
        review: {
          id: 123,
          body: "looks good after that test",
          state: "approved",
          commit_id: "reviewed-sha",
          html_url: "https://github.com/pingdotgg/t3code/pull/42#pullrequestreview-123",
          submitted_at: "2026-08-18T12:02:00Z",
          user: actor,
        },
      },
    });

    expect(event).toMatchObject({
      pullRequestNumbers: [42],
      headSha: "head-sha",
      occurredAt: "2026-08-18T12:02:00Z",
      details: {
        review: {
          id: 123,
          body: "looks good after that test",
          state: "approved",
          commitId: "reviewed-sha",
          author: { login: "contributor" },
        },
      },
    });
  });

  it("includes inline review comment content and location", () => {
    const event = normalizeWebhook({
      deliveryId: "delivery-5",
      eventName: "pull_request_review_comment",
      payload: {
        action: "created",
        repository,
        sender: actor,
        pull_request: {
          number: 42,
          title: "fix the thing",
          state: "open",
          user: actor,
          head: { ref: "fix/thing", sha: "head-sha" },
          base: { ref: "main", sha: "base-sha", repo: { id: 1 } },
        },
        comment: {
          id: 124,
          body: "this branch can return early",
          html_url: "https://github.com/pingdotgg/t3code/pull/42#discussion_r124",
          created_at: "2026-08-18T12:03:00Z",
          updated_at: "2026-08-18T12:03:00Z",
          commit_id: "commented-sha",
          original_commit_id: "original-sha",
          user: actor,
          path: "src/worker.ts",
          line: 20,
          side: "RIGHT",
          diff_hunk: "@@ -19,2 +19,2 @@",
          in_reply_to_id: 120,
        },
      },
    });

    expect(event).toMatchObject({
      pullRequestNumbers: [42],
      headSha: "head-sha",
      details: {
        comment: {
          body: "this branch can return early",
          commitId: "commented-sha",
          originalCommitId: "original-sha",
          path: "src/worker.ts",
          line: 20,
          side: "RIGHT",
          diffHunk: "@@ -19,2 +19,2 @@",
          inReplyToId: 120,
        },
      },
    });
  });

  it("includes check run status and all associated pull requests", () => {
    const event = normalizeWebhook({
      deliveryId: "delivery-6",
      eventName: "check_run",
      payload: {
        action: "completed",
        repository,
        sender: actor,
        check_run: {
          id: 200,
          name: "unit tests",
          status: "completed",
          conclusion: "success",
          head_sha: "head-sha",
          details_url: "https://ci.example/checks/200",
          html_url: "https://github.com/pingdotgg/t3code/runs/200",
          started_at: "2026-08-18T12:00:00Z",
          completed_at: "2026-08-18T12:04:00Z",
          output: {
            title: "tests passed",
            summary: "42 tests passed",
            text: "full output",
            annotations_count: 0,
          },
          pull_requests: [ciPullRequest(42), ciPullRequest(43), ciPullRequest(42)],
        },
      },
    });

    expect(event).toMatchObject({
      pullRequestNumbers: [42, 43],
      headSha: "head-sha",
      occurredAt: "2026-08-18T12:04:00Z",
      details: {
        check: {
          id: 200,
          name: "unit tests",
          status: "completed",
          conclusion: "success",
          url: "https://github.com/pingdotgg/t3code/runs/200",
          detailsUrl: "https://ci.example/checks/200",
          output: {
            title: "tests passed",
            summary: "42 tests passed",
            annotationsCount: 0,
          },
        },
      },
    });
  });

  it("includes commit status context even without a pull request mapping", () => {
    const event = normalizeWebhook({
      deliveryId: "delivery-7",
      eventName: "status",
      payload: {
        repository,
        sender: actor,
        id: 201,
        sha: "head-sha",
        state: "failure",
        context: "deploy preview",
        description: "preview failed",
        target_url: "https://ci.example/runs/201",
        created_at: "2026-08-18T12:05:00Z",
      },
    });

    expect(event).toMatchObject({
      pullRequestNumbers: [],
      headSha: "head-sha",
      occurredAt: "2026-08-18T12:05:00Z",
      details: {
        status: {
          id: 201,
          state: "failure",
          context: "deploy preview",
          description: "preview failed",
        },
      },
    });
  });

  it("includes check suite state", () => {
    const event = normalizeWebhook({
      deliveryId: "delivery-8",
      eventName: "check_suite",
      receivedAt: "2026-08-18T12:06:01Z",
      payload: {
        action: "completed",
        repository,
        sender: actor,
        check_suite: {
          id: 202,
          status: "completed",
          conclusion: "neutral",
          head_sha: "head-sha",
          url: "https://api.github.com/check-suites/202",
          before: "base-sha",
          after: "head-sha",
          created_at: "2026-08-18T12:04:00Z",
          updated_at: "2026-08-18T12:06:00Z",
          pull_requests: [ciPullRequest(42)],
        },
      },
    });

    expect(event).toMatchObject({
      pullRequestNumbers: [42],
      headSha: "head-sha",
      occurredAt: "2026-08-18T12:06:01Z",
      details: {
        checkSuite: {
          id: 202,
          status: "completed",
          conclusion: "neutral",
          beforeSha: "base-sha",
          afterSha: "head-sha",
        },
      },
    });
  });

  it("includes workflow run state and receipt time", () => {
    const event = normalizeWebhook({
      deliveryId: "delivery-9",
      eventName: "workflow_run",
      receivedAt: "2026-08-18T12:07:00Z",
      payload: {
        action: "completed",
        repository,
        sender: actor,
        workflow_run: {
          id: 203,
          workflow_id: 50,
          name: "ci",
          run_number: 12,
          run_attempt: 2,
          event: "pull_request",
          status: "completed",
          conclusion: "failure",
          head_sha: "head-sha",
          html_url: "https://github.com/pingdotgg/t3code/actions/runs/203",
          created_at: "2026-08-18T12:00:00Z",
          updated_at: "2026-08-18T12:06:00Z",
          pull_requests: [ciPullRequest(42)],
        },
      },
    });

    expect(event).toMatchObject({
      receivedAt: "2026-08-18T12:07:00Z",
      occurredAt: "2026-08-18T12:07:00Z",
      pullRequestNumbers: [42],
      headSha: "head-sha",
      details: {
        workflowRun: {
          id: 203,
          workflowId: 50,
          name: "ci",
          runNumber: 12,
          runAttempt: 2,
          status: "completed",
          conclusion: "failure",
        },
      },
    });
  });

  it("includes requested check actions and receipt timing", () => {
    const event = normalizeWebhook({
      deliveryId: "delivery-10",
      eventName: "check_run",
      receivedAt: "2026-08-18T12:08:00Z",
      payload: {
        action: "requested_action",
        repository,
        sender: actor,
        requested_action: { identifier: "rerun-with-debug" },
        check_run: {
          id: 204,
          name: "integration tests",
          status: "completed",
          conclusion: "failure",
          head_sha: "head-sha",
          pull_requests: [],
        },
      },
    });

    expect(event).toMatchObject({
      occurredAt: "2026-08-18T12:08:00Z",
      headSha: "head-sha",
      details: { requestedAction: "rerun-with-debug" },
    });
  });

  it("preserves previous comment bodies on edits", () => {
    const event = normalizeWebhook({
      deliveryId: "delivery-11",
      eventName: "issue_comment",
      receivedAt: "2026-08-18T12:08:00Z",
      payload: {
        action: "edited",
        repository,
        sender: actor,
        issue: {
          number: 42,
          title: "fix the thing",
          state: "open",
          user: actor,
          labels: [],
          pull_request: { url: "https://api.github.com/repos/pingdotgg/t3code/pulls/42" },
        },
        comment: {
          id: 300,
          body: "new body",
          user: actor,
          created_at: "2026-08-18T12:00:00Z",
          updated_at: "2026-08-18T12:08:00Z",
        },
        changes: { body: { from: "old body" } },
      },
    });

    expect(event).toMatchObject({
      details: {
        comment: { body: "new body" },
        changes: { body: { from: "old body" } },
      },
    });
  });

  it("keeps only repository-scoped ci pull request mappings", () => {
    const crossRepository = {
      ...ciPullRequest(42),
      base: {
        ...ciPullRequest(42).base,
        repo: {
          id: 3,
          url: "https://api.github.com/repos/other/repository",
          name: "repository",
        },
      },
    };
    const event = normalizeWebhook({
      deliveryId: "delivery-12",
      eventName: "check_run",
      payload: {
        action: "completed",
        repository,
        sender: actor,
        check_run: {
          id: 400,
          name: "ci",
          status: "completed",
          head_sha: "head-sha",
          pull_requests: [crossRepository, { number: 42 }, ciPullRequest(43)],
        },
      },
    });

    expect(event).toMatchObject({ pullRequestNumbers: [43] });
  });

  it("rejects malformed actioned events and identifiers", () => {
    const checkPayload = {
      action: "completed",
      repository,
      sender: actor,
      check_run: {
        id: 205,
        name: "ci",
        status: "completed",
        pull_requests: [],
      },
    };
    expect(
      normalizeWebhook({
        deliveryId: "delivery-11",
        eventName: "check_run",
        payload: checkPayload,
      }),
    ).toBeNull();
    expect(
      normalizeWebhook({
        deliveryId: "delivery-12",
        eventName: "pull_request",
        payload: { repository, sender: actor },
      }),
    ).toBeNull();
    expect(
      normalizeWebhook({
        deliveryId: "delivery-13",
        eventName: "check_run",
        payload: {
          ...checkPayload,
          action: "requested_action",
          check_run: { ...checkPayload.check_run, head_sha: "head-sha" },
        },
      }),
    ).toBeNull();
    expect(
      normalizeWebhook({
        deliveryId: "delivery-14",
        eventName: "check_run",
        payload: {
          ...checkPayload,
          action: "unexpected",
          check_run: { ...checkPayload.check_run, head_sha: "head-sha" },
        },
      }),
    ).toBeNull();
    expect(
      normalizeWebhook({
        deliveryId: "delivery-15",
        eventName: "pull_request",
        payload: {
          action: "synchronize",
          repository,
          sender: actor,
          pull_request: {
            number: 42,
            title: "fix the thing",
            state: "open",
            head: { ref: "fix/thing", sha: "head-sha" },
            base: { ref: "main", sha: "base-sha" },
          },
        },
      }),
    ).toBeNull();
  });

  it("rejects contradictory direct pull request associations", () => {
    const pullRequest = {
      number: 42,
      title: "fix the thing",
      state: "open",
      head: { ref: "fix/thing", sha: "head-sha", repo: { id: 2 } },
      base: { ref: "main", sha: "base-sha", repo: { id: 1 } },
    };
    const pullRequestPayload = {
      action: "opened",
      number: 42,
      repository,
      sender: actor,
      pull_request: pullRequest,
    };

    expect(
      normalizeWebhook({
        deliveryId: "delivery-association-valid",
        eventName: "pull_request",
        payload: pullRequestPayload,
      }),
    ).toMatchObject({ pullRequestNumbers: [42] });
    expect(
      normalizeWebhook({
        deliveryId: "delivery-association-base-mismatch",
        eventName: "pull_request",
        payload: {
          ...pullRequestPayload,
          pull_request: {
            ...pullRequest,
            base: { ...pullRequest.base, repo: { id: 999 } },
          },
        },
      }),
    ).toBeNull();
    expect(
      normalizeWebhook({
        deliveryId: "delivery-association-number-mismatch",
        eventName: "pull_request",
        payload: { ...pullRequestPayload, number: 43 },
      }),
    ).toBeNull();
    expect(
      normalizeWebhook({
        deliveryId: "delivery-review-base-mismatch",
        eventName: "pull_request_review",
        payload: {
          action: "submitted",
          repository,
          sender: actor,
          pull_request: {
            ...pullRequest,
            base: { ...pullRequest.base, repo: { id: 999 } },
          },
          review: { id: 1, state: "approved", user: actor },
        },
      }),
    ).toBeNull();
  });

  it("validates issue markers and preserves pull request action context", () => {
    const pullRequest = {
      number: 42,
      title: "fix the thing",
      state: "open",
      head: { ref: "fix/thing", sha: "head-sha", repo: { id: 2 } },
      base: { ref: "main", sha: "base-sha", repo: { id: 1 } },
    };
    const actionEvent = normalizeWebhook({
      deliveryId: "delivery-dequeued",
      eventName: "pull_request",
      payload: {
        action: "dequeued",
        number: 42,
        reason: "checks_failed",
        repository,
        sender: actor,
        pull_request: pullRequest,
      },
    });
    expect(actionEvent).toMatchObject({
      details: { action: { reason: "checks_failed" } },
    });
    expect(
      normalizeWebhook({
        deliveryId: "delivery-dequeued-without-reason",
        eventName: "pull_request",
        payload: {
          action: "dequeued",
          number: 42,
          repository,
          sender: actor,
          pull_request: pullRequest,
        },
      }),
    ).toBeNull();
    expect(
      normalizeWebhook({
        deliveryId: "delivery-optional-label",
        eventName: "pull_request",
        payload: {
          action: "labeled",
          number: 42,
          repository,
          sender: actor,
          pull_request: pullRequest,
        },
      }),
    ).not.toBeNull();

    expect(
      normalizeWebhook({
        deliveryId: "delivery-marker-mismatch",
        eventName: "issue_comment",
        payload: {
          action: "created",
          repository,
          sender: actor,
          issue: {
            number: 42,
            title: "fix the thing",
            state: "open",
            pull_request: {
              url: "https://api.github.com/repos/other/other/pulls/99",
            },
          },
          comment: {
            id: 1,
            body: "hello",
            created_at: "2026-08-18T12:00:00Z",
            user: actor,
          },
        },
      }),
    ).toBeNull();
  });
});
