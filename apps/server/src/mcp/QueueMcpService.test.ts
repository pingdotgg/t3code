import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import {
  ThreadManagementProjectionLoadError,
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
} from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { layer, QueueMcpService } from "./QueueMcpService.ts";

const projectId = ProjectId.make("project:queue-mcp-service");
const callerThreadId = ThreadId.make("thread:queue-mcp-caller");
const targetThreadId = ThreadId.make("thread:queue-mcp-target");
const queuedRunId = RunId.make("run:queue-mcp-target");
const queuedMessageId = MessageId.make("message:queue-mcp-target");

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:queue-mcp-service"),
  threadId: callerThreadId,
  providerSessionId: "provider-session:queue-mcp-service",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

function projection(input: {
  readonly threadId: ThreadId;
  readonly runtimeMode: "approval-required" | "full-access";
  readonly interactionMode: "plan" | "default";
  readonly queued?: boolean;
}): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id: input.threadId,
      projectId,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      deletedAt: null,
    },
    runs:
      input.queued === true
        ? [
            {
              id: queuedRunId,
              ordinal: 1,
              status: "queued",
              queuePosition: 1,
              userMessageId: queuedMessageId,
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
            },
          ]
        : [],
    messages:
      input.queued === true
        ? [
            {
              id: queuedMessageId,
              text: "Queued text",
              attachments: [],
            },
          ]
        : [],
  } as unknown as OrchestrationV2ThreadProjection;
}

function serviceLayer(input: {
  readonly caller: OrchestrationV2ThreadProjection;
  readonly target: OrchestrationV2ThreadProjection;
  readonly dispatchCount: Ref.Ref<number>;
}) {
  return layer.pipe(
    Layer.provide(
      Layer.merge(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: () => Effect.succeed(input.caller),
          getProjectThread: () => Effect.succeed(input.target),
          getCommandReceipt: () => Effect.succeed(Option.none()),
          dispatch: () =>
            Ref.update(input.dispatchCount, (count) => count + 1).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            ),
        }),
      ),
    ),
  );
}

describe("QueueMcpService", () => {
  it.effect("applies the shared runtime and interaction ceilings to edit and promote", () =>
    Effect.gen(function* () {
      const dispatchCount = yield* Ref.make(0);
      const caller = projection({
        threadId: callerThreadId,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      const assertDenied = (target: OrchestrationV2ThreadProjection, expectedCode: string) =>
        Effect.gen(function* () {
          const service = yield* QueueMcpService;
          const editError = yield* service
            .edit(scope, {
              threadId: targetThreadId,
              queuedRunId,
              text: "Edited text",
              clientRequestId: `edit-${expectedCode}`,
            })
            .pipe(Effect.flip);
          assert.equal(editError.code, expectedCode);
          const promoteError = yield* service
            .promote(scope, {
              threadId: targetThreadId,
              queuedRunId,
              targetRunId: RunId.make("run:active-target"),
              clientRequestId: `promote-${expectedCode}`,
            })
            .pipe(Effect.flip);
          assert.equal(promoteError.code, expectedCode);
        }).pipe(Effect.provide(serviceLayer({ caller, target, dispatchCount })));

      yield* assertDenied(
        projection({
          threadId: targetThreadId,
          runtimeMode: "full-access",
          interactionMode: "plan",
          queued: true,
        }),
        "runtime_mode_escalation_denied",
      );
      yield* assertDenied(
        projection({
          threadId: targetThreadId,
          runtimeMode: "approval-required",
          interactionMode: "default",
          queued: true,
        }),
        "interaction_mode_escalation_denied",
      );
      assert.equal(yield* Ref.get(dispatchCount), 0);
    }),
  );

  it.effect("allows edit and promote when the target stays within both ceilings", () =>
    Effect.gen(function* () {
      const dispatchCount = yield* Ref.make(0);
      const caller = projection({
        threadId: callerThreadId,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const target = projection({
        threadId: targetThreadId,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        queued: true,
      });
      yield* Effect.gen(function* () {
        const service = yield* QueueMcpService;
        yield* service.edit(scope, {
          threadId: targetThreadId,
          queuedRunId,
          text: "Edited text",
          clientRequestId: "edit-allowed",
        });
        yield* service.promote(scope, {
          threadId: targetThreadId,
          queuedRunId,
          targetRunId: RunId.make("run:active-target"),
          clientRequestId: "promote-allowed",
        });
      }).pipe(Effect.provide(serviceLayer({ caller, target, dispatchCount })));
      assert.equal(yield* Ref.get(dispatchCount), 2);
    }),
  );

  it.effect("distinguishes missing threads from projection failures", () =>
    Effect.gen(function* () {
      const caller = projection({
        threadId: callerThreadId,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const invokeListWith = (
        getProjectThread: ThreadManagementService["Service"]["getProjectThread"],
      ) =>
        Effect.gen(function* () {
          const service = yield* QueueMcpService;
          return yield* service.list(scope, { threadId: targetThreadId }).pipe(Effect.flip);
        }).pipe(
          Effect.provide(
            layer.pipe(
              Layer.provide(
                Layer.merge(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService)({
                    getThreadProjection: () => Effect.succeed(caller),
                    getProjectThread,
                  }),
                ),
              ),
            ),
          ),
        );

      const missing = yield* invokeListWith(() =>
        Effect.fail(
          new ThreadManagementThreadNotFoundError({ projectId, threadId: targetThreadId }),
        ),
      );
      assert.equal(missing.code, "thread_not_found");
      const broken = yield* invokeListWith(() =>
        Effect.fail(
          new ThreadManagementProjectionLoadError({
            projectId,
            threadId: targetThreadId,
            cause: new Error("database unavailable"),
          }),
        ),
      );
      assert.equal(broken.code, "orchestration_error");
    }),
  );

  it.effect("does not disguise caller projection failures as scoped not-found results", () =>
    Effect.gen(function* () {
      const invokeListWith = (cause: unknown) =>
        Effect.gen(function* () {
          const service = yield* QueueMcpService;
          return yield* service.list(scope, {}).pipe(Effect.flip);
        }).pipe(
          Effect.provide(
            layer.pipe(
              Layer.provide(
                Layer.merge(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService)({
                    getThreadProjection: () =>
                      Effect.fail(
                        new OrchestratorProjectionError({ threadId: callerThreadId, cause }),
                      ),
                  }),
                ),
              ),
            ),
          ),
        );

      const projectionFailure = yield* invokeListWith(
        new ProjectionStoreThreadNotFoundError({ threadId: callerThreadId }),
      );
      assert.equal(projectionFailure.code, "orchestration_error");
    }),
  );
});
