import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2DomainEvent,
  type ProviderReplayEntry,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { CursorOrchestratorReplayHarness } from "../Adapters/CursorAdapterV2.testkit.ts";
import { AcpRegistryOrchestratorReplayHarness } from "../Adapters/AcpRegistryAdapterV2.testkit.ts";
import { GrokOrchestratorReplayHarness } from "../Adapters/GrokAdapterV2.testkit.ts";
import { OpenCodeOrchestratorReplayHarness } from "../Adapters/OpenCodeAdapterV2.testkit.ts";
import {
  OPENCODE2_HTTP_PROTOCOL,
  OpenCode2OrchestratorReplayHarness,
} from "../Adapters/OpenCode2AdapterV2.testkit.ts";
import {
  materializeMuseReplayWorkspace,
  MuseOrchestratorReplayHarness,
} from "../Adapters/MuseAdapterV2.testkit.ts";
import { PiOrchestratorReplayHarness } from "../Adapters/PiAdapterV2.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import { messageRestartInput } from "./fixtures/message_steering/input.ts";
import {
  assertProviderNativeSubagentRootTurns,
  materializeFixtureInput,
  SIMPLE_PROMPT,
  projectionFor,
  type OrchestratorFixtureInput,
  type ProviderOrchestratorReplayVariant,
} from "./fixtures/shared.ts";
import {
  runOrchestratorV2ProviderReplayScenario,
  layerProviderReplay,
  type OrchestratorV2ProviderReplayHarness,
} from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";

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
      : input.driver.driver === "muse"
        ? yield* materializeMuseReplayWorkspace(replayTranscript, workspace)
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
    case "acpRegistry":
      return runFixtureProvider({
        ...input,
        harness: AcpRegistryOrchestratorReplayHarness,
      }).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
    case "opencode":
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
    case "muse":
      return runFixtureProvider({
        ...input,
        harness: MuseOrchestratorReplayHarness,
      }).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
    default:
      return Effect.die(
        new Error(`No replay harness registered for provider ${input.driver.driver}.`),
      );
  }
}

describe("orchestrator replay fixtures", () => {
  it.effect.each([
    { name: "open", firstTurn: false, code: -32602 },
    { name: "switch", firstTurn: true, code: -32602 },
    { name: "authentication", firstTurn: false, code: -32000 },
  ])("preserves the ACP model-write $name failure through orchestration", (testCase) =>
    Effect.gen(function* () {
      const name = `acp_model_write_${testCase.name}`;
      const sessionId = "grok-replay-session-1";
      const rejectedModel = "replay-model-b";
      const modelSelection = {
        instanceId: ProviderInstanceId.make("acpRegistry"),
        model: rejectedModel,
      };
      const recorded = yield* readTranscript(
        new URL("./fixtures/simple/registry_transcript.ndjson", import.meta.url),
      );
      const sessionIndex = recorded.entries.findIndex(
        (entry) => "label" in entry && entry.label === "session.created",
      );
      assert.isAtLeast(sessionIndex, 0);
      const transcript = {
        ...recorded,
        scenario: name,
        entries: [
          ...recorded.entries.slice(0, sessionIndex),
          {
            type: "emit_inbound",
            label: "session.created",
            frame: {
              kind: "response",
              method: "session/new",
              result: {
                sessionId,
                configOptions: [
                  {
                    id: "model",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: "replay-model-a",
                    options: [
                      { value: "replay-model-a", name: "Model A" },
                      { value: rejectedModel, name: "Model B" },
                    ],
                  },
                ],
              },
            },
          },
          ...(testCase.firstTurn
            ? recorded.entries
                .slice(sessionIndex + 1)
                .filter((entry) => entry.type !== "runtime_exit")
            : []),
          {
            type: "expect_outbound",
            label: "session.set_model",
            frame: {
              kind: "request",
              method: "session/set_config_option",
              params: { sessionId, configId: "model", value: rejectedModel },
            },
          },
          {
            type: "emit_inbound",
            label: "session.set_model.rejected",
            frame: {
              kind: "response",
              method: "session/set_config_option",
              error: {
                code: testCase.code,
                message: testCase.code === -32602 ? "Invalid provider" : "Authentication required",
              },
            },
          },
        ],
      } satisfies ProviderReplayTranscript;
      const materialized = yield* materializeFixtureInput({
        scenario: name,
        fixtureInput: {
          steps: Array.from({ length: testCase.firstTurn ? 2 : 1 }, () => ({
            type: "message" as const,
            text: SIMPLE_PROMPT,
          })),
        },
        driver: ProviderDriverKind.make("acpRegistry"),
        modelSelection: {
          ...modelSelection,
          model: testCase.firstTurn ? "replay-model-a" : rejectedModel,
        },
      });
      const scenario = {
        ...materialized,
        name,
        transcript: yield* AcpRegistryOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptRuntimeInstructions(transcript, {
            driver: ProviderDriverKind.make("acpRegistry"),
            model: "replay-model-a",
          }),
        ),
        runtimePolicyOverride: { cwd: yield* checkpointWorkspace(name) },
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        if (testCase.firstTurn) yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
        for (const [index, command] of materialized.commands.entries()) {
          const isFirstTurn =
            testCase.firstTurn && command.type === "message.dispatch" && index === 1;
          yield* orchestrator.dispatch(
            command.type === "message.dispatch" && !isFirstTurn
              ? { ...command, modelSelection }
              : command,
          );
          if (isFirstTurn) {
            // Wait for the committed terminal event before switching models.
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) => event.type === "run.updated" && event.payload.status === "completed",
              ),
              Stream.runHead,
            );
          }
        }
        if (testCase.firstTurn) {
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) => event.type === "run.updated" && event.payload.status === "failed",
            ),
            Stream.runHead,
          );
        } else {
          // Failed opens retry on the outbox schedule. Advance to each recorded
          // deadline, draining effects instead of polling the projection.
          for (let attempt = 0; attempt < 10; attempt++) {
            yield* worker.drain();
            const next = yield* worker.nextClaimableAt;
            if (Option.isNone(next)) break;
            const now = yield* DateTime.now;
            yield* TestClock.adjust(
              Math.max(0, DateTime.toEpochMillis(next.value) - DateTime.toEpochMillis(now)),
            );
          }
        }
        const projection = yield* orchestrator.getThreadProjection(
          materialized.projectionThreadIds[0]!,
        );
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          testCase.firstTurn ? ["completed", "failed"] : ["failed"],
        );
        const errors = projection.turnItems.filter((item) => item.type === "error");
        assert.lengthOf(errors, 1);
        assert.equal(errors[0]?.failure.class, "provider_error");
        if (testCase.code === -32602) {
          assert.equal(
            errors[0]?.failure.message,
            'The agent did not accept the model "replay-model-b". Choose another model for this provider, then retry.',
          );
        } else {
          assert.match(
            errors[0]?.failure.message ?? "",
            /^Failed to open acpRegistry provider session \S+\.$/u,
          );
        }
      }).pipe(
        Effect.provide(
          layerProviderReplay(scenario, AcpRegistryOrchestratorReplayHarness, {
            runEffectWorker: false,
          }),
        ),
      );
    }).pipe(
      Effect.scoped,
      provideDeterministicTestRuntime,
      Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
    ),
  );

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

  const afterRootFixture = ORCHESTRATOR_REPLAY_FIXTURES.find(
    (candidate) => candidate.name === "claude_background_subagent_after_root",
  );
  const afterRootProvider = afterRootFixture?.providers[0];
  if (afterRootFixture !== undefined && afterRootProvider !== undefined) {
    const OPEN_TOOL_ID = "toolu_01QDa5jV5g1H9h6QyDfeJohD";
    const SUBAGENT_TASK_ID = "a2995bfced8019363";

    const moveOpenToolBeforeRootResult = (
      move: boolean,
      entries: ReadonlyArray<ProviderReplayEntry>,
    ): ReadonlyArray<ProviderReplayEntry> => {
      if (!move) return entries;
      const toolIndex = entries.findIndex(
        (entry) =>
          entry.type === "emit_inbound" &&
          (entry.frame as Record<string, any>).message?.content?.[0]?.id === OPEN_TOOL_ID,
      );
      const resultIndex = entries.findIndex(
        (entry) => entry.type === "emit_inbound" && entry.label === "result",
      );
      if (toolIndex < 0 || resultIndex < 0) throw new Error("transcript shape changed");
      const toolEntry = entries[toolIndex]!;
      const rest = entries.filter((_, index) => index !== toolIndex);
      return [...rest.slice(0, resultIndex), toolEntry, ...rest.slice(resultIndex)];
    };
    // A subagent's foreground Bash run during the root's turn is tailed like a
    // root call's, so the child's command row streams live.
    const SUBAGENT_BASH_ID = "toolu_01JMN3SSQCHzUTNua9AWdkiH";
    it.effect("streams a subagent's foreground Bash output live during the root turn", () =>
      runFixtureProviderWithRegisteredHarness({
        fixtureName: afterRootFixture.name,
        buildInput: afterRootFixture.buildInput,
        driver: {
          ...afterRootProvider,
          assertOutput: (result) => {
            const childThreadId = projectionFor(result, afterRootFixture.name).subagents[0]
              ?.childThreadId;
            assert.exists(childThreadId);
            const command = result.projections
              .get(childThreadId)
              ?.turnItems.find(
                (item) =>
                  item.type === "command_execution" &&
                  JSON.stringify(item.input).includes("SUB_DONE_1"),
              );
            assert.exists(command);
            const streamed = result.commandOutput?.get(command.id);
            assert.exists(streamed, "the subagent's command must stream its output");
            assert.include(streamed.output.text, "SUB_DONE_1");
          },
        },
        transformTranscript: (transcript) => {
          const isBashFrame = (entry: ProviderReplayEntry) => {
            if (entry.type !== "emit_inbound") return false;
            const frame = entry.frame as Record<string, any>;
            return (
              frame.message?.content?.[0]?.id === SUBAGENT_BASH_ID ||
              frame.message?.content?.[0]?.tool_use_id === SUBAGENT_BASH_ID ||
              (frame.type === "system" && frame.tool_use_id === SUBAGENT_BASH_ID)
            );
          };
          // Recorded without the structured result the replay writes output files from.
          const bashFrames = transcript.entries.filter(isBashFrame).map((entry) => {
            const frame = (entry as { readonly frame: Record<string, any> }).frame;
            return frame.type === "user"
              ? {
                  ...entry,
                  frame: { ...frame, tool_use_result: { stdout: "SUB_DONE_1\n", stderr: "" } },
                }
              : entry;
          });
          const rest = transcript.entries.filter((entry) => !isBashFrame(entry));
          const resultIndex = rest.findIndex(
            (entry) => entry.type === "emit_inbound" && entry.label === "result",
          );
          assert.lengthOf(bashFrames, 4, "transcript shape changed");
          assert.isAtLeast(resultIndex, 0, "transcript shape changed");
          return {
            ...transcript,
            entries: [...rest.slice(0, resultIndex), ...bashFrames, ...rest.slice(resultIndex)],
          };
        },
      }),
    );

    it.effect.each(
      (["WebFetch", "Write"] as const).flatMap((tool) =>
        (["before root settles", "while root is idle"] as const).flatMap((opens) =>
          (["stopped", "failed"] as const).map((status) => [tool, opens, status] as const),
        ),
      ),
    )(
      "ends a background subagent's open %s (opened %s) when its notification is %s",
      ([tool, opens, notificationStatus]) =>
        runFixtureProviderWithRegisteredHarness({
          fixtureName: afterRootFixture.name,
          buildInput: afterRootFixture.buildInput,
          driver: {
            ...afterRootProvider,
            assertOutput: (result) => {
              const parent = projectionFor(result, afterRootFixture.name);
              assert.deepEqual(
                parent.runs.map((run) => run.status),
                ["completed", "completed"],
              );
              const subagent = parent.subagents[0];
              assert.equal(
                subagent?.status,
                notificationStatus === "stopped" ? "cancelled" : "failed",
              );
              const childThreadId = subagent?.childThreadId;
              assert.exists(childThreadId);
              const child = result.projections.get(childThreadId);
              assert.exists(child);
              const fetches = child.turnItems.filter(
                (item) => item.type === (tool === "WebFetch" ? "web_search" : "file_change"),
              );
              assert.lengthOf(fetches, 1, `the ${tool} reached the child thread`);
              assert.deepEqual(
                {
                  openTool: fetches.map((item) => item.status),
                  openChildNodes: child.nodes
                    .filter(
                      (node) =>
                        node.status === "running" ||
                        node.status === "pending" ||
                        node.status === "waiting",
                    )
                    .map((node) => `${node.kind}:${node.status}`),
                },
                {
                  openTool: [notificationStatus === "stopped" ? "interrupted" : "failed"],
                  openChildNodes: [],
                },
              );
            },
          },
          transformTranscript: (transcript) => ({
            ...transcript,
            entries: moveOpenToolBeforeRootResult(
              opens === "before root settles",
              transcript.entries.flatMap((entry): ReadonlyArray<ProviderReplayEntry> => {
                if (entry.type !== "emit_inbound") return [entry];
                const frame = entry.frame as Record<string, any>;
                if (
                  frame.type === "assistant" &&
                  frame.message?.content?.[0]?.id === OPEN_TOOL_ID
                ) {
                  return [
                    {
                      ...entry,
                      frame: {
                        ...frame,
                        message: {
                          ...frame.message,
                          content: [
                            {
                              ...frame.message.content[0],
                              name: tool,
                              input:
                                tool === "WebFetch"
                                  ? { url: "https://example.com", prompt: "Summarize" }
                                  : { file_path: "notes.txt", content: "SUB_DONE_2" },
                            },
                          ],
                        },
                      },
                    },
                  ];
                }
                if (
                  (frame.type === "system" &&
                    (frame.subtype === "task_started" || frame.subtype === "task_notification") &&
                    frame.tool_use_id === OPEN_TOOL_ID) ||
                  (frame.type === "user" &&
                    frame.message?.content?.[0]?.tool_use_id === OPEN_TOOL_ID) ||
                  (frame.type === "assistant" &&
                    frame.parent_tool_use_id !== null &&
                    frame.message?.content?.[0]?.text === "SUB_FINAL_REPORT")
                ) {
                  return [];
                }
                if (frame.type === "system" && frame.subtype === "task_updated") {
                  return [
                    {
                      ...entry,
                      frame: {
                        ...frame,
                        patch: {
                          ...frame.patch,
                          status: notificationStatus === "stopped" ? "killed" : "failed",
                        },
                      },
                    },
                  ];
                }
                if (
                  frame.type === "system" &&
                  frame.subtype === "task_notification" &&
                  frame.task_id === SUBAGENT_TASK_ID
                ) {
                  return [{ ...entry, frame: { ...frame, status: notificationStatus } }];
                }
                return [entry];
              }),
            ),
          }),
        }),
    );
  }
});

function undecodableEvent(entry: ProviderReplayEntry): ProviderReplayEntry {
  if (entry.type !== "emit_inbound") return entry;
  const frame = entry.frame as { readonly event: Record<string, unknown> };
  return { ...entry, frame: { ...frame, event: { ...frame.event, durable: "not-an-envelope" } } };
}
