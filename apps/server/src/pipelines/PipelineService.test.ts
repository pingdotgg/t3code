import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  PipelineError,
  PipelineId,
  PipelineRunId,
  PipelineUpsertInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  FEATURE_DELIVERY_PIPELINE,
  pipelineStarterFingerprint,
  withStarterRuntimeMode,
  type PipelineStarter,
} from "@t3tools/shared/pipelineStarters";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PipelineService from "./PipelineService.ts";
import * as PipelineStore from "./PipelineStore.ts";

const decodeUpsert = Schema.decodeSync(PipelineUpsertInput);
const decodePipelineId = Schema.decodeSync(PipelineId);
const decodeRunId = Schema.decodeSync(PipelineRunId);
const decodeCommandId = Schema.decodeSync(CommandId);

const step = (id: string, promptTemplate: string) => ({
  id,
  name: `Step ${id}`,
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "full-access" as const,
  skills: [],
  promptTemplate,
  pauseBefore: false,
});

const upsertInput = (overrides: Partial<typeof PipelineUpsertInput.Encoded> = {}) =>
  decodeUpsert({
    name: "Review",
    steps: [step("plan", "{{input}}"), step("build", "{{previous.output}}")],
    ...overrides,
  });

const serviceLayer = (
  starters: ReadonlyArray<PipelineStarter>,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) =>
  PipelineService.layerWithStarters(starters).pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest(settings),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          streamDomainEvents: Stream.never,
        }),
        IdAllocator.layer,
        Layer.mock(CheckpointStore.CheckpointStore)({}),
        // Only the worktrees directory is read, to tell managed worktrees from other folders.
        Layer.succeed(ServerConfig.ServerConfig, {
          worktreesDir: "/t3-test-worktrees",
        } as ServerConfig.ServerConfig["Service"]),
      ),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(NodeServices.layer),
  );

const storeLayer = PipelineStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const testLayer = serviceLayer([]).pipe(Layer.provideMerge(storeLayer));

it.effect("creates then updates a definition, keeping its id and createdAt", () =>
  Effect.gen(function* () {
    const service = yield* PipelineService.PipelineService;
    yield* TestClock.setTime(Date.parse("2026-10-28T10:00:00.000Z"));
    const { pipeline: created } = yield* service.upsert(upsertInput());
    assert.strictEqual(created.name, "Review");
    assert.strictEqual(created.createdAt, "2026-10-28T10:00:00.000Z");

    yield* TestClock.setTime(Date.parse("2026-10-28T11:00:00.000Z"));
    const { pipeline: updated } = yield* service.upsert(
      upsertInput({ id: created.id, name: "Renamed", steps: [step("plan", "{{input}}")] }),
    );
    assert.strictEqual(updated.id, created.id);
    assert.strictEqual(updated.name, "Renamed");
    assert.strictEqual(updated.steps.length, 1);
    assert.strictEqual(updated.createdAt, created.createdAt);
    assert.strictEqual(updated.updatedAt, "2026-10-28T11:00:00.000Z");

    const { pipelines } = yield* service.list();
    assert.deepStrictEqual(pipelines, [updated]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("replaying a create commandId resolves to the same pipeline", () =>
  Effect.gen(function* () {
    const service = yield* PipelineService.PipelineService;
    const commandId = decodeCommandId("command-1");
    const first = yield* service.upsert(upsertInput({ commandId }));
    const second = yield* service.upsert(upsertInput({ commandId, name: "Edited" }));
    assert.strictEqual(second.pipeline.id, first.pipeline.id);
    assert.strictEqual((yield* service.list()).pipelines.length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("requireExisting rejects an id that does not exist", () =>
  Effect.gen(function* () {
    const service = yield* PipelineService.PipelineService;
    const failure = yield* Effect.flip(
      service.upsert(
        upsertInput({ id: decodePipelineId("pipeline-missing"), requireExisting: true }),
      ),
    );
    assert.instanceOf(failure, PipelineError);
    assert.strictEqual(failure.message, "Pipeline not found.");
    assert.deepStrictEqual((yield* service.list()).pipelines, []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects an invalid definition even when the schema was skipped", () =>
  Effect.gen(function* () {
    const service = yield* PipelineService.PipelineService;
    const valid = upsertInput();
    const failure = yield* Effect.flip(
      service.upsert({
        ...valid,
        steps: [{ ...valid.steps[0]!, promptTemplate: "{{previous.output}}" }],
      }),
    );
    assert.instanceOf(failure, PipelineError);
    assert.deepStrictEqual((yield* service.list()).pipelines, []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("deletes a definition and fails for a missing one", () =>
  Effect.gen(function* () {
    const service = yield* PipelineService.PipelineService;
    const { pipeline } = yield* service.upsert(upsertInput());
    assert.deepStrictEqual(yield* service.delete({ id: pipeline.id }), { id: pipeline.id });
    assert.deepStrictEqual((yield* service.list()).pipelines, []);
    const failure = yield* Effect.flip(service.delete({ id: pipeline.id }));
    assert.strictEqual(failure.message, "Pipeline not found.");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("subscribeList emits the current list, then again after a change", () =>
  Effect.gen(function* () {
    const service = yield* PipelineService.PipelineService;
    const emissions = yield* service.subscribeList().pipe(
      Stream.mapEffect((result) =>
        // The change happens once the initial snapshot has been emitted.
        result.pipelines.length === 0
          ? service.upsert(upsertInput()).pipe(Effect.as(result))
          : Effect.succeed(result),
      ),
      Stream.take(2),
      Stream.runCollect,
    );
    assert.deepStrictEqual(
      emissions.map((result) => result.pipelines.length),
      [0, 1],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("getRun, subscribeRun and run actions fail for a missing run", () =>
  Effect.gen(function* () {
    const service = yield* PipelineService.PipelineService;
    const runId = decodeRunId("run-missing");
    const failure = yield* Effect.flip(service.getRun(runId));
    assert.strictEqual(failure.message, "Pipeline run not found.");
    const subscription = yield* Effect.flip(service.subscribeRun({ runId }).pipe(Stream.runDrain));
    assert.strictEqual(subscription.message, "Pipeline run not found.");
    const cancel = yield* Effect.flip(service.cancel({ runId }));
    assert.strictEqual(cancel.message, "Pipeline run not found.");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("seeds each starter once and never brings a deleted one back", () =>
  Effect.gen(function* () {
    const starters = [FEATURE_DELIVERY_PIPELINE];
    // Each build is a server start over the same database.
    const start = <A, E>(
      starterList: ReadonlyArray<PipelineStarter>,
      body: (service: PipelineService.PipelineService["Service"]) => Effect.Effect<A, E>,
      settings?: Parameters<typeof ServerSettings.layerTest>[0],
    ) =>
      PipelineService.PipelineService.pipe(
        Effect.flatMap(body),
        Effect.provide(serviceLayer(starterList, settings).pipe(Layer.provide(storeLayer))),
      );

    // Starter steps take the server's configured default runtime mode when they are seeded.
    const first = yield* start(starters, (service) => service.list(), {
      defaultRuntimeMode: "approval-required",
    });
    assert.deepStrictEqual(
      first.pipelines.map((pipeline) => [pipeline.id, pipeline.name, pipeline.steps]),
      [
        [
          "pipeline:starter:feature-delivery",
          "Feature delivery",
          withStarterRuntimeMode(FEATURE_DELIVERY_PIPELINE.steps, "approval-required"),
        ],
      ],
    );

    const second = yield* start(starters, (service) => service.list());
    assert.deepStrictEqual(second.pipelines, first.pipelines);

    yield* start(starters, (service) => service.delete({ id: first.pipelines[0]!.id }));
    assert.deepStrictEqual((yield* start(starters, (service) => service.list())).pipelines, []);

    const added: PipelineStarter = {
      ...FEATURE_DELIVERY_PIPELINE,
      key: "added-later",
      name: "New",
    };
    const afterRelease = yield* start([...starters, added], (service) => service.list());
    assert.deepStrictEqual(
      afterRelease.pipelines.map((pipeline) => pipeline.id),
      ["pipeline:starter:added-later"],
    );
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("an unedited copy of an older starter version is upgraded; an edited one is kept", () =>
  Effect.gen(function* () {
    const store = yield* PipelineStore.PipelineStore;
    const older = FEATURE_DELIVERY_PIPELINE.steps.map((starterStep) => ({
      ...starterStep,
      promptTemplate: `${starterStep.promptTemplate}\n(old wording)`,
    }));
    const starter: PipelineStarter = {
      ...FEATURE_DELIVERY_PIPELINE,
      previousFingerprints: [pipelineStarterFingerprint(older)],
    };
    const id = decodePipelineId("pipeline:starter:feature-delivery");
    const now = "2026-10-29T10:00:00.000Z";
    const start = <A, E>(
      body: (service: PipelineService.PipelineService["Service"]) => Effect.Effect<A, E>,
    ) =>
      PipelineService.PipelineService.pipe(
        Effect.flatMap(body),
        Effect.provide(serviceLayer([starter]).pipe(Layer.provide(storeLayer))),
      );

    // Seeded earlier with "approval-required" steps and never edited since.
    yield* start(() => Effect.void);
    yield* store.updateDefinition({
      id,
      name: "Feature delivery",
      steps: withStarterRuntimeMode(older, "approval-required"),
      createdAt: now,
      updatedAt: now,
    });
    const upgraded = yield* start((service) => service.list());
    assert.deepStrictEqual(
      upgraded.pipelines[0]?.steps,
      withStarterRuntimeMode(FEATURE_DELIVERY_PIPELINE.steps, "approval-required"),
    );

    // An edit makes the copy the user's own: it no longer follows the starter.
    const edited = withStarterRuntimeMode(older, "full-access").map((editedStep, index) =>
      index === 0 ? { ...editedStep, name: "My refine" } : editedStep,
    );
    yield* store.updateDefinition({
      id,
      name: "Feature delivery",
      steps: edited,
      createdAt: now,
      updatedAt: now,
    });
    const kept = yield* start((service) => service.list());
    assert.deepStrictEqual(kept.pipelines[0]?.steps, edited);
  }).pipe(Effect.provide(storeLayer)),
);

it("the shipped starter's previous step lists are recorded before its steps change", () => {
  // Changing the starter's steps changes this fingerprint. Add the old value to the starter's
  // previousFingerprints, so unedited copies upgrade, then update it here.
  assert.strictEqual(pipelineStarterFingerprint(FEATURE_DELIVERY_PIPELINE.steps), "113oj2n9s8j");
  assert.notInclude(
    FEATURE_DELIVERY_PIPELINE.previousFingerprints ?? [],
    pipelineStarterFingerprint(FEATURE_DELIVERY_PIPELINE.steps),
  );
});
