import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  CodexSettings,
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import type * as Cause from "effect/Cause";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { makeReplayServerConfig } from "../testkit/ProviderReplayHarness.ts";
import {
  CODEX_DEFAULT_INSTANCE_ID,
  CODEX_DRIVER_KIND,
  makeCodexAdapterV2,
} from "./CodexAdapterV2.ts";

const defaultCodexSettings = Schema.decodeSync(CodexSettings)({});

it.effect.each([true, false])(
  "rewinds to a Codex control turn with later native ID present: %s",
  (hasNativeId) =>
    Effect.gen(function* () {
      const scenario = "codex-control-turn-rewind";
      const nativeThreadId = "native-thread";
      const nativeHistory = ["kept", "later", "latest"];
      const revertedFrom: string[] = [];
      const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const thread = {
        id: nativeThreadId,
        sessionId: nativeThreadId,
        projectId: null,
        forkedFromId: null,
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: 1782622440,
        updatedAt: 1782622440,
        status: { type: "idle" },
        path: null,
        cwd: "/workspace",
        cliVersion: "0.156.1",
        source: "vscode",
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
        historyMode: "paginated",
      };
      const client = yield* CodexClient.make(
        Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.fromQueue(input),
          stderr: () => Sink.drain,
          stdout: () =>
            Sink.forEach((chunk: string | Uint8Array) =>
              Effect.gen(function* () {
                const { id, method, params } = JSON.parse(
                  typeof chunk === "string" ? chunk : decoder.decode(chunk),
                ) as {
                  id?: number;
                  method: string;
                  params?: { beforeTurnId: string; limit: number };
                };
                if (id === undefined) return;
                const emit = (result: unknown) =>
                  Queue.offer(input, encoder.encode(JSON.stringify({ id, result }) + "\n"));
                switch (method) {
                  case "initialize":
                    yield* emit({
                      userAgent: "T3 Code/0.156.1",
                      codexHome: "/tmp/codex",
                      platformFamily: "unix",
                      platformOs: "linux",
                    });
                    return;
                  case "thread/turns/list":
                    yield* emit({
                      data: nativeHistory
                        .toReversed()
                        .slice(0, params?.limit)
                        .map((id) => ({
                          id,
                          items: [],
                          status: "completed",
                          error: null,
                        })),
                      nextCursor: null,
                    });
                    return;
                  case "thread/revert": {
                    const boundary = nativeHistory.findIndex(
                      (turn) => turn === params?.beforeTurnId,
                    );
                    assert.isAtLeast(boundary, 0);
                    const [firstRemoved] = nativeHistory.splice(boundary);
                    if (firstRemoved !== undefined) revertedFrom.push(firstRemoved);
                    break;
                  }
                  default:
                    assert.equal(method, "thread/read");
                }
                yield* emit({ thread });
              }),
            ),
        }),
      );
      const adapter = yield* makeCodexAdapterV2({
        instanceId: CODEX_DEFAULT_INSTANCE_ID,
        settings: defaultCodexSettings,
        environment: {},
        clientFactory: { open: () => Effect.succeed(client) },
        digest: yield* Digest.Digest,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* makeReplayServerConfig(scenario).pipe(Effect.orDie),
      });
      const threadId = ThreadId.make(scenario);
      const providerSessionId = ProviderSessionId.make(scenario);
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId,
        modelSelection: { instanceId: CODEX_DEFAULT_INSTANCE_ID, model: "gpt-5.4" },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        }),
      });
      const now = yield* DateTime.now;
      const nativeRef = (nativeId: string) => ({
        driver: CODEX_DRIVER_KIND,
        nativeId,
        strength: "strong" as const,
      });
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make(scenario),
        driver: CODEX_DRIVER_KIND,
        providerInstanceId: CODEX_DEFAULT_INSTANCE_ID,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: nativeRef(nativeThreadId),
        nativeConversationHeadRef: nativeRef("latest"),
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 4,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const turn = (
        id: string,
        ordinal: number,
        nativeTurnRef: OrchestrationV2ProviderTurn["nativeTurnRef"],
      ): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(id),
        providerThreadId: providerThread.id,
        nodeId: NodeId.make("test-node"),
        runAttemptId: null,
        ordinal,
        nativeTurnRef,
        status: "completed",
        startedAt: now,
        completedAt: now,
      });
      const keptControl = turn("goal-control", 2, null);
      const laterRef = (id: string) =>
        hasNativeId
          ? nativeRef(id)
          : { ...nativeRef(id), nativeId: null, strength: "none" as const };
      const rewind = runtime.rollbackThread({
        providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make(scenario),
          appRunOrdinal: 2,
          // The durable record owns the boundary when the target carries a stale ordinal.
          providerTurn: { ...keptControl, ordinal: 4 },
        },
        providerThreadTurns: [
          turn("latest", 4, laterRef("latest")),
          turn("kept", 1, nativeRef("kept")),
          keptControl,
          turn("later", 3, laterRef("later")),
        ],
      });
      if (!hasNativeId) {
        const error = yield* rewind.pipe(Effect.flip);
        assert.instanceOf(error, ProviderAdapter.ProviderAdapterRollbackThreadError);
        assert.deepEqual(nativeHistory, ["kept", "later", "latest"]);
        return;
      }
      yield* rewind;
      assert.deepEqual(nativeHistory, ["kept"]);
      yield* rewind;
      assert.deepEqual(nativeHistory, ["kept"]);
      assert.deepEqual(revertedFrom, ["later"]);
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
