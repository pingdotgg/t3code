import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2Run,
  ProviderInstanceId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as ConversationTransfer from "./ConversationTransferMcpService.ts";

const projectId = ProjectId.make("project:conversation-transfer");
const parentThreadId = ThreadId.make("thread:conversation-transfer-parent");
const sourceThreadId = ThreadId.make("thread:conversation-transfer-source");

function projection(input: {
  readonly threadId: ThreadId;
  readonly runtimeMode: "approval-required" | "full-access";
  readonly interactionMode: "plan" | "default";
}): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id: input.threadId,
      projectId,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
    },
    runs: [],
    contextTransfers: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

const scope = (capabilities: ReadonlyArray<"orchestration"> = ["orchestration"]) =>
  ({
    environmentId: EnvironmentId.make("environment:conversation-transfer"),
    threadId: parentThreadId,
    providerSessionId: "provider-session:conversation-transfer",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(capabilities),
    issuedAt: 1,
  }) satisfies McpInvocationScope;

function testLayer(input: {
  readonly parent: OrchestrationV2ThreadProjection;
  readonly source: OrchestrationV2ThreadProjection;
  readonly dispatch: ThreadManagementService["Service"]["dispatch"];
}) {
  return ConversationTransfer.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagementService)({
        getThreadProjection: () => Effect.succeed(input.parent),
        getProjectThread: ({ threadId }) =>
          Effect.succeed(threadId === parentThreadId ? input.parent : input.source),
        dispatch: input.dispatch,
      }),
    ),
  );
}

describe("ConversationTransferMcpService", () => {
  it("reports a selected durable source run as a turn-specific native fork without a native turn ref", () => {
    const run = {
      providerThreadId: "provider-thread:source",
    } as unknown as OrchestrationV2Run;
    const source = {
      providerThreads: [
        {
          id: "provider-thread:source",
          providerSessionId: "provider-session:source",
          nativeThreadRef: { strength: "strong" },
        },
      ],
      providerSessions: [
        {
          id: "provider-session:source",
          capabilities: {
            threads: { canForkThread: true, canForkFromTurn: false },
            identity: { nativeThreadIds: "strong" },
          },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    assert.equal(
      ConversationTransfer.conversationForkNativeEligibility(source, run),
      "provider_does_not_support_turn_fork",
    );
  });

  it.effect("rejects missing stable runs and inherited permission escalation before dispatch", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make(0);
      const parent = projection({
        threadId: parentThreadId,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      const source = projection({
        threadId: sourceThreadId,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const escalation = yield* Effect.gen(function* () {
        const service = yield* ConversationTransfer.ConversationTransferMcpService;
        return yield* service
          .fork(scope(), {
            sourceThreadId,
            sourcePoint: { type: "latest_stable" },
            clientRequestId: "permission-ceiling",
          })
          .pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          testLayer({
            parent,
            source,
            dispatch: () =>
              Ref.update(dispatched, (count) => count + 1).pipe(Effect.as({} as never)),
          }),
        ),
      );
      assert.equal(escalation.code, "runtime_mode_escalation_denied");

      const noRun = yield* Effect.gen(function* () {
        const service = yield* ConversationTransfer.ConversationTransferMcpService;
        return yield* service
          .fork(scope(), {
            sourcePoint: { type: "run", runId: "run:missing" as never },
            clientRequestId: "missing-run",
          })
          .pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          testLayer({
            parent,
            source: parent,
            dispatch: () =>
              Ref.update(dispatched, (count) => count + 1).pipe(Effect.as({} as never)),
          }),
        ),
      );
      assert.equal(noRun.code, "run_not_found");
      assert.equal(yield* Ref.get(dispatched), 0);
    }),
  );

  it.effect("denies transfer reads without orchestration capability", () =>
    Effect.gen(function* () {
      const parent = projection({
        threadId: parentThreadId,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const error = yield* Effect.gen(function* () {
        const service = yield* ConversationTransfer.ConversationTransferMcpService;
        return yield* service.list(scope([]), {}).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          testLayer({
            parent,
            source: parent,
            dispatch: () => Effect.die("dispatch should not run"),
          }),
        ),
      );
      assert.equal(error.code, "capability_denied");
    }),
  );
});
