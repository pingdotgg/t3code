import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PullRequestActionInput,
  PullRequestCapabilities,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestRef,
  PullRequestReviewerRequestInput,
  resolvePullRequestAuthorFilter,
} from "./pullRequest.ts";

const decodeListResult = Schema.decodeUnknownSync(PullRequestListResult);
const decodeListInput = Schema.decodeUnknownSync(PullRequestListInput);
const decodeReviewerRequest = Schema.decodeUnknownSync(PullRequestReviewerRequestInput);
const decodeAction = Schema.decodeUnknownSync(PullRequestActionInput);
const decodeRef = Schema.decodeUnknownSync(PullRequestRef);

const LIST_RESULT: PullRequestListResult = {
  viewers: { "github.com": "bilal", "gitlab.com": "bilal.hassan" },
  providers: [
    {
      host: "github.com",
      kind: "github",
      searchesOnHost: true,
      projectCount: 1,
      configured: true,
      detail: null,
    },
    {
      host: "gitlab.com",
      kind: "gitlab",
      searchesOnHost: true,
      projectCount: 1,
      configured: false,
      detail: "glab is not installed.",
    },
  ],
  entries: [
    {
      provider: "github",
      host: "github.com",
      projectId: "project-1" as PullRequestListResult["entries"][number]["projectId"],
      projectTitle: "t3code",
      repository: "pingdotgg/t3code",
      number: 1,
      title: "Add a pull requests page",
      url: "https://github.com/pingdotgg/t3code/pull/1",
      author: { login: "octocat", name: null, avatarUrl: null },
      headBranch: "feat/page",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 1,
      deletions: 0,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      viewerReviewRequested: false,
      labels: [{ name: "backend", color: null }],
    },
  ],
  errors: [],
  truncated: false,
  nextCursors: { "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|1|1" },
};

it("keeps the URL that identifies a linked pull request without a Git project", () => {
  const url = "https://github.com/pingdotgg/t3code/pull/9435";

  expect(
    decodeRef({ projectId: "parent", repository: "pingdotgg/t3code", number: 9435, url }).url,
  ).toBe(url);
});

describe("PullRequestListResult", () => {
  /**
   * The RPC builds this codec at call time, so a shape it cannot lower — an open-keyed record
   * with an optional value, for one — fails as an interrupted request rather than as a schema
   * error. Building it here turns that into a test failure instead.
   */
  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(PullRequestListResult);

    const decoded = Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(LIST_RESULT));

    expect(decoded).toStrictEqual(LIST_RESULT);
  });

  it("keys a viewer by host, so two hosts of one kind stay separate accounts", () => {
    const decoded = decodeListResult({
      ...LIST_RESULT,
      viewers: { "github.com": "bilal", "github.acme.dev": "b.hassan" },
    });

    expect(decoded.viewers["github.com"]).toBe("bilal");
    expect(decoded.viewers["github.acme.dev"]).toBe("b.hassan");
  });
});

describe("PullRequestListInput", () => {
  it("trims a search, so what is sent is what was typed", () => {
    expect(decodeListInput({ state: "open", query: "  page  " }).query).toBe("page");
  });

  it("has no search when none was asked for", () => {
    expect(decodeListInput({ state: "open" }).query).toBeUndefined();
  });

  it("bounds a search, because it travels into a command and a query string", () => {
    expect(decodeListInput({ state: "open", query: "p".repeat(200) }).query).toHaveLength(200);
    expect(() => decodeListInput({ state: "open", query: "p".repeat(201) })).toThrow();
  });

  it("takes back the continuation a result handed out, keyed the way it arrived", () => {
    const cursors = { "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|99|1,2" };

    expect(decodeListInput({ state: "open", cursors }).cursors).toStrictEqual(cursors);
  });

  it("has no continuation when the listing is being read from the top", () => {
    expect(decodeListInput({ state: "open" }).cursors).toBeUndefined();
  });

  it("bounds a continuation, because it comes back from the page and goes into a filter", () => {
    const long = (length: number) => ({ "github.com acme/web": "c".repeat(length) });
    expect(decodeListInput({ state: "open", cursors: long(4096) })).toBeDefined();
    expect(() => decodeListInput({ state: "open", cursors: long(4097) })).toThrow();
  });
});

describe("PullRequestReviewerRequestInput", () => {
  const ref = { projectId: "p1", repository: "acme/web", number: 1 };
  const reviewer = { id: "octocat", kind: "user" };

  it("carries the same shape whichever direction the request goes", () => {
    // One operation, turned around: `requested` is the whole difference between asking somebody
    // for a review and taking the request back.
    for (const requested of [true, false]) {
      expect(decodeReviewerRequest({ ...ref, reviewers: [reviewer], requested }).requested).toBe(
        requested,
      );
    }
  });

  it("refuses a request that names nobody, which no host would do anything with", () => {
    expect(() => decodeReviewerRequest({ ...ref, reviewers: [], requested: true })).toThrow();
  });

  it("bounds the reviewers, because they travel into a body the page composed", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `user${index}`, kind: "user" }));
    expect(
      decodeReviewerRequest({ ...ref, reviewers: many(25), requested: true }).reviewers,
    ).toHaveLength(25);
    expect(() => decodeReviewerRequest({ ...ref, reviewers: many(26), requested: true })).toThrow();
  });

  it("keeps a team apart from a person, which is a different thing to ask", () => {
    expect(
      decodeReviewerRequest({
        ...ref,
        reviewers: [reviewer, { id: "web-platform", kind: "team" }],
        requested: true,
      }).reviewers.map((entry) => entry.kind),
    ).toEqual(["user", "team"]);
  });
});

describe("updating a branch that has fallen behind its base", () => {
  const ref = { projectId: "project-1", repository: "acme/web", number: 7 };

  it("carries the way the branch should be brought up to date", () => {
    expect(decodeAction({ ...ref, action: "update-branch", updateMethod: "rebase" })).toMatchObject(
      {
        action: "update-branch",
        updateMethod: "rebase",
      },
    );
  });

  it("takes the action without a method, which is the host's own default", () => {
    expect(decodeAction({ ...ref, action: "update-branch" }).updateMethod).toBeUndefined();
  });

  it("refuses a way no host offers", () => {
    expect(() =>
      decodeAction({ ...ref, action: "update-branch", updateMethod: "squash" }),
    ).toThrow();
  });
});

describe("leaving a merge for the host to make once it is ready", () => {
  const ref = { projectId: "project-1", repository: "acme/web", number: 7 };

  it("carries the strategy the deferred merge should use, as merging now does", () => {
    expect(
      decodeAction({ ...ref, action: "enable-auto-merge", mergeMethod: "squash" }),
    ).toMatchObject({ action: "enable-auto-merge", mergeMethod: "squash" });
  });

  it("takes the arming back without a strategy, because there is nothing to choose", () => {
    expect(decodeAction({ ...ref, action: "disable-auto-merge" }).mergeMethod).toBeUndefined();
  });
});

describe("reverting a merged pull request", () => {
  it("carries the revert action without merge options", () => {
    const action = decodeAction({
      projectId: "project-1",
      repository: "acme/web",
      number: 7,
      action: "revert",
    });

    expect(action.action).toBe("revert");
    expect(action.mergeMethod).toBeUndefined();
  });
});

describe("approving fork workflows", () => {
  it("carries workflow approval as its own action", () => {
    const action = decodeAction({
      projectId: "project-1",
      repository: "acme/web",
      number: 7,
      action: "approve-workflows",
    });

    expect(action.action).toBe("approve-workflows");
  });
});

describe("PullRequestCapabilities", () => {
  const decodeCapabilities = Schema.decodeUnknownSync(PullRequestCapabilities);
  const base = {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: true,
    review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
    reviewers: { request: true, listCandidates: true },
  };

  it("decodes a server that says nothing about reactions as a server with none", () => {
    expect(decodeCapabilities(base).reactions).toBeUndefined();
  });
});

describe("naming the reader as the author to narrow by", () => {
  it("reads me as whoever is signed in, however it is written", () => {
    expect(resolvePullRequestAuthorFilter("me", "octocat")).toBe("octocat");
    expect(resolvePullRequestAuthorFilter("@me", "octocat")).toBe("octocat");
    expect(resolvePullRequestAuthorFilter("  ME  ", "octocat")).toBe("octocat");
  });

  it("leaves any other name as it was typed", () => {
    expect(resolvePullRequestAuthorFilter(" mercedes ", "octocat")).toBe("mercedes");
    expect(resolvePullRequestAuthorFilter("me-too", "octocat")).toBe("me-too");
  });

  it("stands as typed where the host has not said who the reader is", () => {
    expect(resolvePullRequestAuthorFilter("me", null)).toBe("me");
    expect(resolvePullRequestAuthorFilter("me", "  ")).toBe("me");
  });
});
