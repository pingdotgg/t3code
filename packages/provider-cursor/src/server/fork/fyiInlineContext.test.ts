import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { makeCursorAdapterV2 } from "../adapter.ts";
import * as CursorAgentSdk from "../CursorAgentSdk.ts";

describe("CursorAdapterV2 inline context", () => {
  it.effect("rewrites no skill that only the turn's inline context names", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cursor-v2-inline-context-",
      });
      const path = yield* Path.Path;
      const userOnlySkill = path.join(workspace, ".cursor", "skills", "grill-me");
      yield* fileSystem.makeDirectory(userOnlySkill, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(userOnlySkill, "SKILL.md"),
        "---\nname: grill-me\ndescription: Grill the plan.\ndisable-model-invocation: true\n---\nAsk one question at a time.",
      );
      const sent: unknown[] = [];
      const finished = yield* Deferred.make<{
        readonly id: string;
        readonly requestId: string;
        readonly status: "finished" | "cancelled";
        readonly model: { readonly id: string };
        readonly durationMs: number;
      }>();
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-inline-context-thread");
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        environment: { HOME: workspace },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-inline-context",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.as(
                  Effect.sync(() => sent.push(input.message)),
                  {
                    agentId: "native-cursor-inline-context",
                    runId: "native-cursor-inline-context-run",
                    wait: Deferred.await(finished),
                    cancel: Deferred.succeed(finished, {
                      id: "native-cursor-inline-context-run",
                      requestId: "native-request",
                      status: "cancelled" as const,
                      model: { id: "composer-2.5" },
                      durationMs: 1,
                    }).pipe(Effect.asVoid),
                  },
                ),
            }),
        }),
        Effect.provide(TestProviderHost.layer({ cwd: workspace })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-inline-context-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const context = "<fyi>Use $grill-me on the plan.</fyi>\n\nUser message:\n";
      yield* runtime.startTurn({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-inline-context-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-inline-context-attempt"),
        rootNodeId: NodeId.make("cursor-inline-context-root"),
        appThread: {
          id: threadId,
          projectId: ProjectId.make("cursor-inline-context-project"),
          createdBy: "user" as const,
          creationSource: "web" as const,
          title: "Cursor inline context",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        message: {
          messageId: MessageId.make("cursor-inline-context-message"),
          createdBy: "user" as const,
          creationSource: "web" as const,
          text: `${context}Review the code.`,
          attachments: [],
        },
        inlineContextLength: context.length,
      });
      assert.include(String(sent[0]), "Use $grill-me on the plan.");
      assert.notInclude(String(sent[0]), "Ask one question at a time.");
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
          driver: CursorAgentSdk.CURSOR_PROVIDER,
          nativeTurnId: "native-cursor-inline-context-run",
        }),
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );
});
