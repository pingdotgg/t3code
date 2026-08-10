import { assert, describe, it } from "vite-plus/test";

import type { ChangeRequest, OrchestrationThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  deriveCodeReviewStatus,
  filterChangeRequests,
  isAssignedToViewer,
  matchesViewer,
  partitionChangeRequests,
  resolveRowReviewStatus,
  selectViewerAccount,
  sortChangeRequests,
} from "./PullRequestsPanel.logic";

function makeChangeRequest(overrides: Partial<ChangeRequest> & { number: number }): ChangeRequest {
  return {
    provider: "github",
    title: `Change ${overrides.number}`,
    url: `https://github.com/octocat/t3code/pull/${overrides.number}`,
    baseRefName: "main",
    headRefName: `feature/${overrides.number}`,
    state: "open",
    updatedAt: Option.none(),
    ...overrides,
  };
}

function updatedAt(iso: string) {
  return Option.some(DateTime.makeUnsafe(iso));
}

describe("matchesViewer", () => {
  it("matches identical handles regardless of case and padding", () => {
    assert.isTrue(matchesViewer("  Octocat ", "octocat"));
  });

  it("matches an email-shaped handle against a bare login", () => {
    assert.isTrue(matchesViewer("ada@example.com", "ada"));
    assert.isTrue(matchesViewer("ada", "ada@example.com"));
  });

  it("does not match different people who share a domain", () => {
    assert.isFalse(matchesViewer("ada@example.com", "grace@example.com"));
  });

  it("does not match when either side is blank", () => {
    assert.isFalse(matchesViewer("", "octocat"));
    assert.isFalse(matchesViewer("octocat", "   "));
  });
});

describe("isAssignedToViewer", () => {
  it("is false when the viewer is unknown", () => {
    const changeRequest = makeChangeRequest({ number: 1, assignees: ["octocat"] });
    assert.isFalse(isAssignedToViewer(changeRequest, null));
  });

  it("is false when the change request has no assignees", () => {
    assert.isFalse(isAssignedToViewer(makeChangeRequest({ number: 1 }), "octocat"));
  });

  it("is true when any assignee matches the viewer", () => {
    const changeRequest = makeChangeRequest({ number: 1, assignees: ["grace", "octocat"] });
    assert.isTrue(isAssignedToViewer(changeRequest, "Octocat"));
  });
});

describe("sortChangeRequests", () => {
  it("orders by most recently updated, then by higher number", () => {
    const sorted = sortChangeRequests([
      makeChangeRequest({ number: 1, updatedAt: updatedAt("2026-08-01T00:00:00Z") }),
      makeChangeRequest({ number: 2, updatedAt: updatedAt("2026-08-03T00:00:00Z") }),
      makeChangeRequest({ number: 3, updatedAt: updatedAt("2026-08-03T00:00:00Z") }),
    ]);
    assert.deepStrictEqual(
      sorted.map((entry) => entry.number),
      [3, 2, 1],
    );
  });

  it("sinks change requests with no timestamp below dated ones", () => {
    const sorted = sortChangeRequests([
      makeChangeRequest({ number: 9 }),
      makeChangeRequest({ number: 1, updatedAt: updatedAt("2026-08-01T00:00:00Z") }),
    ]);
    assert.deepStrictEqual(
      sorted.map((entry) => entry.number),
      [1, 9],
    );
  });
});

describe("partitionChangeRequests", () => {
  it("splits on the viewer's assignments and sorts each side", () => {
    const partition = partitionChangeRequests(
      [
        makeChangeRequest({
          number: 1,
          assignees: ["octocat"],
          updatedAt: updatedAt("2026-08-01T00:00:00Z"),
        }),
        makeChangeRequest({ number: 2, assignees: ["grace"] }),
        makeChangeRequest({
          number: 3,
          assignees: ["grace", "octocat"],
          updatedAt: updatedAt("2026-08-05T00:00:00Z"),
        }),
      ],
      "octocat",
    );
    assert.deepStrictEqual(
      partition.assigned.map((entry) => entry.number),
      [3, 1],
    );
    assert.deepStrictEqual(
      partition.unassigned.map((entry) => entry.number),
      [2],
    );
  });

  it("puts everything under unassigned when the viewer is unknown", () => {
    const partition = partitionChangeRequests(
      [makeChangeRequest({ number: 1, assignees: ["octocat"] })],
      null,
    );
    assert.strictEqual(partition.assigned.length, 0);
    assert.strictEqual(partition.unassigned.length, 1);
  });
});

describe("filterChangeRequests", () => {
  const changeRequests = [
    makeChangeRequest({ number: 42, title: "Add board view", author: "grace" }),
    makeChangeRequest({ number: 7, title: "Fix terminal focus", headRefName: "fix/focus" }),
  ];

  it("returns everything for a blank query", () => {
    assert.strictEqual(filterChangeRequests(changeRequests, "  ").length, 2);
  });

  it("matches on title, case-insensitively", () => {
    assert.deepStrictEqual(
      filterChangeRequests(changeRequests, "BOARD").map((entry) => entry.number),
      [42],
    );
  });

  it("matches a #-prefixed number", () => {
    assert.deepStrictEqual(
      filterChangeRequests(changeRequests, "#42").map((entry) => entry.number),
      [42],
    );
  });

  it("matches on branch and author", () => {
    assert.deepStrictEqual(
      filterChangeRequests(changeRequests, "fix/focus").map((entry) => entry.number),
      [7],
    );
    assert.deepStrictEqual(
      filterChangeRequests(changeRequests, "grace").map((entry) => entry.number),
      [42],
    );
  });
});

describe("deriveCodeReviewStatus", () => {
  const threadWith = (latestTurn: OrchestrationThread["latestTurn"]) =>
    ({ latestTurn }) as OrchestrationThread;

  it("shows nothing when the pull request has no review thread", () => {
    assert.strictEqual(deriveCodeReviewStatus(null), null);
  });

  it("reads a thread with no turn yet as still reviewing", () => {
    // Create and turn-start are two round trips; the gap must not read as done.
    assert.strictEqual(deriveCodeReviewStatus(threadWith(null)), "reviewing");
  });

  it("maps turn state onto the chip", () => {
    const state = (value: "running" | "completed" | "error" | "interrupted") =>
      deriveCodeReviewStatus(
        threadWith({ state: value } as NonNullable<OrchestrationThread["latestTurn"]>),
      );
    assert.strictEqual(state("running"), "reviewing");
    assert.strictEqual(state("completed"), "reviewed");
    assert.strictEqual(state("error"), "failed");
    assert.strictEqual(state("interrupted"), "stopped");
  });
});

describe("resolveRowReviewStatus", () => {
  const thread = (state: "running" | "completed" | "error") =>
    ({ latestTurn: { state } }) as OrchestrationThread;

  it("shows no chip for a pull request that was never reviewed", () => {
    assert.strictEqual(
      resolveRowReviewStatus({ reviewThreadId: null, thread: thread("running") }),
      null,
    );
  });

  it("keeps a started review visible while its thread snapshot is still loading", () => {
    // Regression: the chip used to blank out here, making a running review
    // look like it had never been launched.
    assert.strictEqual(resolveRowReviewStatus({ reviewThreadId: "t1", thread: null }), "reviewing");
  });

  it("reflects the thread once it arrives", () => {
    assert.strictEqual(
      resolveRowReviewStatus({ reviewThreadId: "t1", thread: thread("completed") }),
      "reviewed",
    );
    assert.strictEqual(
      resolveRowReviewStatus({ reviewThreadId: "t1", thread: thread("error") }),
      "failed",
    );
  });
});

describe("selectViewerAccount", () => {
  const providers = [
    { kind: "github", auth: { account: Option.some("octocat") } },
    { kind: "gitlab", auth: { account: Option.some("ada") } },
    { kind: "bitbucket", auth: { account: Option.none<string>() } },
  ];

  it("returns the account for the repo's own provider", () => {
    assert.strictEqual(selectViewerAccount(providers, "github"), "octocat");
  });

  it("never borrows another provider's account", () => {
    assert.strictEqual(selectViewerAccount(providers, "bitbucket"), null);
  });

  it("returns null for an unknown or missing provider", () => {
    assert.strictEqual(selectViewerAccount(providers, "unknown"), null);
    assert.strictEqual(selectViewerAccount(providers, null), null);
    assert.strictEqual(selectViewerAccount(providers, "azure-devops"), null);
  });
});
