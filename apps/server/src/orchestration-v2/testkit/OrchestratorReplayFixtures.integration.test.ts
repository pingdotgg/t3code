import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type {
  OrchestrationV2DomainEvent,
  ProviderReplayEntry,
  ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { CursorOrchestratorReplayHarness } from "../Adapters/CursorAdapterV2.testkit.ts";
import { AcpRegistryOrchestratorReplayHarness } from "../Adapters/AcpRegistryAdapterV2.testkit.ts";
import { GrokOrchestratorReplayHarness } from "../Adapters/GrokAdapterV2.testkit.ts";
import { KiroOrchestratorReplayHarness } from "../Adapters/KiroAdapterV2.testkit.ts";
import { OpenCodeOrchestratorReplayHarness } from "../Adapters/OpenCodeAdapterV2.testkit.ts";
import {
  OPENCODE2_HTTP_PROTOCOL,
  OpenCode2OrchestratorReplayHarness,
} from "../Adapters/OpenCode2AdapterV2.testkit.ts";
import { PiOrchestratorReplayHarness } from "../Adapters/PiAdapterV2.testkit.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import { messageRestartInput } from "./fixtures/message_steering/input.ts";
import {
  assertProviderNativeSubagentRootTurns,
  materializeFixtureInput,
  type OrchestratorFixtureInput,
  type ProviderOrchestratorReplayVariant,
} from "./fixtures/shared.ts";
import {
  runOrchestratorV2ProviderReplayScenario,
  type OrchestratorV2ProviderReplayHarness,
} from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import {
  materializeReplayTranscriptRuntimeInstructions,
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "./ReplayTranscriptNdjson.ts";

const readTranscript = Effect.fn("readOrchestratorReplayTranscript")(function* (file: URL) {
  return yield* readProviderReplayTranscript(file);
}, Effect.provide(NodeServices.layer));

function normalizeTestError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function transcriptEntriesThroughLabel(
  transcript: ProviderReplayTranscript,
  label: string | undefined,
): ProviderReplayTranscript {
  if (label === undefined) {
    return transcript;
  }
  const entryIndex = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === label,
  );
  if (entryIndex === -1) {
    throw new Error(`${transcript.scenario} is missing inbound transcript label ${label}.`);
  }
  return {
    ...transcript,
    entries: transcript.entries.slice(0, entryIndex + 1),
  };
}

function isStreamingAssistantEvent(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "node.updated":
      return event.payload.kind === "assistant_message" && event.payload.status === "running";
    case "message.updated":
      return event.payload.role === "assistant" && event.payload.streaming;
    case "turn-item.updated":
      return event.payload.type === "assistant_message" && event.payload.streaming;
    default:
      return false;
  }
}

const runFixtureProvider = Effect.fn("runOrchestratorReplayFixture")(function* <
  Transcript extends ProviderReplayTranscript,
  Error,
>(input: {
  readonly fixtureName: string;
  readonly buildInput: () => OrchestratorFixtureInput;
  readonly driver: ProviderOrchestratorReplayVariant;
  readonly harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>;
  readonly transformTranscript?: (transcript: ProviderReplayTranscript) => ProviderReplayTranscript;
}) {
  const recordedTranscript = yield* readTranscript(input.driver.transcriptFile);
  const rawTranscript = input.transformTranscript?.(recordedTranscript) ?? recordedTranscript;
  const replayTranscript = materializeReplayTranscriptRuntimeInstructions(
    transcriptEntriesThroughLabel(rawTranscript, input.driver.transcriptEntriesThroughLabel),
    { driver: input.driver.driver, model: input.driver.modelSelection.model },
  );
  const fixtureInput = input.buildInput();
  const workspace = yield* checkpointWorkspace(input.fixtureName, fixtureInput.workspaceFiles);
  const transcript = yield* input.harness.decodeTranscript(
    input.driver.driver === "codex"
      ? materializeReplayTranscriptWorkspace(replayTranscript, workspace)
      : replayTranscript,
  );
  const materialized = yield* materializeFixtureInput({
    scenario: input.fixtureName,
    fixtureInput,
    driver: input.driver.driver,
    modelSelection: input.driver.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const scenario = {
    name: `${input.fixtureName}/${input.driver.driver}`,
    transcript,
    commands: materialized.commands,
    steps: materialized.steps,
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: {
      ...input.driver.runtimePolicyOverride,
      cwd: workspace,
    },
  };

  const result = yield* runOrchestratorV2ProviderReplayScenario(
    scenario,
    input.harness,
    input.driver.runContinuationWorker === true ? { runContinuationWorker: true } : {},
  ).pipe(provideDeterministicTestRuntime);
  input.driver.assertOutput(result, transcript);
  assertProviderNativeSubagentRootTurns(result);
  const expectedAbsentWorkspacePaths = input.driver.expectedAbsentWorkspacePaths;
  if (expectedAbsentWorkspacePaths !== undefined) {
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const relativePath of expectedAbsentWorkspacePaths) {
        assert.isFalse(
          yield* fs.exists(path.join(workspace, relativePath)),
          `${input.fixtureName}/${input.driver.driver} must not create ${relativePath} in the replay workspace`,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer));
  }
  assert.isFalse(
    result.domainEvents.some(isStreamingAssistantEvent),
    "buffered delivery must not persist streaming assistant artifacts",
  );
  const projectionThreadId = materialized.projectionThreadIds[0];
  assert.isDefined(projectionThreadId);
  const projection = result.projections.get(projectionThreadId);
  assert.isDefined(projection);
  const latestRun = projection.runs.at(-1);
  // A `set_model` step moves later runs to another model of the same instance.
  const finalModel = fixtureInput.steps.findLast((step) => step.type === "set_model");
  assert.deepEqual(
    latestRun?.modelSelection,
    finalModel?.type === "set_model"
      ? { ...input.driver.modelSelection, model: finalModel.model }
      : input.driver.modelSelection,
  );
  if (projection.runs.some((run) => run.status === "completed")) {
    const threadStartCheckpoint = projection.checkpoints.find(
      (checkpoint) => checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null,
    );
    assert.isDefined(
      threadStartCheckpoint,
      "completed threads must retain an addressable thread-start checkpoint",
    );
    assert.equal(threadStartCheckpoint.status, "ready");
  }
  return result;
});

function runFixtureProviderWithRegisteredHarness(input: {
  readonly fixtureName: string;
  readonly buildInput: () => OrchestratorFixtureInput;
  readonly driver: ProviderOrchestratorReplayVariant;
  readonly transformTranscript?: (transcript: ProviderReplayTranscript) => ProviderReplayTranscript;
}) {
  switch (input.driver.driver) {
    case "codex":
      return runFixtureProvider({
        ...input,
        harness: CodexOrchestratorReplayHarness,
      }).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
    case "claudeAgent":
      return runFixtureProvider({
        ...input,
        harness: ClaudeOrchestratorReplayHarness,
      }).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
    case "cursor":
      return runFixtureProvider({
        ...input,
        harness: CursorOrchestratorReplayHarness,
      }).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
    case "grok":
      return runFixtureProvider({
        ...input,
        harness: GrokOrchestratorReplayHarness,
      }).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
    case "kiro":
      return runFixtureProvider({
        ...input,
        harness: KiroOrchestratorReplayHarness,
      }).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
    case "acpRegistry":
      return runFixtureProvider({
        ...input,
        harness: AcpRegistryOrchestratorReplayHarness,
      }).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
    case "opencode":
      // One driver, two runtimes: the transcript's protocol says which one recorded it.
      return readTranscript(input.driver.transcriptFile).pipe(
        Effect.flatMap((transcript) =>
          transcript.protocol === OPENCODE2_HTTP_PROTOCOL
            ? runFixtureProvider({ ...input, harness: OpenCode2OrchestratorReplayHarness })
            : runFixtureProvider({ ...input, harness: OpenCodeOrchestratorReplayHarness }),
        ),
        Effect.mapError(normalizeTestError),
        Effect.scoped,
      );
    case "pi":
      return runFixtureProvider({
        ...input,
        harness: PiOrchestratorReplayHarness,
      }).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
    default:
      return Effect.die(
        new Error(`No replay harness registered for provider ${input.driver.driver}.`),
      );
  }
}

describe("orchestrator replay fixtures", () => {
  it.effect.each(
    ORCHESTRATOR_REPLAY_FIXTURES.flatMap((fixture) =>
      fixture.providers.map(
        (provider) => [fixture.name, provider.driver, fixture, provider] as const,
      ),
    ),
  )("runs %s/%s through OrchestratorV2 using deterministic replay", ([, , fixture, provider]) =>
    runFixtureProviderWithRegisteredHarness({
      fixtureName: fixture.name,
      buildInput: fixture.buildInput,
      driver: provider,
    }),
  );

  const steeringFixture = ORCHESTRATOR_REPLAY_FIXTURES.find(
    (fixture) => fixture.name === "message_steering",
  );
  const cursorSteeringProvider = steeringFixture?.providers.find(
    (provider) => provider.driver === "cursor",
  );
  if (cursorSteeringProvider !== undefined) {
    it.effect("executes explicit Cursor restart_active through the recorded SDK boundary", () =>
      runFixtureProviderWithRegisteredHarness({
        fixtureName: "message_steering",
        buildInput: messageRestartInput,
        driver: cursorSteeringProvider,
      }),
    );
  }

  // A later OpenCode may change an execution start's shape; the client then
  // reads it as `unreadable.execution.started`. A subagent's turn and a
  // background follow-up must still start from it.
  it.effect.each(
    (
      [
        ["opencode2_subagent", "session.execution.started.2"],
        ["opencode2_background", "session.execution.started.3"],
      ] as const
    ).flatMap(([fixtureName, label]) => {
      const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find(
        (candidate) => candidate.name === fixtureName,
      );
      const provider = fixture?.providers[0];
      return fixture === undefined || provider === undefined
        ? []
        : [[fixtureName, label, fixture, provider] as const];
    }),
  )(
    "runs %s when %s is an execution start this build cannot decode",
    ([fixtureName, label, fixture, provider]) =>
      runFixtureProviderWithRegisteredHarness({
        fixtureName,
        buildInput: fixture.buildInput,
        driver: provider,
        transformTranscript: (transcript) => ({
          ...transcript,
          entries: transcript.entries.map((entry) =>
            entry.type === "emit_inbound" && entry.label === label
              ? undecodableEvent(entry)
              : entry,
          ),
        }),
      }),
  );
});

/** The same event with an envelope this build cannot decode, as a newer OpenCode may send. */
function undecodableEvent(entry: ProviderReplayEntry): ProviderReplayEntry {
  if (entry.type !== "emit_inbound") return entry;
  const frame = entry.frame as { readonly event: Record<string, unknown> };
  return { ...entry, frame: { ...frame, event: { ...frame.event, durable: "not-an-envelope" } } };
}
