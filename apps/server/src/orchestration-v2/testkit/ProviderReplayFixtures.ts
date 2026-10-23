import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent, ProviderReplayTranscript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
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
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

// Each driver's fixtures run from its own <Provider>ReplayFixtures.integration.test.ts,
// so a focused run loads one adapter. A fixture for a driver missing here would
// silently never run, so loading this module fails instead.
const DRIVERS_WITH_REPLAY_FIXTURE_FILES = new Set([
  "acpRegistry",
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "muse",
  "opencode",
  "pi",
]);
for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
  for (const provider of fixture.providers) {
    if (!DRIVERS_WITH_REPLAY_FIXTURE_FILES.has(provider.driver)) {
      throw new Error(
        `${fixture.name}/${provider.driver} has no ReplayFixtures test file to run it.`,
      );
    }
  }
}

export const readReplayFixtureTranscript = Effect.fn("readOrchestratorReplayTranscript")(function* (
  file: URL,
) {
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

export interface ReplayFixtureCase {
  readonly fixtureName: string;
  readonly buildInput: () => OrchestratorFixtureInput;
  readonly driver: ProviderOrchestratorReplayVariant;
  readonly transformTranscript?: (transcript: ProviderReplayTranscript) => ProviderReplayTranscript;
}

export interface ReplayFixtureRun<
  Transcript extends ProviderReplayTranscript,
  Error,
  WorkspaceError = never,
> extends ReplayFixtureCase {
  readonly harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>;
  /** Rewrites recorded workspace paths to the replay workspace, for drivers that record them. */
  readonly materializeWorkspace?: (
    transcript: ProviderReplayTranscript,
    workspace: string,
  ) => Effect.Effect<ProviderReplayTranscript, WorkspaceError>;
}

const runFixtureProvider = Effect.fn("runOrchestratorReplayFixture")(function* <
  Transcript extends ProviderReplayTranscript,
  Error,
  WorkspaceError,
>(input: ReplayFixtureRun<Transcript, Error, WorkspaceError>) {
  const recordedTranscript = yield* readReplayFixtureTranscript(input.driver.transcriptFile);
  const rawTranscript = input.transformTranscript?.(recordedTranscript) ?? recordedTranscript;
  const replayTranscript = materializeReplayTranscriptRuntimeInstructions(
    transcriptEntriesThroughLabel(rawTranscript, input.driver.transcriptEntriesThroughLabel),
    { driver: input.driver.driver, model: input.driver.modelSelection.model },
  );
  const fixtureInput = input.buildInput();
  const workspace = yield* checkpointWorkspace(input.fixtureName, fixtureInput.workspaceFiles);
  const transcript = yield* input.harness.decodeTranscript(
    input.materializeWorkspace === undefined
      ? replayTranscript
      : yield* input.materializeWorkspace(replayTranscript, workspace),
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
  assert.deepEqual(latestRun?.modelSelection, input.driver.modelSelection);
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

/** Replays one fixture variant through OrchestratorV2 and runs the shared output checks. */
export function runReplayFixture<
  Transcript extends ProviderReplayTranscript,
  Error,
  WorkspaceError = never,
>(input: ReplayFixtureRun<Transcript, Error, WorkspaceError>) {
  return runFixtureProvider(input).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
}

export function findReplayFixture(name: string) {
  return ORCHESTRATOR_REPLAY_FIXTURES.find((fixture) => fixture.name === name);
}

/**
 * Registers one test per recorded fixture variant of `driver`. Call it inside the
 * provider file's `describe`. `run` picks the harness for each variant.
 */
export function itRunsReplayFixtures<E>(
  driver: string,
  run: (input: ReplayFixtureCase) => Effect.Effect<unknown, E>,
) {
  it.effect.each(
    ORCHESTRATOR_REPLAY_FIXTURES.flatMap((fixture) =>
      fixture.providers
        .filter((provider) => provider.driver === driver)
        .map((provider) => [fixture.name, provider.driver, fixture, provider] as const),
    ),
  )("runs %s/%s through OrchestratorV2 using deterministic replay", ([, , fixture, provider]) =>
    run({ fixtureName: fixture.name, buildInput: fixture.buildInput, driver: provider }),
  );
}
