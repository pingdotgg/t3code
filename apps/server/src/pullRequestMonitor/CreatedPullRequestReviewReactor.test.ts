import { assert, describe, it } from "@effect/vitest";
import {
  CollaborativeAcceptanceCandidateId,
  CollaborativeAcceptanceCaseId,
  ProjectId,
  ThreadId,
  type OrchestrationThread,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  createdPullRequestLinks,
  dispatchAutomaticReviewWorkflow,
  makeReferenceCountedKeyedLock,
  reconcileCreatedPullRequestReview,
} from "./CreatedPullRequestReviewReactor.ts";

const threadId = ThreadId.make("created-pr-review-thread");
const projectId = ProjectId.make("created-pr-review-project");

const link = (source: ThreadPullRequestLink["source"]): ThreadPullRequestLink => ({
  source,
  linkedAt: "2026-09-22T00:00:00.000Z",
  pullRequest: {
    title: "Created pull request",
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    baseBranch: "main",
    headBranch: "feature",
    state: "open",
  },
});

const thread = (
  pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread =>
  ({
    id: threadId,
    projectId,
    pullRequests,
    messages: [],
    activities: [],
    latestTurn: null,
    session: null,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  }) as OrchestrationThread;

const observation = (headSha: string, state: "open" | "closed" | "merged" = "open") => ({
  state,
  repository: "owner/repo",
  number: 42,
  headSha,
  sourceRevision: `provider:${headSha}`,
});

describe("created pull-request review reconciliation", () => {
  it.effect("cleans keyed lock entries after the final holder releases", () =>
    Effect.gen(function* () {
      const locks = makeReferenceCountedKeyedLock();
      yield* locks.withLock("thread:pull-request", Effect.void);
      assert.strictEqual(locks.size(), 0);
    }),
  );

  it("admits an inactive created PR with the authoritative current head", async () => {
    const submitted: string[] = [];
    let refreshCount = 0;
    const current = thread([link("created")]);

    await Effect.runPromise(
      reconcileCreatedPullRequestReview(current, {
        refresh: () => {
          refreshCount += 1;
          return Effect.succeed(observation("head-2"));
        },
        readCurrentThread: () => Effect.succeed(current),
        submit: ({ observation: refreshed }) =>
          Effect.sync(() => {
            submitted.push(refreshed.headSha);
          }),
      }),
    );

    assert.strictEqual(refreshCount, 1);
    assert.deepStrictEqual(submitted, ["head-2"]);
  });

  it("does not admit while the creating thread is active", async () => {
    let submitted = 0;
    const active = thread([link("created")], {
      latestTurn: {
        state: "running",
      },
    } as Partial<OrchestrationThread>);

    await Effect.runPromise(
      reconcileCreatedPullRequestReview(active, {
        refresh: () => Effect.succeed(observation("head-1")),
        readCurrentThread: () => Effect.succeed(active),
        submit: () => Effect.sync(() => submitted++),
      }),
    );

    assert.strictEqual(submitted, 0);
  });

  it("does not review PRs inherited by historical review workflow threads", async () => {
    let refreshed = 0;
    const reviewWorker = thread([link("created")], {
      id: ThreadId.make("workflow:run-42:node:review-changes:worker"),
      reviewSnapshot: { scope: { kind: "pull-request" } } as never,
      reviewResult: {} as never,
    });

    await Effect.runPromise(
      reconcileCreatedPullRequestReview(reviewWorker, {
        refresh: () => {
          refreshed++;
          return Effect.succeed(observation("head-1"));
        },
        readCurrentThread: () => Effect.succeed(reviewWorker),
        submit: () => Effect.die("Review workers must not launch another review"),
      }),
    );

    assert.strictEqual(refreshed, 0);
  });

  it("does not submit when a creator becomes a review thread during refresh", async () => {
    let submitted = 0;
    const creator = thread([link("created")]);
    const reviewWorker = thread([link("created")], {
      reviewSnapshot: { scope: { kind: "pull-request" } } as never,
    });

    await Effect.runPromise(
      reconcileCreatedPullRequestReview(creator, {
        refresh: () => Effect.succeed(observation("head-1")),
        readCurrentThread: () => Effect.succeed(reviewWorker),
        submit: () => Effect.sync(() => submitted++),
      }),
    );

    assert.strictEqual(submitted, 0);
  });

  it("continues to review creator threads after they receive a review result", async () => {
    let submitted = 0;
    const creator = thread([link("created")], {
      reviewSnapshot: { scope: { kind: "pull-request" } } as never,
      reviewResult: {} as never,
    });

    await Effect.runPromise(
      reconcileCreatedPullRequestReview(creator, {
        refresh: () => Effect.succeed(observation("head-2")),
        readCurrentThread: () => Effect.succeed(creator),
        submit: () => Effect.sync(() => submitted++),
      }),
    );

    assert.strictEqual(submitted, 1);
  });

  it("ignores manual and recovered associations", async () => {
    let submitted = 0;
    const current = thread([link("manual"), link("recovered")]);

    await Effect.runPromise(
      reconcileCreatedPullRequestReview(current, {
        refresh: () => Effect.succeed(observation("head-1")),
        readCurrentThread: () => Effect.succeed(current),
        submit: () => Effect.sync(() => submitted++),
      }),
    );

    assert.strictEqual(submitted, 0);
  });

  it("ignores closed pull requests", async () => {
    let submitted = 0;
    const current = thread([link("agent")]);

    await Effect.runPromise(
      reconcileCreatedPullRequestReview(current, {
        refresh: () => Effect.succeed(observation("head-1", "closed")),
        readCurrentThread: () => Effect.succeed(current),
        submit: () => Effect.sync(() => submitted++),
      }),
    );

    assert.strictEqual(submitted, 0);
  });

  it("re-checks durable thread state after refresh", async () => {
    let submitted = 0;
    const initial = thread([link("created")]);
    const activeAfterRefresh = thread([link("created")], {
      latestTurn: { state: "running" },
    } as Partial<OrchestrationThread>);

    await Effect.runPromise(
      reconcileCreatedPullRequestReview(initial, {
        refresh: () => Effect.succeed(observation("head-3")),
        readCurrentThread: () => Effect.succeed(activeAfterRefresh),
        submit: () => Effect.sync(() => submitted++),
      }),
    );

    assert.strictEqual(submitted, 0);
  });

  it("reconciliation is safe to repeat when admission is idempotent", async () => {
    const submitted = new Set<string>();
    const current = thread([link("created")]);
    const reconcile = () =>
      reconcileCreatedPullRequestReview(current, {
        refresh: () => Effect.succeed(observation("head-4")),
        readCurrentThread: () => Effect.succeed(current),
        submit: ({ observation: refreshed }) =>
          Effect.sync(() => {
            submitted.add(refreshed.headSha);
          }),
      });

    await Effect.runPromise(Effect.all([reconcile(), reconcile()], { concurrency: 2 }));

    assert.deepStrictEqual([...submitted], ["head-4"]);
  });

  it("cancels legacy self-review requests before launching the child review workflow", async () => {
    const request = {
      kind: "review",
      status: "waiting",
      senderThreadId: threadId,
      recipientThreadId: threadId,
      caseId: "case-42",
      candidateRefs: ["candidate-42"],
    };
    const current = thread([link("created")], {
      collaborationRequests: [request],
    } as unknown as Partial<OrchestrationThread>);
    const effects: string[] = [];

    await Effect.runPromise(
      dispatchAutomaticReviewWorkflow({
        request: {
          caseId: CollaborativeAcceptanceCaseId.make("case-42"),
          candidateId: CollaborativeAcceptanceCandidateId.make("candidate-42"),
          headSha: "head-42",
          workflowId: "review-changes",
          idempotencyKey: "acceptance-review:case-42:candidate-42:review-changes:1",
        },
        pullRequestNumber: 42,
        readCurrentThread: () => Effect.succeed(current),
        cancelLegacySelfReview: () =>
          Effect.sync(() => {
            effects.push("cancel-legacy-request");
          }),
        runWorkflow: (input) =>
          Effect.sync(() => {
            effects.push(
              `run:${input.thread.id}:${input.pullRequestNumber}:${input.headSha}:${input.idempotencyKey}`,
            );
          }),
      }),
    );

    assert.deepStrictEqual(effects, [
      "cancel-legacy-request",
      `run:${threadId}:42:head-42:acceptance-review:case-42:candidate-42:review-changes:1`,
    ]);
  });

  it("does not launch the review workflow when the creator becomes active", async () => {
    let launched = false;
    const active = thread([link("created")], {
      latestTurn: { state: "running" },
    } as Partial<OrchestrationThread>);

    await Effect.runPromise(
      dispatchAutomaticReviewWorkflow({
        request: {
          caseId: CollaborativeAcceptanceCaseId.make("case-42"),
          candidateId: CollaborativeAcceptanceCandidateId.make("candidate-42"),
          headSha: "head-42",
          workflowId: "review-changes",
          idempotencyKey: "review-42",
        },
        pullRequestNumber: 42,
        readCurrentThread: () => Effect.succeed(active),
        cancelLegacySelfReview: () => Effect.void,
        runWorkflow: () =>
          Effect.sync(() => {
            launched = true;
          }),
      }),
    );

    assert.isFalse(launched);
  });

  it("does not launch when the PR link was removed before dispatch", async () => {
    let launched = false;
    const unlinked = thread([]);

    await Effect.runPromise(
      dispatchAutomaticReviewWorkflow({
        request: {
          caseId: CollaborativeAcceptanceCaseId.make("case-42"),
          candidateId: CollaborativeAcceptanceCandidateId.make("candidate-42"),
          headSha: "head-42",
          workflowId: "review-changes",
          idempotencyKey: "review-42",
        },
        pullRequestNumber: 42,
        pullRequest: { repository: "owner/repo", number: 42 },
        readCurrentThread: () => Effect.succeed(unlinked),
        cancelLegacySelfReview: () => Effect.void,
        runWorkflow: () =>
          Effect.sync(() => {
            launched = true;
          }),
      }),
    );

    assert.isFalse(launched);
  });

  it("does not launch when the observed PR is no longer open", async () => {
    let launched = false;
    const current = thread([link("created")]);

    await Effect.runPromise(
      dispatchAutomaticReviewWorkflow({
        request: {
          caseId: CollaborativeAcceptanceCaseId.make("case-42"),
          candidateId: CollaborativeAcceptanceCandidateId.make("candidate-42"),
          headSha: "head-42",
          workflowId: "review-changes",
          idempotencyKey: "review-42",
        },
        pullRequestNumber: 42,
        pullRequest: { repository: "owner/repo", number: 42 },
        observationState: "closed",
        readCurrentThread: () => Effect.succeed(current),
        cancelLegacySelfReview: () => Effect.void,
        runWorkflow: () =>
          Effect.sync(() => {
            launched = true;
          }),
      }),
    );

    assert.isFalse(launched);
  });

  it("does not launch on repository mismatch at the dispatch boundary", async () => {
    let launched = false;
    const current = thread([link("created")]);

    await Effect.runPromise(
      dispatchAutomaticReviewWorkflow({
        request: {
          caseId: CollaborativeAcceptanceCaseId.make("case-42"),
          candidateId: CollaborativeAcceptanceCandidateId.make("candidate-42"),
          headSha: "head-42",
          workflowId: "review-changes",
          idempotencyKey: "review-42",
        },
        pullRequestNumber: 42,
        pullRequest: { repository: "owner/other", number: 42 },
        readCurrentThread: () => Effect.succeed(current),
        cancelLegacySelfReview: () => Effect.void,
        runWorkflow: () =>
          Effect.sync(() => {
            launched = true;
          }),
      }),
    );

    assert.isFalse(launched);
  });

  it("filters only durable creation sources", () => {
    assert.deepStrictEqual(
      createdPullRequestLinks({
        pullRequests: [link("manual"), link("created"), link("agent"), link("recovered")],
      }).map((item) => item.source),
      ["created", "agent"],
    );
  });
});
