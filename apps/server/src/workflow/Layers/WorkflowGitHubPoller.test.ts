// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import {
  GitHubPort,
  type GitHubPrDetail,
  type GitHubPortShape,
  type GitHubReviewItem,
} from "../Services/GitHubPort.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowGitHubPoller } from "../Services/WorkflowGitHubPoller.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { MAX_TICKET_MESSAGE_BODY_LENGTH } from "../ticketMessageBody.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { makeWorkflowGitHubPollerLive } from "./WorkflowGitHubPoller.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

// --- Scriptable gh stub -----------------------------------------------------
//
// Tests push a SEQUENCE of prDetail responses per prNumber; each prDetail()
// call pops the next one (the last is sticky). failingCheckLogs / review
// feedback are configured per prNumber too. A prNumber can be flagged to fail
// prDetail (gh error during observe).

interface PrScript {
  details: GitHubPrDetail[];
  failingLogs: string | null;
  feedback: GitHubReviewItem[];
  failPrDetail: boolean;
  // Optional side effect run when failingCheckLogs is invoked (during observe,
  // before phase 1) — used to simulate a concurrent delete landing mid-sweep.
  onFailingCheckLogs?: (sql: SqlClient.SqlClient) => Effect.Effect<void>;
}

const scripts = new Map<number, PrScript>();
// Optional wrapper to force ingestExternalEvent to fail transiently N times.
let ingestFailureCount = 0;
// When true, ingestExternalEvent always fails with a non-terminal,
// non-transient error (poison-pill simulation).
let ingestAlwaysFails = false;
// When true, postTicketMessage always fails (persistently-failing post
// poison-pill simulation).
let postAlwaysFails = false;

const resetScripts = () => {
  scripts.clear();
  ingestFailureCount = 0;
  ingestAlwaysFails = false;
  postAlwaysFails = false;
};

const scriptPr = (prNumber: number, script: Partial<PrScript>) => {
  scripts.set(prNumber, {
    details: script.details ?? [],
    failingLogs: script.failingLogs ?? null,
    feedback: script.feedback ?? [],
    failPrDetail: script.failPrDetail ?? false,
    ...(script.onFailingCheckLogs === undefined
      ? {}
      : { onFailingCheckLogs: script.onFailingCheckLogs }),
  });
};

const GitHubPortStub = Layer.effect(
  GitHubPort,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      preflight: () => Effect.succeed({ ok: true as const }),
      resolveRemote: () => Effect.succeed({ remoteName: "origin", repo: "acme/widgets" }),
      defaultBranch: () => Effect.succeed("main"),
      openPr: () => Effect.succeed({ number: 0, url: "", adopted: false }),
      prDetail: ({ prNumber }) =>
        Effect.suspend(() => {
          const script = scripts.get(prNumber);
          if (script === undefined || script.failPrDetail) {
            return Effect.fail(
              new WorkflowEventStoreError({ message: `gh prDetail failed for #${prNumber}` }),
            );
          }
          const next = script.details.length > 1 ? script.details.shift()! : script.details[0];
          if (next === undefined) {
            return Effect.fail(
              new WorkflowEventStoreError({ message: `no scripted detail for #${prNumber}` }),
            );
          }
          return Effect.succeed(next);
        }),
      findPrForBranch: () => Effect.succeed(null),
      mergePr: () => Effect.succeed({ ok: true as const }),
      failingCheckLogs: ({ prNumber }) =>
        Effect.gen(function* () {
          const script = scripts.get(prNumber);
          if (script?.onFailingCheckLogs !== undefined) {
            yield* script.onFailingCheckLogs(sql);
          }
          return script?.failingLogs ?? null;
        }),
      listReviewFeedback: ({ prNumber }) =>
        Effect.sync(() => scripts.get(prNumber)?.feedback ?? []),
    } satisfies GitHubPortShape;
  }),
);

const succeedingExecutor = Layer.succeed(StepExecutor, {
  execute: () => Effect.succeed({ _tag: "completed" as const }),
} satisfies StepExecutorShape);

// Wrap the real engine so ingestExternalEvent can be made to fail transiently
// for the retry test, without disturbing every other engine method.
const EngineWrapper = Layer.effect(
  WorkflowEngine,
  Effect.gen(function* () {
    const inner = yield* WorkflowEngine;
    return {
      ...inner,
      postTicketMessage: (input) =>
        Effect.suspend(() =>
          postAlwaysFails
            ? Effect.fail(new WorkflowEventStoreError({ message: "poison-pill post failure" }))
            : inner.postTicketMessage(input),
        ),
      ingestExternalEvent: (input) =>
        Effect.suspend(() => {
          if (ingestAlwaysFails) {
            return Effect.fail(
              new WorkflowEventStoreError({ message: "poison-pill ingest failure" }),
            );
          }
          if (ingestFailureCount > 0) {
            ingestFailureCount -= 1;
            return Effect.fail(
              new WorkflowEventStoreError({ message: "transient ingest failure" }),
            );
          }
          return inner.ingestExternalEvent(input);
        }),
    } satisfies typeof inner;
  }),
).pipe(Layer.provide(WorkflowEngineLayer));

const baseEngine = WorkflowEngineLayer.pipe(
  Layer.provideMerge(WorkflowEventCommitterLive),
  Layer.provideMerge(
    Layer.succeed(ScriptCancelRegistry, {
      register: () => Effect.void,
      unregister: () => Effect.void,
      cancel: () => Effect.void,
    }),
  ),
  Layer.provideMerge(succeedingExecutor),
  Layer.provideMerge(ApprovalGateLive),
  Layer.provideMerge(BoardRegistryLive),
  Layer.provideMerge(PredicateEvaluatorLive),
  Layer.provideMerge(WorkflowRoutingContextBuilderLive),
  Layer.provideMerge(WorkflowBoardSaveLocksLive),
  Layer.provideMerge(DeterministicWorkflowIds),
  Layer.provideMerge(WorkflowFoundationLive),
  Layer.provideMerge(MigrationsLive),
  Layer.provideMerge(SqlitePersistenceMemory),
);

// Engine + persistence + gh stub all share one SqlClient (the in-memory DB),
// so the poller, the wrapped engine and the gh stub's side-effecting SQL all
// hit the same database.
const supportLayer = Layer.mergeAll(EngineWrapper, GitHubPortStub).pipe(
  Layer.provideMerge(baseEngine),
);

const pollerLayer = makeWorkflowGitHubPollerLive({
  sweepIntervalMs: 60_000,
  maxTicketsPerSweep: 20,
}).pipe(Layer.provideMerge(supportLayer));

const layer = it.layer(pollerLayer);

// --- helpers ----------------------------------------------------------------

const prBoard = {
  name: "pr-flow",
  lanes: [
    {
      key: "review",
      name: "Review",
      entry: "manual",
      onEvent: [
        { name: "ci.failed", to: "work" },
        { name: "pr.changes_requested", to: "work" },
        { name: "pr.merged", to: "done" },
        { name: "pr.closed", to: "done" },
      ],
    },
    {
      key: "work",
      name: "Work",
      entry: "manual",
      onEvent: [
        { name: "ci.failed", to: "work" },
        { name: "pr.changes_requested", to: "work" },
      ],
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const seedPrState = (
  sql: SqlClient.SqlClient,
  input: {
    ticketId: string;
    prNumber: number;
    lastHeadSha?: string | null;
    lastCiState?: string | null;
    lastReviewDecision?: string | null;
    lastCommentCursor?: string | null;
    prState?: string;
  },
) =>
  sql`
    INSERT INTO workflow_pr_state (
      ticket_id, pr_number, pr_url, branch, remote_name, repo,
      pr_state, last_head_sha, last_ci_state, last_review_decision,
      last_comment_cursor, updated_at
    ) VALUES (
      ${input.ticketId},
      ${input.prNumber},
      ${`https://github.com/acme/widgets/pull/${input.prNumber}`},
      ${`workflow/${input.ticketId}`},
      'origin',
      'acme/widgets',
      ${input.prState ?? "open"},
      ${input.lastHeadSha ?? null},
      ${input.lastCiState ?? null},
      ${input.lastReviewDecision ?? null},
      ${input.lastCommentCursor ?? null},
      '2026-06-12T00:00:00.000Z'
    )
  `;

const detail = (over: Partial<GitHubPrDetail>): GitHubPrDetail => ({
  number: over.number ?? 1,
  url: over.url ?? "https://github.com/acme/widgets/pull/1",
  state: over.state ?? "open",
  headSha: over.headSha ?? "sha1",
  reviewDecision: over.reviewDecision ?? "none",
  ciState: over.ciState ?? "pending",
});

interface ObservationRow {
  readonly dedupKey: string;
  readonly eventName: string;
  readonly status: string;
  readonly messageBody: string | null;
  readonly payloadJson: string;
  readonly attemptCount: number;
}

const observationsFor = (sql: SqlClient.SqlClient, ticketId: string) =>
  sql<ObservationRow>`
    SELECT
      dedup_key AS "dedupKey",
      event_name AS "eventName",
      status,
      message_body AS "messageBody",
      payload_json AS "payloadJson",
      attempt_count AS "attemptCount"
    FROM workflow_pr_observation
    WHERE ticket_id = ${ticketId}
    ORDER BY created_at ASC, observation_id ASC
  `;

// it.layer shares one in-memory DB across the suite. Clear the PR tables at the
// start of each test so sweep-wide totals (observedTickets / recordedObservations)
// reflect only this test's tickets.
const resetDb = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM workflow_pr_observation`;
    yield* sql`DELETE FROM workflow_pr_state`;
  });

const prStateFor = (sql: SqlClient.SqlClient, ticketId: string) =>
  sql<{
    readonly prState: string;
    readonly lastCiState: string | null;
    readonly lastReviewDecision: string | null;
    readonly lastCommentCursor: string | null;
    readonly lastHeadSha: string | null;
  }>`
    SELECT
      pr_state AS "prState",
      last_ci_state AS "lastCiState",
      last_review_decision AS "lastReviewDecision",
      last_comment_cursor AS "lastCommentCursor",
      last_head_sha AS "lastHeadSha"
    FROM workflow_pr_state
    WHERE ticket_id = ${ticketId}
  `.pipe(Effect.map((rows) => rows[0]));

layer("WorkflowGitHubPoller", (it) => {
  it.effect("1. ci pending -> failure: observation, message, ci.failed ingested, applied", () =>
    Effect.gen(function* () {
      resetScripts();
      const sql = yield* SqlClient.SqlClient;
      yield* resetDb(sql);
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const poller = yield* WorkflowGitHubPoller;

      yield* registry.register("b1" as never, prBoard);
      const ticketId = yield* engine.createTicket({
        boardId: "b1" as never,
        title: "PR ticket",
        initialLane: "review" as never,
      });
      yield* seedPrState(sql, {
        ticketId: ticketId as string,
        prNumber: 1,
        lastHeadSha: "sha1",
        lastCiState: "pending",
      });
      scriptPr(1, {
        details: [detail({ number: 1, headSha: "sha1", ciState: "failure" })],
        failingLogs: "boom: secret=ghp_" + "aaaaaaaaaaaaaaaaaaaaaaaa\nassertion failed",
      });

      const result = yield* poller.sweep();
      assert.equal(result.recordedObservations, 1);
      assert.equal(result.appliedObservations, 1);

      const obs = yield* observationsFor(sql, ticketId as string);
      assert.equal(obs.length, 1);
      assert.equal(obs[0]!.dedupKey, `ci:${ticketId as string}:sha1:failure`);
      assert.equal(obs[0]!.eventName, "ci.failed");
      assert.equal(obs[0]!.status, "applied");
      // message_body cleared after posting.
      assert.equal(obs[0]!.messageBody, null);
      // token redacted in the persisted payload summary.
      assert.isFalse(obs[0]!.payloadJson.includes("ghp_aaaa"));

      // Message posted to the discussion (redacted).
      const messages = yield* read.listTicketMessages(ticketId as never);
      assert.equal(messages.length, 1);
      assert.isTrue(messages[0]!.body.includes("[redacted]"));
      assert.isFalse(messages[0]!.body.includes("ghp_aaaa"));

      // ci.failed routed review -> work.
      const ticketDetail = yield* read.getTicketDetail(ticketId as never);
      assert.equal(ticketDetail?.ticket.currentLaneKey, "work");

      const state = yield* prStateFor(sql, ticketId as string);
      assert.equal(state?.lastCiState, "failure");
    }),
  );

  it.effect("2. same prDetail observed twice -> no second observation (dedup)", () =>
    Effect.gen(function* () {
      resetScripts();
      const sql = yield* SqlClient.SqlClient;
      yield* resetDb(sql);
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const poller = yield* WorkflowGitHubPoller;

      yield* registry.register("b2" as never, prBoard);
      const ticketId = yield* engine.createTicket({
        boardId: "b2" as never,
        title: "dedup",
        initialLane: "review" as never,
      });
      yield* seedPrState(sql, {
        ticketId: ticketId as string,
        prNumber: 2,
        lastHeadSha: "sha1",
        lastCiState: "pending",
      });
      scriptPr(2, {
        details: [detail({ number: 2, headSha: "sha1", ciState: "success" })],
      });

      const first = yield* poller.sweep();
      assert.equal(first.recordedObservations, 1);
      const second = yield* poller.sweep();
      assert.equal(second.recordedObservations, 0);

      const obs = yield* observationsFor(sql, ticketId as string);
      assert.equal(obs.length, 1);
      assert.equal(obs[0]!.dedupKey, `ci:${ticketId as string}:sha1:success`);
    }),
  );

  it.effect("3. new head sha after failure -> fresh ci:<sha2> fires again", () =>
    Effect.gen(function* () {
      resetScripts();
      const sql = yield* SqlClient.SqlClient;
      yield* resetDb(sql);
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const poller = yield* WorkflowGitHubPoller;

      yield* registry.register("b3" as never, prBoard);
      const ticketId = yield* engine.createTicket({
        boardId: "b3" as never,
        title: "newsha",
        initialLane: "review" as never,
      });
      yield* seedPrState(sql, {
        ticketId: ticketId as string,
        prNumber: 3,
        lastHeadSha: "sha1",
        lastCiState: "pending",
      });
      // First sweep: sha1 failure. Second sweep: sha2 failure.
      scriptPr(3, {
        details: [
          detail({ number: 3, headSha: "sha1", ciState: "failure" }),
          detail({ number: 3, headSha: "sha2", ciState: "failure" }),
        ],
        failingLogs: "still broken",
      });

      yield* poller.sweep();
      yield* poller.sweep();

      const obs = yield* observationsFor(sql, ticketId as string);
      const keys = obs.map((row) => row.dedupKey).sort();
      assert.deepEqual(keys, [
        `ci:${ticketId as string}:sha1:failure`,
        `ci:${ticketId as string}:sha2:failure`,
      ]);
    }),
  );

  it.effect("4. transient ingest failure stays pending, re-drives next sweep", () =>
    Effect.gen(function* () {
      resetScripts();
      const sql = yield* SqlClient.SqlClient;
      yield* resetDb(sql);
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const poller = yield* WorkflowGitHubPoller;

      yield* registry.register("b4" as never, prBoard);
      const ticketId = yield* engine.createTicket({
        boardId: "b4" as never,
        title: "retry",
        initialLane: "review" as never,
      });
      yield* seedPrState(sql, {
        ticketId: ticketId as string,
        prNumber: 4,
        lastHeadSha: "sha1",
        lastCiState: "pending",
      });
      scriptPr(4, {
        details: [detail({ number: 4, headSha: "sha1", ciState: "success" })],
      });

      // First ingest attempt fails transiently.
      ingestFailureCount = 1;
      const first = yield* poller.sweep();
      assert.equal(first.recordedObservations, 1);
      // Observation recorded but NOT applied (ingest failed, left pending).
      assert.equal(first.appliedObservations, 0);
      let obs = yield* observationsFor(sql, ticketId as string);
      assert.equal(obs[0]!.status, "pending");

      // Second sweep: observe is a no-op (dedup) but phase 2 re-drives pending.
      const second = yield* poller.sweep();
      assert.equal(second.recordedObservations, 0);
      assert.equal(second.appliedObservations, 1);
      obs = yield* observationsFor(sql, ticketId as string);
      assert.equal(obs[0]!.status, "applied");
    }),
  );

  it.effect("5. changes_requested with 2 feedback items -> 2 messages + 1 routing event", () =>
    Effect.gen(function* () {
      resetScripts();
      const sql = yield* SqlClient.SqlClient;
      yield* resetDb(sql);
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const poller = yield* WorkflowGitHubPoller;

      yield* registry.register("b5" as never, prBoard);
      const ticketId = yield* engine.createTicket({
        boardId: "b5" as never,
        title: "review",
        initialLane: "review" as never,
      });
      yield* seedPrState(sql, {
        ticketId: ticketId as string,
        prNumber: 5,
        lastHeadSha: "sha1",
        lastReviewDecision: "none",
      });
      scriptPr(5, {
        details: [
          detail({
            number: 5,
            headSha: "sha1",
            ciState: "pending",
            reviewDecision: "changes_requested",
          }),
        ],
        feedback: [
          {
            id: "c1",
            author: "alice",
            body: "fix this",
            submittedAt: "2026-06-12T01:00:00.000Z",
          },
          {
            id: "c2",
            author: "bob",
            body: "and that",
            submittedAt: "2026-06-12T02:00:00.000Z",
          },
        ],
      });

      const result = yield* poller.sweep();
      // 2 comment observations (with body) + 1 routing observation.
      assert.equal(result.recordedObservations, 3);

      const obs = yield* observationsFor(sql, ticketId as string);
      const keys = obs.map((row) => row.dedupKey).sort();
      assert.deepEqual(keys, [
        `comment:${ticketId as string}:c1`,
        `comment:${ticketId as string}:c2`,
        // Routing key now carries the newest feedback id so a later round on the
        // same head re-fires (and a quiet re-poll is deduped).
        `review:${ticketId as string}:sha1:changes_requested:c2`,
      ]);
      const withBody = obs.filter((row) => row.eventName === "pr.changes_requested");
      assert.equal(withBody.length, 3);

      // 2 messages posted.
      const messages = yield* read.listTicketMessages(ticketId as never);
      assert.equal(messages.length, 2);
      assert.isTrue(messages.some((m) => m.body.includes("**@alice**")));
      assert.isTrue(messages.some((m) => m.body.includes("**@bob**")));

      // Cursor advanced to newest feedback.
      const state = yield* prStateFor(sql, ticketId as string);
      assert.equal(state?.lastCommentCursor, "2026-06-12T02:00:00.000Z");
      assert.equal(state?.lastReviewDecision, "changes_requested");

      // Routed to work.
      const ticketDetail = yield* read.getTicketDetail(ticketId as never);
      assert.equal(ticketDetail?.ticket.currentLaneKey, "work");

      // Re-sweep adds nothing (same detail, cursor caught up).
      scriptPr(5, {
        details: [
          detail({
            number: 5,
            headSha: "sha1",
            ciState: "pending",
            reviewDecision: "changes_requested",
          }),
        ],
        feedback: [
          {
            id: "c1",
            author: "alice",
            body: "fix this",
            submittedAt: "2026-06-12T01:00:00.000Z",
          },
          {
            id: "c2",
            author: "bob",
            body: "and that",
            submittedAt: "2026-06-12T02:00:00.000Z",
          },
        ],
      });
      const reSweep = yield* poller.sweep();
      assert.equal(reSweep.recordedObservations, 0);
    }),
  );

  it.effect(
    "5b. a later changes_requested round on the same head re-fires + surfaces new feedback (H3)",
    () =>
      Effect.gen(function* () {
        resetScripts();
        const sql = yield* SqlClient.SqlClient;
        yield* resetDb(sql);
        const registry = yield* BoardRegistry;
        const engine = yield* WorkflowEngine;
        const read = yield* WorkflowReadModel;
        const poller = yield* WorkflowGitHubPoller;

        yield* registry.register("b5b" as never, prBoard);
        const ticketId = yield* engine.createTicket({
          boardId: "b5b" as never,
          title: "review",
          initialLane: "review" as never,
        });
        yield* seedPrState(sql, {
          ticketId: ticketId as string,
          prNumber: 55,
          lastHeadSha: "sha1",
          lastReviewDecision: "none",
        });
        // Shared array we grow between sweeps to simulate a SECOND review round
        // arriving on the same head WITHOUT GitHub's reviewDecision flipping (it
        // stays CHANGES_REQUESTED). Pre-fix this round was silently dropped.
        const feedback: GitHubReviewItem[] = [
          { id: "r1", author: "alice", body: "round one", submittedAt: "2026-06-12T01:00:00.000Z" },
        ];
        scriptPr(55, {
          details: [
            detail({
              number: 55,
              headSha: "sha1",
              ciState: "pending",
              reviewDecision: "changes_requested",
            }),
            detail({
              number: 55,
              headSha: "sha1",
              ciState: "pending",
              reviewDecision: "changes_requested",
            }),
          ],
          feedback,
        });

        yield* poller.sweep(); // round 1: records r1 + routing key ...:r1

        feedback.push({
          id: "r2",
          author: "bob",
          body: "round two",
          submittedAt: "2026-06-12T03:00:00.000Z",
        });

        const second = yield* poller.sweep();
        // r2 comment + a NEW routing event keyed by the newest feedback id.
        assert.equal(second.recordedObservations, 2);

        const keys = new Set(
          (yield* observationsFor(sql, ticketId as string)).map((row) => row.dedupKey),
        );
        assert.isTrue(keys.has(`comment:${ticketId as string}:r2`));
        assert.isTrue(keys.has(`review:${ticketId as string}:sha1:changes_requested:r2`));

        const messages = yield* read.listTicketMessages(ticketId as never);
        assert.isTrue(messages.some((m) => m.body.includes("round two")));
      }),
  );

  it.effect("6. merged -> pr.merged ingested, pr_state merged, not scanned next sweep", () =>
    Effect.gen(function* () {
      resetScripts();
      const sql = yield* SqlClient.SqlClient;
      yield* resetDb(sql);
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const poller = yield* WorkflowGitHubPoller;

      yield* registry.register("b6" as never, prBoard);
      const ticketId = yield* engine.createTicket({
        boardId: "b6" as never,
        title: "merge",
        initialLane: "review" as never,
      });
      yield* seedPrState(sql, {
        ticketId: ticketId as string,
        prNumber: 6,
        lastHeadSha: "sha1",
        lastCiState: "success",
        lastReviewDecision: "approved",
      });
      scriptPr(6, {
        details: [
          detail({
            number: 6,
            headSha: "sha1",
            ciState: "success",
            reviewDecision: "approved",
            state: "merged",
          }),
        ],
      });

      const result = yield* poller.sweep();
      assert.equal(result.observedTickets, 1);

      const obs = yield* observationsFor(sql, ticketId as string);
      assert.equal(obs.length, 1);
      assert.equal(obs[0]!.dedupKey, `lifecycle:${ticketId as string}:merged`);
      assert.equal(obs[0]!.eventName, "pr.merged");
      assert.equal(obs[0]!.status, "applied");

      const state = yield* prStateFor(sql, ticketId as string);
      assert.equal(state?.prState, "merged");

      // Next sweep: ticket no longer watched (pr_state != open).
      const second = yield* poller.sweep();
      assert.equal(second.observedTickets, 0);
    }),
  );

  it.effect("7. ticket deleted between observe and phase 1 -> recheck skips, no rows", () =>
    Effect.gen(function* () {
      resetScripts();
      const sql = yield* SqlClient.SqlClient;
      yield* resetDb(sql);
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const poller = yield* WorkflowGitHubPoller;

      yield* registry.register("b7" as never, prBoard);
      const ticketId = yield* engine.createTicket({
        boardId: "b7" as never,
        title: "deleted",
        initialLane: "review" as never,
      });
      yield* seedPrState(sql, {
        ticketId: ticketId as string,
        prNumber: 7,
        lastHeadSha: "sha1",
        lastCiState: "pending",
      });
      // The ticket IS in the watched set when observe selects it. prDetail
      // returns failure, so observe calls failingCheckLogs — we hook that call
      // to delete the pr_state row, simulating a concurrent retention/board
      // delete landing AFTER the watched-select but BEFORE phase 1's
      // in-transaction recheck. The recheck must then find no open row and write
      // nothing — even though observe produced an observation in memory.
      scriptPr(7, {
        details: [detail({ number: 7, headSha: "sha1", ciState: "failure" })],
        failingLogs: "boom",
        onFailingCheckLogs: (s) =>
          s`DELETE FROM workflow_pr_state WHERE ticket_id = ${ticketId as string}`.pipe(
            Effect.asVoid,
            Effect.orDie,
          ),
      });

      const result = yield* poller.sweep();
      // Observe selected + ran (1), but the in-tx recheck found the row gone and
      // wrote nothing.
      assert.equal(result.observedTickets, 1);
      assert.equal(result.recordedObservations, 0);
      const obs = yield* observationsFor(sql, ticketId as string);
      assert.equal(obs.length, 0);
    }),
  );

  it.effect("8. gh error during observe -> sweep logs + continues, fiber survives", () =>
    Effect.gen(function* () {
      resetScripts();
      const sql = yield* SqlClient.SqlClient;
      yield* resetDb(sql);
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const poller = yield* WorkflowGitHubPoller;

      yield* registry.register("b8" as never, prBoard);
      const failTicket = yield* engine.createTicket({
        boardId: "b8" as never,
        title: "fail",
        initialLane: "review" as never,
      });
      const okTicket = yield* engine.createTicket({
        boardId: "b8" as never,
        title: "ok",
        initialLane: "review" as never,
      });
      yield* seedPrState(sql, {
        ticketId: failTicket as string,
        prNumber: 81,
        lastHeadSha: "sha1",
        lastCiState: "pending",
      });
      yield* seedPrState(sql, {
        ticketId: okTicket as string,
        prNumber: 82,
        lastHeadSha: "sha1",
        lastCiState: "pending",
      });
      scriptPr(81, { failPrDetail: true });
      scriptPr(82, {
        details: [detail({ number: 82, headSha: "sha1", ciState: "success" })],
      });

      // sweep() returns without throwing.
      const result = yield* poller.sweep();
      assert.equal(result.observedTickets, 2);
      assert.equal(result.failedTickets, 1);
      // The healthy ticket still got its observation + ingest.
      assert.equal(result.recordedObservations, 1);

      const okObs = yield* observationsFor(sql, okTicket as string);
      assert.equal(okObs.length, 1);
      assert.equal(okObs[0]!.dedupKey, `ci:${okTicket as string}:sha1:success`);

      const failObs = yield* observationsFor(sql, failTicket as string);
      assert.equal(failObs.length, 0);
    }),
  );

  it.effect("9. two tickets on one board both merge -> distinct lifecycle obs + both ingest", () =>
    Effect.gen(function* () {
      resetScripts();
      const sql = yield* SqlClient.SqlClient;
      yield* resetDb(sql);
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const poller = yield* WorkflowGitHubPoller;

      yield* registry.register("b9" as never, prBoard);
      const ticketA = yield* engine.createTicket({
        boardId: "b9" as never,
        title: "A",
        initialLane: "review" as never,
      });
      const ticketB = yield* engine.createTicket({
        boardId: "b9" as never,
        title: "B",
        initialLane: "review" as never,
      });
      yield* seedPrState(sql, {
        ticketId: ticketA as string,
        prNumber: 91,
        lastHeadSha: "sha1",
      });
      yield* seedPrState(sql, {
        ticketId: ticketB as string,
        prNumber: 92,
        lastHeadSha: "sha1",
      });
      // Both PRs reach merged. Bare `lifecycle:merged` keys would collide on the
      // table-wide UNIQUE dedup_key, dropping B's observation while still
      // flipping B's pr_state to merged — stranding B. Per-ticket keys avoid it.
      scriptPr(91, { details: [detail({ number: 91, headSha: "sha1", state: "merged" })] });
      scriptPr(92, { details: [detail({ number: 92, headSha: "sha1", state: "merged" })] });

      const result = yield* poller.sweep();
      assert.equal(result.recordedObservations, 2);

      const obsA = yield* observationsFor(sql, ticketA as string);
      const obsB = yield* observationsFor(sql, ticketB as string);
      assert.equal(obsA.length, 1);
      assert.equal(obsB.length, 1);
      assert.equal(obsA[0]!.dedupKey, `lifecycle:${ticketA as string}:merged`);
      assert.equal(obsB[0]!.dedupKey, `lifecycle:${ticketB as string}:merged`);
      // BOTH pr.merged events ingested (the bug dropped B's).
      assert.equal(obsA[0]!.status, "applied");
      assert.equal(obsB[0]!.status, "applied");

      const detailA = yield* read.getTicketDetail(ticketA as never);
      const detailB = yield* read.getTicketDetail(ticketB as never);
      assert.equal(detailA?.ticket.currentLaneKey, "done");
      assert.equal(detailB?.ticket.currentLaneKey, "done");
    }),
  );

  it.effect("10. poison-pill ingest: retried up to 5 times then marked failed", () =>
    Effect.gen(function* () {
      resetScripts();
      const sql = yield* SqlClient.SqlClient;
      yield* resetDb(sql);
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const poller = yield* WorkflowGitHubPoller;

      yield* registry.register("b10" as never, prBoard);
      const ticketId = yield* engine.createTicket({
        boardId: "b10" as never,
        title: "poison",
        initialLane: "review" as never,
      });
      yield* seedPrState(sql, {
        ticketId: ticketId as string,
        prNumber: 10,
        lastHeadSha: "sha1",
        lastCiState: "pending",
      });
      scriptPr(10, {
        details: [detail({ number: 10, headSha: "sha1", ciState: "success" })],
      });

      // Ingest always fails with a non-terminal, non-transient error.
      ingestAlwaysFails = true;

      // Sweep 1 records the observation; ingest fails -> attempt_count = 1, pending.
      const first = yield* poller.sweep();
      assert.equal(first.recordedObservations, 1);
      assert.equal(first.appliedObservations, 0);
      let obs = yield* observationsFor(sql, ticketId as string);
      assert.equal(obs[0]!.status, "pending");
      assert.equal(obs[0]!.attemptCount, 1);

      // Sweeps 2..4: still pending, attempt_count climbs (no new observation).
      for (let i = 2; i <= 4; i += 1) {
        yield* poller.sweep();
        obs = yield* observationsFor(sql, ticketId as string);
        assert.equal(obs[0]!.status, "pending");
        assert.equal(obs[0]!.attemptCount, i);
      }

      // Sweep 5: 5th failed attempt hits the ceiling -> marked 'failed'.
      yield* poller.sweep();
      obs = yield* observationsFor(sql, ticketId as string);
      assert.equal(obs[0]!.status, "failed");
      assert.equal(obs[0]!.attemptCount, 5);

      // Sweep 6: 'failed' is no longer drained -> attempt_count frozen at 5.
      const sixth = yield* poller.sweep();
      assert.equal(sixth.appliedObservations, 0);
      obs = yield* observationsFor(sql, ticketId as string);
      assert.equal(obs[0]!.status, "failed");
      assert.equal(obs[0]!.attemptCount, 5);
    }),
  );

  it.effect("11. oversized redacted message body posts (capped <= body limit, no throw)", () =>
    Effect.gen(function* () {
      resetScripts();
      const sql = yield* SqlClient.SqlClient;
      yield* resetDb(sql);
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const poller = yield* WorkflowGitHubPoller;

      yield* registry.register("b11" as never, prBoard);
      const ticketId = yield* engine.createTicket({
        boardId: "b11" as never,
        title: "huge log",
        initialLane: "review" as never,
      });
      yield* seedPrState(sql, {
        ticketId: ticketId as string,
        prNumber: 11,
        lastHeadSha: "sha1",
        lastCiState: "pending",
      });
      // A failing-check log far larger than the ticket body limit. redactAndCap
      // (truncateKeepingTail with the marker INCLUDED in the budget) must bring
      // it under MAX_TICKET_MESSAGE_BODY_LENGTH so postTicketMessage accepts it.
      scriptPr(11, {
        details: [detail({ number: 11, headSha: "sha1", ciState: "failure" })],
        failingLogs: "x".repeat(MAX_TICKET_MESSAGE_BODY_LENGTH * 3),
      });

      const result = yield* poller.sweep();
      // Recorded AND applied — the post did not throw, the event ingested.
      assert.equal(result.recordedObservations, 1);
      assert.equal(result.appliedObservations, 1);

      const obs = yield* observationsFor(sql, ticketId as string);
      assert.equal(obs[0]!.status, "applied");
      assert.equal(obs[0]!.attemptCount, 0);

      // The message landed in the discussion and fits under the body limit.
      const messages = yield* read.listTicketMessages(ticketId as never);
      assert.equal(messages.length, 1);
      assert.isTrue(messages[0]!.body.length <= MAX_TICKET_MESSAGE_BODY_LENGTH);
      assert.isTrue(messages[0]!.body.startsWith("…[truncated]\n"));

      // Routed review -> work via ci.failed.
      const ticketDetail = yield* read.getTicketDetail(ticketId as never);
      assert.equal(ticketDetail?.ticket.currentLaneKey, "work");
    }),
  );

  it.effect("12. poison-pill post: persistently-failing post retried to ceiling then failed", () =>
    Effect.gen(function* () {
      resetScripts();
      const sql = yield* SqlClient.SqlClient;
      yield* resetDb(sql);
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const poller = yield* WorkflowGitHubPoller;

      yield* registry.register("b12" as never, prBoard);
      const ticketId = yield* engine.createTicket({
        boardId: "b12" as never,
        title: "bad post",
        initialLane: "review" as never,
      });
      yield* seedPrState(sql, {
        ticketId: ticketId as string,
        prNumber: 12,
        lastHeadSha: "sha1",
        lastCiState: "pending",
      });
      // ci.failed carries a message body, so phase 2 hits postTicketMessage.
      scriptPr(12, {
        details: [detail({ number: 12, headSha: "sha1", ciState: "failure" })],
        failingLogs: "boom",
      });

      // Every post attempt fails (non-terminal). It must count toward the
      // ceiling, not retry forever.
      postAlwaysFails = true;

      // Sweep 1: observation recorded; post fails -> attempt_count = 1, pending.
      const first = yield* poller.sweep();
      assert.equal(first.recordedObservations, 1);
      assert.equal(first.appliedObservations, 0);
      let obs = yield* observationsFor(sql, ticketId as string);
      assert.equal(obs[0]!.status, "pending");
      assert.equal(obs[0]!.attemptCount, 1);
      // message_body NOT cleared (post never succeeded) so the message is still
      // pending delivery.
      assert.isNotNull(obs[0]!.messageBody);

      // Sweeps 2..4: still pending, attempt_count climbs.
      for (let i = 2; i <= 4; i += 1) {
        yield* poller.sweep();
        obs = yield* observationsFor(sql, ticketId as string);
        assert.equal(obs[0]!.status, "pending");
        assert.equal(obs[0]!.attemptCount, i);
      }

      // Sweep 5: 5th failed post hits the ceiling -> marked 'failed'.
      yield* poller.sweep();
      obs = yield* observationsFor(sql, ticketId as string);
      assert.equal(obs[0]!.status, "failed");
      assert.equal(obs[0]!.attemptCount, 5);

      // No message was ever delivered, and a failed row is not re-attempted.
      const messages = yield* read.listTicketMessages(ticketId as never);
      assert.equal(messages.length, 0);
      const sixth = yield* poller.sweep();
      assert.equal(sixth.appliedObservations, 0);
      obs = yield* observationsFor(sql, ticketId as string);
      assert.equal(obs[0]!.attemptCount, 5);
    }),
  );
});
