import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ThreadMetadataMcp from "./ThreadMetadataMcpService.ts";

const threadId = ThreadId.make("thread:metadata-caller");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:metadata-test"),
  requestNamespace: "provider-session:metadata-test",
  thread: {
    threadId,
    providerSessionId: "provider-session:metadata-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

function serviceLayer(
  getThreadShell: ThreadManagement.ThreadManagementService["Service"]["getThreadShell"],
) {
  return ThreadMetadataMcp.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell,
          getThreadRecords: () => Effect.die("projection must not load after shell failure"),
        } satisfies Partial<ThreadManagement.ThreadManagementService["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );
}

const updateCallingThread = Effect.gen(function* () {
  const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
  return yield* service.update(scope, {
    action: "rename",
    title: "Renamed thread",
    clientRequestId: "metadata-caller-classification",
  });
});

it.effect("reports an absent calling thread as thread_not_found", () =>
  Effect.gen(function* () {
    const error = yield* updateCallingThread.pipe(
      Effect.provide(serviceLayer(() => Effect.succeed(null))),
      Effect.flip,
    );

    expect(error.code).toBe("thread_not_found");
  }),
);

it.effect("keeps calling-thread storage failures as orchestration errors", () =>
  Effect.gen(function* () {
    const error = yield* updateCallingThread.pipe(
      Effect.provide(
        serviceLayer(() =>
          Effect.fail(
            new OrchestratorProjectionError({
              threadId,
              cause: new Error("storage unavailable"),
            }),
          ),
        ),
      ),
      Effect.flip,
    );

    expect(error.code).toBe("orchestration_error");
  }),
);

it.effect("refuses to change a thread that runs above the caller's modes", () =>
  Effect.gen(function* () {
    const fullAccessThread = ThreadId.make("thread:metadata-full-access");
    const shells = new Map([
      [
        threadId,
        {
          id: threadId,
          projectId: "project",
          runtimeMode: "auto",
          interactionMode: "default",
          activeRunId: "run-live",
          archivedAt: null,
          providerInstanceId: "codex",
          deletedAt: null,
        },
      ],
      [
        fullAccessThread,
        {
          id: fullAccessThread,
          projectId: "project",
          runtimeMode: "full-access",
          interactionMode: "default",
          deletedAt: null,
        },
      ],
    ]);
    const error = yield* Effect.gen(function* () {
      const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
      return yield* service.update(scope, {
        threadId: fullAccessThread,
        action: "rename",
        title: "Renamed from a narrower thread",
      });
    }).pipe(
      Effect.provide(serviceLayer((id) => Effect.succeed((shells.get(id) ?? null) as never))),
      Effect.flip,
    );

    expect(error.code).toBe("runtime_mode_escalation_denied");
  }),
);

it.effect("refuses another thread's metadata to a thread caller whose run has ended", () =>
  Effect.gen(function* () {
    const otherThread = ThreadId.make("thread:metadata-other");
    const shells = new Map([
      [
        threadId,
        {
          id: threadId,
          projectId: "project",
          runtimeMode: "full-access",
          interactionMode: "default",
          activeRunId: null,
          archivedAt: null,
          providerInstanceId: "codex",
          deletedAt: null,
        },
      ],
      [
        otherThread,
        {
          id: otherThread,
          projectId: "project",
          runtimeMode: "approval-required",
          interactionMode: "default",
          deletedAt: null,
        },
      ],
    ]);
    const error = yield* Effect.gen(function* () {
      const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
      return yield* service.update(scope, {
        threadId: otherThread,
        action: "rename",
        title: "Renamed after the run ended",
      });
    }).pipe(
      Effect.provide(serviceLayer((id) => Effect.succeed((shells.get(id) ?? null) as never))),
      Effect.flip,
    );

    expect(error.code).toBe("parent_not_active");
  }),
);
