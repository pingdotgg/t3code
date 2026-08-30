import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  PENDING_REQUEST_MCP_MAX_QUESTION_CHARS,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { CommandReceiptV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import {
  ThreadManagementProjectionLoadError,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { layer, PendingRequestMcpService } from "./PendingRequestMcpService.ts";

const parentThreadId = ThreadId.make("thread:pending-request-parent");
const childThreadId = ThreadId.make("thread:pending-request-child");
const unrelatedThreadId = ThreadId.make("thread:pending-request-unrelated");
const projectId = ProjectId.make("project:pending-request");
const taskId = NodeId.make("node:pending-request-task");
const requestNodeId = NodeId.make("node:pending-request-question");
const requestId = RuntimeRequestId.make("request:pending-request-question");
const providerThreadId = ProviderThreadId.make("provider-thread:pending-request");
const providerSessionId = ProviderSessionId.make("provider-session:pending-request-child");
const now = DateTime.makeUnsafe("2026-08-29T12:00:00.000Z");

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:pending-request"),
  threadId: parentThreadId,
  providerSessionId: "provider-session:mcp-pending-request",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const questions = [
  {
    id: "editor",
    header: "Editor",
    question: "Which editor should the delegated task configure?",
    options: [
      { label: "Vim", description: "Use Vim." },
      { label: "Zed", description: "Use Zed." },
    ],
  },
];

function parentProjection(
  origin: "app_owned" | "provider_native" = "app_owned",
  modes: {
    readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
    readonly interactionMode?: "plan" | "default";
  } = {},
) {
  return {
    thread: {
      id: parentThreadId,
      projectId,
      runtimeMode: modes.runtimeMode ?? "auto-accept-edits",
      interactionMode: modes.interactionMode ?? "default",
      deletedAt: null,
    },
    subagents: [
      {
        id: taskId,
        threadId: parentThreadId,
        origin,
        childThreadId,
        updatedAt: now,
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

function childProjection(
  input: {
    readonly kind?: OrchestrationV2RuntimeRequest["kind"];
    readonly status?: OrchestrationV2RuntimeRequest["status"];
    readonly resumable?: boolean;
    readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
    readonly interactionMode?: "plan" | "default";
  } = {},
) {
  const status = input.status ?? "pending";
  return {
    thread: {
      id: childThreadId,
      projectId,
      runtimeMode: input.runtimeMode ?? "auto-accept-edits",
      interactionMode: input.interactionMode ?? "default",
      deletedAt: null,
    },
    providerThreads: [
      {
        id: providerThreadId,
        driver: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId,
      },
    ],
    runtimeRequests: [
      {
        id: requestId,
        nodeId: requestNodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: input.kind ?? "user_input",
        status,
        responseCapability:
          input.resumable === false
            ? { type: "not_resumable", reason: "The provider session ended." }
            : { type: "live", providerSessionId },
        createdAt: now,
        resolvedAt: status === "pending" ? null : now,
      },
    ],
    turnItems: [
      {
        id: TurnItemId.make("turn-item:pending-request-question"),
        threadId: childThreadId,
        runId: null,
        nodeId: requestNodeId,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: status === "pending" ? "waiting" : "completed",
        title: null,
        startedAt: now,
        completedAt: status === "pending" ? null : now,
        updatedAt: now,
        type: "user_input_request",
        requestId,
        questions,
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

function parentProjectionWithTasks(
  tasks: ReadonlyArray<{
    readonly taskId: ReturnType<typeof NodeId.make>;
    readonly childThreadId: ReturnType<typeof ThreadId.make>;
    readonly updatedAt?: typeof now;
  }>,
) {
  const parent = parentProjection();
  const baseTask = parent.subagents[0];
  if (baseTask === undefined) throw new Error("Pending-request parent fixture is incomplete.");
  return {
    ...parent,
    subagents: tasks.map((task) => ({
      ...baseTask,
      id: task.taskId,
      threadId: parentThreadId,
      origin: "app_owned" as const,
      childThreadId: task.childThreadId,
      updatedAt: task.updatedAt ?? now,
    })),
  } as OrchestrationV2ThreadProjection;
}

function childProjectionWithRequests(input: {
  readonly childThreadId: ReturnType<typeof ThreadId.make>;
  readonly requests: ReadonlyArray<{
    readonly requestId: ReturnType<typeof RuntimeRequestId.make>;
    readonly status?: OrchestrationV2RuntimeRequest["status"];
    readonly questions?: typeof questions;
  }>;
}) {
  const base = childProjection();
  const providerThread = base.providerThreads[0];
  const item = base.turnItems.find((candidate) => candidate.type === "user_input_request");
  if (providerThread === undefined || item?.type !== "user_input_request") {
    throw new Error("Pending-request test fixture is incomplete.");
  }
  return {
    ...base,
    thread: { ...base.thread, id: input.childThreadId },
    runtimeRequests: input.requests.map((request) => ({
      ...base.runtimeRequests[0],
      id: request.requestId,
      nodeId: NodeId.make(`node:pending-request:${request.requestId}`),
      status: request.status ?? "pending",
      resolvedAt: request.status === undefined || request.status === "pending" ? null : now,
    })),
    turnItems: input.requests.map((request, index) => ({
      ...item,
      id: TurnItemId.make(`turn-item:pending-request:${index}`),
      threadId: input.childThreadId,
      nodeId: NodeId.make(`node:pending-request:${request.requestId}`),
      requestId: request.requestId,
      questions: request.questions ?? questions,
      status:
        request.status === undefined || request.status === "pending" ? "waiting" : "completed",
      completedAt: request.status === undefined || request.status === "pending" ? null : now,
    })),
  } as OrchestrationV2ThreadProjection;
}

function serviceLayer(input: {
  readonly getParent?: () => OrchestrationV2ThreadProjection;
  readonly getChild: () => OrchestrationV2ThreadProjection;
  readonly getThreadProjection?: ThreadManagementService["Service"]["getThreadProjection"];
  readonly getProjectThread?: ThreadManagementService["Service"]["getProjectThread"];
  readonly getReceipt?: ThreadManagementService["Service"]["getCommandReceipt"];
  readonly dispatch?: ThreadManagementService["Service"]["dispatch"];
}) {
  return layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection:
            input.getThreadProjection ??
            (() => Effect.succeed(input.getParent?.() ?? parentProjection())),
          getProjectThread:
            input.getProjectThread ??
            (({ threadId }) =>
              threadId === childThreadId
                ? Effect.succeed(input.getChild())
                : Effect.die(new Error(`Unexpected child projection read: ${threadId}`))),
          getCommandReceipt: input.getReceipt ?? (() => Effect.succeed(Option.none())),
          dispatch:
            input.dispatch ??
            (() => Effect.succeed({ sequence: 1, storedEvents: [], replayed: false })),
        }),
      ),
    ),
  );
}

describe("PendingRequestMcpService", () => {
  it.effect(
    "lists and reads only structured user-input questions on direct app-owned children",
    () =>
      Effect.gen(function* () {
        const service = yield* PendingRequestMcpService;
        const listed = yield* service.list(scope, {});
        assert.equal(listed.requests.length, 1);
        assert.equal(listed.requests[0]?.taskId, taskId);
        assert.equal(listed.requests[0]?.childThreadId, childThreadId);
        assert.equal(listed.requests[0]?.requestId, requestId);
        assert.deepEqual(listed.requests[0]?.questions, questions);
        assert.equal(listed.requests[0]?.questionPayloadStatus, "complete");
        assert.isTrue(listed.requests[0]?.answerable);
        assert.equal(listed.nextCursor, null);

        const read = yield* service.read(scope, { childThreadId, requestId });
        assert.equal(read.providerInstanceId, "codex");
        assert.equal(read.driverKind, "codex");
        assert.equal(read.status, "pending");
        assert.isTrue(read.resumable);
      }).pipe(Effect.provide(serviceLayer({ getChild: () => childProjection() }))),
  );

  it.effect("continues by stable task and request identities after prior results change", () =>
    Effect.gen(function* () {
      const taskA = NodeId.make("node:pending-request-task-a");
      const taskB = NodeId.make("node:pending-request-task-b");
      const childA = ThreadId.make("thread:pending-request-child-a");
      const childB = ThreadId.make("thread:pending-request-child-b");
      const requestA = RuntimeRequestId.make("request:pending-request-a");
      const requestB = RuntimeRequestId.make("request:pending-request-b");
      const requestC = RuntimeRequestId.make("request:pending-request-c");
      let parent = parentProjectionWithTasks([
        { taskId: taskB, childThreadId: childB },
        { taskId: taskA, childThreadId: childA },
      ]);
      let projectionA = childProjectionWithRequests({
        childThreadId: childA,
        requests: [{ requestId: requestA }, { requestId: requestB }],
      });
      const projectionB = childProjectionWithRequests({
        childThreadId: childB,
        requests: [{ requestId: requestC }],
      });

      yield* Effect.gen(function* () {
        const service = yield* PendingRequestMcpService;
        const first = yield* service.list(scope, { limit: 1 });
        assert.deepEqual(
          first.requests.map((request) => request.requestId),
          [requestA],
        );
        assert.isNotNull(first.nextCursor);

        parent = parentProjectionWithTasks([
          {
            taskId: taskA,
            childThreadId: childA,
            updatedAt: DateTime.makeUnsafe("2026-08-29T12:02:00.000Z"),
          },
          {
            taskId: taskB,
            childThreadId: childB,
            updatedAt: DateTime.makeUnsafe("2026-08-29T12:01:00.000Z"),
          },
        ]);
        projectionA = childProjectionWithRequests({
          childThreadId: childA,
          requests: [{ requestId: requestA, status: "resolved" }, { requestId: requestB }],
        });

        const second = yield* service.list(scope, {
          cursor: first.nextCursor ?? undefined,
          limit: 2,
        });
        assert.deepEqual(
          second.requests.map((request) => request.requestId),
          [requestB, requestC],
        );
        assert.isNull(second.nextCursor);
      }).pipe(
        Effect.provide(
          serviceLayer({
            getParent: () => parent,
            getChild: () => projectionA,
            getProjectThread: ({ threadId }) =>
              Effect.succeed(threadId === childA ? projectionA : projectionB),
          }),
        ),
      );
    }),
  );

  it.effect("bounds empty child scans and returns a continuation for unscanned children", () =>
    Effect.gen(function* () {
      const tasks = Array.from({ length: 22 }, (_, index) => ({
        taskId: NodeId.make(`node:pending-request-empty-${String(index).padStart(2, "0")}`),
        childThreadId: ThreadId.make(
          `thread:pending-request-empty-${String(index).padStart(2, "0")}`,
        ),
      }));
      const getProjectThread = vi.fn(({ threadId }) =>
        Effect.succeed(childProjectionWithRequests({ childThreadId: threadId, requests: [] })),
      );

      yield* Effect.gen(function* () {
        const service = yield* PendingRequestMcpService;
        const first = yield* service.list(scope, { limit: 50 });
        assert.deepEqual(first.requests, []);
        assert.isNotNull(first.nextCursor);
        assert.equal(getProjectThread.mock.calls.length, 20);

        const second = yield* service.list(scope, { cursor: first.nextCursor ?? undefined });
        assert.deepEqual(second.requests, []);
        assert.isNull(second.nextCursor);
        assert.equal(getProjectThread.mock.calls.length, 22);
      }).pipe(
        Effect.provide(
          serviceLayer({
            getParent: () => parentProjectionWithTasks(tasks),
            getChild: () => childProjection(),
            getProjectThread,
          }),
        ),
      );
    }),
  );

  it.effect("skips only typed missing children while surfacing projection storage failures", () =>
    Effect.gen(function* () {
      const missingTask = NodeId.make("node:pending-request-missing-a");
      const validTask = NodeId.make("node:pending-request-valid-b");
      const missingChild = ThreadId.make("thread:pending-request-missing-a");
      const validChild = ThreadId.make("thread:pending-request-valid-b");
      const validRequest = RuntimeRequestId.make("request:pending-request-valid");
      const parent = parentProjectionWithTasks([
        { taskId: missingTask, childThreadId: missingChild },
        { taskId: validTask, childThreadId: validChild },
      ]);
      const missingCause = new ThreadManagementProjectionLoadError({
        projectId,
        threadId: missingChild,
        cause: new OrchestratorProjectionError({
          threadId: missingChild,
          cause: new ProjectionStoreThreadNotFoundError({ threadId: missingChild }),
        }),
      });
      const storageCause = new ThreadManagementProjectionLoadError({
        projectId,
        threadId: missingChild,
        cause: new OrchestratorProjectionError({
          threadId: missingChild,
          cause: new Error("sqlite credentials leaked"),
        }),
      });

      yield* Effect.gen(function* () {
        const service = yield* PendingRequestMcpService;
        const listed = yield* service.list(scope, {});
        assert.deepEqual(
          listed.requests.map((request) => request.requestId),
          [validRequest],
        );
      }).pipe(
        Effect.provide(
          serviceLayer({
            getParent: () => parent,
            getChild: () => childProjection(),
            getProjectThread: ({ threadId }) =>
              threadId === missingChild
                ? Effect.fail(missingCause)
                : Effect.succeed(
                    childProjectionWithRequests({
                      childThreadId: validChild,
                      requests: [{ requestId: validRequest }],
                    }),
                  ),
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const service = yield* PendingRequestMcpService;
        const failed = yield* service.list(scope, {}).pipe(Effect.flip);
        assert.equal(failed.code, "orchestration_error");
        assert.notInclude(failed.message, "sqlite credentials leaked");
      }).pipe(
        Effect.provide(
          serviceLayer({
            getParent: () =>
              parentProjectionWithTasks([{ taskId: missingTask, childThreadId: missingChild }]),
            getChild: () => childProjection(),
            getProjectThread: () => Effect.fail(storageCause),
          }),
        ),
      );
    }),
  );

  it.effect("marks oversized provider questions as unavailable and refuses partial answers", () => {
    const dispatch = vi.fn(() => Effect.die("oversized requests must not dispatch"));
    const oversizedQuestions = [
      {
        ...questions[0]!,
        question: "q".repeat(PENDING_REQUEST_MCP_MAX_QUESTION_CHARS + 1),
      },
    ];
    const oversized = childProjectionWithRequests({
      childThreadId,
      requests: [{ requestId, questions: oversizedQuestions }],
    });

    return Effect.gen(function* () {
      const service = yield* PendingRequestMcpService;
      const read = yield* service.read(scope, { childThreadId, requestId });
      assert.equal(read.questionPayloadStatus, "too_large");
      assert.equal(read.questionCount, 1);
      assert.deepEqual(read.questions, []);
      assert.isFalse(read.answerable);

      const rejected = yield* service
        .respond(scope, {
          childThreadId,
          requestId,
          answers: { editor: "Vim" },
          clientRequestId: "oversized-question",
        })
        .pipe(Effect.flip);
      assert.equal(rejected.code, "request_payload_too_large");
      assert.equal(dispatch.mock.calls.length, 0);
    }).pipe(
      Effect.provide(
        serviceLayer({
          getChild: () => oversized,
          dispatch,
        }),
      ),
    );
  });

  it.effect("keeps projection defects out of MCP failure messages", () =>
    Effect.gen(function* () {
      const service = yield* PendingRequestMcpService;
      const failure = yield* service.list(scope, {}).pipe(Effect.flip);
      assert.equal(failure.code, "orchestration_error");
      assert.equal(
        failure.message,
        `Unable to load calling thread '${parentThreadId}': Failed to load orchestration projection for thread ${parentThreadId}.`,
      );
      assert.notInclude(failure.message, "database credentials leaked");
    }).pipe(
      Effect.provide(
        serviceLayer({
          getChild: () => childProjection(),
          getThreadProjection: () =>
            Effect.fail(
              new OrchestratorProjectionError({
                threadId: parentThreadId,
                cause: new Error("database credentials leaked"),
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("rejects provider-native children and non-user-input request kinds", () =>
    Effect.gen(function* () {
      const providerOwnedService = yield* PendingRequestMcpService;
      const wrongChild = yield* providerOwnedService
        .read(scope, { childThreadId, requestId })
        .pipe(Effect.flip);
      assert.equal(wrongChild.code, "child_not_found");
    }).pipe(
      Effect.provide(
        serviceLayer({
          getParent: () => parentProjection("provider_native"),
          getChild: () => childProjection(),
        }),
      ),
      Effect.andThen(
        Effect.gen(function* () {
          const service = yield* PendingRequestMcpService;
          const wrongKind = yield* service
            .read(scope, { childThreadId, requestId })
            .pipe(Effect.flip);
          assert.equal(wrongKind.code, "wrong_request_kind");
        }).pipe(
          Effect.provide(
            serviceLayer({ getChild: () => childProjection({ kind: "file-change" }) }),
          ),
        ),
      ),
    ),
  );

  it.effect("answers every question once and replays the accepted durable receipt", () =>
    Effect.gen(function* () {
      const projection = yield* Ref.make(childProjection());
      const acceptedReceipt = yield* Ref.make<Option.Option<CommandReceiptV2>>(Option.none());
      const dispatch = vi.fn((command) =>
        Effect.gen(function* () {
          assert.equal(command.type, "runtime-request.respond");
          if (command.type !== "runtime-request.respond") return assert.fail("wrong command");
          assert.equal(command.decision, undefined);
          assert.deepEqual(command.answers, { editor: "Vim" });
          yield* Ref.set(projection, childProjection({ status: "resolved" }));
          yield* Ref.set(
            acceptedReceipt,
            Option.some({
              commandId: command.commandId,
              threadId: childThreadId,
              commandType: command.type,
              acceptedAt: now,
              resultSequence: 7,
              status: "accepted",
              error: null,
            }),
          );
          return { sequence: 7, storedEvents: [], replayed: false };
        }),
      );
      const testLayer = serviceLayer({
        getChild: () => Ref.getUnsafe(projection),
        getReceipt: () => Ref.get(acceptedReceipt),
        dispatch,
      });

      yield* Effect.gen(function* () {
        const service = yield* PendingRequestMcpService;
        const input = {
          childThreadId,
          requestId,
          answers: { editor: "Vim" },
          clientRequestId: "answer-editor-once",
        } as const;
        const first = yield* service.respond(scope, input);
        assert.equal(first.receiptSequence, 7);
        assert.isFalse(first.replayed);
        assert.equal(first.request.status, "resolved");

        const replay = yield* service.respond(scope, input);
        assert.equal(replay.commandId, first.commandId);
        assert.equal(replay.receiptSequence, first.receiptSequence);
        assert.isTrue(replay.replayed);
        assert.equal(dispatch.mock.calls.length, 1);
      }).pipe(Effect.provide(testLayer));
    }),
  );

  it.effect("reloads the child projection after an overlapping response becomes accepted", () =>
    Effect.gen(function* () {
      const childReads = vi
        .fn<() => OrchestrationV2ThreadProjection>()
        .mockReturnValueOnce(childProjection())
        .mockReturnValue(childProjection({ status: "resolved" }));
      const dispatch = vi.fn(() => Effect.die("accepted replay must not dispatch again"));
      const acceptedReceipt: CommandReceiptV2 = {
        commandId: "command:accepted-overlap" as CommandReceiptV2["commandId"],
        threadId: childThreadId,
        commandType: "runtime-request.respond",
        acceptedAt: now,
        resultSequence: 11,
        status: "accepted",
        error: null,
      };

      yield* Effect.gen(function* () {
        const service = yield* PendingRequestMcpService;
        const replay = yield* service.respond(scope, {
          childThreadId,
          requestId,
          answers: { editor: "Vim" },
          clientRequestId: "accepted-overlap",
        });
        assert.isTrue(replay.replayed);
        assert.equal(replay.receiptSequence, 11);
        assert.equal(replay.request.status, "resolved");
        assert.equal(childReads.mock.calls.length, 2);
        assert.equal(dispatch.mock.calls.length, 0);
      }).pipe(
        Effect.provide(
          serviceLayer({
            getChild: childReads,
            getReceipt: () => Effect.succeed(Option.some(acceptedReceipt)),
            dispatch,
          }),
        ),
      );
    }),
  );

  it.effect("rejects incomplete answers, stale requests, and ended provider sessions", () =>
    Effect.gen(function* () {
      const service = yield* PendingRequestMcpService;
      const invalid = yield* service
        .respond(scope, {
          childThreadId,
          requestId,
          answers: { unknown: "value" },
          clientRequestId: "invalid-answers",
        })
        .pipe(Effect.flip);
      assert.equal(invalid.code, "invalid_answers");
    }).pipe(
      Effect.provide(serviceLayer({ getChild: () => childProjection() })),
      Effect.andThen(
        Effect.gen(function* () {
          const service = yield* PendingRequestMcpService;
          const stale = yield* service
            .respond(scope, {
              childThreadId,
              requestId,
              answers: { editor: "Vim" },
              clientRequestId: "stale-request",
            })
            .pipe(Effect.flip);
          assert.equal(stale.code, "request_not_pending");
        }).pipe(
          Effect.provide(serviceLayer({ getChild: () => childProjection({ status: "resolved" }) })),
        ),
      ),
      Effect.andThen(
        Effect.gen(function* () {
          const service = yield* PendingRequestMcpService;
          const unavailable = yield* service
            .respond(scope, {
              childThreadId,
              requestId,
              answers: { editor: "Vim" },
              clientRequestId: "ended-provider-session",
            })
            .pipe(Effect.flip);
          assert.equal(unavailable.code, "request_not_resumable");
        }).pipe(
          Effect.provide(serviceLayer({ getChild: () => childProjection({ resumable: false }) })),
        ),
      ),
    ),
  );

  it.effect("requires own answers for prototype-named question IDs", () => {
    const dispatch = vi.fn(() => Effect.die("missing answers must not dispatch"));
    const prototypeQuestion = childProjectionWithRequests({
      childThreadId,
      requests: [
        {
          requestId,
          questions: [{ ...questions[0]!, id: "toString" }],
        },
      ],
    });

    return Effect.gen(function* () {
      const service = yield* PendingRequestMcpService;
      const rejected = yield* service
        .respond(scope, {
          childThreadId,
          requestId,
          answers: {},
          clientRequestId: "prototype-question-id",
        })
        .pipe(Effect.flip);
      assert.equal(rejected.code, "invalid_answers");
      assert.equal(rejected.message, "Missing question IDs: toString.");
      assert.equal(dispatch.mock.calls.length, 0);
    }).pipe(
      Effect.provide(
        serviceLayer({
          getChild: () => prototypeQuestion,
          dispatch,
        }),
      ),
    );
  });

  it.effect("keeps delegated answers within the caller's runtime and interaction ceilings", () =>
    Effect.gen(function* () {
      const service = yield* PendingRequestMcpService;
      const runtimeError = yield* service
        .respond(scope, {
          childThreadId,
          requestId,
          answers: { editor: "Vim" },
          clientRequestId: "runtime-ceiling",
        })
        .pipe(Effect.flip);
      assert.equal(runtimeError.code, "runtime_mode_escalation_denied");
    }).pipe(
      Effect.provide(
        serviceLayer({
          getParent: () => parentProjection("app_owned", { runtimeMode: "approval-required" }),
          getChild: () => childProjection({ runtimeMode: "full-access" }),
        }),
      ),
      Effect.andThen(
        Effect.gen(function* () {
          const service = yield* PendingRequestMcpService;
          const interactionError = yield* service
            .respond(scope, {
              childThreadId,
              requestId,
              answers: { editor: "Vim" },
              clientRequestId: "interaction-ceiling",
            })
            .pipe(Effect.flip);
          assert.equal(interactionError.code, "interaction_mode_escalation_denied");
        }).pipe(
          Effect.provide(
            serviceLayer({
              getParent: () => parentProjection("app_owned", { interactionMode: "plan" }),
              getChild: () => childProjection({ interactionMode: "default" }),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("never treats an unrelated thread id as an authorized child", () =>
    Effect.gen(function* () {
      const service = yield* PendingRequestMcpService;
      const error = yield* service
        .read(scope, { childThreadId: unrelatedThreadId, requestId })
        .pipe(Effect.flip);
      assert.equal(error.code, "child_not_found");
    }).pipe(Effect.provide(serviceLayer({ getChild: () => childProjection() }))),
  );
});
