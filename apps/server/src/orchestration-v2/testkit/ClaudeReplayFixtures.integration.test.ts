import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  isProviderNativeSubagentThread,
  MessageId,
  ProviderDriverKind,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../Orchestrator.ts";
import { userFacingDispatchErrorMessage } from "../UserFacingErrors.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { subagentInput } from "./fixtures/subagent/input.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";
import {
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  projectionFor,
} from "./fixtures/shared.ts";
import {
  findReplayFixture,
  itRunsReplayFixtures,
  runReplayFixture,
  type ReplayFixtureCase,
} from "./ProviderReplayFixtures.ts";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";

const readTranscript = Effect.fn("readClaudeReplayFixture")(function* (file: URL) {
  return yield* readProviderReplayTranscript(file);
}, Effect.provide(NodeServices.layer));

function readClaudeTranscriptFixture(path: string) {
  return readTranscript(new URL(`./fixtures/${path}/claude_transcript.ndjson`, import.meta.url));
}

function runClaudeReplayFixture(input: ReplayFixtureCase) {
  return runReplayFixture({ ...input, harness: ClaudeOrchestratorReplayHarness });
}

describe("Claude Agent SDK replay fixtures", () => {
  itRunsReplayFixtures("claudeAgent", runClaudeReplayFixture);

  it.effect("refuses messages to a native subagent thread without touching it", () =>
    Effect.gen(function* () {
      const raw = yield* readClaudeTranscriptFixture("subagent");
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptRuntimeInstructions(raw, {
          driver: ProviderDriverKind.make("claudeAgent"),
          model: CLAUDE_MODEL_SELECTION.model,
        }),
      );
      const materialized = yield* materializeFixtureInput({
        scenario: "subagent",
        fixtureInput: subagentInput(),
        driver: ProviderDriverKind.make("claudeAgent"),
        modelSelection: CLAUDE_MODEL_SELECTION,
      }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
      const scenario = {
        name: "subagent/claudeAgent:read-only-child",
        transcript,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
      };
      yield* Effect.gen(function* () {
        const result = yield* runOrchestratorV2Scenario(scenario);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const child = [...result.projections.values()].find((projection) =>
          isProviderNativeSubagentThread(projection.thread),
        );
        assert.isDefined(child);
        const before = yield* orchestrator.getThreadEventSequence(child.thread.id);

        const refused = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:subagent:message-native-child"),
            threadId: child.thread.id,
            messageId: MessageId.make("message:subagent:message-native-child"),
            text: "Also check the tests.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          })
          .pipe(Effect.flip);
        assert.equal(refused._tag, "OrchestratorSubagentThreadReadOnlyError");
        assert.equal(
          userFacingDispatchErrorMessage(refused),
          "This subagent is run by its provider and cannot take messages. Message the parent thread instead.",
        );
        assert.equal(yield* orchestrator.getThreadEventSequence(child.thread.id), before);
        const after = yield* orchestrator.getThreadProjection(child.thread.id);
        assert.lengthOf(after.runs, 0);
        assert.deepEqual(after.messages, child.messages);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerProviderReplay(scenario, ClaudeOrchestratorReplayHarness),
        ),
        provideDeterministicTestRuntime,
        Effect.scoped,
      );
    }),
  );

  const afterRootFixture = findReplayFixture("claude_background_subagent_after_root");
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
      runClaudeReplayFixture({
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

    // regression: #16486 a background subagent's tool left open while its parent is idle never settled
    it.effect.each([
      ["WebFetch", "while root is idle", "stopped"],
      ["Write", "before root settles", "failed"],
    ] as const)(
      "ends a background subagent's open %s (opened %s) when its notification is %s",
      ([tool, opens, notificationStatus]) =>
        runClaudeReplayFixture({
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
