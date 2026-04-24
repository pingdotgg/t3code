import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as CodexReplay from "effect-codex-app-server/replay";
import { mkdirSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CodexOrchestratorReplayHarness,
  makeCodexProviderAdapterRegistryReplayLayer,
} from "../Adapters/CodexAdapterV2.testkit.ts";
import { layer as idAllocatorLayer } from "../IdAllocator.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  materializeFixtureInput,
  type MaterializedOrchestratorFixtureInput,
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

const FIRST_PROMPT = "Respond with exactly: provider thread resume fixture first turn complete";
const SECOND_PROMPT =
  "Using the conversation history available in this resumed thread, first repeat the exact final answer you gave in the previous turn. Then on a new line write exactly: provider thread resume fixture second turn complete";
const FIRST_FINAL = "provider thread resume fixture first turn complete";
const SECOND_FINAL = "provider thread resume fixture second turn complete";

async function readCodexTranscript(): Promise<CodexReplay.CodexAppServerReplayTranscript> {
  const text = await readFile(
    new URL("./fixtures/provider_thread_resume/codex_transcript.ndjson", import.meta.url),
    "utf8",
  );
  const transcript = await Effect.runPromise(decodeProviderReplayNdjson(text));
  return Schema.decodeUnknownSync(CodexReplay.CodexAppServerReplayTranscript)(transcript);
}

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

describe("orchestrator replay recovery", () => {
  it("resumes a provider-native Codex thread after recreating the orchestrator runtime", async () => {
    const transcript = await readCodexTranscript();
    const tempDir = mkdtempSync(path.join(tmpdir(), "t3-orchestration-v2-recovery-"));
    mkdirSync(tempDir, { recursive: true });
    const dbPath = path.join(tempDir, "state.sqlite");

    await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* CodexReplay.makeReplayDriver(transcript);
        const materialized = yield* materializeFixtureInput({
          scenario: "provider_thread_resume",
          fixtureInput: {
            steps: [
              { type: "message", text: FIRST_PROMPT },
              { type: "message", text: SECOND_PROMPT },
            ],
          },
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
        });
        const { phase1Commands, phase1Steps, phase2Commands, phase2Steps } =
          splitAfterFirstIdle(materialized);

        const harness = {
          ...CodexOrchestratorReplayHarness,
          makeProviderAdapterRegistryLayer: () =>
            makeCodexProviderAdapterRegistryReplayLayer({ transcript, driver }),
        };
        const options = {
          databaseLayer: makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
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
        assertUserMessagesInclude(projection, [FIRST_PROMPT, SECOND_PROMPT]);
        assertAssistantTextIncludes(projection, FIRST_FINAL);
        assertAssistantTextIncludes(projection, SECOND_FINAL);
        assert.lengthOf(projection.providerThreads, 1);
      }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime),
    );
  });
});
