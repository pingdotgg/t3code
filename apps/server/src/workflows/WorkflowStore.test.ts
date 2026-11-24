import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import type * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import WorkflowsMigration from "../persistence/Migrations/110_Workflows.ts";
import * as MilestoneHub from "../milestones/MilestoneHub.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

const withStore = <A, E>(
  use: Effect.Effect<A, E, WorkflowStore.WorkflowStore | MilestoneHub.MilestoneHub>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-store-" });
    const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
    const migrated = Layer.effectDiscard(WorkflowsMigration);
    return yield* Effect.provide(
      use,
      WorkflowStore.layer.pipe(
        Layer.provideMerge(Layer.merge(migrated, MilestoneHub.layer)),
        Layer.provide(database),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

it.effect("a run still waits while one of the things it started side by side is out", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      yield* store.runStarted({
        runId: "r1",
        workflow: "duo",
        version: 1,
        engineTag: "duo@1",
        idempotencyKey: "k",
        input: {},
      });
      // Started again under its key: nothing changed, so nobody is told.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const told = yield* PubSub.subscribe(store.changes);
          yield* store.runStarted({
            runId: "r1",
            workflow: "duo",
            version: 1,
            engineTag: "duo@1",
            idempotencyKey: "k",
            input: {},
          });
          assert.equal(yield* PubSub.remaining(told), 0);
        }),
      );
      const now = Effect.map(store.run("r1"), (run) => [run?.status, run?.detail]);
      yield* store.stepStarted("r1", "left", "agent");
      yield* store.stepStarted("r1", "right", "agent");
      yield* store.stepStarted("r1", "approve", "ask");
      yield* store.runStatus("r1", "waiting", "agent left");

      yield* store.stepEnded("r1", "left", "completed", null);
      yield* store.runResumed("r1");
      assert.deepStrictEqual(yield* now, ["waiting", "agent right"]);

      yield* store.stepEnded("r1", "right", "completed", null);
      yield* store.runResumed("r1");
      assert.deepStrictEqual(yield* now, ["waiting", "approve"]);

      yield* store.stepEnded("r1", "approve", "completed", null);
      yield* store.runResumed("r1");
      assert.deepStrictEqual(yield* now, ["running", null]);

      // One of them failed and paused the run: the others ending do not take that back.
      yield* store.stepStarted("r1", "again", "agent");
      yield* store.stepStarted("r1", "beside", "agent");
      yield* store.stepStarted("r1", "later", "wait");
      yield* store.runPaused("r1", "again gave up", true);
      yield* store.stepEnded("r1", "beside", "completed", null);
      yield* store.runResumed("r1");
      yield* store.runStatus("r1", "waiting", "later");
      const paused = yield* store.run("r1");
      assert.deepStrictEqual(
        [paused?.status, paused?.detail, Number(paused?.pauses), Number(paused?.held)],
        ["paused", "again gave up", 1, 1],
      );
      // The sweep's resume is for the pause it read, not for one that came after it.
      assert.isTrue(yield* store.runUnpaused("r1"));
      yield* store.runPaused("r1", "gave up again");
      assert.isFalse(
        yield* store.runUnpaused("r1", { pauses: 1, updatedAt: paused?.updated_at ?? "" }),
      );
      assert.equal((yield* store.run("r1"))?.status, "paused");
    }),
  ),
);

it.effect("a key is taken by the first run started under it, whatever its version", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      for (const version of [1, 2]) {
        yield* store.runStarted({
          runId: `r${version}`,
          workflow: "fix",
          version,
          engineTag: `fix@${version}`,
          idempotencyKey: "k",
          input: {},
        });
      }
      assert.isUndefined(yield* store.run("r2"));
      assert.equal((yield* store.runByKey("fix", "k"))?.run_id, "r1");
    }),
  ),
);

it.effect("lists of runs leave out what each run was started with", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const input = { payload: "x".repeat(20_000) };
      yield* store.runStarted({
        runId: "r1",
        workflow: "intake",
        version: 1,
        engineTag: "intake@1",
        idempotencyKey: "k",
        input,
      });
      const listed = [
        ...(yield* store.runs(undefined)),
        ...(yield* store.runs("running")),
        ...(yield* store.runsWhere({ workflow: "intake" })),
      ];
      assert.deepStrictEqual(
        listed.map((row) => [row.run_id, "input_json" in row]),
        [
          ["r1", false],
          ["r1", false],
          ["r1", false],
        ],
      );
      const one = yield* store.run("r1");
      assert.deepStrictEqual(
        one?.input_json === null || one?.input_json === undefined
          ? undefined
          : WorkflowStore.jsonValue(one.input_json),
        input,
      );
    }),
  ),
);

it.effect("keeps each thing a run touched once, with what the latest touch knew", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const issue = { kind: "issue", key: "i1", address: { scope: "me/app", key: "1" } };
      yield* store.referenceNoted("r1", null, {
        ...issue,
        title: "Crash",
        url: "https://x/1",
        state: "open",
      });
      yield* store.referenceNoted("r1", "triage", { ...issue, title: "" });
      // A kind the engine has never heard of comes back as it went in.
      const machine = { kind: "machine", key: "m1", address: { id: [1, 2] }, title: "box" };
      yield* store.referenceNoted("r1", "make", machine);
      yield* store.referenceNoted("r1", "fix", {
        ...issue,
        title: "Crash at noon",
        state: "closed",
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const told = yield* PubSub.subscribe(store.changes);
          // Seen again by a step that already touched it, with nothing new: nobody is told.
          yield* store.referenceNoted("r1", "triage", { ...issue, title: "" });
          assert.equal(yield* PubSub.remaining(told), 0);
        }),
      );
      assert.deepStrictEqual(yield* store.references("r1"), [
        {
          ...issue,
          title: "Crash at noon",
          url: "https://x/1",
          state: "closed",
          steps: ["triage", "fix"],
          origin: "trigger",
        },
        { ...machine, url: null, state: null, steps: ["make"], origin: "step" },
      ]);
      assert.deepStrictEqual(yield* store.references("r2"), []);
    }),
  ),
);

it.effect("counts what waits on a person, and finds the run's latest agent thread", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const start = (runId: string) =>
        store.runStarted({
          runId,
          workflow: "fix",
          version: 1,
          engineTag: "fix@1",
          idempotencyKey: runId,
          input: {},
        });
      assert.deepStrictEqual(yield* store.counts, { needsYou: 0, active: 0, total: 0 });
      yield* Effect.forEach(["r1", "r2", "r3"], start);
      yield* store.runPaused("r1", "the build failed");
      assert.isTrue(yield* store.runEnded("r3", "completed", null, null));
      // A second ending, such as a cancel that lost the race, is not recorded and says so.
      assert.isFalse(yield* store.runEnded("r3", "cancelled", "late", null));
      assert.equal((yield* store.run("r3"))?.status, "completed");
      // Every run still going, with no list limit: the guard on dropping a version reads this.
      assert.equal((yield* store.unfinished).length, 2);
      yield* store.waitOpened({
        runId: "r2",
        name: "merge",
        workflow: "fix",
        key: undefined,
        token: "t",
        schemaJson: "{}",
        requestJson: '{"title":"Merge?"}',
        watchJson: null,
        deadline: null,
      });
      // A paused run and an open question each wait on someone; a plain wait does not.
      yield* store.waitOpened({
        runId: "r2",
        name: "ci",
        workflow: "fix",
        key: undefined,
        token: "u",
        schemaJson: "{}",
        requestJson: null,
        watchJson: null,
        deadline: null,
      });
      assert.deepStrictEqual(yield* store.counts, { needsYou: 2, active: 2, total: 3 });

      assert.isNull(yield* store.latestThread("r2"));
      yield* store.stepStarted("r2", "write", "agent");
      yield* store.stepThread("r2", "write", "thread-1", null, "turn-1");
      yield* store.stepStarted("r2", "review", "agent");
      yield* store.stepThread("r2", "review", "thread-2", "env-b", "turn-2");
      assert.deepStrictEqual(yield* store.latestThread("r2"), {
        threadId: "thread-2",
        environmentId: "env-b",
      });
    }),
  ),
);

it.effect("a long step result is cut without leaving half an emoji", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      yield* store.stepStarted("r1", "write", "step");
      yield* store.stepResult("r1", "write", `${"a".repeat(7_998)}\u{1F680}tail`);
      const [step] = yield* store.steps("r1");
      // The cut is of the JSON text, which opens with a quote.
      assert.equal(WorkflowStore.jsonValue(step?.result_json ?? "null"), `"${"a".repeat(7_998)}…`);
    }),
  ),
);

it.effect("what a long agent step said is cut without leaving half an emoji", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      yield* store.stepStarted("r1", "write", "agent");
      yield* store.stepResult("r1", "write", null, `${"a".repeat(7_999)}\u{1F680}tail`);
      const [step] = yield* store.steps("r1");
      assert.equal(step?.said, `${"a".repeat(7_999)}…`);
    }),
  ),
);

it.effect("a long failure detail is cut without leaving half an emoji", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      yield* store.runStarted({
        runId: "r1",
        workflow: "fail",
        version: 1,
        engineTag: "fail@1",
        idempotencyKey: "k",
        input: {},
      });
      yield* store.stepStarted("r1", "work", "step");
      const detail = `${"a".repeat(1_999)}\u{1F680}tail`;
      yield* store.stepEnded("r1", "work", "failed", detail);
      yield* store.runPaused("r1", detail);
      const [step] = yield* store.steps("r1");
      const run = yield* store.run("r1");
      assert.equal(step?.detail, "a".repeat(1_999));
      assert.equal(run?.detail, "a".repeat(1_999));
    }),
  ),
);

it.effect("a long run title is cut without leaving half an emoji", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      yield* store.runStarted({
        runId: "r1",
        workflow: "titled",
        version: 1,
        engineTag: "titled@1",
        idempotencyKey: "k",
        input: {},
      });
      yield* store.runTitle("r1", `${"a".repeat(199)}\u{1F680}tail`);
      const run = yield* store.run("r1");
      assert.equal(run?.title, "a".repeat(199));
    }),
  ),
);

it.effect("one buffered signal goes to one wait, and a claimed wait keeps what woke it", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const open = (runId: string) =>
        Effect.andThen(
          store.runStarted({
            runId,
            workflow: "gate",
            version: 1,
            engineTag: "gate@1",
            idempotencyKey: runId,
            input: {},
          }),
          store.waitOpened({
            runId,
            name: "go",
            workflow: "gate",
            key: "ready",
            token: `token-${runId}`,
            schemaJson: "{}",
            requestJson: null,
            watchJson: null,
            deadline: null,
          }),
        );
      yield* open("r1");
      yield* open("r2");
      // The parts of an address are kept apart: this one is for another workflow's other key.
      yield* store.mailPut({
        signalId: "other",
        address: { workflow: "gate:ready", channel: "x" },
        valueJson: "1",
        expiresAt: "2999-01-01T00:00:00.000Z",
      });
      assert.isUndefined(yield* store.mailNext([{ workflow: "gate", channel: "ready:x" }]));

      yield* store.mailPut({
        signalId: "s1",
        address: { workflow: "gate", channel: "ready" },
        valueJson: '"yes"',
        expiresAt: "2999-01-01T00:00:00.000Z",
      });
      const woke = { expired: false, value: "yes" };
      assert.equal(yield* store.mailDeliver("s1", "r1", "go", woke), "delivered");
      // The second wait finds the signal gone and stays open for the next one.
      assert.equal(yield* store.mailDeliver("s1", "r2", "go", woke), "gone");
      assert.isDefined(yield* store.waitAt({ runId: "r2", wait: "go" }));
      assert.isTrue(yield* store.signalSeen("s1"));
      // Nor can the id, sent again straight to that wait, claim it: one id wakes one wait.
      assert.isFalse(yield* store.waitSignalled("r2", "go", woke, "s1"));
      assert.isDefined(yield* store.waitAt({ runId: "r2", wait: "go" }));
      // And a kept copy of an id that already woke a wait straight wakes none: the two sends of a
      // retry that overlapped, one buffered and one delivered.
      yield* store.mailPut({
        signalId: "s1",
        address: { workflow: "gate", channel: "ready" },
        valueJson: '"yes"',
        expiresAt: "2999-01-01T00:00:00.000Z",
      });
      assert.equal(yield* store.mailDeliver("s1", "r2", "go", woke), "gone");
      assert.isDefined(yield* store.waitAt({ runId: "r2", wait: "go" }));
      // It is dropped, so a wait looking through its mail is not handed it again.
      assert.isUndefined(yield* store.mailNext([{ workflow: "gate", channel: "ready" }]));
      // A wait that is already claimed takes no second wake.
      assert.equal(yield* store.mailDeliver("other", "r1", "go", woke), "claimed");

      // Its wake is redone once the claim has gone unanswered for a while.
      assert.deepStrictEqual(yield* store.waitsToWake, []);
      yield* TestClock.adjust("1 minute");
      const again = yield* store.waitsToWake;
      assert.deepStrictEqual(
        again.map((wait) => [wait.run_id, wait.woke_json]),
        [["r1", JSON.stringify(woke)]],
      );

      // An id is remembered as long as its signal could have been kept, so a sender's retry
      // within a long time to live is still the same signal.
      yield* open("r3");
      yield* store.mailPut({
        signalId: "long",
        address: { runId: "r3", wait: "go" },
        valueJson: '"yes"',
        expiresAt: "1970-01-31T00:00:00.000Z",
      });
      assert.equal(yield* store.mailDeliver("long", "r3", "go", woke), "delivered");
      yield* TestClock.adjust("10 days");
      yield* store.mailExpire;
      assert.isTrue(yield* store.signalSeen("long"));
    }),
  ),
);

it.effect("tells the milestone hub of each run and question transition once", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const hub = yield* MilestoneHub.MilestoneHub;
      const start = {
        runId: "r1",
        workflow: "review",
        version: 1,
        engineTag: "review@1",
        idempotencyKey: "k",
        input: {},
      };
      const ask = (name: string, request: Schema.Json) =>
        store.waitOpened({
          runId: "r1",
          name,
          workflow: "review",
          key: undefined,
          token: `token-${name}`,
          schemaJson: "{}",
          requestJson: WorkflowStore.jsonText(request),
          watchJson: null,
          deadline: null,
        });
      yield* store.runStarted(start);
      yield* store.runStarted(start);
      yield* ask("approve", { title: "Ship it?" });
      yield* ask("approve", { title: "Ship it?" });
      // A wait nobody is asked is no question.
      yield* store.waitOpened({
        runId: "r1",
        name: "checks",
        workflow: "review",
        key: undefined,
        token: "token-checks",
        schemaJson: "{}",
        requestJson: null,
        watchJson: null,
        deadline: null,
      });
      yield* store.waitSignalled("r1", "approve", { expired: false, value: true });
      yield* store.waitSignalled("r1", "approve", { expired: false, value: false });
      yield* store.waitSignalled("r1", "checks", { expired: false, value: null });
      yield* ask("later", {});
      yield* store.waitSignalled("r1", "later", { expired: true, value: null });
      yield* ask("last", { title: "Anything else?" });
      yield* store.runPaused("r1", "agent failed");
      yield* store.runPaused("r1", "agent failed again");
      yield* store.runUnpaused("r1");
      yield* store.runUnpaused("r1");
      // A run another run invoked is muted unless asked for, as a subagent's thread is.
      yield* store.runStarted({
        ...start,
        runId: "r2",
        idempotencyKey: "child",
        parent: { runId: "r1", wait: "child" },
      });
      yield* store.runEnded("r1", "cancelled", "stopped by a person", null);
      yield* store.runEnded("r1", "completed", null, null);

      assert.notInclude(
        (yield* hub.recent()).events.map((event) => event.workflowRunId),
        "r2",
      );
      const { events } = yield* hub.recent({ filter: { includeSubagentChildren: true } });
      assert.deepStrictEqual(
        events.map((event): unknown => {
          const { id: _id, occurredAt: _at, ...rest } = event;
          return rest;
        }),
        [
          { type: "workflow.run_started" },
          { type: "workflow.needs_input", step: "approve", question: "Ship it?" },
          { type: "workflow.input_resolved", step: "approve", resolution: "answered" },
          { type: "workflow.needs_input", step: "later", question: "later" },
          { type: "workflow.input_resolved", step: "later", resolution: "expired" },
          { type: "workflow.needs_input", step: "last", question: "Anything else?" },
          { type: "workflow.run_paused", reason: "agent failed" },
          { type: "workflow.run_resumed" },
          {
            type: "workflow.run_started",
            isSubagentChild: true,
            workflowRunId: "r2",
            runTitle: "review child",
            parentWorkflowRunId: "r1",
          },
          { type: "workflow.input_resolved", step: "last", resolution: "cancelled" },
          { type: "workflow.run_ended", outcome: "cancelled", detail: "stopped by a person" },
        ].map((news) => ({
          projectId: null,
          threadId: null,
          parentThreadId: null,
          actor: { type: "system" },
          isSubagentChild: false,
          workflowRunId: "r1",
          workflow: "review",
          runTitle: "review k",
          parentWorkflowRunId: null,
          ...news,
        })),
      );
    }),
  ),
);
