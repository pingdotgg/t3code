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
import { decodeProviderReplayNdjson } from "./ReplayTranscriptNdjson.ts";

const FIRST_FINAL = "provider thread resume fixture first turn complete";
const SECOND_FINAL = "provider thread resume fixture second turn complete";

const decodeCodexTranscript = Schema.decodeUnknownEffect(
  CodexReplay.CodexAppServerReplayTranscript,
);
const readRawTranscript = Effect.fn("readRecoveryTranscript")(function* (file: URL) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(decodeURIComponent(file.pathname));
  return yield* decodeProviderReplayNdjson(text);
});
const readCodexTranscript = Effect.fn("readCodexRecoveryTranscript")(function* () {
  const transcript = yield* readRawTranscript(
    new URL("./fixtures/provider_thread_resume/codex_transcript.ndjson", import.meta.url),
  );
  return yield* decodeCodexTranscript(transcript);
});
const readCursorTranscript = Effect.fn("readCursorRecoveryTranscript")(function* () {
  const transcript = yield* readRawTranscript(
    new URL("./fixtures/provider_thread_resume/cursor_transcript.ndjson", import.meta.url),
  );
  return yield* CursorOrchestratorReplayHarness.decodeTranscript(transcript);
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
          const transcript = yield* readCodexTranscript();
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
});
