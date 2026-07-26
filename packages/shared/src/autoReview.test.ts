import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_AUTO_REVIEW_SETTINGS, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import type { AutoReviewJob } from "@t3tools/contracts";

import {
  buildAutoReviewFooter,
  clampAutoReviewMaxAttempts,
  deriveAutoReviewThreadPhase,
  isAutoReviewFixThreadBusy,
  linkOriginThread,
  mapFindingsToDecision,
  matchAutoReviewMention,
  nextAutoReviewAttempt,
  parseAutoReviewFooter,
  resolveAutoReviewJobOriginThread,
  resolveAutoReviewPolicy,
  shouldAutoFixOriginThread,
  shouldEnqueueAutoReviewJob,
} from "./autoReview.ts";

describe("resolveAutoReviewPolicy", () => {
  it("project can opt out while global is enabled", () => {
    const policy = resolveAutoReviewPolicy(
      {
        ...DEFAULT_AUTO_REVIEW_SETTINGS,
        enabled: true,
        projects: {
          [ProjectId.make("proj_1")]: { enabled: false },
        },
      },
      ProjectId.make("proj_1"),
    );
    expect(policy.enabled).toBe(false);
  });

  it("inherits model and mode from global when project omits them", () => {
    const policy = resolveAutoReviewPolicy(
      { ...DEFAULT_AUTO_REVIEW_SETTINGS, enabled: true, mode: "mention" },
      "proj_1",
    );
    expect(policy.enabled).toBe(true);
    expect(policy.mode).toBe("mention");
  });

  it("clamps maxAttempts into 1..10 with default 2", () => {
    expect(resolveAutoReviewPolicy(DEFAULT_AUTO_REVIEW_SETTINGS, "proj_1").maxAttempts).toBe(2);
    expect(
      resolveAutoReviewPolicy({ ...DEFAULT_AUTO_REVIEW_SETTINGS, maxAttempts: 99 }, "proj_1")
        .maxAttempts,
    ).toBe(10);
  });
});

describe("clampAutoReviewMaxAttempts", () => {
  it("clamps to a sane 1..10 range", () => {
    expect(clampAutoReviewMaxAttempts(undefined)).toBe(2);
    expect(clampAutoReviewMaxAttempts(0)).toBe(1);
    expect(clampAutoReviewMaxAttempts(3)).toBe(3);
    expect(clampAutoReviewMaxAttempts(50)).toBe(10);
    expect(clampAutoReviewMaxAttempts(Number.NaN)).toBe(2);
  });
});

describe("nextAutoReviewAttempt", () => {
  it("starts at 1 when there is no prior job or the latest did not fail", () => {
    expect(nextAutoReviewAttempt({ latestJob: null, maxAttempts: 2 })).toBe(1);
    expect(
      nextAutoReviewAttempt({
        latestJob: { attempt: 1, status: "succeeded" },
        maxAttempts: 2,
      }),
    ).toBe(1);
  });

  it("increments failed attempts until the cap, then returns null", () => {
    expect(
      nextAutoReviewAttempt({
        latestJob: { attempt: 1, status: "failed" },
        maxAttempts: 2,
      }),
    ).toBe(2);
    expect(
      nextAutoReviewAttempt({
        latestJob: { attempt: 2, status: "failed" },
        maxAttempts: 2,
      }),
    ).toBeNull();
  });
});

describe("matchAutoReviewMention", () => {
  it("matches @surgecode case-insensitively", () => {
    expect(matchAutoReviewMention("please @SurgeCode review", "surgecode")).toBe(true);
    expect(matchAutoReviewMention("no mention here", "surgecode")).toBe(false);
  });
});

describe("mapFindingsToDecision", () => {
  it("maps blocking to request_changes", () => {
    expect(mapFindingsToDecision([{ severity: "blocking" }, { severity: "nit" }])).toBe(
      "request_changes",
    );
  });

  it("maps only nits to comment", () => {
    expect(mapFindingsToDecision([{ severity: "nit" }])).toBe("comment");
  });
});

describe("shouldEnqueueAutoReviewJob", () => {
  it("skips when a succeeded job already exists for the head sha", () => {
    expect(
      shouldEnqueueAutoReviewJob({
        mode: "auto",
        existingStatus: "succeeded",
        trigger: "open_or_push",
      }),
    ).toBe(false);
  });

  it("allows mention re-review when comment id is new even if succeeded", () => {
    expect(
      shouldEnqueueAutoReviewJob({
        mode: "mention",
        existingStatus: "succeeded",
        trigger: "mention",
        isNewMentionComment: true,
      }),
    ).toBe(true);
  });
});

describe("footer", () => {
  it("round-trips head sha", () => {
    const footer = buildAutoReviewFooter({
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      headSha: "abcdef1234567890",
    });
    expect(parseAutoReviewFooter(footer)?.headSha.startsWith("abcdef1")).toBe(true);
  });
});

describe("shouldAutoFixOriginThread", () => {
  it("is true only for blocking or important", () => {
    expect(shouldAutoFixOriginThread({ comments: [{ severity: "nit" }] as never })).toBe(false);
    expect(
      shouldAutoFixOriginThread({
        comments: [
          {
            path: "a.ts",
            line: 1,
            side: "RIGHT",
            severity: "important",
            body: "x",
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("linkOriginThread", () => {
  it("prefers pr number match over branch and idle over busy", () => {
    const threadId = linkOriginThread({
      projectId: "proj",
      prNumber: 12,
      headBranch: "feat",
      candidates: [
        {
          threadId: "t-branch",
          projectId: "proj",
          deletedAt: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
          status: "idle",
          prNumber: null,
          prState: null,
          branch: "feat",
        },
        {
          threadId: "t-pr-busy",
          projectId: "proj",
          deletedAt: null,
          updatedAt: "2026-01-03T00:00:00.000Z",
          status: "busy",
          prNumber: 12,
          prState: "open",
          branch: "feat",
        },
        {
          threadId: "t-pr-idle",
          projectId: "proj",
          deletedAt: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          status: "idle",
          prNumber: 12,
          prState: "open",
          branch: "feat",
        },
      ],
    });
    expect(threadId).toBe("t-pr-idle");
  });
});

describe("resolveAutoReviewJobOriginThread", () => {
  const candidates = [
    {
      threadId: "t-feat",
      projectId: "proj",
      deletedAt: null,
      updatedAt: "2026-01-02T00:00:00.000Z",
      status: "idle",
      prNumber: null,
      prState: null,
      branch: "feat",
    },
  ];

  const job = (overrides: Partial<AutoReviewJob>) =>
    ({
      originThreadId: null,
      projectId: "proj",
      prNumber: 12,
      headBranch: "feat",
      status: "queued",
      ...overrides,
    }) as AutoReviewJob;

  it("keeps the stored linkage when the runner already assigned one", () => {
    expect(
      resolveAutoReviewJobOriginThread({
        job: job({ originThreadId: "t-linked" as never, status: "succeeded" }),
        candidates,
      }),
    ).toBe("t-linked");
  });

  it("provisionally links a queued or running job by head branch", () => {
    expect(resolveAutoReviewJobOriginThread({ job: job({ status: "queued" }), candidates })).toBe(
      "t-feat",
    );
    expect(resolveAutoReviewJobOriginThread({ job: job({ status: "running" }), candidates })).toBe(
      "t-feat",
    );
  });

  it("does not guess for terminal jobs the runner left unlinked", () => {
    for (const status of ["succeeded", "failed", "skipped"] as const) {
      expect(resolveAutoReviewJobOriginThread({ job: job({ status }), candidates })).toBeNull();
    }
  });

  it("returns null when the job has no head branch to match on", () => {
    expect(
      resolveAutoReviewJobOriginThread({ job: job({ headBranch: null }), candidates }),
    ).toBeNull();
  });

  it("returns null when no thread tracks the head branch", () => {
    expect(
      resolveAutoReviewJobOriginThread({ job: job({ headBranch: "other" }), candidates }),
    ).toBeNull();
  });
});

describe("isAutoReviewFixThreadBusy", () => {
  const base = {
    sessionStatus: null,
    latestTurnState: null,
    latestUserMessageAt: null,
    latestTurnTimestamps: [] as ReadonlyArray<string | null>,
    now: "2026-05-25T12:00:00.000Z",
  };

  it("is busy when the session is starting or running", () => {
    expect(isAutoReviewFixThreadBusy({ ...base, sessionStatus: "starting" })).toBe(true);
    expect(isAutoReviewFixThreadBusy({ ...base, sessionStatus: "running" })).toBe(true);
  });

  it("is busy when the latest turn is running", () => {
    expect(
      isAutoReviewFixThreadBusy({
        ...base,
        sessionStatus: "idle",
        latestTurnState: "running",
      }),
    ).toBe(true);
  });

  it("is busy while a queued turn start is within the grace window", () => {
    expect(
      isAutoReviewFixThreadBusy({
        ...base,
        sessionStatus: null,
        latestUserMessageAt: "2026-05-25T11:59:30.000Z",
        latestTurnTimestamps: ["2026-05-25T11:58:00.000Z", null, null],
      }),
    ).toBe(true);
  });

  it("is idle when the latest turn adopted the newest user message", () => {
    expect(
      isAutoReviewFixThreadBusy({
        ...base,
        sessionStatus: "idle",
        latestTurnState: "completed",
        latestUserMessageAt: "2026-05-25T11:59:30.000Z",
        latestTurnTimestamps: [
          "2026-05-25T11:59:30.000Z",
          "2026-05-25T11:59:31.000Z",
          "2026-05-25T11:59:45.000Z",
        ],
      }),
    ).toBe(false);
  });

  it("is idle when the queued message is older than the grace window", () => {
    expect(
      isAutoReviewFixThreadBusy({
        ...base,
        latestUserMessageAt: "2026-05-25T11:50:00.000Z",
        latestTurnTimestamps: [null],
      }),
    ).toBe(false);
  });

  it("is idle when the message timestamp is ahead of now beyond the grace window", () => {
    expect(
      isAutoReviewFixThreadBusy({
        ...base,
        latestUserMessageAt: "2026-05-25T12:10:00.000Z",
        latestTurnTimestamps: [null],
      }),
    ).toBe(false);
  });

  it("is idle for a queued message after a failed session start", () => {
    expect(
      isAutoReviewFixThreadBusy({
        ...base,
        sessionStatus: "error",
        latestUserMessageAt: "2026-05-25T11:59:30.000Z",
        latestTurnTimestamps: [null],
      }),
    ).toBe(false);
  });

  it("is idle when there is no activity at all", () => {
    expect(isAutoReviewFixThreadBusy(base)).toBe(false);
  });

  it("is idle on unparseable timestamps", () => {
    expect(
      isAutoReviewFixThreadBusy({
        ...base,
        latestUserMessageAt: "not-a-date",
        latestTurnTimestamps: [null],
      }),
    ).toBe(false);
  });
});

describe("deriveAutoReviewThreadPhase", () => {
  const makeJob = (overrides: Partial<AutoReviewJob>): AutoReviewJob =>
    ({
      id: "arj_1",
      projectId: "proj",
      prNumber: 1,
      headSha: "abc",
      trigger: "open_or_push",
      commentId: null,
      status: "succeeded",
      attempt: 1,
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      findingsCount: null,
      reviewUrl: null,
      githubReviewId: null,
      originThreadId: "thread-1",
      autoFixEnqueued: false,
      pendingFix: null,
      decision: null,
      actionableFindings: false,
      error: null,
      skipReason: null,
      createdAt: "2026-05-25T12:00:00.000Z#00000001",
      updatedAt: "2026-05-25T12:00:00.000Z#00000001",
      ...overrides,
    }) as AutoReviewJob;

  it("is null when no jobs are relevant to the thread", () => {
    expect(
      deriveAutoReviewThreadPhase({ jobs: [], threadId: "thread-1", threadBusy: false }),
    ).toBeNull();
  });

  it("is reviewing while any job is queued or running", () => {
    expect(
      deriveAutoReviewThreadPhase({
        jobs: [
          makeJob({ status: "succeeded" }),
          makeJob({
            id: "arj_2",
            status: "queued",
            createdAt: "2026-05-25T12:01:00.000Z#00000002",
          }),
        ],
        threadId: "thread-1",
        threadBusy: false,
      }),
    ).toBe("reviewing");
    expect(
      deriveAutoReviewThreadPhase({
        jobs: [makeJob({ status: "running" })],
        threadId: "thread-1",
        threadBusy: false,
      }),
    ).toBe("reviewing");
  });

  it("is fixing while a fix is pending for this thread", () => {
    expect(
      deriveAutoReviewThreadPhase({
        jobs: [
          makeJob({
            actionableFindings: true,
            pendingFix: {
              threadId: "thread-1",
              prompt: "fix it",
              queuedAt: "2026-05-25T12:00:30.000Z",
            } as never,
          }),
        ],
        threadId: "thread-1",
        threadBusy: true,
      }),
    ).toBe("fixing");
  });

  it("is fixing while the dispatched fix turn is still busy", () => {
    expect(
      deriveAutoReviewThreadPhase({
        jobs: [makeJob({ actionableFindings: true, autoFixEnqueued: true })],
        threadId: "thread-1",
        threadBusy: true,
      }),
    ).toBe("fixing");
  });

  it("is readyToMerge when the latest review came back clean", () => {
    expect(
      deriveAutoReviewThreadPhase({
        jobs: [makeJob({ actionableFindings: false })],
        threadId: "thread-1",
        threadBusy: false,
      }),
    ).toBe("readyToMerge");
  });

  it("is null once the fix turn finished on an actionable review", () => {
    expect(
      deriveAutoReviewThreadPhase({
        jobs: [makeJob({ actionableFindings: true, autoFixEnqueued: true })],
        threadId: "thread-1",
        threadBusy: false,
      }),
    ).toBeNull();
  });

  it("is null when nothing ever succeeded", () => {
    expect(
      deriveAutoReviewThreadPhase({
        jobs: [makeJob({ status: "failed" })],
        threadId: "thread-1",
        threadBusy: false,
      }),
    ).toBeNull();
  });

  it("uses the latest succeeded job by createdAt", () => {
    expect(
      deriveAutoReviewThreadPhase({
        jobs: [
          makeJob({ actionableFindings: true, autoFixEnqueued: true }),
          makeJob({
            id: "arj_2",
            actionableFindings: false,
            createdAt: "2026-05-25T12:05:00.000Z#00000002",
          }),
        ],
        threadId: "thread-1",
        threadBusy: true,
      }),
    ).toBe("readyToMerge");
  });
});
