import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";

import WorkflowsMigration from "../persistence/Migrations/110_Workflows.ts";
import WorkflowSkippedRunsMigration from "../persistence/Migrations/113_WorkflowSkippedRuns.ts";
import WorkflowRunIndexesMigration from "../persistence/Migrations/114_WorkflowRunIndexes.ts";
import WorkflowRunTagsMigration from "../persistence/Migrations/115_WorkflowRunTags.ts";
import WorkflowMailSenderMigration from "../persistence/Migrations/117_WorkflowMailSender.ts";
import WorkflowPoolsMigration from "../persistence/Migrations/118_WorkflowPools.ts";
import * as MilestoneHub from "../milestones/MilestoneHub.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

const sender = { answeredBy: "t3 CLI", answeredAt: "2026-01-01T00:00:00.000Z" };

const withStore = <A, E>(
  use: Effect.Effect<
    A,
    E,
    WorkflowStore.WorkflowStore | MilestoneHub.MilestoneHub | SqlClient.SqlClient
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-store-" });
    const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
    const migrated = Layer.effectDiscard(
      Effect.andThen(WorkflowsMigration, WorkflowSkippedRunsMigration).pipe(
        Effect.andThen(WorkflowRunIndexesMigration),
        Effect.andThen(WorkflowRunTagsMigration),
        Effect.andThen(WorkflowMailSenderMigration),
        Effect.andThen(WorkflowPoolsMigration),
      ),
    );
    return yield* Effect.provide(
      use,
      WorkflowStore.layer.pipe(
        Layer.provideMerge(Layer.merge(migrated, MilestoneHub.layer)),
        Layer.provideMerge(database),
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
        sender,
      });
      assert.isUndefined(yield* store.mailNext([{ workflow: "gate", channel: "ready:x" }]));

      yield* store.mailPut({
        signalId: "s1",
        address: { workflow: "gate", channel: "ready" },
        valueJson: '"yes"',
        expiresAt: "2999-01-01T00:00:00.000Z",
        sender,
      });
      // Who sent it is kept beside the value, as the server said it on receiving it.
      assert.deepStrictEqual(
        (yield* store.mailNext([{ workflow: "gate", channel: "ready" }]))?.sender,
        sender,
      );
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
        sender,
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
        sender,
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

const started = (
  store: WorkflowStore.WorkflowStore["Service"],
  runId: string,
  workflow = "intake",
  parent?: WorkflowStore.RunParent,
) =>
  Effect.andThen(
    TestClock.adjust("1 second"),
    store.runStarted({
      runId,
      workflow,
      version: 1,
      engineTag: `${workflow}@1`,
      idempotencyKey: runId,
      input: { body: "a webhook payload" },
      parent,
    }),
  );

it.effect("a skipped top-level run drops the input it started with; other ends keep theirs", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      yield* started(store, "skipped");
      yield* started(store, "stopped");
      yield* started(store, "child", "intake", { runId: "stopped", wait: "w" });
      yield* store.runEnded("skipped", "skipped", "only a ping", null);
      yield* store.runEnded("stopped", "stopped", "no need", null);
      yield* store.runEnded("child", "skipped", "nothing to do", null);
      const input = (runId: string) => Effect.map(store.run(runId), (run) => run?.input_json);
      assert.isNull(yield* input("skipped"));
      assert.isNotNull(yield* input("stopped"));
      assert.isNotNull(yield* input("child"));
    }),
  ),
);

it.effect("keeps each workflow's latest skipped runs and deletes older ones with their steps", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const skipped = Effect.fnUntraced(function* (runId: string, workflow = "intake") {
        yield* started(store, runId, workflow);
        yield* store.stepStarted(runId, "look", "step");
        yield* store.stepEnded(runId, "look", "completed", null);
        yield* store.runEnded(runId, "skipped", "only a ping", null);
        yield* store.enginePruned(runId);
      });
      for (const n of [1, 2, 3, 4]) yield* skipped(`old${n}`);
      // Not deleted: it did something, its journal is still kept, or it invoked a run.
      yield* started(store, "done");
      yield* store.runEnded("done", "completed", null, null);
      yield* store.enginePruned("done");
      yield* started(store, "journaled");
      yield* store.runEnded("journaled", "skipped", "only a ping", null);
      yield* skipped("parent");
      yield* started(store, "invoked", "intake", { runId: "parent", wait: "w" });
      for (const n of [1, 2]) yield* skipped(`new${n}`);
      yield* skipped("other", "sweep");

      // A small batch leaves the rest to the next sweep.
      assert.equal(yield* store.pruneSkipped(2, 3), 3);
      assert.equal(yield* store.pruneSkipped(2, 100), 1);
      assert.equal(yield* store.pruneSkipped(2, 100), 0);

      const left = (yield* store.runs(undefined)).map((run) => run.run_id).toSorted();
      assert.deepStrictEqual(left, [
        "done",
        "invoked",
        "journaled",
        "new1",
        "new2",
        "other",
        "parent",
      ]);
      assert.deepStrictEqual(yield* store.steps("old1"), []);
      assert.equal((yield* store.steps("new1")).length, 1);

      // Keeping none deletes every skipped run the rules allow, in every workflow.
      assert.equal(yield* store.pruneSkipped(0, 100), 3);
      assert.deepStrictEqual((yield* store.runs(undefined)).map((run) => run.run_id).toSorted(), [
        "done",
        "invoked",
        "journaled",
        "parent",
      ]);
    }),
  ),
);

it.effect("prunes past the kept number when runs share a start time, and tells watchers once", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      // A webhook burst: every run starts in the same instant.
      for (const runId of ["a", "b", "c", "d"]) {
        yield* store.runStarted({
          runId,
          workflow: "intake",
          version: 1,
          engineTag: "intake@1",
          idempotencyKey: runId,
          input: {},
        });
        yield* store.runEnded(runId, "skipped", "only a ping", null);
        yield* store.enginePruned(runId);
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const told = yield* PubSub.subscribe(store.changes);
          assert.equal(yield* store.pruneSkipped(2, 100), 2);
          assert.equal(yield* PubSub.remaining(told), 1);
          assert.equal(yield* store.pruneSkipped(2, 100), 0);
          assert.equal(yield* PubSub.remaining(told), 1);
        }),
      );
      assert.deepStrictEqual((yield* store.runs(undefined)).map((run) => run.run_id).toSorted(), [
        "c",
        "d",
      ]);
    }),
  ),
);

it.effect("tells watchers of the deletions that committed when a later workflow's fails", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const sql = yield* SqlClient.SqlClient;
      for (const [runId, workflow] of [
        ["a1", "a"],
        ["b1", "b"],
      ] as const) {
        yield* started(store, runId, workflow);
        yield* store.runEnded(runId, "skipped", "only a ping", null);
        yield* store.enginePruned(runId);
      }
      yield* sql`
        CREATE TRIGGER refuse_b BEFORE DELETE ON workflow_runs WHEN OLD.workflow = 'b'
        BEGIN SELECT RAISE(ABORT, 'refused'); END
      `;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const told = yield* PubSub.subscribe(store.changes);
          const exit = yield* Effect.exit(store.pruneSkipped(0, 100));
          assert.isTrue(Exit.isFailure(exit));
          assert.equal(yield* PubSub.remaining(told), 1);
        }),
      );
      assert.deepStrictEqual(
        (yield* store.runs(undefined)).map((run) => run.run_id),
        ["b1"],
      );
    }),
  ),
);

it.effect("reads that run on every change or sweep do not read every run", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const sql = yield* SqlClient.SqlClient;
      for (const [index, status] of ["skipped", "skipped", "completed", "running"].entries()) {
        yield* store.runStarted({
          runId: `r${index}`,
          workflow: "intake",
          version: 1,
          engineTag: "intake@1",
          idempotencyKey: `hook:${index}`,
          input: {},
        });
        if (status !== "running") yield* store.runEnded(`r${index}`, status as never, null, null);
      }
      const reads = {
        list: store.runs(undefined),
        listOfStatus: store.runs("skipped"),
        listOfWorkflow: store.runsWhere({ workflow: "intake" }),
        listOfWorkflowStatus: store.runsWhere({ workflow: "intake", status: "completed" }),
        listOfKeys: store.runsWhere({ workflow: "intake", keyPrefix: "hook:" }),
        counts: store.counts,
        unfinished: store.unfinished,
        untold: store.untold,
        waitsToWake: store.waitsToWake,
        pruneSkipped: store.pruneSkipped(1, 100),
      };
      const plans: Record<string, ReadonlyArray<string>> = {};
      for (const [name, read] of Object.entries(reads)) {
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* (read as Effect.Effect<unknown>).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) => {
            statements.push(statement.compile());
            return Effect.succeed(statement);
          }),
        );
        plans[name] = (yield* Effect.forEach(statements, ([query, params]) =>
          sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params),
        )).flatMap((plan) => plan.map((row) => row.detail));
      }
      for (const [name, plan] of Object.entries(plans)) {
        // A scan of an index is fine: a partial one holds only the few rows it is for.
        const scans = plan.filter((detail) => /^SCAN (workflow_runs|c|r)$/.test(detail));
        assert.deepStrictEqual(scans, [], `${name}: ${JSON.stringify(plan)}`);
      }
      // A list of one status comes in index order, with no sort of every run of that status.
      assert.isFalse(
        plans.listOfStatus!.some((detail) => detail.includes("TEMP B-TREE")),
        JSON.stringify(plans.listOfStatus),
      );
      // The sweep stays on one workflow's skipped runs, not every workflow's.
      assert.isTrue(
        plans
          .pruneSkipped!.filter((detail) => /^(SCAN|SEARCH) (workflow_runs|r) /.test(detail))
          .every((detail) => detail.includes("workflow_runs_skipped")),
        JSON.stringify(plans.pruneSkipped),
      );
      // The list leaves skipped runs to their own index-ordered half.
      assert.isTrue(
        plans.list!.some((detail) => detail.includes("workflow_runs_listed")),
        JSON.stringify(plans.list),
      );
      assert.deepStrictEqual(
        (yield* store.runsWhere({ workflow: "intake", status: "skipped" })).map(
          (run) => run.run_id,
        ),
        ["r1", "r0"],
      );
    }),
  ),
);

it.effect("a run waiting on you is listed however many runs started after it", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const start = (runId: string) =>
        store.runStarted({
          runId,
          workflow: "ask",
          version: 1,
          engineTag: "ask@1",
          idempotencyKey: runId,
          input: {},
        });
      yield* start("old");
      yield* store.runStatus("old", "waiting", "waiting on you");
      yield* store.waitOpened({
        runId: "old",
        name: "approve",
        workflow: "ask",
        key: undefined,
        token: "t",
        schemaJson: "{}",
        requestJson: '{"title":"Ship it?"}',
        watchJson: null,
        deadline: null,
      });
      yield* start("paused");
      yield* store.runPaused("paused", "gave up", true);
      for (let index = 0; index < 500; index++) {
        yield* TestClock.adjust("1 second");
        yield* start(`new-${index}`);
        yield* store.runEnded(`new-${index}`, "completed", null, null);
      }
      assert.deepStrictEqual(
        (yield* store.requests).map((wait) => wait.run_id),
        ["old"],
      );
      // Needs you lists the paused runs and open questions it is sent; one it is not sent is lost.
      const listed = new Set((yield* store.runs(undefined)).map((run) => run.run_id));
      assert.isTrue(listed.has("old"));
      assert.isTrue(listed.has("paused"));
    }),
  ),
);

it.effect("a resumed run takes back all it held, though a smaller limit queued meanwhile", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      for (const runId of ["a", "c", "b"]) {
        yield* store.runStarted({
          runId,
          workflow: "pooled",
          version: 1,
          engineTag: "pooled@1",
          idempotencyKey: runId,
          input: {},
        });
      }
      const ask = (runId: string, name: string, size: number) =>
        Effect.map(store.placeAsked({ runId, name, pool: "p", size }), (asked) => asked.held);
      assert.deepStrictEqual(
        [yield* ask("a", "outer", 2), yield* ask("a", "inner", 2)],
        [true, true],
      );
      yield* store.runPaused("a", "a step failed");
      assert.isTrue(yield* ask("c", "only", 2));
      assert.isFalse(yield* ask("b", "lock", 1));
      yield* store.runUnpaused("a");
      assert.isTrue(yield* store.placesBack("a"));
      yield* store.placeLeft("c", "only");
      const given = yield* store.placesGiven;
      assert.deepStrictEqual(
        given.map((place) => `${place.run_id}/${place.name}`),
        ["a/outer", "a/inner"],
      );
    }),
  ),
);

/** Runs in one pool `p` unless a place names another, and what the store did to their places. */
const pools = Effect.fnUntraced(function* (runIds: ReadonlyArray<string>) {
  const store = yield* WorkflowStore.WorkflowStore;
  const sql = yield* SqlClient.SqlClient;
  for (const runId of runIds) {
    yield* store.runStarted({
      runId,
      workflow: "pooled",
      version: 1,
      engineTag: "pooled@1",
      idempotencyKey: runId,
      input: {},
    });
  }
  const named = (given: ReadonlyArray<WorkflowStore.PlaceRow>) =>
    given.map((place) => `${place.run_id}/${place.name}`);
  return {
    /** Asks for a place, and says whether the run holds it now. */
    ask: (runId: string, name: string, size: number, pool = "p") =>
      Effect.map(store.placeAsked({ runId, name, pool, size }), (asked) => asked.held),
    pause: (runId: string) => store.runPaused(runId, "a step failed"),
    /** Resumes the run, and returns the places that gave out. */
    resume: (runId: string) =>
      Effect.andThen(
        Effect.andThen(store.runUnpaused(runId), store.placesBack(runId)),
        Effect.map(store.placesGiven, named),
      ),
    /** Gives a place back, and returns the places that gave out. */
    leave: (runId: string, name: string) =>
      Effect.andThen(store.placeLeft(runId, name), Effect.map(store.placesGiven, named)),
    held: Effect.map(
      sql<{ readonly place: string }>`
        SELECT run_id || '/' || name AS place FROM workflow_pool_places
        WHERE state = 'held' ORDER BY seq
      `,
      (rows) => rows.map((row) => row.place),
    ),
  };
});

it.effect("two paused runs that asked for different limits both get back in", () =>
  withStore(
    Effect.gen(function* () {
      const { ask, pause, resume, leave, held } = yield* pools(["a", "b"]);
      assert.deepStrictEqual([yield* ask("a", "one", 2), yield* ask("a", "two", 2)], [true, true]);
      yield* pause("a");
      // The pool is empty while `a` is out, so the lock goes in, and pauses there too.
      assert.isTrue(yield* ask("b", "lock", 1));
      yield* pause("b");
      assert.deepStrictEqual(yield* resume("a"), ["a/one", "a/two"]);
      // The lock waits for the pool to be empty, holding nothing meanwhile.
      assert.deepStrictEqual(yield* resume("b"), []);
      assert.deepStrictEqual(yield* held, ["a/one", "a/two"]);
      assert.deepStrictEqual(yield* leave("a", "one"), []);
      assert.deepStrictEqual(yield* leave("a", "two"), ["b/lock"]);
    }),
  ),
);

it.effect("resumed the other way round, the lock goes first and the other run after it", () =>
  withStore(
    Effect.gen(function* () {
      const { ask, pause, resume, leave, held } = yield* pools(["a", "b"]);
      yield* ask("a", "one", 2);
      yield* ask("a", "two", 2);
      yield* pause("a");
      yield* ask("b", "lock", 1);
      yield* pause("b");
      assert.deepStrictEqual(yield* resume("b"), ["b/lock"]);
      // Not one of its two beside the lock: all of them, once the lock is out.
      assert.deepStrictEqual(yield* resume("a"), []);
      assert.deepStrictEqual(yield* held, ["b/lock"]);
      assert.deepStrictEqual(yield* leave("b", "lock"), ["a/one", "a/two"]);
    }),
  ),
);

it.effect("a resumed run takes back every place it had or none, ahead of whoever is queued", () =>
  withStore(
    Effect.gen(function* () {
      const { ask, pause, resume, leave, held } = yield* pools(["a", "e", "h", "z"]);
      // Three runs that each held two of the pool's three places, one after the other.
      for (const runId of ["a", "e", "h"]) {
        assert.deepStrictEqual(
          [yield* ask(runId, "one", 3), yield* ask(runId, "two", 3)],
          [true, true],
        );
        yield* pause(runId);
      }
      assert.deepStrictEqual(yield* resume("a"), ["a/one", "a/two"]);
      // One place is free. Taking it would leave `e` holding a place while it cannot go on.
      assert.deepStrictEqual(yield* resume("e"), []);
      assert.deepStrictEqual(yield* resume("h"), []);
      assert.deepStrictEqual(yield* held, ["a/one", "a/two"]);
      // A newcomer does not take the free place from the runs that wait to come back.
      assert.isFalse(yield* ask("z", "one", 3));
      assert.deepStrictEqual(yield* leave("a", "one"), ["e/one", "e/two"]);
      assert.deepStrictEqual(yield* leave("a", "two"), []);
      // `h` comes back as soon as two are free, and the newcomer takes the place after that.
      assert.deepStrictEqual(yield* leave("e", "one"), ["h/one", "h/two"]);
      assert.deepStrictEqual(yield* leave("e", "two"), ["z/one"]);
      assert.deepStrictEqual(yield* held, ["h/one", "h/two", "z/one"]);
    }),
  ),
);

it.effect("a resumed run holds nothing in one pool while it waits for a place in another", () =>
  withStore(
    Effect.gen(function* () {
      const { ask, pause, resume, leave, held } = yield* pools(["a", "y"]);
      assert.deepStrictEqual(
        [yield* ask("a", "outer", 1, "p"), yield* ask("a", "inner", 1, "q")],
        [true, true],
      );
      yield* pause("a");
      assert.isTrue(yield* ask("y", "outer", 1, "p"));
      // `q` is free, but `a` cannot go on without `p`, and `y` needs `q` to ever leave `p`.
      assert.deepStrictEqual(yield* resume("a"), []);
      assert.deepStrictEqual(yield* held, ["y/outer"]);
      assert.isTrue(yield* ask("y", "inner", 1, "q"));
      assert.deepStrictEqual(yield* leave("y", "inner"), []);
      assert.deepStrictEqual(yield* leave("y", "outer"), ["a/outer", "a/inner"]);
    }),
  ),
);

it.effect("a run waiting to come back is given no new place it queued for either", () =>
  withStore(
    Effect.gen(function* () {
      const { ask, pause, resume, leave, held } = yield* pools(["a", "x", "y"]);
      assert.isTrue(yield* ask("a", "first", 1, "p"));
      assert.isTrue(yield* ask("x", "only", 1, "q"));
      assert.isFalse(yield* ask("a", "second", 1, "q"));
      yield* pause("a");
      assert.isTrue(yield* ask("y", "first", 1, "p"));
      assert.deepStrictEqual(yield* resume("a"), []);
      // `q` frees up while `a` still waits for `p`: it goes to `y`, who is going.
      assert.deepStrictEqual(yield* leave("x", "only"), []);
      assert.isTrue(yield* ask("y", "second", 1, "q"));
      assert.deepStrictEqual(yield* leave("y", "second"), []);
      assert.deepStrictEqual(yield* leave("y", "first"), ["a/first", "a/second"]);
      assert.deepStrictEqual(yield* held, ["a/first", "a/second"]);
    }),
  ),
);

it.effect(
  "a resumed run goes back in beside its like while a lock waits, and the lock still runs alone",
  () =>
    withStore(
      Effect.gen(function* () {
        const { ask, pause, resume, leave, held } = yield* pools(["w1", "w2", "w3", "n"]);
        assert.deepStrictEqual(
          [yield* ask("w1", "one", 2), yield* ask("w2", "one", 2)],
          [true, true],
        );
        yield* pause("w2");
        assert.isFalse(yield* ask("n", "lock", 1));
        // It had its place before the lock asked, and those inside allow two.
        assert.deepStrictEqual(yield* resume("w2"), ["w2/one"]);
        // Nobody who asks after the lock goes in ahead of it, room or not.
        assert.deepStrictEqual(yield* leave("w1", "one"), []);
        assert.isFalse(yield* ask("w3", "one", 2));
        assert.deepStrictEqual(yield* leave("w2", "one"), ["n/lock"]);
        assert.deepStrictEqual(yield* held, ["n/lock"]);
        assert.deepStrictEqual(yield* leave("n", "lock"), ["w3/one"]);
      }),
    ),
);

it.effect("a pool lets in no more than the smallest limit of those inside it", () =>
  withStore(
    Effect.gen(function* () {
      const { ask, leave, held } = yield* pools(["two", "three", "four", "n"]);
      assert.isTrue(yield* ask("two", "one", 2));
      assert.isTrue(yield* ask("three", "one", 3));
      // Three would fit by its own limit, but one of those inside asked for two.
      assert.isFalse(yield* ask("four", "one", 3));
      assert.isFalse(yield* ask("n", "lock", 1));
      // The one in line first goes in when there is room for it; the lock waits for an empty pool.
      assert.deepStrictEqual(yield* leave("two", "one"), ["four/one"]);
      assert.deepStrictEqual(yield* leave("three", "one"), []);
      assert.deepStrictEqual(yield* leave("four", "one"), ["n/lock"]);
      assert.deepStrictEqual(yield* held, ["n/lock"]);
    }),
  ),
);

it.effect("a run paused again before its places came back keeps nobody waiting", () =>
  withStore(
    Effect.gen(function* () {
      const { ask, pause, resume, leave } = yield* pools(["a", "y", "z"]);
      assert.isTrue(yield* ask("a", "lock", 1));
      yield* pause("a");
      assert.isTrue(yield* ask("y", "lock", 1));
      assert.deepStrictEqual(yield* resume("a"), []);
      yield* pause("a");
      assert.deepStrictEqual(yield* leave("y", "lock"), []);
      assert.isTrue(yield* ask("z", "lock", 1));
      assert.deepStrictEqual(yield* resume("a"), []);
      assert.deepStrictEqual(yield* leave("z", "lock"), ["a/lock"]);
    }),
  ),
);
