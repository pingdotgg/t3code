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
  providerThreadId,
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  threadEnvOf,
  codexReplayPreamble,
  makeCodexReplayTranscript,
  makeCodexReplayHarness,
  codexReplayThreadResult,
  codexReplaySourceTurn,
  nativeThreadId,
  nativeTurnId,
  prompt,
} from "./CodexAdapterV2-fixtures.testkit.ts";

describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect("unarchives an unloaded Codex thread before rolling it back", () =>
    Effect.gen(function* () {
      const nativeThreadId = "archived-rollback-thread";
      const resumeParams = {
        threadId: nativeThreadId,
        excludeTurns: true,
        cwd: CODEX_TEST_RUNTIME_POLICY.cwd,
        model: CODEX_TEST_MODEL_SELECTION.model,
        config: CodexAdapterV2.CODEX_THREAD_CONFIG,
      };
      const thread = codexReplayThreadResult({ nativeThreadId, forkedFromId: null });
      const exchange = (
        id: number,
        method: string,
        params: unknown,
        reply: { readonly result: unknown } | { readonly error: unknown },
      ): Array<CodexReplay.CodexAppServerReplayEntry> => [
        { type: "expect_outbound", label: method, frame: { id, method, params } },
        { type: "emit_inbound", label: method, frame: { id, ...reply } },
      ];
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-archived-rollback",
        entries: [
          ...codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: "archived-rollback-turn",
            prompt: "unused",
          }).slice(0, 5),
          ...exchange(
            3,
            "thread/read",
            { threadId: nativeThreadId, includeTurns: false },
            {
              result: {
                thread: {
                  id: nativeThreadId,
                  historyMode: "paginated",
                  status: { type: "notLoaded" },
                },
              },
            },
          ),
          ...exchange(4, "thread/resume", resumeParams, {
            error: { code: -32600, message: `session ${nativeThreadId} is archived` },
          }),
          ...exchange(5, "thread/unarchive", { threadId: nativeThreadId }, { result: thread }),
          ...exchange(6, "thread/resume", resumeParams, { result: thread }),
          ...exchange(
            7,
            "thread/turns/list",
            {
              threadId: nativeThreadId,
              cursor: null,
              limit: 1,
              sortDirection: "desc",
              itemsView: "summary",
            },
            {
              result: {
                data: [{ id: "native-turn-second", items: [], status: "completed", error: null }],
                nextCursor: null,
              },
            },
          ),
          ...exchange(
            8,
            "thread/revert",
            { threadId: nativeThreadId, beforeTurnId: "native-turn-second" },
            { result: thread },
          ),
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      const now = yield* DateTime.now;
      const firstTurn = codexReplaySourceTurn({
        id: "provider-turn-first",
        ordinal: 1,
        nativeId: "native-turn-first",
        providerThreadId: harness.providerThread.id,
        now,
      });
      const secondTurn = codexReplaySourceTurn({
        id: "provider-turn-second",
        ordinal: 2,
        nativeId: "native-turn-second",
        providerThreadId: harness.providerThread.id,
        now,
      });

      const snapshot = yield* harness.runtime.rollbackThread({
        providerThread: harness.providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-archived-rollback"),
          appRunOrdinal: 1,
          providerTurn: firstTurn,
        },
        providerThreadTurns: [firstTurn, secondTurn],
      });

      assert.equal(snapshot.providerThread.nativeThreadRef?.nativeId, nativeThreadId);
      assert.deepEqual(snapshot.providerThread.nativeConversationHeadRef, firstTurn.nativeTurnRef);
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
  it.effect(
    "falls back to fork-local thread/revert on paginated history when the source turn lacks a native reference",
    () =>
      Effect.gen(function* () {
        const nativeThreadId = "fallback-source-thread";
        const forkThreadId = "fallback-fork-thread";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "fallback-source-turn",
          prompt: "unused",
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-fork-paginated-fallback",
          entries: [
            ...preamble.slice(0, 5),
            {
              type: "expect_outbound",
              label: "thread/fork",
              frame: {
                id: 3,
                method: "thread/fork",
                params: { threadId: nativeThreadId, config: CodexAdapterV2.CODEX_THREAD_CONFIG },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/fork",
              frame: {
                id: 3,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: nativeThreadId,
                }),
              },
            },
            {
              type: "expect_outbound",
              label: "thread/read",
              frame: {
                id: 4,
                method: "thread/read",
                params: { threadId: forkThreadId, includeTurns: false },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/read",
              frame: {
                id: 4,
                result: { thread: { id: forkThreadId, historyMode: "paginated" } },
              },
            },
            {
              type: "expect_outbound",
              label: "thread/turns/list",
              frame: {
                id: 5,
                method: "thread/turns/list",
                params: {
                  threadId: forkThreadId,
                  cursor: null,
                  limit: 1,
                  sortDirection: "desc",
                  itemsView: "summary",
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/turns/list",
              frame: {
                id: 5,
                result: {
                  data: [{ id: "native-turn-second", items: [], status: "completed", error: null }],
                  nextCursor: null,
                },
              },
            },
            {
              type: "expect_outbound",
              label: "thread/revert",
              frame: {
                id: 6,
                method: "thread/revert",
                params: { threadId: forkThreadId, beforeTurnId: "native-turn-second" },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/revert",
              frame: {
                id: 6,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: null,
                }),
              },
            },
          ],
        });
        const outbound: Array<string> = [];
        const forkThreadEnvs: Array<unknown> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method, params) =>
            Effect.sync(() => {
              outbound.push(method);
              if (method === "thread/fork") forkThreadEnvs.push(threadEnvOf(params));
            }),
        );
        const now = yield* DateTime.now;
        const firstTurn = codexReplaySourceTurn({
          id: "provider-turn-first",
          ordinal: 1,
          nativeId: null,
          providerThreadId: harness.providerThread.id,
          now,
        });
        const secondTurn = codexReplaySourceTurn({
          id: "provider-turn-second",
          ordinal: 2,
          nativeId: "native-turn-second",
          providerThreadId: harness.providerThread.id,
          now,
        });

        const forkedProviderThread = yield* harness.runtime.forkThread({
          sourceProviderThread: harness.providerThread,
          sourceProviderTurns: [firstTurn, secondTurn],
          providerTurnId: firstTurn.id,
          targetThreadId: ThreadId.make("thread-fork-paginated-fallback-target"),
        });

        assert.equal(forkedProviderThread.nativeThreadRef?.nativeId, forkThreadId);
        assert.notEqual(forkedProviderThread.id, harness.providerThread.id);
        assert.equal(forkedProviderThread.forkedFrom?.providerTurnId, firstTurn.id);
        assert.deepEqual(outbound.slice(-2), ["thread/turns/list", "thread/revert"]);
        assert.deepEqual(forkThreadEnvs, ["thread-fork-paginated-fallback-target"]);
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
  it.effect("unarchives an archived Codex source thread before forking it", () =>
    Effect.gen(function* () {
      const nativeThreadId = "archived-fork-source";
      const forkThreadId = "archived-fork-target";
      const forkParams = {
        threadId: nativeThreadId,
        lastTurnId: "native-turn-first",
        config: CodexAdapterV2.CODEX_THREAD_CONFIG,
      };
      const exchange = (
        id: number,
        method: string,
        params: unknown,
        reply: { readonly result: unknown } | { readonly error: unknown },
      ): Array<CodexReplay.CodexAppServerReplayEntry> => [
        { type: "expect_outbound", label: method, frame: { id, method, params } },
        { type: "emit_inbound", label: method, frame: { id, ...reply } },
      ];
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-archived-fork",
        entries: [
          ...codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: "archived-fork-turn",
            prompt: "unused",
          }).slice(0, 5),
          ...exchange(3, "thread/fork", forkParams, {
            error: {
              code: -32600,
              message: `session ${nativeThreadId} is archived. Run \`codex unarchive ${nativeThreadId}\` to unarchive it first.`,
            },
          }),
          ...exchange(
            4,
            "thread/unarchive",
            { threadId: nativeThreadId },
            { result: codexReplayThreadResult({ nativeThreadId, forkedFromId: null }) },
          ),
          ...exchange(5, "thread/fork", forkParams, {
            result: codexReplayThreadResult({
              nativeThreadId: forkThreadId,
              forkedFromId: nativeThreadId,
            }),
          }),
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      const now = yield* DateTime.now;
      const firstTurn = codexReplaySourceTurn({
        id: "provider-turn-first",
        ordinal: 1,
        nativeId: "native-turn-first",
        providerThreadId: harness.providerThread.id,
        now,
      });

      const forkedProviderThread = yield* harness.runtime.forkThread({
        sourceProviderThread: harness.providerThread,
        sourceProviderTurns: [firstTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-archived-fork-target"),
      });

      assert.equal(forkedProviderThread.nativeThreadRef?.nativeId, forkThreadId);
      assert.equal(forkedProviderThread.forkedFrom?.providerTurnId, firstTurn.id);
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
