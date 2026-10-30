import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  PIPELINE_OUTPUT_PREVIEW_CHARS,
  PipelineDefinition,
  PipelineError,
  PipelineId,
  PipelineRun,
  PipelineRunId,
  PipelineStepId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PipelineStore from "./PipelineStore.ts";

const decodeDefinition = Schema.decodeSync(PipelineDefinition);
const decodeRun = Schema.decodeSync(PipelineRun);
const decodePipelineId = Schema.decodeSync(PipelineId);
const decodeRunId = Schema.decodeSync(PipelineRunId);
const decodeStepId = Schema.decodeSync(PipelineStepId);
const decodeThreadId = Schema.decodeSync(ThreadId);
const decodeCheckpointRef = Schema.decodeSync(CheckpointRef);
const pipelineId = decodePipelineId("pipeline-1");
const runId = decodeRunId("run-1");
const parentThreadId = decodeThreadId("thread-parent");
const childThreadId = decodeThreadId("thread-child");
const missingPipelineId = decodePipelineId("pipeline-missing");
const corruptPipelineId = decodePipelineId("pipeline-bad");
const missingRunId = decodeRunId("run-missing");
const NOW = "2026-10-28T10:00:00.000Z";
const LATER = "2026-10-28T11:00:00.000Z";

const step = (id: string) => ({
  id,
  name: `Step ${id}`,
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "full-access" as const,
  skills: ["review"],
  promptTemplate: id === "plan" ? "{{input}}" : "{{previous.output}}",
  pauseBefore: false,
});

const definition = (overrides: Partial<typeof PipelineDefinition.Encoded> = {}) =>
  decodeDefinition({
    id: pipelineId,
    name: "Review",
    steps: [step("plan"), step("build")],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

const newRun = () => {
  const { steps: _steps, ...run } = decodeRun({
    id: runId,
    pipelineId,
    definition: { name: "Review", steps: [step("plan"), step("build")] },
    projectId: "project-1",
    parentThreadId,
    input: "Ship it",
    workspaceStrategy: { type: "root" },
    status: "running",
    pauseReason: null,
    error: null,
    currentStepIndex: 0,
    steps: [],
    createdBy: "user",
    creationSource: "web",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
  });
  return run;
};

const newSteps = (stepIds: ReadonlyArray<string>) =>
  stepIds.map((id, index) => ({
    index,
    stepId: decodeStepId(id),
    pauseBefore: index === 1,
  }));

const testLayer = PipelineStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

it.effect("round-trips, updates and deletes definitions", () =>
  Effect.gen(function* () {
    const store = yield* PipelineStore.PipelineStore;
    assert.deepStrictEqual(yield* store.getDefinition(pipelineId), null);

    const created = definition();
    yield* store.insertDefinition(created);
    assert.deepStrictEqual(yield* store.getDefinition(pipelineId), created);
    assert.deepStrictEqual(yield* store.listDefinitions(), [created]);

    const edited = definition({
      name: "Renamed",
      steps: [step("plan")],
      createdAt: LATER,
      updatedAt: LATER,
    });
    assert.isTrue(yield* store.updateDefinition(edited));
    const stored = yield* store.getDefinition(pipelineId);
    assert.deepStrictEqual(stored, { ...edited, createdAt: NOW });

    const missing = missingPipelineId;
    assert.isFalse(yield* store.updateDefinition(definition({ id: missing })));
    assert.isFalse(yield* store.deleteDefinition(missing));
    assert.isTrue(yield* store.deleteDefinition(pipelineId));
    assert.deepStrictEqual(yield* store.listDefinitions(), []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("seeds a starter once per key, even after the definition is deleted", () =>
  Effect.gen(function* () {
    const store = yield* PipelineStore.PipelineStore;
    const starter = definition();
    assert.isTrue(yield* store.seedStarter({ key: "starter", definition: starter }));
    assert.deepStrictEqual(yield* store.listDefinitions(), [starter]);

    assert.isFalse(
      yield* store.seedStarter({ key: "starter", definition: definition({ name: "Other" }) }),
    );
    assert.deepStrictEqual(yield* store.listDefinitions(), [starter]);

    assert.isTrue(yield* store.deleteDefinition(pipelineId));
    assert.isFalse(yield* store.seedStarter({ key: "starter", definition: starter }));
    assert.deepStrictEqual(yield* store.listDefinitions(), []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("records the seed without overwriting a definition that already has the id", () =>
  Effect.gen(function* () {
    const store = yield* PipelineStore.PipelineStore;
    const existing = definition({ name: "Mine" });
    yield* store.insertDefinition(existing);
    assert.isFalse(yield* store.seedStarter({ key: "starter", definition: definition() }));
    assert.deepStrictEqual(yield* store.listDefinitions(), [existing]);

    assert.isTrue(yield* store.deleteDefinition(pipelineId));
    assert.isFalse(yield* store.seedStarter({ key: "starter", definition: definition() }));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("skips a corrupt definition row when listing and fails getDefinition for it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* PipelineStore.PipelineStore;
    yield* store.insertDefinition(definition());
    yield* sql`
      INSERT INTO pipelines (pipeline_id, name, steps_json, created_at, updated_at)
      VALUES ('pipeline-bad', 'Bad', '{not json', ${NOW}, ${NOW})
    `;
    const messages: Array<string> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(String(message));
    });
    const listed = yield* store.listDefinitions().pipe(Effect.provide(Logger.layer([logger])));
    assert.deepStrictEqual(
      listed.map((entry) => entry.id),
      [pipelineId],
    );
    assert.isTrue(
      messages.some((message) => message.includes("Skipping undecodable pipeline row")),
    );

    const failure = yield* Effect.flip(store.getDefinition(corruptPipelineId));
    assert.instanceOf(failure, PipelineError);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("round-trips a run with steps, truncating previews but keeping full outputs", () =>
  Effect.gen(function* () {
    const store = yield* PipelineStore.PipelineStore;
    yield* store.insertRunWithSteps(newRun(), newSteps(["plan", "build"]));

    const initial = yield* store.getRun(runId);
    assert.deepStrictEqual(initial?.steps, [
      {
        index: 0,
        stepId: decodeStepId("plan"),
        status: "pending",
        attempt: 0,
        childThreadId: null,
        pauseBefore: false,
        canRestoreWorkspace: false,
        handedOff: false,
        outputPreview: null,
        error: null,
        startedAt: null,
        completedAt: null,
      },
      {
        index: 1,
        stepId: decodeStepId("build"),
        status: "pending",
        attempt: 0,
        childThreadId: null,
        pauseBefore: true,
        canRestoreWorkspace: false,
        handedOff: false,
        outputPreview: null,
        error: null,
        startedAt: null,
        completedAt: null,
      },
    ]);
    assert.deepStrictEqual(initial?.workspaceStrategy, { type: "root" });
    assert.strictEqual(initial?.definition.steps.length, 2);

    const fullOutput = "x".repeat(PIPELINE_OUTPUT_PREVIEW_CHARS + 500);
    yield* store.updateStep(runId, 0, {
      status: "completed",
      attempt: 1,
      childThreadId,
      prompt: "Ship it",
      output: fullOutput,
      startedAt: NOW,
      completedAt: LATER,
    });
    yield* store.updateStep(runId, 1, { pauseBefore: false });
    yield* store.updateRun(runId, {
      updatedAt: LATER,
      status: "paused",
      pauseReason: "awaiting_continue",
      currentStepIndex: 1,
    });

    const updated = yield* store.getRun(runId);
    assert.strictEqual(updated?.status, "paused");
    assert.strictEqual(updated?.pauseReason, "awaiting_continue");
    assert.strictEqual(updated?.currentStepIndex, 1);
    assert.strictEqual(updated?.updatedAt, LATER);
    assert.strictEqual(updated?.completedAt, null);
    assert.strictEqual(updated?.steps[0]?.status, "completed");
    assert.strictEqual(updated?.steps[0]?.childThreadId, childThreadId);
    assert.strictEqual(updated?.steps[0]?.outputPreview, "x".repeat(PIPELINE_OUTPUT_PREVIEW_CHARS));
    assert.strictEqual(updated?.steps[1]?.pauseBefore, false);

    const outputs = yield* store.getStepOutputs(runId);
    assert.deepStrictEqual([...outputs], [[0, fullOutput]]);

    // The starting snapshot survives later writes to the step, such as a new attempt.
    const startCheckpoint = {
      cwd: "/worktrees/repo/feature",
      ref: decodeCheckpointRef("refs/start"),
    };
    assert.deepStrictEqual(yield* store.getStepStartCheckpoint(runId, 0), null);
    yield* store.updateStep(runId, 0, { startCheckpoint });
    yield* store.updateStep(runId, 0, { status: "pending", attempt: 2 });
    assert.deepStrictEqual(yield* store.getStepStartCheckpoint(runId, 0), startCheckpoint);
    assert.deepStrictEqual(yield* store.getStepStartCheckpoint(runId, 1), null);
    const restorable = yield* store.getRun(runId);
    assert.deepStrictEqual(
      restorable?.steps.map((entry) => entry.canRestoreWorkspace),
      [true, false],
    );

    yield* store.updateRun(runId, { updatedAt: LATER, pauseReason: null, completedAt: LATER });
    const cleared = yield* store.getRun(runId);
    assert.strictEqual(cleared?.pauseReason, null);
    assert.strictEqual(cleared?.completedAt, LATER);
    assert.strictEqual(cleared?.status, "paused");

    assert.strictEqual((yield* store.getRunByParentThreadId(parentThreadId))?.id, runId);
    assert.deepStrictEqual(yield* store.getRunByParentThreadId(childThreadId), null);
    assert.deepStrictEqual(yield* store.listRunIdsByStatus(["running", "completed"]), []);
    assert.deepStrictEqual(yield* store.listRunIdsByStatus(["paused"]), [runId]);
    assert.deepStrictEqual(yield* store.listRunIdsByStatus([]), []);
    assert.deepStrictEqual(yield* store.getRun(missingRunId), null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not split a surrogate pair when truncating a preview", () =>
  Effect.sync(() => {
    const output = `${"a".repeat(PIPELINE_OUTPUT_PREVIEW_CHARS - 1)}\u{1F600}tail`;
    assert.strictEqual(
      PipelineStore.pipelineOutputPreview(output),
      "a".repeat(PIPELINE_OUTPUT_PREVIEW_CHARS - 1),
    );
    assert.strictEqual(PipelineStore.pipelineOutputPreview("short"), "short");
    assert.strictEqual(PipelineStore.pipelineOutputPreview(null), null);
  }),
);

it.effect("rolls back the run when its steps fail to insert", () =>
  Effect.gen(function* () {
    const store = yield* PipelineStore.PipelineStore;
    const [first] = newSteps(["plan"]);
    const duplicate = yield* Effect.flip(store.insertRunWithSteps(newRun(), [first!, first!]));
    assert.instanceOf(duplicate, PipelineError);
    assert.deepStrictEqual(yield* store.getRun(runId), null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("fails getRun with a typed error for a corrupt run", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* PipelineStore.PipelineStore;
    yield* store.insertRunWithSteps(newRun(), newSteps(["plan"]));
    yield* sql`UPDATE pipeline_runs SET definition_json = '{broken' WHERE run_id = ${runId}`;
    const failure = yield* Effect.flip(store.getRun(runId));
    assert.instanceOf(failure, PipelineError);
    assert.strictEqual(failure.runId, runId);
    // Other runs and the status index stay usable.
    assert.deepStrictEqual(yield* store.listRunIdsByStatus(["running"]), [runId]);
  }).pipe(Effect.provide(testLayer)),
);
