import type {
  PullRequestActor,
  PullRequestCapabilities,
  PullRequestComment,
  PullRequestDetail,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canEditPullRequestChangeRequest,
  canEditPullRequestComment,
} from "./pullRequestEditing.logic";

type Subject = Pick<PullRequestDetail, "author" | "capabilities" | "viewer" | "viewerPermissions">;

function actor(login: string): PullRequestActor {
  return { login, name: null, avatarUrl: null };
}

function capabilities(edit?: PullRequestCapabilities["edit"]): PullRequestCapabilities {
  return {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: true,
    reactions: true,
    review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
    reviewers: { request: true, listCandidates: true },
    ...(edit === undefined ? {} : { edit }),
  };
}

function permissions(
  overrides: Partial<PullRequestViewerPermissions> = {},
): PullRequestViewerPermissions {
  return {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: true,
    ...overrides,
  };
}

function subject(overrides: Partial<Subject> = {}): Subject {
  return {
    author: actor("octocat"),
    capabilities: capabilities({ changeRequest: true, comment: true }),
    viewer: "octocat",
    viewerPermissions: permissions(),
    ...overrides,
  };
}

function comment(overrides: Partial<PullRequestComment> = {}): PullRequestComment {
  return {
    id: "c1",
    kind: "issue-comment",
    author: actor("octocat"),
    body: "words",
    createdAt: "2026-01-01T00:00:00.000Z",
    url: null,
    path: null,
    reviewState: null,
    ...overrides,
  };
}

describe("canEditPullRequestChangeRequest", () => {
  it("lets the author rewrite their own change request", () => {
    expect(canEditPullRequestChangeRequest(subject())).toBe(true);
  });

  it("matches the author regardless of case", () => {
    expect(canEditPullRequestChangeRequest(subject({ viewer: "OctoCat" }))).toBe(true);
  });

  it("lets somebody who may merge rewrite a change request they did not write", () => {
    expect(
      canEditPullRequestChangeRequest(
        subject({
          author: actor("someone-else"),
          viewerPermissions: permissions({ actions: ["merge"] }),
        }),
      ),
    ).toBe(true);
  });

  it("refuses a reader who neither wrote it nor may merge it", () => {
    expect(
      canEditPullRequestChangeRequest(
        subject({
          author: actor("someone-else"),
          viewerPermissions: permissions({ actions: ["close"] }),
        }),
      ),
    ).toBe(false);
  });

  it("refuses where the host cannot rewrite a change request at all", () => {
    expect(
      canEditPullRequestChangeRequest(
        subject({ capabilities: capabilities({ changeRequest: false, comment: true }) }),
      ),
    ).toBe(false);
    expect(canEditPullRequestChangeRequest(subject({ capabilities: capabilities() }))).toBe(false);
  });

  it("refuses where the host did not say who the reader is", () => {
    expect(canEditPullRequestChangeRequest(subject({ viewer: undefined }))).toBe(false);
  });

  it("still allows a merger the host could not name", () => {
    expect(
      canEditPullRequestChangeRequest(
        subject({ viewer: undefined, viewerPermissions: permissions({ actions: ["merge"] }) }),
      ),
    ).toBe(true);
  });
});

describe("canEditPullRequestComment", () => {
  it("lets the reader rewrite their own conversation comment", () => {
    expect(canEditPullRequestComment(subject(), comment())).toBe(true);
  });

  it("lets the reader rewrite their own remark on a line", () => {
    expect(canEditPullRequestComment(subject(), comment({ kind: "review-comment" }))).toBe(true);
  });

  it("matches the author regardless of case", () => {
    expect(
      canEditPullRequestComment(
        subject({ viewer: "OCTOCAT" }),
        comment({ author: actor("octocat") }),
      ),
    ).toBe(true);
  });

  it("refuses somebody else's remark", () => {
    expect(canEditPullRequestComment(subject(), comment({ author: actor("someone-else") }))).toBe(
      false,
    );
  });

  it("refuses a remark the host attributes to nobody", () => {
    expect(canEditPullRequestComment(subject(), comment({ author: null }))).toBe(false);
  });

  it("refuses a review's own summary", () => {
    expect(canEditPullRequestComment(subject(), comment({ kind: "review" }))).toBe(false);
  });

  it("refuses where the host cannot rewrite a remark at all", () => {
    expect(
      canEditPullRequestComment(
        subject({ capabilities: capabilities({ changeRequest: true, comment: false }) }),
        comment(),
      ),
    ).toBe(false);
    expect(canEditPullRequestComment(subject({ capabilities: capabilities() }), comment())).toBe(
      false,
    );
  });

  it("refuses where the host did not say who the reader is", () => {
    expect(canEditPullRequestComment(subject({ viewer: undefined }), comment())).toBe(false);
  });
});
