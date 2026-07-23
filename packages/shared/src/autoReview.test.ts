import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_AUTO_REVIEW_SETTINGS, ProjectId, ProviderInstanceId } from "@t3tools/contracts";

import {
  buildAutoReviewFooter,
  linkOriginThread,
  mapFindingsToDecision,
  matchAutoReviewMention,
  parseAutoReviewFooter,
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
