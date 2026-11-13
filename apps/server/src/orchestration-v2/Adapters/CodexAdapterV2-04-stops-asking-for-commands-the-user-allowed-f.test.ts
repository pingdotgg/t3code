import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CheckpointId,
  CodexSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderSetupError,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as CodexError from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import { MCP_APP_OUTPUT_KEY, readMcpAppReference } from "@t3tools/shared/mcpApp";
import { toolOutputImages } from "@t3tools/shared/toolOutput";
import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import packageJson from "../../../package.json" with { type: "json" };
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import { resolveProviderCompatibility } from "../../provider/providerCompatibility.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";
import * as CodexAdapterV2Testkit from "./CodexAdapterV2.testkit.ts";

import {
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  makeCodexTestTurnInput,
  makeCodexReplayTurn,
  codexReplayPreamble,
  makeCodexReplayTranscript,
  withReplayRequestId,
  makeCodexReplayHarness,
  nativeThreadId,
  request,
  nativeTurnId,
  prompt,
  fileChange,
  approval,
} from "./CodexAdapterV2-fixtures.testkit.ts";

describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect("stops asking for commands the user allowed for the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "session-approval-thread";
        const turnIds = [
          "session-approval-turn-1",
          "session-approval-turn-2",
          "session-approval-turn-3",
        ];
        const turnPolicies = {
          "approval-required": {
            approvalPolicy: "untrusted",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "readOnly" },
          },
          "full-access": {
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "dangerFullAccess" },
          },
        } as const;
        const turnModes = ["approval-required", "full-access", "approval-required"] as const;
        const turnText = (index: number) => `Review round ${index + 1}.`;
        const startTurn = (index: number): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => [
          {
            type: "expect_outbound",
            label: `turn ${index + 1} turn/start`,
            frame: {
              id: 3 + index,
              method: "turn/start",
              params: {
                threadId: nativeThreadId,
                input: [{ type: "text", text: turnText(index) }],
                cwd: "/workspace",
                model: "gpt-5.4",
                ...turnPolicies[turnModes[index]!],
                summary: "detailed",
                collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
              },
            },
          },
          {
            type: "emit_inbound",
            label: `turn ${index + 1} turn/start`,
            frame: {
              id: 3 + index,
              result: { turn: makeCodexReplayTurn({ id: turnIds[index]!, status: "inProgress" }) },
            },
          },
          turnEvent("turn/started", turnIds[index]!),
        ];
        const approval = (input: {
          readonly id: number;
          readonly turnId: string;
          readonly kind: "commandExecution" | "fileChange";
          readonly itemId: string;
          readonly decision: string;
        }): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => [
          {
            type: "emit_inbound",
            label: `${input.itemId} approval`,
            frame: {
              id: input.id,
              method: `item/${input.kind}/requestApproval`,
              params: {
                threadId: nativeThreadId,
                turnId: input.turnId,
                itemId: input.itemId,
                startedAtMs: 1782622441000,
                ...(input.kind === "commandExecution" ? { command: `cat ${input.itemId}` } : {}),
              },
            },
          },
          {
            type: "expect_outbound",
            label: `${input.itemId} decision`,
            frame: { id: input.id, result: { decision: input.decision } },
          },
        ];
        const turnEvent = (
          method: "turn/started" | "turn/completed",
          turnId: string,
        ): CodexReplay.CodexAppServerReplayEntry => ({
          type: "emit_inbound",
          label: `${turnId} ${method}`,
          frame: {
            method,
            params: {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({
                id: turnId,
                status: method === "turn/started" ? "inProgress" : "completed",
              }),
            },
          },
        });
        const [patchRequest, patchDecision] = approval({
          id: 102,
          turnId: turnIds[0]!,
          kind: "fileChange",
          itemId: "first-patch",
          decision: "acceptForSession",
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-session-approvals",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId: turnIds[0]!,
              prompt: turnText(0),
            }).slice(0, -3),
            ...startTurn(0),
            ...approval({
              id: 100,
              turnId: turnIds[0]!,
              kind: "commandExecution",
              itemId: "first-command",
              decision: "acceptForSession",
            }),
            patchRequest!,
            ...approval({
              id: 101,
              turnId: turnIds[0]!,
              kind: "commandExecution",
              itemId: "second-command",
              decision: "acceptForSession",
            }),
            turnEvent("turn/completed", turnIds[0]!),
            ...startTurn(1),
            patchDecision!,
            turnEvent("turn/completed", turnIds[1]!),
            ...startTurn(2),
            ...approval({
              id: 103,
              turnId: turnIds[2]!,
              kind: "commandExecution",
              itemId: "third-command",
              decision: "accept",
            }),
            ...approval({
              id: 104,
              turnId: turnIds[2]!,
              kind: "fileChange",
              itemId: "second-patch",
              decision: "accept",
            }),
            turnEvent("turn/completed", turnIds[2]!),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const requests = () => [
          ...new Map(
            harness.events.flatMap((event) =>
              event.type === "runtime_request.updated"
                ? [[event.runtimeRequest.id, event.runtimeRequest] as const]
                : [],
            ),
          ).values(),
        ];
        const answer = (
          count: number,
          kind: "command" | "file-change",
          decision: ProviderApprovalDecision,
        ) =>
          Effect.gen(function* () {
            yield* harness.until(() => requests().length === count);
            const request = requests()[count - 1]!;
            assert.equal(request.kind, kind);
            yield* harness.runtime.respondToRuntimeRequest({ requestId: request.id, decision });
          });

        const runTurn = (index: number) =>
          Effect.gen(function* () {
            yield* harness.runtime.startTurn({
              ...makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make(`session-approvals-${index + 1}`),
                text: turnText(index),
              }),
              runOrdinal: index + 1,
              providerTurnOrdinal: index + 1,
              runtimePolicy: { ...CODEX_TEST_RUNTIME_POLICY, runtimeMode: turnModes[index]! },
            });
          });

        yield* runTurn(0);
        yield* answer(1, "command", "acceptForSession");
        yield* harness.until(() => requests().length === 2);
        yield* harness.awaitTerminal(1);
        yield* runTurn(1);
        yield* answer(2, "file-change", "acceptForSession");
        yield* harness.awaitTerminal(2);
        yield* runTurn(2);
        yield* answer(3, "command", "accept");
        yield* answer(4, "file-change", "accept");
        yield* harness.awaitTerminal(3);
        assert.lengthOf(requests(), 4);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );
  it.effect("preserves T3 context on the wire and restores it after compaction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "context-thread";
        const nativeTurnId = "context-turn";
        const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId,
          codexInput: [{ type: "text", text: "work" }],
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          hasT3Mcp: true,
        });
        assert.include(
          params.additionalContext?.t3_code_orchestration_01?.value ?? "",
          "delegate_task",
        );
        const entries = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" });
        const transcript = makeCodexReplayTranscript({
          scenario: "restore-context",
          entries: [
            ...entries.slice(0, 5),
            {
              type: "expect_outbound",
              label: "context turn",
              frame: { id: 3, method: "turn/start", params },
            },
            ...entries.slice(6),
            {
              type: "emit_inbound",
              label: "compacted",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: { type: "contextCompaction", id: "compact-context" },
                },
              },
            },
            {
              type: "expect_outbound",
              label: "restore context",
              frame: {
                id: 4,
                method: "thread/inject_items",
                params: {
                  threadId: nativeThreadId,
                  items: Object.entries(params.additionalContext ?? {}).map(([key, entry]) => ({
                    type: "message",
                    role: "developer",
                    content: [{ type: "input_text", text: `<${key}>${entry.value}</${key}>` }],
                  })),
                },
              },
            },
            { type: "emit_inbound", label: "restored", frame: { id: 4, result: {} } },
            {
              type: "emit_inbound",
              label: "done",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("test"),
          threadId: harness.threadId,
          providerSessionId: "context-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer test",
          browserToolsAvailable: true,
        });
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("context-attempt"),
            text: "work",
          }),
        );
        yield* harness.firstTerminal;
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );
  it.effect("compacts Codex with the native RPC and completes the compaction turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "compact-thread";
        const nativeTurnId = "compact-turn";
        const item = { type: "contextCompaction", id: "compact-item" };
        const transcript = makeCodexReplayTranscript({
          scenario: "native-compaction",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "unused" }).slice(0, 5),
            {
              type: "expect_outbound",
              label: "compact",
              frame: {
                id: 3,
                method: "thread/compact/start",
                params: { threadId: nativeThreadId },
              },
            },
            { type: "emit_inbound", label: "compact", frame: { id: 3, result: {} } },
            {
              type: "emit_inbound",
              label: "start",
              frame: {
                method: "turn/started",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                },
              },
            },
            ...(["item/started", "item/completed"] as const).map((method) => ({
              type: "emit_inbound" as const,
              label: method,
              frame: { method, params: { threadId: nativeThreadId, turnId: nativeTurnId, item } },
            })),
            {
              type: "emit_inbound",
              label: "complete",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        assert.isDefined(harness.runtime.compactThread);
        yield* harness.runtime.compactThread!(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("compact-attempt"),
            text: "/compact",
          }),
        );
        yield* harness.firstTerminal;
        const items = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        );
        assert.deepEqual(
          items.map((entry) => entry.status),
          ["running", "completed"],
        );
        assert.equal(items[0]?.id, items[1]?.id);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );
  it.effect.each(["failed", "interrupted", "Stop"] as const)(
    "settles unfinished compaction on %s without changing completed compaction",
    (outcome) =>
      Effect.scoped(
        Effect.gen(function* () {
          const nativeThreadId = "compact-thread";
          const nativeTurnId = "compact-turn";
          const error = {
            message: "Remote compaction stream disconnected",
            codexErrorInfo: "other",
            additionalDetails: null,
          };
          const transcript = makeCodexReplayTranscript({
            scenario: `automatic-compaction-${outcome}`,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Continue." }),
              ...(
                [
                  { method: "item/started", id: "completed-item", startedAtMs: 1782622441000 },
                  { method: "item/completed", id: "completed-item", completedAtMs: 1782622442000 },
                  { method: "item/started", id: "unfinished-item", startedAtMs: 1782622443000 },
                ] as const
              ).map(({ method, id, ...timestamps }) => ({
                type: "emit_inbound" as const,
                label: `${method}/${id}`,
                frame: {
                  method,
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    item: { type: "contextCompaction", id },
                    ...timestamps,
                  },
                },
              })),
              ...(outcome === "Stop"
                ? [
                    {
                      type: "expect_outbound" as const,
                      label: "turn/interrupt",
                      frame: {
                        id: 4,
                        method: "turn/interrupt",
                        params: { threadId: nativeThreadId, turnId: nativeTurnId },
                      },
                    },
                    {
                      type: "emit_inbound" as const,
                      label: "turn/interrupt/failed",
                      frame: { id: 4, error: { code: -32_000, message: "Interrupt failed" } },
                    },
                  ]
                : [
                    {
                      type: "emit_inbound" as const,
                      label: "turn/completed",
                      frame: {
                        method: "turn/completed",
                        params: {
                          threadId: nativeThreadId,
                          turn: {
                            ...makeCodexReplayTurn({ id: nativeTurnId, status: outcome }),
                            error: outcome === "failed" ? error : null,
                          },
                        },
                      },
                    },
                  ]),
            ],
          });
          const compactionStarted = yield* Deferred.make<ProviderTurnId>();
          const harness = yield* makeCodexReplayHarness(transcript, (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === "unfinished-item" &&
            event.turnItem.status === "running" &&
            event.turnItem.providerTurnId !== null
              ? Deferred.succeed(compactionStarted, event.turnItem.providerTurnId)
              : Effect.void,
          );
          yield* TestClock.setTime(1782622445000);
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`compact-${outcome}-attempt`),
              text: "Continue.",
            }),
          );
          if (outcome === "Stop") {
            const providerTurnId = yield* Deferred.await(compactionStarted);
            const interrupt = yield* harness.runtime
              .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
              .pipe(Effect.exit);
            assert.equal(interrupt._tag, "Failure");
          }
          yield* harness.firstTerminal;
          const items = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "compaction"
              ? [event.turnItem]
              : [],
          );
          const completed = items.filter(
            (item) => item.nativeItemRef?.nativeId === "completed-item",
          );
          const unfinished = items.filter(
            (item) => item.nativeItemRef?.nativeId === "unfinished-item",
          );
          const status = outcome === "failed" ? "failed" : "interrupted";
          assert.deepEqual(
            unfinished.map((item) => item.status),
            ["running", status],
          );
          assert.equal(unfinished[0]?.id, unfinished[1]?.id);
          assert.deepEqual(unfinished[1]?.startedAt, DateTime.makeUnsafe(1782622443000));
          assert.deepEqual(
            unfinished[1]?.completedAt,
            DateTime.makeUnsafe(outcome === "Stop" ? 1782622445000 : 1782622450000),
          );
          assert.deepEqual(
            completed.map((item) => item.status),
            ["running", "completed"],
          );
          assert.deepEqual(completed[1]?.startedAt, DateTime.makeUnsafe(1782622441000));
          assert.deepEqual(completed[1]?.completedAt, DateTime.makeUnsafe(1782622442000));
          assert.equal(harness.terminalEvents()[0]?.status, status);
          if (outcome === "failed") {
            assert.equal(harness.terminalEvents()[0]?.failure?.message, error.message);
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
  );
  it.effect.each([
    { hook: "stopped", status: "interrupted", expected: true },
    { hook: "completed", status: "interrupted", expected: false },
    { hook: "warning", status: "interrupted", expected: false },
    { hook: "empty", status: "interrupted", expected: false },
    { hook: "wrong-turn", status: "interrupted", expected: false },
    { hook: "wrong-thread", status: "interrupted", expected: false },
    { hook: "unscoped", status: "interrupted", expected: false },
    { hook: "stopped", status: "completed", expected: false },
    { hook: "stopped", status: "failed", expected: false },
  ] as const)(
    "correlates $hook hook output with a $status turn only",
    ({ hook, status, expected }) =>
      Effect.gen(function* () {
        const nativeThreadId = "hook-thread";
        const stopReason = "Save a current task checkpoint before compaction.";
        const hookCompleted = (turnId: string | null) => ({
          type: "emit_inbound" as const,
          label: "hook/completed",
          frame: {
            method: "hook/completed",
            params: {
              threadId: hook === "wrong-thread" ? "other-thread" : nativeThreadId,
              turnId: hook === "unscoped" ? null : hook === "wrong-turn" ? "other-turn" : turnId,
              run: {
                id: "checkpoint-hook",
                eventName: "preCompact",
                source: "project",
                sourcePath: "/workspace/.codex/hooks.json",
                scope: "turn",
                executionMode: "sync",
                handlerType: "command",
                displayOrder: 1,
                startedAt: 1782622440,
                status: hook === "completed" ? "completed" : "stopped",
                entries: [
                  { kind: "warning", text: "Unrelated hook diagnostic" },
                  {
                    kind: hook === "warning" ? "warning" : "stop",
                    text: hook === "empty" ? "  " : stopReason,
                  },
                ],
              },
            },
          },
        });
        const transcript = makeCodexReplayTranscript({
          scenario: `hook-stop-${hook}-${status}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "hook-turn", prompt: "work" }),
            hookCompleted("hook-turn"),
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: "hook-turn", status }),
                },
              },
            },
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "next-turn", prompt: "work" })
              .slice(-3)
              .map((entry, index) => (index < 2 ? withReplayRequestId(entry, 4) : entry)),
            hookCompleted("hook-turn"),
            {
              type: "emit_inbound",
              label: "turn/completed/next",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: "next-turn", status: "interrupted" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        for (const turn of ["hook-turn", "next-turn"]) {
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(turn),
              text: "work",
            }),
          );
          yield* harness.awaitTerminal(turn === "hook-turn" ? 1 : 2);
        }
        assert.deepEqual(
          harness.terminalEvents().map((event) => ({
            status: event.status,
            reason: event.status === "failed" ? undefined : event.reason,
          })),
          [
            { status, reason: expected ? `preCompact hook (project): ${stopReason}` : undefined },
            { status: "interrupted", reason: undefined },
          ],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
  );
});
