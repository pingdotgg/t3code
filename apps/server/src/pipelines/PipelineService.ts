import {
  PipelineError,
  PipelineId,
  pipelineDefinitionIssues,
  type OrchestrationV2Actor,
  type PipelineDefinition,
  type PipelineDeleteInput,
  type PipelineDeleteResult,
  type PipelineListResult,
  type PipelineMutationResult,
  type PipelineRun,
  type PipelineRunCancelInput,
  type PipelineRunId,
  type PipelineRunResult,
  type PipelineRunRetryInput,
  type PipelineRunSetPauseBeforeInput,
  type PipelineRunStartInput,
  type PipelineRunStepActionInput,
  type PipelineRunsLiveResult,
  type PipelineRunSubscribeInput,
  type PipelineRunSummary,
  type PipelineUpsertInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  PIPELINE_STARTERS,
  withStarterRuntimeMode,
  type PipelineStarter,
} from "@t3tools/shared/pipelineStarters";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import type { DispatchModes } from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makePipelineRunner, pipelineError } from "./pipelineRunner.ts";
import * as PipelineStore from "./PipelineStore.ts";

export class PipelineService extends Context.Service<
  PipelineService,
  {
    readonly list: () => Effect.Effect<PipelineListResult, PipelineError>;
    readonly subscribeList: () => Stream.Stream<PipelineListResult, PipelineError>;
    readonly upsert: (
      input: PipelineUpsertInput,
    ) => Effect.Effect<PipelineMutationResult, PipelineError>;
    readonly delete: (
      input: PipelineDeleteInput,
    ) => Effect.Effect<PipelineDeleteResult, PipelineError>;
    readonly start: (
      input: PipelineRunStartInput,
      options?: {
        readonly createdBy?: OrchestrationV2Actor;
        readonly modeLimit?: DispatchModes;
      },
    ) => Effect.Effect<PipelineRunResult, PipelineError>;
    readonly getRun: (runId: PipelineRunId) => Effect.Effect<PipelineRun, PipelineError>;
    readonly subscribeRun: (
      input: PipelineRunSubscribeInput,
    ) => Stream.Stream<PipelineRunResult, PipelineError>;
    /** Every running or paused run, re-emitted whenever any run changes. */
    readonly subscribeLiveRuns: () => Stream.Stream<PipelineRunsLiveResult, PipelineError>;
    readonly continueRun: (
      input: PipelineRunStepActionInput,
    ) => Effect.Effect<PipelineRunResult, PipelineError>;
    readonly retryStep: (
      input: PipelineRunRetryInput,
    ) => Effect.Effect<PipelineRunResult, PipelineError>;
    readonly skipStep: (
      input: PipelineRunStepActionInput,
    ) => Effect.Effect<PipelineRunResult, PipelineError>;
    readonly cancel: (
      input: PipelineRunCancelInput,
    ) => Effect.Effect<PipelineRunResult, PipelineError>;
    readonly setStepPauseBefore: (
      input: PipelineRunSetPauseBeforeInput,
    ) => Effect.Effect<PipelineRunResult, PipelineError>;
  }
>()("t3/pipelines/PipelineService") {}

export const layerWithStarters = (
  starters: ReadonlyArray<PipelineStarter>,
): Layer.Layer<
  PipelineService,
  never,
  | PipelineStore.PipelineStore
  | Crypto.Crypto
  | ThreadLaunchService.ThreadLaunchService
  | ThreadManagementService.ThreadManagementService
  | IdAllocator.IdAllocatorV2
  | ServerSettings.ServerSettingsService
  | CheckpointStore.CheckpointStore
  | ServerConfig.ServerConfig
  | FileSystem.FileSystem
  | Path.Path
> =>
  Layer.effect(
    PipelineService,
    Effect.gen(function* () {
      const store = yield* PipelineStore.PipelineStore;
      const crypto = yield* Crypto.Crypto;
      const serverSettings = yield* ServerSettings.ServerSettingsService;

      // Notifications re-emit the full list; slow subscribers need only the newest dirty signal.
      const defsChanged = yield* PubSub.sliding<void>(1);
      const notifyDefsChanged = PubSub.publish(defsChanged, undefined).pipe(Effect.asVoid);
      // Run subscribers filter by id, so every change must be delivered.
      const runChanged = yield* PubSub.unbounded<PipelineRunId>();
      const runner = yield* makePipelineRunner((runId) =>
        PubSub.publish(runChanged, runId).pipe(Effect.asVoid),
      );

      const list: PipelineService["Service"]["list"] = () =>
        store.listDefinitions().pipe(Effect.map((pipelines) => ({ pipelines })));

      const subscribeList: PipelineService["Service"]["subscribeList"] = () =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before reading to buffer concurrent changes.
            const subscription = yield* PubSub.subscribe(defsChanged);
            return Stream.concat(
              Stream.fromEffect(list()),
              Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
            );
          }),
        );

      const upsert: PipelineService["Service"]["upsert"] = Effect.fn("PipelineService.upsert")(
        function* (input) {
          // The wire schema already enforces this; direct callers (MCP, tests) skip the schema.
          const issue = pipelineDefinitionIssues(input.steps)[0];
          if (issue !== undefined) return yield* pipelineError(issue.message);

          const now = DateTime.formatIso(yield* DateTime.now);
          const uuid =
            input.id !== undefined || input.commandId !== undefined
              ? null
              : yield* crypto
                  .randomUUIDv4()
                  .pipe(
                    Effect.mapError((cause) =>
                      pipelineError("Could not generate pipeline id.", { cause }),
                    ),
                  );
          // Derived from the commandId so a replayed create resolves to the same row.
          const id =
            input.id ??
            PipelineId.make(
              input.commandId === undefined ? `pipeline:${uuid}` : `pipeline:${input.commandId}`,
            );

          const existing = yield* store.getDefinition(id);
          if (existing === null && input.requireExisting === true) {
            return yield* pipelineError("Pipeline not found.", { pipelineId: id });
          }
          const definition: PipelineDefinition = {
            id,
            name: input.name,
            steps: input.steps,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          // The update is checked in the write, so an edit cannot undo a concurrent delete.
          const saved =
            existing === null
              ? yield* insertOrUpdate(definition)
              : yield* store.updateDefinition(definition);
          if (!saved) return yield* pipelineError("Pipeline not found.", { pipelineId: id });
          yield* notifyDefsChanged;
          return { pipeline: (yield* store.getDefinition(id)) ?? definition };
        },
      );

      // A concurrent replay of the same create can win the insert; fall back to the update path.
      const insertOrUpdate = Effect.fn("PipelineService.insertOrUpdate")(function* (
        definition: PipelineDefinition,
      ) {
        return yield* store.insertDefinition(definition).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            store
              .getDefinition(definition.id)
              .pipe(
                Effect.flatMap((current) =>
                  current === null ? Effect.fail(error) : store.updateDefinition(definition),
                ),
              ),
          ),
        );
      });

      const deleteDefinition: PipelineService["Service"]["delete"] = Effect.fn(
        "PipelineService.delete",
      )(function* (input) {
        const deleted = yield* store.deleteDefinition(input.id);
        if (!deleted) return yield* pipelineError("Pipeline not found.", { pipelineId: input.id });
        yield* notifyDefsChanged;
        return { id: input.id };
      });

      const getRun: PipelineService["Service"]["getRun"] = Effect.fn("PipelineService.getRun")(
        function* (runId) {
          const run = yield* store.getRun(runId);
          if (run === null) return yield* pipelineError("Pipeline run not found.", { runId });
          return run;
        },
      );

      const subscribeRun: PipelineService["Service"]["subscribeRun"] = (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before reading to buffer concurrent changes.
            const subscription = yield* PubSub.subscribe(runChanged);
            const current = getRun(input.runId).pipe(Effect.map((run) => ({ run })));
            return Stream.concat(
              Stream.fromEffect(current),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((runId) => runId === input.runId),
                Stream.mapEffect(() => current),
              ),
            );
          }),
        );

      const summarize = (run: PipelineRun): PipelineRunSummary => ({
        id: run.id,
        parentThreadId: run.parentThreadId,
        name: run.definition.name,
        status: run.status,
        pauseReason: run.pauseReason,
        currentStepIndex: run.currentStepIndex,
        steps: run.steps.map((step) => ({
          stepId: step.stepId,
          name:
            run.definition.steps.find((candidate) => candidate.id === step.stepId)?.name ??
            step.stepId,
          status: step.status,
          childThreadId: step.childThreadId,
        })),
      });

      const liveRuns = Effect.fn("PipelineService.liveRuns")(function* () {
        const runIds = yield* store.listRunIdsByStatus(["running", "paused"]);
        const runs = yield* Effect.forEach(runIds, (runId) =>
          store.getRun(runId).pipe(
            // One corrupt run must not hide the others.
            Effect.catch((error) =>
              Effect.logWarning("Skipping unreadable pipeline run", { runId, error }).pipe(
                Effect.as(null),
              ),
            ),
          ),
        );
        return {
          runs: runs.flatMap((run) =>
            run !== null && (run.status === "running" || run.status === "paused")
              ? [summarize(run)]
              : [],
          ),
        } satisfies PipelineRunsLiveResult;
      });

      const subscribeLiveRuns: PipelineService["Service"]["subscribeLiveRuns"] = () =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before reading to buffer concurrent changes.
            const subscription = yield* PubSub.subscribe(runChanged);
            return Stream.concat(
              Stream.fromEffect(liveRuns()),
              Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => liveRuns())),
            ).pipe(Stream.changes);
          }),
        );

      // Seeding is best effort: a failure must never keep the server from starting.
      const seeded = yield* Effect.forEach(starters, (starter) =>
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          const { defaultRuntimeMode } = yield* serverSettings.getSettings;
          return yield* store.seedStarter({
            key: starter.key,
            definition: {
              id: PipelineId.make(`pipeline:starter:${starter.key}`),
              name: starter.name,
              steps: withStarterRuntimeMode(starter.steps, defaultRuntimeMode),
              createdAt: now,
              updatedAt: now,
            },
          });
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not seed starter pipeline", {
              starterKey: starter.key,
              cause,
            }).pipe(Effect.as(false)),
          ),
        ),
      );
      if (seeded.includes(true)) yield* notifyDefsChanged;

      yield* runner.startRecovery();

      return PipelineService.of({
        list,
        subscribeList,
        upsert,
        delete: deleteDefinition,
        start: runner.start,
        getRun,
        subscribeRun,
        subscribeLiveRuns,
        continueRun: runner.continueRun,
        retryStep: runner.retryStep,
        skipStep: runner.skipStep,
        cancel: runner.cancel,
        setStepPauseBefore: runner.setStepPauseBefore,
      });
    }),
  );

export const layer = layerWithStarters(PIPELINE_STARTERS);
