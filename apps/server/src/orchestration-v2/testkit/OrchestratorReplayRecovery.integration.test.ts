import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexReplay from "effect-codex-app-server/replay";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  CodexOrchestratorReplayHarness,
  makeCodexProviderAdapterRegistryReplayLayer,
} from "../Adapters/CodexAdapterV2.testkit.ts";
import {
  type CursorAgentSdkReplayTranscript,
  CursorOrchestratorReplayHarness,
  makeCursorAgentSdkReplayRunner,
  makeCursorProviderAdapterRegistryReplayLayer,
} from "../Adapters/CursorAdapterV2.testkit.ts";
import { layer as idAllocatorLayer } from "../IdAllocator.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  CODEX_MODEL_SELECTION,
  CURSOR_MODEL_SELECTION,
  materializeFixtureInput,
  type MaterializedOrchestratorFixtureInput,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
} from "./fixtures/shared.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertConversationMessageRoles,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
} from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import {
  materializeReplayTranscriptRuntimeInstructions,
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "./ReplayTranscriptNdjson.ts";

const FIRST_FINAL = "provider thread resume fixture first turn complete";
const SECOND_FINAL = "provider thread resume fixture second turn complete";

const decodeCodexTranscript = Schema.decodeUnknownEffect(
  CodexReplay.CodexAppServerReplayTranscript,
);
const readRawTranscript = Effect.fn("readRecoveryTranscript")(function* (file: URL) {
  return yield* readProviderReplayTranscript(file);
});
const readCodexTranscript = Effect.fn("readCodexRecoveryTranscript")(function* (workspace: string) {
  const transcript = yield* readRawTranscript(
    new URL("./fixtures/provider_thread_resume/codex_transcript.ndjson", import.meta.url),
  );
  return yield* decodeCodexTranscript(materializeReplayTranscriptWorkspace(transcript, workspace));
});
const readCursorTranscript = Effect.fn("readCursorRecoveryTranscript")(function* () {
  const transcript = yield* readRawTranscript(
    new URL("./fixtures/provider_thread_resume/cursor_transcript.ndjson", import.meta.url),
  );
  return yield* CursorOrchestratorReplayHarness.decodeTranscript(
    materializeReplayTranscriptRuntimeInstructions(transcript, {
      driver: ProviderDriverKind.make("cursor"),
      model: CURSOR_MODEL_SELECTION.model,
    }),
  );
});

function splitAfterFirstIdle(materialized: MaterializedOrchestratorFixtureInput) {
  const splitIndex = materialized.steps.findIndex((step) => step.type === "await_thread_idle");
  if (splitIndex < 0) {
    throw new Error("Expected fixture to contain await_thread_idle after the first turn.");
  }

  const phase1Steps = materialized.steps.slice(0, splitIndex + 1);
  const phase2Steps = materialized.steps.slice(splitIndex + 1);
  return {
    phase1Steps,
    phase2Steps,
    phase1Commands: phase1Steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
    phase2Commands: phase2Steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
  };
}

const runCursorRecovery = Effect.fn("runCursorRecovery")(function* (input: {
  readonly transcript: CursorAgentSdkReplayTranscript;
  readonly runner: ReturnType<typeof makeCursorAgentSdkReplayRunner>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* Effect.acquireRelease(
    fs.makeTempDirectory({
      prefix: "t3-orchestration-v2-cursor-recovery-",
    }),
    (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  yield* fs.makeDirectory(tempDir, { recursive: true });
  const dbPath = path.join(tempDir, "state.sqlite");
  const materialized = yield* materializeFixtureInput({
    scenario: "provider_thread_resume",
    fixtureInput: {
      steps: [
        { type: "message", text: PROVIDER_THREAD_RESUME_FIRST_PROMPT },
        { type: "message", text: PROVIDER_THREAD_RESUME_SECOND_PROMPT },
      ],
    },
    driver: ProviderDriverKind.make("cursor"),
    modelSelection: CURSOR_MODEL_SELECTION,
  });
  const { phase1Commands, phase1Steps, phase2Commands, phase2Steps } =
    splitAfterFirstIdle(materialized);
  const options = {
    databaseLayer: makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
  };
  const harness = {
    ...CursorOrchestratorReplayHarness,
    makeProviderAdapterRegistryLayer: () =>
      makeCursorProviderAdapterRegistryReplayLayer(input.transcript, {
        runner: input.runner,
        assertCompleteOnFinalize: false,
      }),
  };

  yield* Effect.scoped(
    runOrchestratorV2ProviderReplayScenario(
      {
        name: "provider_thread_resume/cursor:first-runtime",
        transcript: input.transcript,
        commands: phase1Commands,
        steps: phase1Steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { cwd: tempDir },
        runtimeRestart: true,
      },
      harness,
      options,
    ),
  );

  const result = yield* Effect.scoped(
    runOrchestratorV2ProviderReplayScenario(
      {
        name: "provider_thread_resume/cursor:second-runtime",
        transcript: input.transcript,
        commands: phase2Commands,
        steps: phase2Steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { cwd: tempDir },
        runtimeRestart: true,
      },
      harness,
      options,
    ),
  );

  assertBaseProjection({
    result,
    transcript: input.transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, input.transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRunOrdinals(projection, [1, 2]);
  assertConversationMessageRoles(projection, ["user", "assistant", "user", "assistant"]);
  assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
  assertUserMessagesInclude(projection, [
    PROVIDER_THREAD_RESUME_FIRST_PROMPT,
    PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  ]);
  assertAssistantTextIncludes(projection, FIRST_FINAL);
  assertAssistantTextIncludes(projection, SECOND_FINAL);
  assert.lengthOf(projection.providerThreads, 1);
});

describe("orchestrator replay recovery", () => {
  it.effect(
    "resumes a provider-native Codex thread after recreating the orchestrator runtime",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // Checkpoint against a throwaway git workspace: with no override the
          // scope cwd falls back to process.cwd(), and a cold full-repo
          // baseline capture on CI outlives the scenario wait budget.
          const workspace = yield* checkpointWorkspace("provider_thread_resume");
          const transcript = yield* readCodexTranscript(workspace);
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* Effect.acquireRelease(
            fs.makeTempDirectory({
              prefix: "t3-orchestration-v2-recovery-",
            }),
            (directory) =>
              fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
          );
          yield* fs.makeDirectory(tempDir, { recursive: true });
          const dbPath = path.join(tempDir, "state.sqlite");
          const driver = yield* CodexReplay.makeReplayDriver(transcript);
          const materialized = yield* materializeFixtureInput({
            scenario: "provider_thread_resume",
            fixtureInput: {
              steps: [
                { type: "message", text: PROVIDER_THREAD_RESUME_FIRST_PROMPT },
                { type: "message", text: PROVIDER_THREAD_RESUME_SECOND_PROMPT },
              ],
            },
            driver: ProviderDriverKind.make("codex"),
            modelSelection: CODEX_MODEL_SELECTION,
          });
          const { phase1Commands, phase1Steps, phase2Commands, phase2Steps } =
            splitAfterFirstIdle(materialized);

          const harness = {
            ...CodexOrchestratorReplayHarness,
            makeProviderAdapterRegistryLayer: () =>
              makeCodexProviderAdapterRegistryReplayLayer({ transcript, driver }),
          };
          const options = {
            databaseLayer: makeSqlitePersistenceLive(dbPath).pipe(
              Layer.provide(NodeServices.layer),
            ),
          };

          yield* runOrchestratorV2ProviderReplayScenario(
            {
              name: "provider_thread_resume/codex:first-runtime",
              transcript,
              commands: phase1Commands,
              steps: phase1Steps,
              projectionThreadIds: materialized.projectionThreadIds,
              runtimePolicyOverride: { cwd: workspace },
            },
            harness,
            options,
          );

          const result = yield* runOrchestratorV2ProviderReplayScenario(
            {
              name: "provider_thread_resume/codex:second-runtime",
              transcript,
              commands: phase2Commands,
              steps: phase2Steps,
              projectionThreadIds: materialized.projectionThreadIds,
              runtimePolicyOverride: { cwd: workspace },
            },
            harness,
            options,
          );

          assertBaseProjection({
            result,
            transcript,
            runCount: 2,
            runStatuses: ["completed", "completed"],
          });
          const projection = projectionFor(result, transcript.scenario);
          assertSemanticProjectionIntegrity(projection);
          assertRunOrdinals(projection, [1, 2]);
          assertConversationMessageRoles(projection, ["user", "assistant", "user", "assistant"]);
          assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
          assertUserMessagesInclude(projection, [
            PROVIDER_THREAD_RESUME_FIRST_PROMPT,
            PROVIDER_THREAD_RESUME_SECOND_PROMPT,
          ]);
          assertAssistantTextIncludes(projection, FIRST_FINAL);
          assertAssistantTextIncludes(projection, SECOND_FINAL);
          assert.lengthOf(projection.providerThreads, 1);
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer)),
        ),
      ),
  );

  it.effect(
    "resumes a provider-native Cursor thread after recreating the orchestrator runtime",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const transcript = yield* readCursorTranscript();
          const runner = makeCursorAgentSdkReplayRunner(transcript);
          yield* runCursorRecovery({ transcript, runner });
          yield* runner.assertComplete;
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer)),
        ),
      ),
  );

  it.effect("reconciles persisted effects before the effect worker restarts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = yield* readCursorTranscript();
        const runner = makeCursorAgentSdkReplayRunner(transcript);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* Effect.acquireRelease(
          fs.makeTempDirectory({
            prefix: "t3-orchestration-v2-cursor-recovery-",
          }),
          (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
        );
        yield* fs.makeDirectory(tempDir, { recursive: true });
        const dbPath = path.join(tempDir, "state.sqlite");
        const materialized = yield* materializeFixtureInput({
          scenario: "provider_thread_resume",
          fixtureInput: {
            steps: [
              { type: "message", text: PROVIDER_THREAD_RESUME_FIRST_PROMPT },
              { type: "message", text: PROVIDER_THREAD_RESUME_SECOND_PROMPT },
            ],
          },
          driver: ProviderDriverKind.make("cursor"),
          modelSelection: CURSOR_MODEL_SELECTION,
        });
        const { phase1Commands, phase1Steps, phase2Commands, phase2Steps } =
          splitAfterFirstIdle(materialized);
        const options = {
          databaseLayer: makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
        };
        const harness = {
          ...CursorOrchestratorReplayHarness,
          makeProviderAdapterRegistryLayer: () =>
            makeCursorProviderAdapterRegistryReplayLayer(transcript, {
              runner,
              assertCompleteOnFinalize: false,
            }),
        };

        yield* Effect.scoped(
          runOrchestratorV2ProviderReplayScenario(
            {
              name: "provider_thread_resume/cursor:reconcile-first-runtime",
              transcript,
              commands: phase1Commands,
              steps: phase1Steps,
              projectionThreadIds: materialized.projectionThreadIds,
              runtimePolicyOverride: { cwd: tempDir },
              runtimeRestart: true,
            },
            harness,
            options,
          ),
        );

        // Persisted work left behind by the dead process: a pending row that
        // must be claimed exactly once after reconciliation, and a running
        // row that reconciliation must requeue before it can execute again.
        // The deterministic runtime's clock starts at epoch, so persisted
        // rows must be seeded at epoch to be immediately claimable.
        const pendingEffectId = "restart-reconcile-pending";
        const runningEffectId = "restart-reconcile-running";
        const seededAt = "1970-01-01T00:00:00.000Z";
        const seed = new NodeSqlite.DatabaseSync(dbPath);
        try {
          const insert = seed.prepare(
            `INSERT INTO orchestration_v2_effect_outbox (
                effect_id, command_id, thread_id, effect_type, payload_json,
                status, attempt_count, available_at, created_at, updated_at
              ) VALUES (?, ?, ?, 'terminal.cleanup', '{"type":"terminal.cleanup"}', ?, ?, ?, ?, ?)`,
          );
          insert.run(
            pendingEffectId,
            "restart-reconcile-command-pending",
            "restart-reconcile-thread-pending",
            "pending",
            0,
            seededAt,
            seededAt,
            seededAt,
          );
          insert.run(
            runningEffectId,
            "restart-reconcile-command-running",
            "restart-reconcile-thread-running",
            "running",
            1,
            seededAt,
            seededAt,
            seededAt,
          );
        } finally {
          seed.close();
        }

        yield* Effect.scoped(
          runOrchestratorV2ProviderReplayScenario(
            {
              name: "provider_thread_resume/cursor:reconcile-second-runtime",
              transcript,
              commands: phase2Commands,
              steps: phase2Steps,
              projectionThreadIds: materialized.projectionThreadIds,
              runtimePolicyOverride: { cwd: tempDir },
              runtimeRestart: true,
            },
            harness,
            options,
          ),
        );

        const check = new NodeSqlite.DatabaseSync(dbPath);
        try {
          const rows = check
            .prepare(
              `SELECT effect_id, status, attempt_count, last_error
                 FROM orchestration_v2_effect_outbox
                 WHERE effect_id IN (?, ?)`,
            )
            .all(pendingEffectId, runningEffectId) as unknown as ReadonlyArray<{
            readonly effect_id: string;
            readonly status: string;
            readonly attempt_count: number;
            readonly last_error: string | null;
          }>;
          const pendingRow = rows.find((row) => row.effect_id === pendingEffectId);
          const runningRow = rows.find((row) => row.effect_id === runningEffectId);
          // A pre-reconciliation claim would surface as a second attempt
          // after reconciliation requeues the claimed row.
          assert.deepStrictEqual(pendingRow, {
            effect_id: pendingEffectId,
            status: "succeeded",
            attempt_count: 1,
            last_error: null,
          });
          assert.deepStrictEqual(runningRow, {
            effect_id: runningEffectId,
            status: "succeeded",
            attempt_count: 2,
            last_error: null,
          });
        } finally {
          check.close();
        }

        // A restart with the worker disabled must not start the daemon after
        // reconciliation — persisted work stays parked for manual inspection.
        const parkedEffectId = "restart-reconcile-parked";
        const seedParked = new NodeSqlite.DatabaseSync(dbPath);
        try {
          seedParked
            .prepare(
              `INSERT INTO orchestration_v2_effect_outbox (
                  effect_id, command_id, thread_id, effect_type, payload_json,
                  status, attempt_count, available_at, created_at, updated_at
                ) VALUES (?, ?, ?, 'terminal.cleanup', '{"type":"terminal.cleanup"}', 'pending', 0, ?, ?, ?)`,
            )
            .run(
              parkedEffectId,
              "restart-reconcile-command-parked",
              "restart-reconcile-thread-parked",
              seededAt,
              seededAt,
              seededAt,
            );
        } finally {
          seedParked.close();
        }

        yield* Effect.scoped(
          runOrchestratorV2ProviderReplayScenario(
            {
              name: "provider_thread_resume/cursor:reconcile-worker-disabled",
              transcript,
              commands: [],
              steps: [],
              projectionThreadIds: materialized.projectionThreadIds,
              runtimePolicyOverride: { cwd: tempDir },
              runtimeRestart: true,
            },
            harness,
            { ...options, runEffectWorker: false },
          ),
        );

        const checkParked = new NodeSqlite.DatabaseSync(dbPath);
        try {
          const parkedRow = checkParked
            .prepare(
              `SELECT status, attempt_count
                 FROM orchestration_v2_effect_outbox
                 WHERE effect_id = ?`,
            )
            .get(parkedEffectId) as unknown as {
            readonly status: string;
            readonly attempt_count: number;
          };
          assert.deepStrictEqual(parkedRow, { status: "pending", attempt_count: 0 });
        } finally {
          checkParked.close();
        }
      }).pipe(
        provideDeterministicTestRuntime,
        Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer)),
      ),
    ),
  );
});
