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
  projectionFor,
  type OrchestratorFixtureInput,
  type ProviderOrchestratorReplayVariant,
} from "./fixtures/shared.ts";
import {
  runOrchestratorV2ProviderReplayScenario,
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

  it.effect("keeps Pi decisions and text answers after the provider turn ends", () => {
    const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((candidate) => candidate.name === "simple");
    const provider = fixture?.providers.find((candidate) => candidate.driver === "pi");
    assert.isDefined(fixture);
    assert.isDefined(provider);
    const answers = { "ui-input": "Keep the existing tests" };
    return runFixtureProviderWithRegisteredHarness({
      fixtureName: fixture.name,
      buildInput: () => ({
        ...fixture.buildInput(),
        steps: [
          ...fixture.buildInput().steps,
          { type: "approve_next_runtime_request", decision: "accept" },
          { type: "approve_next_runtime_request", decision: "decline" },
          { type: "answer_next_user_input_request", answers },
        ],
      }),
      driver: {
        ...provider,
        assertOutput: (result) => {
          const projection = projectionFor(result, fixture.name);
          assert.lengthOf(projection.runtimeRequests, 3);
          for (const [nativeId, response, status] of [
            ["ui-accept", { decision: "accept" }, "completed"],
            ["ui-decline", { decision: "decline" }, "cancelled"],
            ["ui-input", { answers }, "completed"],
          ] as const) {
            const request = projection.runtimeRequests.find(
              (candidate) => candidate.nativeRequestRef?.nativeId === nativeId,
            );
            assert.isDefined(request);
            assert.deepInclude(request, { status: "resolved", ...response });
            assert.equal(
              projection.nodes.find((node) => node.id === request.nodeId)?.status,
              status,
            );
            assert.equal(
              projection.turnItems.find((item) => item.nodeId === request.nodeId)?.status,
              status,
            );
          }
          assert.equal(projection.runs.at(-1)?.status, "completed");
        },
      },
      transformTranscript: (transcript) => {
        const at = transcript.entries.findIndex(
          (entry) => entry.type === "emit_inbound" && entry.label === "turn_start",
        );
        assert.isAtLeast(at, 0, "Pi fixture must contain turn_start");
        return {
          ...transcript,
          entries: [
            ...transcript.entries.slice(0, at + 1),
            ...(["accept", "decline"] as const).flatMap((decision): ProviderReplayEntry[] => [
              {
                type: "emit_inbound",
                frame: {
                  type: "extension_ui_request",
                  id: `ui-${decision}`,
                  method: "confirm",
                  title: "Allow bash?",
                },
              },
              {
                type: "expect_outbound",
                frame: {
                  type: "extension_ui_response",
                  id: `ui-${decision}`,
                  confirmed: decision === "accept",
                },
              },
            ]),
            {
              type: "emit_inbound",
              frame: {
                type: "extension_ui_request",
                id: "ui-input",
                method: "input",
                title: "How?",
              },
            },
            {
              type: "expect_outbound",
              frame: { type: "extension_ui_response", id: "ui-input", value: answers["ui-input"] },
            },
            ...transcript.entries.slice(at + 1),
          ],
        };
      },
    });
  });

  it.effect(
    "keeps Muse answers and decisions across native acknowledgement and turn cleanup",
    () => {
      const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((candidate) => candidate.name === "simple");
      const provider = fixture?.providers.find((candidate) => candidate.driver === "muse");
      assert.isDefined(fixture);
      assert.isDefined(provider);
      const answers = { approach: ["Small", "Keep tests focused"] };
      return runFixtureProviderWithRegisteredHarness({
        fixtureName: fixture.name,
        buildInput: () => ({
          ...fixture.buildInput(),
          steps: [
            ...fixture.buildInput().steps,
            { type: "answer_next_user_input_request", answers },
            { type: "answer_next_user_input_request", answers },
            { type: "approve_next_runtime_request", decision: "acceptForSession" },
          ],
        }),
        driver: {
          ...provider,
          assertOutput: (result) => {
            const projection = projectionFor(result, fixture.name);
            assert.equal(projection.runs.at(-1)?.status, "completed");
            assert.lengthOf(projection.runtimeRequests, 3);
            const observed = [];
            const expected = [];
            for (const nativeId of ["question-ack", "question-no-ack", "approval-no-ack"]) {
              const request = projection.runtimeRequests.find(
                (candidate) => candidate.nativeRequestRef?.nativeId === nativeId,
              );
              assert.isDefined(request);
              const card = projection.turnItems.find((item) => item.nodeId === request.nodeId);
              const node = projection.nodes.find((candidate) => candidate.id === request.nodeId);
              const isQuestion = request.kind === "user_input";
              const response = isQuestion ? { answers } : { decision: "acceptForSession" as const };
              const submitted = result.domainEvents.find(
                (event) =>
                  event.type === "runtime-request.updated" &&
                  event.payload.id === request.id &&
                  event.payload.status === "resolved",
              );
              assert.isDefined(submitted, `${nativeId} was persisted before native delivery`);
              assert.deepInclude(submitted.payload, response);
              if (!isQuestion) {
                const assistantItemIndex = result.domainEvents.findIndex(
                  (event) =>
                    event.type === "turn-item.updated" &&
                    event.payload.type === "assistant_message",
                );
                const submittedIndex = result.domainEvents.indexOf(submitted);
                assert.isAbove(assistantItemIndex, submittedIndex);
                // The next assistant item is persisted after stageResolved, before turn cleanup.
                const beforeAssistant = result.domainEvents.slice(0, assistantItemIndex);
                const requestAtUpdate = beforeAssistant.findLast(
                  (event) =>
                    event.type === "runtime-request.updated" && event.payload.id === request.id,
                );
                const nodeAtUpdate = beforeAssistant.findLast(
                  (event) => event.type === "node.updated" && event.payload.id === request.nodeId,
                );
                const cardAtUpdate = beforeAssistant.findLast(
                  (event) =>
                    event.type === "turn-item.updated" && event.payload.nodeId === request.nodeId,
                );
                assert.deepInclude(
                  requestAtUpdate?.payload,
                  { status: "resolved", decision: "acceptForSession" },
                  "stageResolved must preserve the persisted T3 decision before turn cleanup",
                );
                assert.deepInclude(nodeAtUpdate?.payload, { status: "completed" });
                assert.deepInclude(cardAtUpdate?.payload, { status: "completed" });
              }
              observed.push({
                nativeId,
                status: request.status,
                answers: request.answers,
                decision: request.decision,
                nodeStatus: node?.status,
                cardStatus: card?.status,
                questionAnswer:
                  card?.type === "user_input_request" ? card.questionAnswer : undefined,
              });
              expected.push({
                nativeId,
                status: "resolved",
                answers: isQuestion ? answers : undefined,
                decision: isQuestion ? undefined : "acceptForSession",
                nodeStatus: "completed",
                cardStatus: "completed",
                questionAnswer: isQuestion
                  ? {
                      requestId: request.id,
                      answers,
                      attachmentsByQuestionId: {},
                      questionTextById: { approach: "Which approach?" },
                    }
                  : undefined,
              } as const);
            }
            assert.deepEqual(observed, expected);
          },
        },
        transformTranscript: (transcript) => {
          const at = transcript.entries.findIndex(
            (entry) => entry.type === "emit_inbound" && entry.label === "turn/started",
          );
          const started = transcript.entries[at];
          assert.isDefined(started);
          if (started.type !== "emit_inbound") assert.fail("Missing Muse turn/started");
          const { sessionId, turnId } = (
            started.frame as {
              readonly params: { readonly sessionId: string; readonly turnId: string };
            }
          ).params;
          const metadata = transcript.metadata as {
            readonly commandIds: ReadonlyArray<ReadonlyArray<string>>;
          };
          return {
            ...transcript,
            metadata: {
              ...transcript.metadata,
              commandIds: [
                [...metadata.commandIds[0]!, "answer-ack", "answer-no-ack", "approve-no-ack"],
              ],
            },
            entries: [
              ...transcript.entries.slice(0, at + 1),
              ...["question-ack", "question-no-ack"].flatMap(
                (userInputId, index): ProviderReplayEntry[] => [
                  {
                    type: "emit_inbound",
                    frame: {
                      jsonrpc: "2.0",
                      method: "userInput/requested",
                      params: {
                        sessionId,
                        turnId,
                        userInputId,
                        questions: [
                          {
                            id: "approach",
                            header: "Approach",
                            question: "Which approach?",
                            options: [{ label: "Small" }, { label: "Large" }],
                            selection: { mode: "single" },
                          },
                        ],
                      },
                    },
                  },
                  {
                    type: "expect_outbound",
                    frame: {
                      jsonrpc: "2.0",
                      id: 4 + index,
                      method: "userInput/answer",
                      params: {
                        sessionId,
                        userInputId,
                        commandId: index === 0 ? "answer-ack" : "answer-no-ack",
                        answers: [
                          {
                            questionId: "approach",
                            selectedLabel: "Small",
                            note: "Keep tests focused",
                          },
                        ],
                      },
                    },
                  },
                  { type: "emit_inbound", frame: { jsonrpc: "2.0", id: 4 + index, result: {} } },
                  ...(index === 0
                    ? [
                        {
                          type: "emit_inbound" as const,
                          frame: {
                            jsonrpc: "2.0",
                            method: "userInput/settled",
                            params: { sessionId, turnId, userInputId },
                          },
                        },
                      ]
                    : []),
                ],
              ),
              {
                type: "emit_inbound",
                frame: {
                  jsonrpc: "2.0",
                  method: "approval/requested",
                  params: {
                    sessionId,
                    turnId,
                    approvalId: "approval-no-ack",
                    currentRequirementId: { approvalId: "approval-no-ack", sourceIndex: 0 },
                    availableChoices: [
                      {
                        choiceId: "session",
                        label: "Allow for session",
                        decision: "approvedForSession",
                        scope: "session",
                      },
                    ],
                    subject: { kind: "shell", command: "touch result.txt" },
                  },
                },
              },
              {
                type: "expect_outbound",
                frame: {
                  jsonrpc: "2.0",
                  id: 6,
                  method: "approval/decide",
                  params: {
                    sessionId,
                    approvalId: "approval-no-ack",
                    commandId: "approve-no-ack",
                    requirementId: { approvalId: "approval-no-ack", sourceIndex: 0 },
                    choiceId: "session",
                  },
                },
              },
              { type: "emit_inbound", frame: { jsonrpc: "2.0", id: 6, result: {} } },
              {
                type: "emit_inbound",
                frame: {
                  jsonrpc: "2.0",
                  method: "approval/updated",
                  params: {
                    sessionId,
                    turnId,
                    approvalId: "approval-no-ack",
                    currentRequirementId: { approvalId: "approval-no-ack", sourceIndex: 0 },
                    availableChoices: [
                      {
                        choiceId: "session",
                        label: "Allow for session",
                        decision: "approvedForSession",
                        scope: "session",
                      },
                    ],
                    subject: { kind: "shell", command: "touch result.txt" },
                    change: {
                      kind: "stageResolved",
                      requirementId: { approvalId: "approval-no-ack", sourceIndex: 0 },
                      choiceId: "session",
                      decision: "approvedForSession",
                    },
                  },
                },
              },
              ...transcript.entries.slice(at + 1),
            ],
          };
        },
      });
    },
  );

  it.effect("keeps an OpenCode decline when the turn ends without acknowledgement", () => {
    const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find(
      (candidate) => candidate.name === "opencode_child_approval",
    );
    const provider = fixture?.providers.find((candidate) => candidate.driver === "opencode");
    assert.isDefined(fixture);
    assert.isDefined(provider);
    return runFixtureProviderWithRegisteredHarness({
      fixtureName: fixture.name,
      buildInput: () => ({
        ...fixture.buildInput(),
        steps: fixture
          .buildInput()
          .steps.map((step) =>
            step.type === "approve_next_runtime_request" ? { ...step, decision: "decline" } : step,
          ),
      }),
      driver: {
        ...provider,
        assertOutput: (result) => {
          const projection = projectionFor(result, fixture.name);
          assert.lengthOf(projection.runtimeRequests, 1);
          const request = projection.runtimeRequests[0]!;
          assert.deepInclude(request, { status: "resolved", decision: "decline" });
          assert.equal(
            projection.nodes.find((node) => node.id === request.nodeId)?.status,
            "cancelled",
          );
          assert.equal(
            projection.turnItems.find((item) => item.nodeId === request.nodeId)?.status,
            "cancelled",
          );
          assert.equal(projection.runs.at(-1)?.status, "completed");
        },
      },
      transformTranscript: (transcript) => {
        assert.isTrue(
          transcript.entries.some(
            (entry) => entry.type === "expect_outbound" && entry.label === "permission.reply",
          ),
        );
        assert.isTrue(
          transcript.entries.some(
            (entry) => entry.type === "emit_inbound" && entry.label === "child.permission.replied",
          ),
        );
        return {
          ...transcript,
          entries: transcript.entries
            .filter(
              (entry) =>
                entry.type !== "emit_inbound" || entry.label !== "child.permission.replied",
            )
            .map((entry) => {
              if (entry.type !== "expect_outbound" || entry.label !== "permission.reply")
                return entry;
              const frame = entry.frame as { readonly input: object };
              return { ...entry, frame: { ...frame, input: { ...frame.input, reply: "reject" } } };
            }),
        };
      },
    });
  });
});

function undecodableEvent(entry: ProviderReplayEntry): ProviderReplayEntry {
  if (entry.type !== "emit_inbound") return entry;
  const frame = entry.frame as { readonly event: Record<string, unknown> };
  return { ...entry, frame: { ...frame, event: { ...frame.event, durable: "not-an-envelope" } } };
}
