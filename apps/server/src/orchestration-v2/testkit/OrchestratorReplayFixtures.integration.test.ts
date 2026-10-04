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
import { MuseOrchestratorReplayHarness } from "../Adapters/MuseAdapterV2.testkit.ts";
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
  // Muse canonicalizes its workspace path (macOS /var -> /private/var) before sending it.
  const transcript = yield* input.harness.decodeTranscript(
    input.driver.driver === "codex"
      ? materializeReplayTranscriptWorkspace(replayTranscript, workspace)
      : input.driver.driver === "muse"
        ? materializeReplayTranscriptWorkspace(
            replayTranscript,
            yield* FileSystem.FileSystem.pipe(
              Effect.flatMap((fs) => fs.realPath(workspace)),
              Effect.provide(NodeServices.layer),
            ),
          )
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

  // A background subagent opens a WebFetch or Write, then stops without
  // returning its result. The continuation that drains the stop must leave the
  // child's tool row and node terminal, whether the call opened before the
  // root settled or while it was idle.
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
              // The stored tool row and every child node end terminal.
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
                // The subagent's second step becomes a call that never returns.
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
                // Drop the Bash background task, the tool result, and the final report.
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

  // Pi and OpenCode report a request answered after T3 sends its answer. The
  // orchestrator's record (decision, decline status, the plugin that answered)
  // must survive the response worker and that acknowledgement.
  it.effect.each(
    (
      [
        ["opencode", "opencode_child_approval", "accept"],
        ["opencode", "opencode_child_approval", "decline"],
        ["pi", "simple", "accept"],
        ["pi", "simple", "decline"],
      ] as const
    ).flatMap(([driver, fixtureName, decision]) => {
      const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find(
        (candidate) => candidate.name === fixtureName,
      );
      const provider = fixture?.providers.find((candidate) => candidate.driver === driver);
      return fixture === undefined || provider === undefined
        ? []
        : [[driver, decision, fixture, provider] as const];
    }),
  )(
    "keeps a plugin's answer through %s's acknowledgement (%s)",
    ([driver, decision, fixture, provider]) => {
      const resolvedBy = {
        _tag: "plugin",
        pluginId: "test.policy",
        pluginName: "Test policy",
        decision,
        reason: "Fixture policy.",
      } as const;
      const prompt = fixture.buildInput().steps[0];
      return runFixtureProviderWithRegisteredHarness({
        fixtureName: fixture.name,
        buildInput: () => ({
          steps: [
            ...(prompt === undefined ? [] : [prompt]),
            { type: "approve_next_runtime_request", decision, resolvedBy },
          ],
        }),
        driver: {
          ...provider,
          assertOutput: (result) => {
            const status = decision === "accept" ? "completed" : "cancelled";
            const projection = [...result.projections.values()].find(
              (candidate) => candidate.thread.lineage.parentThreadId === null,
            );
            const item = projection?.turnItems.find(
              (candidate) => candidate.type === "approval_request",
            );
            assert.deepInclude(item, { status, resolvedBy });
            assert.deepInclude(projection?.runtimeRequests[0], { status: "resolved", decision });
            // The last word on the card and the request, as every client and a replay read them.
            const card = result.domainEvents.findLast(
              (event) => event.type === "turn-item.updated" && event.payload.id === item?.id,
            );
            assert.deepInclude(card?.payload, { status, resolvedBy });
            const request = result.domainEvents.findLast(
              (event) => event.type === "runtime-request.updated",
            );
            assert.deepInclude(request?.payload, { status: "resolved", decision });
          },
        },
        transformTranscript: (transcript) =>
          driver === "pi"
            ? withPiConfirm(transcript, decision)
            : withOpenCodeReply(transcript, decision),
      });
    },
  );
});

/** Adds an extension confirm dialog to the turn and the answer T3 sends for it. */
function withPiConfirm(
  transcript: ProviderReplayTranscript,
  decision: "accept" | "decline",
): ProviderReplayTranscript {
  const at = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn_start",
  );
  const id = "ui-plugin-approval";
  return {
    ...transcript,
    entries: [
      ...transcript.entries.slice(0, at + 1),
      {
        type: "emit_inbound",
        label: "extension_ui_request.confirm",
        frame: { type: "extension_ui_request", id, method: "confirm", title: "Allow bash?" },
      },
      {
        type: "expect_outbound",
        label: "extension_ui_response",
        frame: { type: "extension_ui_response", id, confirmed: decision === "accept" },
      },
      ...transcript.entries.slice(at + 1),
    ],
  };
}

/** The recorded permission reply and its echo, rejected instead when declining. */
function withOpenCodeReply(
  transcript: ProviderReplayTranscript,
  decision: "accept" | "decline",
): ProviderReplayTranscript {
  if (decision === "accept") return transcript;
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type === "expect_outbound" && entry.label === "permission.reply") {
        const frame = entry.frame as { readonly input: object };
        return { ...entry, frame: { ...frame, input: { ...frame.input, reply: "reject" } } };
      }
      if (entry.type === "emit_inbound" && entry.label === "child.permission.replied") {
        const frame = entry.frame as { readonly event: { readonly properties: object } };
        const event = {
          ...frame.event,
          properties: { ...frame.event.properties, reply: "reject" },
        };
        return { ...entry, frame: { ...frame, event } };
      }
      return entry;
    }),
  };
}

/** The same event with an envelope this build cannot decode, as a newer OpenCode may send. */
function undecodableEvent(entry: ProviderReplayEntry): ProviderReplayEntry {
  if (entry.type !== "emit_inbound") return entry;
  const frame = entry.frame as { readonly event: Record<string, unknown> };
  return { ...entry, frame: { ...frame, event: { ...frame.event, durable: "not-an-envelope" } } };
}
