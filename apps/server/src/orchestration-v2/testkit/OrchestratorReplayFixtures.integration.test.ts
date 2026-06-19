import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent, ProviderReplayTranscript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { CursorOrchestratorReplayHarness } from "../Adapters/CursorAdapterV2.testkit.ts";
import { AcpRegistryOrchestratorReplayHarness } from "../Adapters/AcpRegistryAdapterV2.testkit.ts";
import { GrokOrchestratorReplayHarness } from "../Adapters/GrokAdapterV2.testkit.ts";
import { OpenCodeOrchestratorReplayHarness } from "../Adapters/OpenCodeAdapterV2.testkit.ts";
import { layer as idAllocatorLayer } from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import { messageRestartInput } from "./fixtures/message_steering/input.ts";
import {
  materializeFixtureInput,
  type OrchestratorFixtureInput,
  type ProviderOrchestratorReplayVariant,
} from "./fixtures/shared.ts";
import {
  runOrchestratorV2ProviderReplayScenario,
  type OrchestratorV2ProviderReplayHarness,
} from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import { decodeProviderReplayNdjson } from "./ReplayTranscriptNdjson.ts";

const readTranscript = Effect.fn("readOrchestratorReplayTranscript")(function* (file: URL) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(decodeURIComponent(file.pathname));
  return yield* decodeProviderReplayNdjson(text);
}, Effect.provide(NodeServices.layer));

function normalizeTestError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
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
  readonly provider: ProviderOrchestratorReplayVariant;
  readonly harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>;
  readonly enableAssistantStreaming?: boolean;
}) {
  const rawTranscript = yield* readTranscript(input.provider.transcriptFile);
  const transcript = yield* input.harness.decodeTranscript(rawTranscript);
  const workspace = yield* checkpointWorkspace(input.fixtureName);
  const materialized = yield* materializeFixtureInput({
    scenario: input.fixtureName,
    fixtureInput: input.buildInput(),
    modelSelection: input.provider.modelSelection,
  }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime);
  const scenario = {
    name: `${input.fixtureName}/${input.provider.provider}`,
    transcript,
    commands: materialized.commands,
    steps: materialized.steps,
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: {
      ...input.provider.runtimePolicyOverride,
      cwd: workspace,
    },
  };

  const result = yield* runOrchestratorV2ProviderReplayScenario(scenario, input.harness, {
    enableAssistantStreaming: input.enableAssistantStreaming ?? false,
  }).pipe(provideDeterministicTestRuntime);

  input.provider.assertOutput(result, transcript);
  if (input.enableAssistantStreaming !== true) {
    assert.isFalse(
      result.domainEvents.some(isStreamingAssistantEvent),
      "buffered delivery must not persist streaming assistant artifacts",
    );
  }
  const projectionThreadId = materialized.projectionThreadIds[0];
  assert.isDefined(projectionThreadId);
  const projection = result.projections.get(projectionThreadId);
  assert.isDefined(projection);
  const latestRun = projection.runs.at(-1);
  assert.deepEqual(latestRun?.modelSelection, input.provider.modelSelection);
  return result;
});

function runFixtureProviderWithRegisteredHarness(input: {
  readonly fixtureName: string;
  readonly buildInput: () => OrchestratorFixtureInput;
  readonly provider: ProviderOrchestratorReplayVariant;
  readonly enableAssistantStreaming?: boolean;
}) {
  switch (input.provider.provider) {
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
    case "acpRegistry":
      return runFixtureProvider({
        ...input,
        harness: AcpRegistryOrchestratorReplayHarness,
      }).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
    case "opencode":
      return runFixtureProvider({
        ...input,
        harness: OpenCodeOrchestratorReplayHarness,
      }).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
    default:
      return Effect.die(
        new Error(`No replay harness registered for provider ${input.provider.provider}.`),
      );
  }
}

describe("orchestrator replay fixtures", () => {
  for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
    for (const provider of fixture.providers) {
      it.effect(
        `runs ${fixture.name}/${provider.provider} through OrchestratorV2 using deterministic replay`,
        () =>
          runFixtureProviderWithRegisteredHarness({
            fixtureName: fixture.name,
            buildInput: fixture.buildInput,
            provider,
          }),
      );
    }
  }

  const steeringFixture = ORCHESTRATOR_REPLAY_FIXTURES.find(
    (fixture) => fixture.name === "message_steering",
  );
  const cursorSteeringProvider = steeringFixture?.providers.find(
    (provider) => provider.provider === "cursor",
  );
  if (cursorSteeringProvider !== undefined) {
    it.effect("executes explicit Cursor restart_active through the recorded SDK boundary", () =>
      runFixtureProviderWithRegisteredHarness({
        fixtureName: "message_steering",
        buildInput: messageRestartInput,
        provider: cursorSteeringProvider,
      }),
    );
  }

  const simpleFixture = ORCHESTRATOR_REPLAY_FIXTURES.find((fixture) => fixture.name === "simple");
  const simpleCursorProvider = simpleFixture?.providers.find(
    (provider) => provider.provider === "cursor",
  );
  if (simpleFixture !== undefined && simpleCursorProvider !== undefined) {
    it.effect("streams Cursor assistant artifacts only when streaming is enabled", () =>
      Effect.gen(function* () {
        const result = yield* runFixtureProviderWithRegisteredHarness({
          fixtureName: "simple-cursor-streaming",
          buildInput: simpleFixture.buildInput,
          provider: simpleCursorProvider,
          enableAssistantStreaming: true,
        });

        assert.deepEqual(
          Array.from(
            new Set(
              result.domainEvents.filter(isStreamingAssistantEvent).map((event) => event.type),
            ),
          ).toSorted(),
          ["message.updated", "node.updated", "turn-item.updated"],
        );
      }),
    );
  }
});
