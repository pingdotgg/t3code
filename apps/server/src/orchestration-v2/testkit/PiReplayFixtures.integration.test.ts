import { assert, describe, it } from "@effect/vitest";

import { PiOrchestratorReplayHarness } from "../Adapters/PiAdapterV2.testkit.ts";
import {
  findReplayFixture,
  itRunsReplayFixtures,
  runReplayFixture,
} from "./ProviderReplayFixtures.ts";
import type { ProviderReplayEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { projectionFor, SIMPLE_PROMPT } from "./fixtures/shared.ts";

describe("Pi replay fixtures", () => {
  itRunsReplayFixtures("pi", (input) =>
    runReplayFixture({ ...input, harness: PiOrchestratorReplayHarness }),
  );

  it.effect.each([
    { mode: "single", completion: "notice", parentStatus: "completed" },
    { mode: "single", completion: "snapshot", parentStatus: "completed" },
    { mode: "workflow", completion: "snapshot-notice", parentStatus: "completed" },
    { mode: "workflow", completion: "snapshot", parentStatus: "completed" },
    { mode: "chain", completion: "notice-snapshot", parentStatus: "completed" },
    { mode: "parallel", completion: "notice-snapshot", parentStatus: "completed" },
    { mode: "single", completion: "snapshot", parentStatus: "failed" },
    { mode: "workflow", completion: "snapshot-notice", parentStatus: "failed" },
    { mode: "single", completion: "snapshot", parentStatus: "interrupted" },
  ])(
    "settles native async $mode children after a $parentStatus parent through $completion",
    ({ mode, completion, parentStatus }) => {
      const fixture = findReplayFixture("simple")!;
      const pi = fixture.providers.find((provider) => provider.driver === "pi")!;
      const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
      return runReplayFixture({
        fixtureName: "simple",
        buildInput: () => ({
          steps:
            parentStatus === "completed"
              ? [
                  { type: "message", text: SIMPLE_PROMPT },
                  { type: "await_run_status", targetRunIndex: 2, status: "completed" },
                ]
              : [
                  { type: "message", text: SIMPLE_PROMPT },
                  { type: "approve_next_runtime_request" },
                ],
        }),
        harness: PiOrchestratorReplayHarness,
        driver: {
          ...pi,
          runContinuationWorker: true,
          awaitCommandEffects: true,
          assertOutput: (result, transcript) => {
            const projection = projectionFor(result, transcript.scenario);
            assert.deepEqual(
              projection.runs.map((run) => run.status),
              parentStatus === "completed" ? ["completed", "completed"] : [parentStatus],
            );
            assert.lengthOf(projection.subagents, mode === "single" ? 2 : 3);
            assert.lengthOf(
              projection.turnItems.filter((item) => item.type === "subagent"),
              projection.subagents.length,
            );
            for (const child of projection.subagents) {
              assert.equal(child.status, "completed");
              assert.equal(child.runId, projection.runs[0]?.id);
              assert.isNull(child.childThreadId);
              assert.equal(
                projection.nodes.find((node) => node.id === child.id)?.status,
                "completed",
              );
            }
            if (parentStatus !== "completed") {
              assert.isFalse(
                result.domainEvents.some(
                  (event) =>
                    event.type === "subagent.updated" && event.payload.status === "interrupted",
                ),
                "a reusable parent terminal must not interrupt its detached children",
              );
            }
            if (completion === "snapshot-notice") {
              assert.equal(
                projection.subagents.find((child) => child.title === "workflow")?.result,
                "native result",
              );
              assert.equal(
                projection.subagents.find((child) => child.title === "beta")?.result,
                "/outputs/beta.md",
              );
            }
            for (const child of projection.subagents) {
              assert.lengthOf(
                result.domainEvents.filter(
                  (event) =>
                    event.type === "subagent.updated" &&
                    event.payload.id === child.id &&
                    event.payload.status === child.status &&
                    event.payload.result === child.result,
                ),
                1,
                "each final observation is persisted once",
              );
            }
            if (parentStatus !== "completed") return;
            const wake = result.domainEvents.findIndex(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === projection.runs[1]?.id &&
                event.payload.status === "starting",
            );
            assert.isAtLeast(wake, 0);
            for (const child of projection.subagents) {
              const completionIndex = result.domainEvents.findIndex(
                (event) =>
                  event.type === "subagent.updated" &&
                  event.payload.id === child.id &&
                  event.payload.status === "completed",
              );
              assert.isAtLeast(completionIndex, 0);
              const lateMember =
                (completion === "notice-snapshot" &&
                  child.nativeTaskRef?.nativeId?.endsWith('["step:1"]')) ||
                (completion === "snapshot-notice" &&
                  child.nativeTaskRef?.nativeId?.endsWith('["beta"]'));
              if (!lateMember)
                assert.isBelow(
                  completionIndex,
                  wake,
                  "known native children settle before the wake can dispatch",
                );
            }
          },
        },
        transformTranscript: (transcript) => {
          // Keep the recorded Pi transport setup and root response. These controlled
          // 0.80.0 payloads exercise the two completions around a wake, without a live model.
          const agentStart = transcript.entries.findIndex(
            (entry) =>
              entry.type === "emit_inbound" &&
              Predicate.isObject(entry.frame) &&
              entry.frame["type"] === "agent_start",
          );
          const lastListing = transcript.entries
            .flatMap((entry) =>
              entry.type === "emit_inbound" &&
              Predicate.isObject(entry.frame) &&
              entry.frame["command"] === "get_entries" &&
              Predicate.isObject(entry.frame["data"])
                ? [entry.frame["data"]]
                : [],
            )
            .at(-1);
          const ids = mode === "single" ? ["alpha", "beta"] : [mode];
          const keys = mode === "workflow" ? ["alpha", "beta"] : ["step:0", "step:1"];
          const tasks = keys.map((task) => ({ agent: "scout", task }));
          const launches: ProviderReplayEntry[] = ids.flatMap((id) => [
            {
              type: "emit_inbound",
              frame: {
                type: "tool_execution_start",
                toolCallId: `native:${id}`,
                toolName: "subagent",
                args:
                  mode === "single"
                    ? { agent: "scout", task: id, async: true }
                    : mode === "workflow"
                      ? { workflow: true, async: true }
                      : mode === "chain"
                        ? { chain: tasks, async: true }
                        : { tasks, async: true },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                type: "tool_execution_end",
                toolCallId: `native:${id}`,
                toolName: "subagent",
                isError: false,
                result: { details: { mode, asyncId: id, results: [] } },
              },
            },
          ]);
          if (mode !== "single")
            launches.push({
              type: "emit_inbound",
              frame: {
                type: "extension_ui_request",
                method: "setWidget",
                widgetKey: "subagent-async",
                widgetLines: [
                  `PI_SUBAGENT_ASYNC_JSON:${encodeJson({
                    kind: "pi-subagents.async-status-snapshot",
                    version: 1,
                    runs: [
                      {
                        id: mode,
                        kind: mode === "workflow" ? "workflow" : "subagent",
                        label: mode,
                        state: "running",
                        children: keys.slice(0, 1).map((id) => ({
                          id,
                          kind: "step",
                          label: id,
                          agent: "scout",
                          state: "running",
                        })),
                      },
                    ],
                  })}`,
                ],
              },
            });
          const terminalWidget = (
            id: string,
            children: ReadonlyArray<string>,
          ): ProviderReplayEntry => ({
            type: "emit_inbound" as const,
            frame: {
              type: "extension_ui_request",
              method: "setWidget",
              widgetKey: "subagent-async",
              widgetLines: [
                `PI_SUBAGENT_ASYNC_JSON:${encodeJson({
                  kind: "pi-subagents.async-status-snapshot",
                  version: 1,
                  runs: [
                    {
                      id,
                      kind: mode === "workflow" ? "workflow" : "subagent",
                      label: mode === "single" ? "scout" : mode,
                      state: "complete",
                      children: children.map((id) => ({
                        id,
                        kind: "step",
                        label: id,
                        agent: mode === "workflow" ? id : "scout",
                        state: "complete",
                      })),
                    },
                  ],
                })}`,
              ],
            },
          });
          const notice = (id: string): ProviderReplayEntry => ({
            type: "emit_inbound",
            frame: {
              type: "message_end",
              message: {
                role: "custom",
                customType: "subagent-notify",
                content: "native result",
                details: {
                  runs: [
                    {
                      runId: id,
                      status: "completed",
                      ...(mode === "workflow"
                        ? {
                            workflowRunId: id,
                            childRuns: keys.map((key) => ({
                              runId: `member:${key}`,
                              workflowKey: key,
                              agent: key,
                              status: "completed",
                            })),
                            childOutputs: keys.map((key) => ({
                              runId: `member:${key}`,
                              workflowKey: key,
                              savedOutputPath: `/outputs/${key}.md`,
                            })),
                          }
                        : {}),
                    },
                  ],
                },
              },
            },
          });
          const earlyCompletion =
            completion === "snapshot-notice"
              ? [terminalWidget(mode, keys.slice(0, 1))]
              : mode === "single"
                ? [
                    completion === "snapshot"
                      ? terminalWidget("alpha", ["step:0"])
                      : notice("alpha"),
                  ]
                : [];
          const lateCompletion =
            completion === "snapshot"
              ? [
                  terminalWidget(
                    mode === "single" ? "beta" : mode,
                    mode === "single" ? ["step:0"] : keys,
                  ),
                ]
              : [notice(mode === "single" ? "beta" : mode)];
          const wake: ProviderReplayEntry[] = [
            ...earlyCompletion,
            { type: "emit_inbound", frame: { type: "agent_start" } },
            ...lateCompletion,
            ...(completion === "notice-snapshot" ? [terminalWidget(mode, keys)] : []),
            {
              type: "emit_inbound",
              frame: { type: "message_start", message: { role: "assistant" } },
            },
            {
              type: "emit_inbound",
              frame: {
                type: "message_update",
                assistantMessageEvent: {
                  type: "text_end",
                  contentIndex: 0,
                  content: "wake complete",
                },
              },
            },
            { type: "emit_inbound", frame: { type: "agent_settled" } },
            { type: "expect_outbound", frame: { type: "get_state", id: "t3-100" } },
            {
              type: "emit_inbound",
              frame: {
                type: "response",
                id: "t3-100",
                command: "get_state",
                success: true,
                data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
              },
            },
            {
              type: "expect_outbound",
              frame: { type: "get_entries", id: "t3-101", since: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: {
                type: "response",
                id: "t3-101",
                command: "get_entries",
                success: true,
                data: {
                  entries: [
                    {
                      id: "wake-result",
                      parentId: lastListing?.["leafId"],
                      type: "message",
                      message: { role: "assistant", content: [] },
                    },
                  ],
                  leafId: "wake-result",
                },
              },
            },
            { type: "expect_outbound", frame: { type: "get_session_stats", id: "t3-102" } },
            {
              type: "emit_inbound",
              frame: {
                type: "response",
                id: "t3-102",
                command: "get_session_stats",
                success: true,
                data: {},
              },
            },
          ];
          const parentEntries = transcript.entries.slice(agentStart + 1).map((entry) => {
            if (
              parentStatus === "interrupted" &&
              entry.type === "emit_inbound" &&
              Predicate.isObject(entry.frame) &&
              entry.frame["type"] === "agent_settled"
            )
              return { ...entry, frame: { ...entry.frame, aborted: true } };
            if (
              parentStatus === "failed" &&
              entry.type === "emit_inbound" &&
              Predicate.isObject(entry.frame) &&
              entry.frame["type"] === "message_end" &&
              Predicate.isObject(entry.frame["message"]) &&
              entry.frame["message"]["role"] === "assistant"
            )
              return {
                ...entry,
                frame: {
                  ...entry.frame,
                  message: {
                    ...entry.frame["message"],
                    stopReason: "error",
                    errorMessage: "provider overloaded",
                  },
                },
              };
            return entry;
          });
          return {
            ...transcript,
            entries: [
              ...transcript.entries.slice(0, agentStart + 1),
              ...launches,
              ...parentEntries,
              ...(parentStatus === "completed"
                ? wake
                : [
                    ...earlyCompletion,
                    ...lateCompletion,
                    // This runless request follows the native results through the
                    // session pump, so answering it proves late ingestion finished.
                    {
                      type: "emit_inbound" as const,
                      frame: {
                        type: "extension_ui_request",
                        id: "late-ingestion-barrier",
                        method: "confirm",
                        title: "Native results received",
                        message: "Continue",
                      },
                    },
                    {
                      type: "expect_outbound" as const,
                      frame: {
                        type: "extension_ui_response",
                        id: "late-ingestion-barrier",
                        confirmed: true,
                      },
                    },
                  ]),
            ],
          };
        },
      }).pipe(Effect.scoped);
    },
  );
});
