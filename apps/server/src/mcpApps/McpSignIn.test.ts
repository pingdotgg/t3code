import {
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as McpSignIn from "./McpSignIn.ts";

const threadId = ThreadId.make("thread-sign-in");
const providerThreadId = ProviderThreadId.make("provider-thread-sign-in");
const providerSessionId = ProviderSessionId.make("provider-session-sign-in");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-haiku-5-5" } as ModelSelection;
const runtimePolicy = { cwd: "/repo" } as ProviderAdapter.ProviderAdapterV2RuntimePolicy;
const providerThread = {
  id: providerThreadId,
  providerSessionId,
  providerInstanceId: instanceId,
  nativeThreadRef: { driver: "claudeAgent", nativeId: "native-sign-in", strength: "strong" },
} as OrchestrationV2ProviderThread;

describe("McpSignIn", () => {
  // regression: #42868 Sign in must reopen a session that was released while idle
  it.effect("reopens the thread's released session to start a sign-in", () =>
    Effect.gen(function* () {
      const opened: Array<unknown> = [];
      const started: Array<OrchestrationV2ProviderThread> = [];
      const resumed = { ...providerThread, status: "idle" } as OrchestrationV2ProviderThread;
      const mcpSignIn: ProviderAdapter.ProviderAdapterV2McpSignIn = {
        start: (input) =>
          Effect.sync(() => {
            started.push(input.providerThread);
            return { authorizationUrl: "https://linear.example/authorize" };
          }),
        complete: () => Effect.void,
      };
      const layer = McpSignIn.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: threadId,
                    deletedAt: null,
                    activeProviderThreadId: providerThreadId,
                    modelSelection,
                  },
                  providerThreads: [providerThread],
                  providerSessions: [],
                } as never),
            }),
            Layer.mock(RuntimePolicy.RuntimePolicyV2)({
              resolve: () => Effect.succeed(runtimePolicy),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () => Effect.succeedNone,
              open: (input) =>
                Effect.sync(() => {
                  opened.push(input);
                  return {
                    resumeThread: () => Effect.succeed(resumed),
                    mcpSignIn,
                  } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
                }),
            }),
          ),
        ),
      );

      const result = yield* McpSignIn.McpSignIn.use((signIn) =>
        signIn.start({ threadId, providerThreadId, server: "linear" }),
      ).pipe(Effect.provide(layer));

      assert.deepEqual(result, {
        authorizationUrl: "https://linear.example/authorize",
        signedInAt: null,
      });
      assert.deepEqual(opened, [
        {
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
          initialNativeThreadId: "native-sign-in",
        },
      ]);
      assert.deepEqual(started, [resumed]);
    }),
  );
});
