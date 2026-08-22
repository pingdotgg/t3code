import type { V2Event } from "@opencode-ai/client";
type SessionPendingInfo = {
  sessionID: string;
  type?: string;
  id?: string;
  admittedSeq?: number;
  [key: string]: unknown;
};
type ShellInfoV2 = {
  id: string;
  status: string;
  metadata: Record<string, unknown>;
  command?: string;
  cwd?: string;
  exit?: number;
  time?: { started?: number; completed?: number };
  [key: string]: unknown;
};
import {
  ContextHandoffId,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { describe } from "vite-plus/test";

import {
  bindOpenCode2CanonicalProviderThread,
  bufferOpenCode2DeferredChildEvent,
  drainOpenCode2DeferredChildEvents,
  forgetOpenCode2SessionPermission,
  openCode2AllActiveTurnsAwaitRuntimeRequest,
  openCode2AutoPermissionReply,
  openCode2CanAdoptMissingExecutionStart,
  openCode2ChildTurnItemOrdinals,
  openCode2CleanEofResubscribeDelayMs,
  openCode2CompactionDiagnostics,
  openCode2EventClearsHeldExecutionFailure,
  openCode2EventEndsExecution,
  openCode2EventSettlesHeldExecutionFailure,
  openCode2FormAnswer,
  openCode2FormQuestions,
  openCode2ForkEventPumpInScope,
  openCode2ForkParameters,
  openCode2InterruptedThreadDisposition,
  openCode2HasInFlightPendingWork,
  openCode2LocationQuery,
  openCode2McpServersFromList,
  openCode2ShellsFromList,
  openCode2IsCancelledPostSettleWake,
  openCode2IsPostSettleWakeAdmission,
  openCode2LastErrorAt,
  openCode2PendingItemsFromList,
  openCode2PendingWorkForSession,
  openCode2PermissionAutoReply,
  openCode2PermissionAutoReplyForSession,
  openCode2ProviderErrorStatus,
  openCode2ProviderFailure,
  openCode2ProviderRetryIsScheduled,
  openCode2PermissionReplyStatus,
  openCode2QuestionId,
  openCode2RuntimeRequestEventId,
  openCode2RuntimeRequestNativeKey,
  openCode2RuntimeRequestResponseSettlement,
  openCode2SessionSelectionParameters,
  openCode2SessionErrorMessage,
  openCode2SessionErrorStatus,
  openCode2SessionErrorTargetSessionIds,
  openCode2ShellRemovalSucceeded,
  openCode2ShouldChargeCleanEofBudget,
  openCode2ShouldChargeStallBudget,
  openCode2ShouldChargeStreamFailure,
  openCode2ShouldFailActiveTurnsAfterCleanEof,
  openCode2ShouldForceInterruptFinalize,
  openCode2ShouldHoldExecutionFailure,
  openCode2ShouldQuarantineInterruptedSession,
  openCode2ShouldResubscribeStalledStream,
  openCode2ShouldSettleTurn,
  openCode2T3OrchestrationInstructions,
  openCode2ToolNeedsTerminalOverride,
  openCode2TokenUsage,
  makeOpenCode2DeferredChildEventBuffer,
  normalizeOpenCode2PermissionEvent,
  OPENCODE2_EVENT_CLEAN_EOF_MAX_RESUBSCRIBES,
  OPENCODE2_DEFERRED_CHILD_EVENT_LIMIT,
  OPENCODE2_EVENT_PENDING_RESUBSCRIBE_DELAY_MS,
  OPENCODE2_EVENT_RESUBSCRIBE_DELAY_MS,
  OPENCODE2_EVENT_STALL_MS,
  OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS,
  OPENCODE2_PROMOTED_INPUT_ID_LIMIT,
  OPENCODE2_RETIRED_SUPPRESS_WAKE_LIMIT,
  pruneOpenCode2PromotedInputIds,
  pruneOpenCode2RetiredSuppressWakes,
  rememberOpenCode2SessionPermission,
  removeOpenCode2Session,
  settleOpenCode2ClientRemoval,
  unwrapOpenCode2Data,
} from "./OpenCode2AdapterV2.ts";
import {
  normalizeOpenCode2WireType,
  openCode2WireAdmittedInput,
  openCode2WireInputID,
} from "./openCode2Wire.ts";

const v2Event = (event: unknown) => event as V2Event;

describe("OpenCode 2 wire input ids", () => {
  it("reads every supported input id alias", () => {
    for (const key of [
      "inputID",
      "inputId",
      "inboxID",
      "inboxId",
      "messageID",
      "messageId",
      "id",
    ]) {
      assert.strictEqual(openCode2WireInputID({ data: { [key]: `input:${key}` } }), `input:${key}`);
    }
  });

  it("prefers the native input id over compatibility aliases", () => {
    assert.strictEqual(
      openCode2WireInputID({
        data: { inputID: "native", inputId: "camel", messageID: "message" },
      }),
      "native",
    );
  });
});

describe("unwrapOpenCode2Data", () => {
  it.effect("reads through both envelopes", () =>
    Effect.gen(function* () {
      const payload = yield* unwrapOpenCode2Data("session.create", {
        data: { data: { id: "ses_1" } },
      });
      assert.deepStrictEqual(payload, {
        id: "ses_1",
      });
    }),
  );

  // The failure mode this guards is silent: reading one layer yields the
  // envelope, which looks like a valid object and fails much later.
  it.effect("fails through the typed channel for an outer-only envelope", () =>
    Effect.gen(function* () {
      const error = yield* unwrapOpenCode2Data("session.create", { data: {} }).pipe(Effect.flip);
      assert.strictEqual(error.operation, "session.create");
      assert.strictEqual(error.category, "missing-response-payload");
    }),
  );

  it.effect("fails through the typed channel for a missing payload", () =>
    Effect.gen(function* () {
      const error = yield* unwrapOpenCode2Data("session.get", {}).pipe(Effect.flip);
      assert.strictEqual(error.operation, "session.get");
      assert.strictEqual(error.category, "missing-response-payload");
    }),
  );
});

describe("bindOpenCode2CanonicalProviderThread", () => {
  const now = DateTime.makeUnsafe("2026-08-20T19:24:25.000Z");
  const nativeThread = {
    id: ProviderThreadId.make("provider-thread:native"),
    driver: ProviderDriverKind.make("opencode2"),
    providerInstanceId: ProviderInstanceId.make("opencode2"),
    providerSessionId: ProviderSessionId.make("provider-session:test"),
    appThreadId: ThreadId.make("thread:test"),
    ownerNodeId: null,
    nativeThreadRef: {
      driver: ProviderDriverKind.make("opencode2"),
      nativeId: "ses_native",
      strength: "strong" as const,
    },
    nativeConversationHeadRef: null,
    status: "active" as const,
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [{ taskId: "shell_1", taskType: "shell" }],
    createdAt: now,
    updatedAt: now,
  } satisfies OrchestrationV2ProviderThread;
  const pendingThread = {
    ...nativeThread,
    id: ProviderThreadId.make("provider-thread:pending"),
    status: "idle" as const,
    handoffIds: [ContextHandoffId.make("handoff:1")],
    pendingBackgroundTasks: [],
  } satisfies OrchestrationV2ProviderThread;

  it("keeps the pending T3 id and the native session ref", () => {
    const bound = bindOpenCode2CanonicalProviderThread(nativeThread, pendingThread);
    assert.strictEqual(bound.id, ProviderThreadId.make("provider-thread:pending"));
    assert.strictEqual(bound.nativeThreadRef?.nativeId, "ses_native");
    assert.strictEqual(bound.status, "active");
    assert.deepEqual(bound.handoffIds, [ContextHandoffId.make("handoff:1")]);
    assert.deepEqual(bound.pendingBackgroundTasks, [{ taskId: "shell_1", taskType: "shell" }]);
  });
});

describe("OpenCode 2 post-settle wake classification", () => {
  const syntheticAdmission = v2Event({
    type: "session.inbox.enqueued",
    data: {
      sessionID: "ses_root",
      inputID: "input_wake",
      input: {
        type: "synthetic",
        data: { text: '<subagent state="completed">child completed</subagent>' },
        delivery: "queue",
      },
    },
  });

  it("classifies provider completion admissions for input-aware ownership", () => {
    assert.isTrue(
      openCode2IsPostSettleWakeAdmission(syntheticAdmission, {
        isChildSession: false,
      }),
    );
    assert.isTrue(
      openCode2IsPostSettleWakeAdmission(syntheticAdmission, {
        isChildSession: false,
      }),
    );
    assert.isFalse(
      openCode2IsPostSettleWakeAdmission(syntheticAdmission, {
        isChildSession: true,
      }),
    );
    assert.isFalse(
      openCode2IsPostSettleWakeAdmission(
        v2Event({
          type: "session.inbox.enqueued",
          data: {
            sessionID: "ses_root",
            inputID: "input_user",
            input: { type: "user", data: { text: "hello" }, delivery: "queue" },
          },
        }),
        {
          isChildSession: false,
        },
      ),
    );
  });

  it("keeps in-turn synthetic control instructions on their owning execution", () => {
    assert.isFalse(
      openCode2IsPostSettleWakeAdmission(
        v2Event({
          type: "session.inbox.enqueued",
          data: {
            sessionID: "ses_root",
            inputID: "input_background_instruction",
            input: {
              type: "synthetic",
              data: {
                text: "User requested that active blocking work be moved to the background.",
              },
              delivery: "steer",
            },
          },
        }),
        { isChildSession: false },
      ),
    );
  });

  it("accepts observed provider metadata when completion text is not wrapped", () => {
    assert.isTrue(
      openCode2IsPostSettleWakeAdmission(
        v2Event({
          type: "session.inbox.enqueued",
          data: {
            sessionID: "ses_root",
            inputID: "input_shell_wake",
            input: {
              type: "synthetic",
              data: {
                text: "shell completed",
                metadata: { source: "shell", state: "completed" },
              },
              delivery: "steer",
            },
          },
        }),
        { isChildSession: false },
      ),
    );
  });

  it("classifies a synthetic wake beside an allocated user execution", () => {
    assert.isTrue(
      openCode2IsPostSettleWakeAdmission(syntheticAdmission, {
        isChildSession: false,
      }),
    );
    assert.isTrue(
      openCode2IsPostSettleWakeAdmission(syntheticAdmission, {
        isChildSession: false,
      }),
    );
  });

  it("defers cancelled wake ownership until input promotion identifies the execution", () => {
    const cancelledAdmission = v2Event({
      type: "session.inbox.enqueued",
      data: {
        sessionID: "ses_root",
        inputID: "input_cancelled",
        input: {
          type: "synthetic",
          data: { text: '<subagent state="cancelled">cancelled continuation</subagent>' },
          delivery: "queue",
        },
      },
    });

    assert.isTrue(
      openCode2IsPostSettleWakeAdmission(cancelledAdmission, {
        isChildSession: false,
      }),
    );
    assert.isTrue(
      openCode2IsPostSettleWakeAdmission(syntheticAdmission, {
        isChildSession: false,
      }),
    );
  });

  it("isolates cancellation synthetic inputs without dropping the wake boundary", () => {
    for (const state of ["cancelled", "interrupted"] as const) {
      const event = v2Event({
        type: "session.inbox.enqueued",
        data: {
          sessionID: "ses_root",
          inputID: `input_${state}`,
          input: {
            type: "synthetic",
            data: { text: `<subagent state="${state}">partial output</subagent>` },
            delivery: "queue",
          },
        },
      });
      assert.isTrue(openCode2IsCancelledPostSettleWake(event));
      assert.isTrue(
        openCode2IsPostSettleWakeAdmission(event, {
          isChildSession: false,
        }),
      );
    }
    assert.isFalse(openCode2IsCancelledPostSettleWake(syntheticAdmission));
  });

  it("accepts the observed state marker with flexible tag attributes", () => {
    for (const text of [
      ` \n\t<subagent state = "cancelled">partial output</subagent>`,
      `<subagent state = "cancelled">partial output</subagent>`,
      `<subagent data="provider" state='interrupted'>partial output</subagent>`,
      `<subagent state='interrupted' data="provider">partial output</subagent>`,
    ]) {
      assert.isTrue(
        openCode2IsCancelledPostSettleWake(
          v2Event({
            type: "session.inbox.enqueued",
            data: {
              sessionID: "ses_root",
              inputID: "input_cancelled",
              input: {
                type: "synthetic",
                data: { text },
                delivery: "queue",
              },
            },
          }),
        ),
      );
    }
    assert.isFalse(
      openCode2IsCancelledPostSettleWake(
        v2Event({
          type: "session.inbox.enqueued",
          data: {
            sessionID: "ses_root",
            inputID: "input_status",
            input: {
              type: "synthetic",
              data: { text: `<subagent status="cancelled">partial output</subagent>` },
              delivery: "queue",
            },
          },
        }),
      ),
    );
  });

  it("requires a top-level cancellation marker at the start of synthetic text", () => {
    for (const text of [
      '<subagent state="completed">completed output</subagent>',
      'quoted text: "<subagent state="cancelled">nested output</subagent>"',
      '<wrapper><subagent state="interrupted">nested output</subagent></wrapper>',
    ]) {
      assert.isFalse(
        openCode2IsCancelledPostSettleWake(
          v2Event({
            type: "session.inbox.enqueued",
            data: {
              sessionID: "ses_root",
              inputID: "input_not_cancelled",
              input: {
                type: "synthetic",
                data: { text },
                delivery: "queue",
              },
            },
          }),
        ),
      );
    }
  });

  it("suppresses an empty interrupted background-shell wake", () => {
    const interruptedShellAdmission = v2Event({
      type: "session.inbox.enqueued",
      data: {
        sessionID: "ses_root",
        inputID: "input_interrupted_shell",
        input: {
          type: "synthetic",
          data: {
            text: '<shell id="call_shell" state="error" command="sleep 30">\n\n</shell>',
            metadata: { source: "shell", state: "error" },
          },
          delivery: "steer",
        },
      },
    });
    assert.isTrue(openCode2IsCancelledPostSettleWake(interruptedShellAdmission));
  });

  it("keeps a background-shell error that carries output visible", () => {
    assert.isFalse(
      openCode2IsCancelledPostSettleWake(
        v2Event({
          type: "session.inbox.enqueued",
          data: {
            sessionID: "ses_root",
            inputID: "input_failed_shell",
            input: {
              type: "synthetic",
              data: {
                text: '<shell state="error">command failed</shell>',
                metadata: { source: "shell", state: "error" },
              },
              delivery: "steer",
            },
          },
        }),
      ),
    );
  });

  it("leaves a child synthetic admission eligible for child-turn creation", () => {
    assert.isTrue(
      openCode2IsCancelledPostSettleWake(
        v2Event({
          type: "session.inbox.enqueued",
          data: {
            sessionID: "ses_child",
            inputID: "input_child_cancelled",
            input: {
              type: "synthetic",
              data: { text: `<subagent state="cancelled">partial output</subagent>` },
              delivery: "queue",
            },
          },
        }),
      ),
    );
    assert.isFalse(
      openCode2IsPostSettleWakeAdmission(
        v2Event({
          type: "session.inbox.enqueued",
          data: {
            sessionID: "ses_child",
            inputID: "input_child_cancelled",
            input: {
              type: "synthetic",
              data: { text: `<subagent state="cancelled">partial output</subagent>` },
              delivery: "queue",
            },
          },
        }),
        {
          isChildSession: true,
        },
      ),
    );
  });

  it("closes a buffered wake only on execution terminal or idle", () => {
    assert.isFalse(
      openCode2EventEndsExecution(
        v2Event({ type: "session.step.started", data: { sessionID: "ses_root" } }),
      ),
    );
    assert.isFalse(
      openCode2EventEndsExecution(
        v2Event({
          type: "session.step.ended",
          data: { sessionID: "ses_root", finish: "tool-calls" },
        }),
      ),
    );
    assert.isFalse(
      openCode2EventEndsExecution(
        v2Event({
          type: "session.step.ended",
          data: { sessionID: "ses_root", finish: "tool_calls" },
        }),
      ),
    );
    for (const type of [
      "session.step.ended",
      "session.step.failed",
      "session.execution.interrupted",
      "session.idle",
    ] as const) {
      assert.isTrue(
        openCode2EventEndsExecution(v2Event({ type, data: { sessionID: "ses_root" } })),
      );
    }
    assert.isTrue(
      openCode2EventEndsExecution(
        v2Event({
          type: "session.step.ended",
          data: { sessionID: "ses_root", finish: "stop" },
        }),
      ),
    );
  });
});

describe("OpenCode 2 wake evidence bounds", () => {
  it("keeps a terminal fallback after an unbound child overflows its event prefix", () => {
    const sessionID = "ses_deferred_child";
    const buffer = makeOpenCode2DeferredChildEventBuffer();
    const admitted = {
      type: "session.inbox.enqueued",
      data: { sessionID, inputID: "input_deferred_child" },
    };
    const started = {
      type: "session.execution.started",
      data: { sessionID },
    };
    bufferOpenCode2DeferredChildEvent(buffer, admitted, sessionID);
    bufferOpenCode2DeferredChildEvent(buffer, started, sessionID);
    for (let index = 2; index < OPENCODE2_DEFERRED_CHILD_EVENT_LIMIT; index += 1) {
      bufferOpenCode2DeferredChildEvent(
        buffer,
        {
          type: "session.reasoning.delta",
          data: { sessionID, delta: String(index) },
        },
        sessionID,
      );
    }

    assert.isTrue(
      bufferOpenCode2DeferredChildEvent(
        buffer,
        { type: "session.reasoning.delta", data: { sessionID, delta: "overflow" } },
        sessionID,
      ),
    );
    const terminal = {
      type: "session.step.ended",
      data: { sessionID, finish: "stop" },
    };
    assert.isFalse(bufferOpenCode2DeferredChildEvent(buffer, terminal, sessionID));

    const drained = drainOpenCode2DeferredChildEvents(buffer);
    assert.lengthOf(drained, OPENCODE2_DEFERRED_CHILD_EVENT_LIMIT + 1);
    assert.strictEqual(drained[0], admitted);
    assert.strictEqual(drained[1], started);
    assert.strictEqual(drained.at(-1), terminal);
    assert.isTrue(openCode2EventEndsExecution(drained.at(-1) as V2Event));
  });

  it("synthesizes a failed terminal at the deferred child overflow boundary", () => {
    const sessionID = "ses_deferred_child_without_terminal";
    const buffer = makeOpenCode2DeferredChildEventBuffer();
    for (let index = 0; index <= OPENCODE2_DEFERRED_CHILD_EVENT_LIMIT; index += 1) {
      bufferOpenCode2DeferredChildEvent(
        buffer,
        { type: "session.reasoning.delta", data: { sessionID, delta: String(index) } },
        sessionID,
      );
    }

    const terminal = drainOpenCode2DeferredChildEvents(buffer).at(-1) as V2Event;
    assert.strictEqual(terminal.type, "session.execution.failed");
    assert.isTrue(openCode2EventEndsExecution(terminal));
  });

  it("evicts the oldest retired suppression evidence in insertion order", () => {
    const wakes = new Map<string, unknown>();
    for (let index = 0; index < OPENCODE2_RETIRED_SUPPRESS_WAKE_LIMIT + 2; index += 1) {
      wakes.set(`input_retired_${index}`, {});
    }

    pruneOpenCode2RetiredSuppressWakes(wakes);

    assert.equal(wakes.size, OPENCODE2_RETIRED_SUPPRESS_WAKE_LIMIT);
    assert.isFalse(wakes.has("input_retired_0"));
    assert.isFalse(wakes.has("input_retired_1"));
    assert.isTrue(wakes.has(`input_retired_${OPENCODE2_RETIRED_SUPPRESS_WAKE_LIMIT + 1}`));
  });

  it("keeps recent unclaimed promotion evidence for late admissions", () => {
    const inputIds = new Set(
      Array.from(
        { length: OPENCODE2_PROMOTED_INPUT_ID_LIMIT + 1 },
        (_, index) => `input_promoted_${index}`,
      ),
    );

    pruneOpenCode2PromotedInputIds(inputIds);

    assert.equal(inputIds.size, OPENCODE2_PROMOTED_INPUT_ID_LIMIT);
    assert.isFalse(inputIds.has("input_promoted_0"));
    assert.isTrue(inputIds.has(`input_promoted_${OPENCODE2_PROMOTED_INPUT_ID_LIMIT}`));
  });
});

describe("OpenCode 2 session selection", () => {
  it("round-trips a provider model whose id contains a slash", () => {
    assert.deepStrictEqual(
      openCode2SessionSelectionParameters({
        instanceId: ProviderInstanceId.make("opencode2"),
        model: "openrouter/qwen/qwen3-coder",
      }),
      {
        model: {
          providerID: "openrouter",
          id: "qwen/qwen3-coder",
        },
      },
    );
  });
});

describe("removeOpenCode2Session", () => {
  it.effect("treats an already-missing native session as deleted", () =>
    removeOpenCode2Session(
      "ses_missing",
      Effect.succeed({
        data: undefined,
        error: { name: "SessionNotFoundError" },
        response: { status: 404 },
      }),
    ),
  );

  it.effect("treats the typed client's session-not-found error as deleted", () =>
    Effect.gen(function* () {
      const settled = yield* Effect.promise(() =>
        settleOpenCode2ClientRemoval(
          Promise.reject({
            _tag: "SessionNotFoundError",
            sessionID: "ses_missing",
            message: "session not found",
          }),
        ),
      );
      yield* removeOpenCode2Session("ses_missing", Effect.succeed(settled));
    }),
  );

  it.effect("retains non-idempotent native deletion failures", () =>
    Effect.gen(function* () {
      const failure = yield* removeOpenCode2Session(
        "ses_broken",
        Effect.succeed({
          data: undefined,
          error: { name: "InternalServerError" },
          response: { status: 500 },
        }),
      ).pipe(Effect.flip);

      assert.strictEqual(failure.operation, "session.remove");
      assert.strictEqual(failure.category, "session-remove-failed");
      assert.include(failure.message, "session-remove-failed");
      assert.notInclude(failure.message, "InternalServerError");
    }),
  );
});

describe("OpenCode 2 shell removal", () => {
  it("rejects resolved HTTP failures while accepting removed or already-missing shells", () => {
    assert.isTrue(openCode2ShellRemovalSucceeded({ data: true }));
    assert.isTrue(
      openCode2ShellRemovalSucceeded({
        error: { name: "ShellNotFoundError" },
        response: { status: 404 },
      }),
    );
    assert.isTrue(
      openCode2ShellRemovalSucceeded({
        error: {
          _tag: "ShellNotFoundError",
          id: "shl_missing",
          message: "shell not found",
        },
      }),
    );
    assert.isFalse(
      openCode2ShellRemovalSucceeded({
        error: { name: "InternalServerError" },
        response: { status: 500 },
      }),
    );
    assert.isFalse(
      openCode2ShellRemovalSucceeded({
        error: { name: "UnknownError" },
      }),
    );
  });
});

describe("openCode2QuestionId", () => {
  it("slugs the header so answers keyed by id resolve", () => {
    assert.strictEqual(openCode2QuestionId(0, "Pick a Branch!"), "question-0-pick-a-branch");
  });

  it("falls back to the index when the header carries no usable characters", () => {
    assert.strictEqual(openCode2QuestionId(2, "  ???  "), "question-2");
  });
});

describe("openCode2ForkParameters", () => {
  it("maps a boundary message onto the required before union member", () => {
    assert.deepStrictEqual(openCode2ForkParameters("ses_123", "msg_456"), {
      sessionID: "ses_123",
      $body_boundary: { type: "before", messageID: "msg_456" },
    });
  });

  it("maps a whole-head fork onto the through union member", () => {
    assert.deepStrictEqual(openCode2ForkParameters("ses_123", undefined), {
      sessionID: "ses_123",
      $body_boundary: { type: "through" },
    });
  });
});

describe("openCode2LocationQuery", () => {
  it("scopes list routes to a directory", () => {
    assert.strictEqual(
      openCode2LocationQuery("/tmp/project"),
      "location%5Bdirectory%5D=%2Ftmp%2Fproject",
    );
  });
});

describe("openCode2ShellsFromList", () => {
  it("keeps running shells and defaults missing metadata", () => {
    assert.deepStrictEqual(
      openCode2ShellsFromList([
        { id: "sh_1", status: "running", metadata: { sessionID: "ses_a" }, command: "sleep 1" },
        { id: "sh_2", status: "exited" },
        { status: "running" },
      ]),
      [
        { id: "sh_1", status: "running", metadata: { sessionID: "ses_a" }, command: "sleep 1" },
        { id: "sh_2", status: "exited", metadata: {} },
      ],
    );
  });

  it("peels a location-scoped HTTP envelope", () => {
    assert.deepStrictEqual(
      openCode2ShellsFromList({
        location: { directory: "/tmp/project" },
        data: [{ id: "sh_1", status: "running", metadata: { sessionID: "ses_a" } }],
      }),
      [{ id: "sh_1", status: "running", metadata: { sessionID: "ses_a" } }],
    );
  });
});

describe("openCode2McpServersFromList", () => {
  it("reads an array catalog and a name-to-status record", () => {
    assert.deepStrictEqual(
      openCode2McpServersFromList([{ name: "t3-code", status: "connected" }]),
      [{ name: "t3-code", status: "connected" }],
    );
    assert.deepStrictEqual(openCode2McpServersFromList({ "t3-code": "connected" }), [
      { name: "t3-code", status: "connected" },
    ]);
  });
});

describe("openCode2T3OrchestrationInstructions", () => {
  it("includes shared orchestration rules and the OpenCode execute bridge", () => {
    const text = openCode2T3OrchestrationInstructions();
    assert.include(text, "use `delegate_task`");
    assert.include(text, 'tools["t3-code"]');
    assert.include(text, 'await tools["t3-code"].t3_thread_start');
    assert.include(text, 'await tools["t3-code"].orchestrator_capabilities');
    assert.include(text, 'providerInstanceId: "..."');
    assert.include(text, "modelCursor: 50");
    assert.include(text, "includeModelOptions: true");
    assert.isBelow(Buffer.byteLength(JSON.stringify(text), "utf8"), 8 * 1024);
  });
});

describe("openCode2AutoPermissionReply", () => {
  const policy = (overrides: Record<string, unknown>) =>
    ({
      cwd: "/tmp",
      runtimeMode: "default",
      interactionMode: "default",
      ...overrides,
    }) as never;
  const reply = (
    overrides: Record<string, unknown>,
    action: string,
    resources: ReadonlyArray<string> = ["*"],
  ) => openCode2AutoPermissionReply(policy(overrides), { action, resources });

  it("approves only the current request in full-access mode", () => {
    assert.strictEqual(reply({ runtimeMode: "full-access" }, "bash"), "once");
  });

  it("does not turn approval never into implicit full access", () => {
    assert.strictEqual(reply({ runtimeMode: "auto", approvalPolicy: "never" }, "bash"), "reject");
    assert.strictEqual(reply({ runtimeMode: "auto", approvalPolicy: "never" }, "read"), "once");
  });

  it("surfaces the request when an approval policy asks for one", () => {
    assert.strictEqual(
      reply({ runtimeMode: "full-access", approvalPolicy: "always" }, "bash"),
      null,
    );
  });

  // A structured approval policy is a request for interactive review, so
  // full-access must not silently override it.
  it("surfaces the request for a structured approval policy", () => {
    assert.strictEqual(
      reply({ runtimeMode: "full-access", approvalPolicy: { type: "onRequest" } }, "bash"),
      null,
    );
  });

  it("auto-accepts edits but still asks for shell access", () => {
    assert.strictEqual(reply({ runtimeMode: "auto-accept-edits" }, "edit"), "once");
    assert.strictEqual(reply({ runtimeMode: "auto-accept-edits" }, "bash"), null);
  });

  it("enforces workspace-write and network policy without native persistent grants", () => {
    const sandboxPolicy = {
      type: "workspaceWrite",
      networkAccess: true,
      writableRoots: ["/workspace/shared"],
    };
    const overrides = {
      runtimeMode: "auto",
      approvalPolicy: "never",
      sandboxPolicy,
    };
    assert.strictEqual(reply(overrides, "edit"), "once");
    assert.strictEqual(reply(overrides, "bash"), "reject");
    assert.strictEqual(reply(overrides, "websearch"), "once");
    assert.strictEqual(
      reply(overrides, "external_directory", ["/workspace/shared/file.txt"]),
      "once",
    );
    assert.strictEqual(reply(overrides, "external_directory", ["/outside/file.txt"]), "reject");
  });

  it("does not let a remembered session grant override a later policy denial", () => {
    assert.strictEqual(
      openCode2PermissionAutoReply(
        policy({ runtimeMode: "auto", approvalPolicy: "never" }),
        [{ action: "bash", resources: ["*"] }],
        { action: "bash", resources: ["*"] },
      ),
      "reject",
    );
  });

  it("uses a remembered session grant when policy still requires approval", () => {
    assert.strictEqual(
      openCode2PermissionAutoReply(
        policy({ runtimeMode: "default" }),
        [{ action: "bash", resources: ["/workspace/*"] }],
        { action: "bash", resources: ["/workspace/file.txt"] },
      ),
      "once",
    );
  });

  it("combines remembered grants per resource in a multi-resource request", () => {
    assert.strictEqual(
      openCode2PermissionAutoReply(
        policy({ runtimeMode: "default" }),
        [
          { action: "bash", resources: ["/workspace/first/*"] },
          { action: "bash", resources: ["/workspace/second/*"] },
        ],
        {
          action: "bash",
          resources: ["/workspace/first/file.txt", "/workspace/second/file.txt"],
        },
      ),
      "once",
    );
  });
});

describe("normalizeOpenCode2PermissionEvent", () => {
  it("treats a missing legacy patterns list as a wildcard request", () => {
    assert.deepStrictEqual(
      normalizeOpenCode2PermissionEvent("legacy", {
        id: "permission-1",
        sessionID: "session-1",
        permission: "grep",
        metadata: {},
        always: [],
      }),
      {
        action: "grep",
        resources: [],
        save: [],
      },
    );
  });

  it("accepts preview aliases and singular patterns", () => {
    assert.deepStrictEqual(
      normalizeOpenCode2PermissionEvent("v2", {
        permission: "external_directory",
        pattern: "/workspace/file.txt",
        always: ["/workspace/*"],
      }),
      {
        action: "external_directory",
        resources: ["/workspace/file.txt"],
        save: ["/workspace/*"],
      },
    );
  });
});

describe("OpenCode 2 remembered session permissions", () => {
  it("reads every supported runtime request event id alias", () => {
    assert.equal(openCode2RuntimeRequestEventId({ requestID: "request-1" }), "request-1");
    assert.equal(openCode2RuntimeRequestEventId({ formID: "form-1" }), "form-1");
    assert.equal(openCode2RuntimeRequestEventId({ id: "legacy-1" }), "legacy-1");
  });

  it("scopes native request ids to their native session", () => {
    assert.notEqual(
      openCode2RuntimeRequestNativeKey("session-a", "request-1"),
      openCode2RuntimeRequestNativeKey("session-b", "request-1"),
    );
    assert.equal(
      openCode2RuntimeRequestNativeKey("session-a", "request-1"),
      openCode2RuntimeRequestNativeKey("session-a", "request-1"),
    );
  });

  it("maps provider permission rejections to cancellation", () => {
    assert.equal(openCode2PermissionReplyStatus("once"), "resolved");
    assert.equal(openCode2PermissionReplyStatus("reject"), "cancelled");
  });

  it("resolves answered requests while cancelling rejected request items", () => {
    assert.deepStrictEqual(openCode2RuntimeRequestResponseSettlement("accept"), {
      requestStatus: "resolved",
      itemStatus: "completed",
      rememberPermissionForSession: false,
    });
    assert.deepStrictEqual(openCode2RuntimeRequestResponseSettlement("decline"), {
      requestStatus: "resolved",
      itemStatus: "cancelled",
      rememberPermissionForSession: false,
    });
    assert.deepStrictEqual(openCode2RuntimeRequestResponseSettlement("cancel"), {
      requestStatus: "resolved",
      itemStatus: "cancelled",
      rememberPermissionForSession: false,
    });
    assert.deepStrictEqual(openCode2RuntimeRequestResponseSettlement("acceptForSession"), {
      requestStatus: "resolved",
      itemStatus: "completed",
      rememberPermissionForSession: true,
    });
  });

  const runtimePolicy = {
    cwd: "/tmp",
    interactionMode: "default",
    runtimeMode: "default",
  } as never;

  it("scopes remembered grants to their native session", () => {
    const permissions = new Map();
    rememberOpenCode2SessionPermission(permissions, "ses_child", {
      action: "bash",
      resources: ["/workspace/*"],
      save: [],
    });
    const request = { action: "bash", resources: ["/workspace/file.txt"] };

    assert.strictEqual(
      openCode2PermissionAutoReplyForSession(runtimePolicy, permissions, "ses_child", request),
      "once",
    );
    assert.isNull(
      openCode2PermissionAutoReplyForSession(runtimePolicy, permissions, "ses_sibling", request),
    );
  });

  it("retains a duplicate grant until every owner revokes it", () => {
    const permissions = new Map();
    const permission = {
      action: "bash",
      resources: ["/workspace/*"],
      save: [],
    };
    const remembered = rememberOpenCode2SessionPermission(permissions, "ses_root", permission);
    const duplicate = rememberOpenCode2SessionPermission(permissions, "ses_root", permission);
    const request = { action: "bash", resources: ["/workspace/file.txt"] };

    assert.isNotNull(remembered);
    assert.strictEqual(duplicate, remembered);
    assert.strictEqual(
      openCode2PermissionAutoReplyForSession(runtimePolicy, permissions, "ses_root", request),
      "once",
    );
    forgetOpenCode2SessionPermission(permissions, "ses_root", remembered!);
    assert.strictEqual(
      openCode2PermissionAutoReplyForSession(runtimePolicy, permissions, "ses_root", request),
      "once",
    );
    forgetOpenCode2SessionPermission(permissions, "ses_root", duplicate!);
    assert.isNull(
      openCode2PermissionAutoReplyForSession(runtimePolicy, permissions, "ses_root", request),
    );
  });

  it("remembers a resource-less grant as a wildcard", () => {
    const permissions = new Map();
    rememberOpenCode2SessionPermission(permissions, "ses_root", {
      action: "grep",
      resources: [],
      save: [],
    });

    assert.strictEqual(
      openCode2PermissionAutoReplyForSession(runtimePolicy, permissions, "ses_root", {
        action: "grep",
        resources: ["/workspace/file.txt"],
      }),
      "once",
    );
  });
});

describe("OpenCode 2 child item ordinals", () => {
  it("reserves a distinct item block for every child turn", () => {
    assert.deepStrictEqual(openCode2ChildTurnItemOrdinals(1), { user: 100, next: 101 });
    assert.deepStrictEqual(openCode2ChildTurnItemOrdinals(2), { user: 200, next: 201 });
  });
});

describe("openCode2PendingItemsFromList", () => {
  it("keeps pending and inbox items that name a session", () => {
    assert.deepStrictEqual(
      openCode2PendingItemsFromList([
        { sessionID: "ses_a", id: "pending-1", type: "compaction" },
        { sessionID: "ses_b", id: "msg_1", type: "user", payload: { text: "hi" } },
        { id: "orphan" },
        "skip",
      ]),
      [
        { sessionID: "ses_a", id: "pending-1", type: "compaction" },
        { sessionID: "ses_b", id: "msg_1", type: "user" },
      ],
    );
  });

  it("returns an empty list for a missing payload", () => {
    assert.deepStrictEqual(openCode2PendingItemsFromList(undefined), []);
    assert.deepStrictEqual(openCode2PendingItemsFromList({ data: [] }), []);
  });
});

describe("openCode2PendingWorkForSession", () => {
  const sessionID = "ses_target";
  const pending = (owner: string): SessionPendingInfo => ({
    admittedSeq: 1,
    id: "pending-1",
    sessionID: owner,
    timeCreated: 1,
    type: "compaction",
  });
  const shell = (owner: string, status: ShellInfoV2["status"]): ShellInfoV2 => ({
    id: "shell-1",
    status,
    command: "sleep 20",
    cwd: "/workspace",
    shell: "/bin/bash",
    file: "/workspace/shell.out",
    metadata: { sessionID: owner },
    time: { started: 1 },
  });

  it.effect("pins the thread for its durable pending input while still inspecting shells", () =>
    Effect.gen(function* () {
      let listedShells = false;
      const result = yield* openCode2PendingWorkForSession({
        sessionID,
        pending: Effect.succeed([pending(sessionID)]),
        shells: Effect.sync(() => {
          listedShells = true;
          return [];
        }),
      });

      assert.isTrue(result);
      assert.isTrue(listedShells);
    }),
  );

  it.effect("pins only running shells owned by the same native session", () =>
    Effect.gen(function* () {
      assert.isTrue(
        yield* openCode2PendingWorkForSession({
          sessionID,
          pending: Effect.succeed([]),
          shells: Effect.succeed([shell(sessionID, "running")]),
        }),
      );
      assert.isFalse(
        yield* openCode2PendingWorkForSession({
          sessionID,
          pending: Effect.succeed([pending("ses_sibling")]),
          shells: Effect.succeed([shell("ses_sibling", "running"), shell(sessionID, "exited")]),
        }),
      );
    }),
  );
});

describe("openCode2ToolNeedsTerminalOverride", () => {
  const part = (status: "pending" | "running" | "completed" | "error", errorMessage?: string) => ({
    status,
    errorMessage,
  });

  it("terminalizes tools that have no native terminal state", () => {
    assert.isTrue(openCode2ToolNeedsTerminalOverride(part("pending"), "failed"));
    assert.isTrue(openCode2ToolNeedsTerminalOverride(part("running"), "interrupted"));
  });

  it("restamps only the provider's interrupt-specific tool failure", () => {
    assert.isTrue(
      openCode2ToolNeedsTerminalOverride(
        part("error", "Tool execution interrupted"),
        "interrupted",
      ),
    );
    assert.isFalse(
      openCode2ToolNeedsTerminalOverride(part("error", "command failed"), "interrupted"),
    );
    assert.isFalse(
      openCode2ToolNeedsTerminalOverride(part("error", "Tool execution interrupted"), "failed"),
    );
  });

  it("preserves completed tools", () => {
    assert.isFalse(openCode2ToolNeedsTerminalOverride(part("completed"), "interrupted"));
  });
});

describe("OpenCode 2 session errors", () => {
  it("fans an unscoped error out to every active native session", () => {
    assert.deepStrictEqual(
      openCode2SessionErrorTargetSessionIds(undefined, ["ses_first", "ses_second"]),
      ["ses_first", "ses_second"],
    );
    assert.deepStrictEqual(
      openCode2SessionErrorTargetSessionIds("ses_second", ["ses_first", "ses_second"]),
      ["ses_second"],
    );
    assert.deepStrictEqual(
      openCode2SessionErrorTargetSessionIds("ses_missing", ["ses_first", "ses_second"]),
      [],
    );
  });

  it("normalizes provider abort errors without poisoning the provider session", () => {
    const error = {
      sessionID: "ses_target",
      error: {
        name: "MessageAbortedError",
        data: { message: "The user aborted the request." },
      },
    } as const;

    assert.strictEqual(openCode2SessionErrorMessage(error), "The user aborted the request.");
    assert.strictEqual(openCode2SessionErrorStatus(error, false), "interrupted");
  });

  it("preserves ordinary provider failures", () => {
    const error = {
      error: {
        name: "UnknownError",
        data: { message: "Provider exploded." },
      },
    } as const;

    assert.strictEqual(openCode2SessionErrorMessage(error), "Provider exploded.");
    assert.strictEqual(openCode2SessionErrorStatus(error, false), "failed");
    assert.strictEqual(openCode2SessionErrorStatus(error, true), "interrupted");
  });

  it("breaks a native thread only when the provider shuts down", () => {
    assert.strictEqual(openCode2InterruptedThreadDisposition("user" as any), "reusable");
    assert.strictEqual(openCode2InterruptedThreadDisposition("superseded" as any), "reusable");
    assert.strictEqual(openCode2InterruptedThreadDisposition("shutdown" as any), "broken");
  });

  it("uses idle only before the authoritative execution lifecycle starts", () => {
    assert.isTrue(openCode2ShouldSettleTurn("idle", false));
    assert.isFalse(openCode2ShouldSettleTurn("execution-terminal", false));
    assert.isFalse(openCode2ShouldSettleTurn("execution-interrupted", false));
    assert.isTrue(openCode2ShouldSettleTurn("execution-interrupted", false, true));
    assert.isFalse(openCode2ShouldSettleTurn("idle", true));
    assert.isTrue(openCode2ShouldSettleTurn("execution-terminal", true));
    assert.isTrue(openCode2ShouldSettleTurn("execution-interrupted", true));
  });
});

describe("openCode2 interrupt and event-stream recovery helpers", () => {
  it("keeps an error occurrence stable until the error clears", () => {
    const firstErrorAt = DateTime.makeUnsafe("2026-08-11T12:00:00Z");
    const unrelatedUpdateAt = DateTime.makeUnsafe("2026-08-11T12:01:00Z");
    const repeatedErrorAt = DateTime.makeUnsafe("2026-08-11T12:02:00Z");

    assert.deepStrictEqual(
      openCode2LastErrorAt({
        previousError: "event stream stalled",
        previousErrorAt: firstErrorAt,
        nextError: "event stream stalled",
        updatedAt: unrelatedUpdateAt,
      }),
      firstErrorAt,
    );
    assert.isNull(
      openCode2LastErrorAt({
        previousError: "event stream stalled",
        previousErrorAt: firstErrorAt,
        nextError: null,
        updatedAt: unrelatedUpdateAt,
      }),
    );
    assert.deepStrictEqual(
      openCode2LastErrorAt({
        previousError: null,
        previousErrorAt: null,
        nextError: "event stream stalled",
        updatedAt: repeatedErrorAt,
      }),
      repeatedErrorAt,
    );
  });

  it.effect("registers event-pump abort before startup interruption can close the scope", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const forked = yield* Deferred.make<void>();
      const releaseRegistration = yield* Deferred.make<void>();
      const finalizerOrder: Array<"abort" | "pump"> = [];
      const startup = yield* openCode2ForkEventPumpInScope({
        scope,
        abort: Effect.sync(() => finalizerOrder.push("abort")),
        pump: Effect.never.pipe(Effect.ensuring(Effect.sync(() => finalizerOrder.push("pump")))),
        afterFork: Deferred.succeed(forked, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRegistration)),
        ),
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(forked);
      const interruption = yield* Fiber.interrupt(startup).pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseRegistration, undefined);
      yield* Fiber.join(interruption);
      yield* Scope.close(scope, Exit.void);

      assert.deepStrictEqual(finalizerOrder, ["abort", "pump"]);
    }),
  );

  it("force-finalizes only after an interrupted turn outlives the settle wait", () => {
    assert.isFalse(
      openCode2ShouldForceInterruptFinalize({
        interrupted: true,
        finalized: false,
        stillActive: true,
        waitedMs: OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS - 1,
        settleTimeoutMs: OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS,
      }),
    );
    assert.isTrue(
      openCode2ShouldForceInterruptFinalize({
        interrupted: true,
        finalized: false,
        stillActive: true,
        waitedMs: OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS,
        settleTimeoutMs: OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS,
      }),
    );
    assert.isFalse(
      openCode2ShouldForceInterruptFinalize({
        interrupted: true,
        finalized: true,
        stillActive: false,
        waitedMs: OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS,
        settleTimeoutMs: OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS,
      }),
    );
    assert.isFalse(
      openCode2ShouldForceInterruptFinalize({
        interrupted: false,
        finalized: false,
        stillActive: true,
        waitedMs: OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS,
        settleTimeoutMs: OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS,
      }),
    );
  });

  it("quarantines an ambiguous interrupt or any force-finalized execution", () => {
    // Confirmed interrupt request and shells stopped: reusable.
    assert.isFalse(
      openCode2ShouldQuarantineInterruptedSession({
        interruptRequestConfirmed: true,
        shellRemovalConfirmed: true,
      }),
    );
    // A timed-out or failed session.interrupt leaves the native execution
    // running; Stop still force-finalizes locally, but the session must not
    // be reused by a follow-up turn.
    assert.isTrue(
      openCode2ShouldQuarantineInterruptedSession({
        interruptRequestConfirmed: false,
        shellRemovalConfirmed: true,
      }),
    );
    // An owned shell that could not be stopped may still run the interrupted
    // work on the same native session.
    assert.isTrue(
      openCode2ShouldQuarantineInterruptedSession({
        interruptRequestConfirmed: true,
        shellRemovalConfirmed: false,
      }),
    );
    assert.isTrue(
      openCode2ShouldQuarantineInterruptedSession({
        interruptRequestConfirmed: false,
        shellRemovalConfirmed: false,
      }),
    );
    // Request acknowledgements are not an execution terminal. If the terminal
    // never arrives before local force-finalization, the session is ambiguous.
    assert.isTrue(
      openCode2ShouldQuarantineInterruptedSession({
        interruptRequestConfirmed: true,
        shellRemovalConfirmed: true,
        forceFinalizedWithoutTerminal: true,
      }),
    );
  });

  it("fails active turns only after the clean-EOF budget with no idle penalty", () => {
    assert.isFalse(
      openCode2ShouldFailActiveTurnsAfterCleanEof({
        consecutiveCleanEofs: OPENCODE2_EVENT_CLEAN_EOF_MAX_RESUBSCRIBES - 1,
        maxCleanEofs: OPENCODE2_EVENT_CLEAN_EOF_MAX_RESUBSCRIBES,
        cleanEofWindowAgeMs: OPENCODE2_EVENT_STALL_MS,
        minimumWindowMs: OPENCODE2_EVENT_STALL_MS,
        hasActiveTurn: true,
      }),
    );
    assert.isTrue(
      openCode2ShouldFailActiveTurnsAfterCleanEof({
        consecutiveCleanEofs: OPENCODE2_EVENT_CLEAN_EOF_MAX_RESUBSCRIBES,
        maxCleanEofs: OPENCODE2_EVENT_CLEAN_EOF_MAX_RESUBSCRIBES,
        cleanEofWindowAgeMs: OPENCODE2_EVENT_STALL_MS,
        minimumWindowMs: OPENCODE2_EVENT_STALL_MS,
        hasActiveTurn: true,
      }),
    );
    assert.isFalse(
      openCode2ShouldFailActiveTurnsAfterCleanEof({
        consecutiveCleanEofs: OPENCODE2_EVENT_CLEAN_EOF_MAX_RESUBSCRIBES,
        maxCleanEofs: OPENCODE2_EVENT_CLEAN_EOF_MAX_RESUBSCRIBES,
        cleanEofWindowAgeMs: OPENCODE2_EVENT_STALL_MS - 1,
        minimumWindowMs: OPENCODE2_EVENT_STALL_MS,
        hasActiveTurn: true,
      }),
    );
    // Idle reconnects (normal resubscription) and replay parking never count
    // toward the budget.
    assert.isFalse(
      openCode2ShouldFailActiveTurnsAfterCleanEof({
        consecutiveCleanEofs: OPENCODE2_EVENT_CLEAN_EOF_MAX_RESUBSCRIBES * 10,
        maxCleanEofs: OPENCODE2_EVENT_CLEAN_EOF_MAX_RESUBSCRIBES,
        cleanEofWindowAgeMs: OPENCODE2_EVENT_STALL_MS * 10,
        minimumWindowMs: OPENCODE2_EVENT_STALL_MS,
        hasActiveTurn: false,
      }),
    );
  });

  it("backs off clean-EOF reconnects while a runtime request is pending", () => {
    assert.equal(openCode2CleanEofResubscribeDelayMs(1, true), 250);
    assert.equal(
      openCode2CleanEofResubscribeDelayMs(100, true),
      OPENCODE2_EVENT_PENDING_RESUBSCRIBE_DELAY_MS,
    );
    assert.equal(
      openCode2CleanEofResubscribeDelayMs(100, false),
      OPENCODE2_EVENT_RESUBSCRIBE_DELAY_MS,
    );
  });

  it("charges clean-EOF budget only for unexplained peer closes", () => {
    assert.isTrue(
      openCode2ShouldChargeCleanEofBudget({
        watchdogResubscribe: false,
        hasPendingRuntimeRequest: false,
        hasInFlightPendingWork: false,
      }),
    );
    // Stall watchdog already owns its own fail budget; local aborts must not
    // also spend the clean-EOF budget (live: 30s quiet shells then fail).
    assert.isFalse(
      openCode2ShouldChargeCleanEofBudget({
        watchdogResubscribe: true,
        hasPendingRuntimeRequest: false,
        hasInFlightPendingWork: false,
      }),
    );
    assert.isFalse(
      openCode2ShouldChargeCleanEofBudget({
        watchdogResubscribe: false,
        hasPendingRuntimeRequest: false,
        hasInFlightPendingWork: true,
      }),
    );
    assert.isFalse(
      openCode2ShouldChargeCleanEofBudget({
        watchdogResubscribe: false,
        hasPendingRuntimeRequest: true,
        hasInFlightPendingWork: false,
      }),
    );
  });

  it("matches projected child runtime requests to the parent turn and child session", () => {
    assert.isTrue(
      openCode2AllActiveTurnsAwaitRuntimeRequest({
        activeTurns: [
          { nativeSessionId: "ses_parent", providerTurnId: "turn_parent" },
          { nativeSessionId: "ses_child", providerTurnId: "turn_child" },
        ],
        // Production stores the projected parent turn plus the native child
        // session, so both active turns are legitimately waiting on one prompt.
        pendingRequests: [{ nativeSessionId: "ses_child", providerTurnId: "turn_parent" }],
      }),
    );
    assert.isFalse(
      openCode2AllActiveTurnsAwaitRuntimeRequest({
        activeTurns: [
          { nativeSessionId: "ses_parent", providerTurnId: "turn_parent" },
          { nativeSessionId: "ses_child", providerTurnId: "turn_child" },
        ],
        pendingRequests: [{ nativeSessionId: "ses_parent", providerTurnId: "turn_parent" }],
      }),
    );
  });

  it("resubscribes a stalled stream only while a turn is active", () => {
    assert.isTrue(
      openCode2ShouldResubscribeStalledStream({
        sessionAborted: false,
        hasActiveTurn: true,
        lastEventAgeMs: OPENCODE2_EVENT_STALL_MS,
        stallMs: OPENCODE2_EVENT_STALL_MS,
      }),
    );
    assert.isFalse(
      openCode2ShouldResubscribeStalledStream({
        sessionAborted: false,
        hasActiveTurn: true,
        lastEventAgeMs: OPENCODE2_EVENT_STALL_MS - 1,
        stallMs: OPENCODE2_EVENT_STALL_MS,
      }),
    );
    assert.isFalse(
      openCode2ShouldResubscribeStalledStream({
        sessionAborted: false,
        hasActiveTurn: false,
        lastEventAgeMs: OPENCODE2_EVENT_STALL_MS,
        stallMs: OPENCODE2_EVENT_STALL_MS,
      }),
    );
    assert.isFalse(
      openCode2ShouldResubscribeStalledStream({
        sessionAborted: true,
        hasActiveTurn: true,
        lastEventAgeMs: OPENCODE2_EVENT_STALL_MS,
        stallMs: OPENCODE2_EVENT_STALL_MS,
      }),
    );
    // Explained quiet still reconnects so a dead stream cannot hide the event
    // that clears the local pending marker.
    assert.isTrue(
      openCode2ShouldResubscribeStalledStream({
        sessionAborted: false,
        hasActiveTurn: true,
        lastEventAgeMs: OPENCODE2_EVENT_STALL_MS * 10,
        stallMs: OPENCODE2_EVENT_STALL_MS,
      }),
    );
    assert.isFalse(
      openCode2ShouldChargeStallBudget({
        hasPendingRuntimeRequest: true,
        hasInFlightPendingWork: false,
      }),
    );
    assert.isFalse(
      openCode2ShouldChargeStallBudget({
        hasPendingRuntimeRequest: false,
        hasInFlightPendingWork: true,
      }),
    );
    assert.isTrue(
      openCode2ShouldChargeStallBudget({
        hasPendingRuntimeRequest: false,
        hasInFlightPendingWork: false,
      }),
    );
    assert.isFalse(openCode2ShouldChargeStreamFailure(true));
    assert.isTrue(openCode2ShouldChargeStreamFailure(false));
  });

  it("expires provider retry deadlines independently of durable retry presentation", () => {
    const providerRetry = { scheduledUntilAtMs: 1_000 };
    assert.isTrue(openCode2ProviderRetryIsScheduled(providerRetry, 1_000));
    assert.isFalse(openCode2ProviderRetryIsScheduled(providerRetry, 1_001));
    assert.isFalse(openCode2ProviderRetryIsScheduled(null, 0));
  });

  it("recognizes local work that legitimately keeps an active turn quiet", () => {
    const base = {
      toolStatuses: [],
      shellStatuses: [],
      hasProviderRetry: false,
      compactionStatus: null,
      subagentStatuses: [],
    } as const;
    assert.isFalse(openCode2HasInFlightPendingWork(base));
    assert.isTrue(openCode2HasInFlightPendingWork({ ...base, toolStatuses: ["running"] }));
    assert.isTrue(openCode2HasInFlightPendingWork({ ...base, toolStatuses: ["pending"] }));
    assert.isFalse(openCode2HasInFlightPendingWork({ ...base, toolStatuses: ["completed"] }));
    assert.isTrue(openCode2HasInFlightPendingWork({ ...base, shellStatuses: ["running"] }));
    assert.isTrue(openCode2HasInFlightPendingWork({ ...base, hasProviderRetry: true }));
    assert.isTrue(openCode2HasInFlightPendingWork({ ...base, compactionStatus: "running" }));
    assert.isTrue(openCode2HasInFlightPendingWork({ ...base, subagentStatuses: ["running"] }));
    assert.isFalse(openCode2HasInFlightPendingWork({ ...base, subagentStatuses: ["completed"] }));
  });

  it("computes compaction diagnostics from model limits rather than pricing tiers", () => {
    const usage = openCode2TokenUsage({
      tokens: {
        total: 0,
        input: 272_000,
        output: 0,
        reasoning: 0,
        cache: { read: 630_000, write: 0 },
      },
    });
    assert.deepStrictEqual(
      openCode2CompactionDiagnostics({
        usage,
        limits: { context: 1_050_000, input: 922_000, output: 128_000 },
        reason: "auto",
      }),
      {
        usedTokenCount: 902_000,
        inputTokenCount: 272_000,
        inputLimit: 922_000,
        contextLimit: 1_050_000,
        outputReserve: 32_000,
        triggerThreshold: 902_000,
        triggerReason: "auto",
      },
    );
    const reportedTotal = openCode2TokenUsage({
      tokens: {
        total: 910_000,
        input: 272_000,
        output: 1_000,
        reasoning: 500_000,
        cache: { read: 630_000, write: 0 },
      },
    });
    assert.equal(
      openCode2CompactionDiagnostics({
        usage: reportedTotal,
        limits: { context: 1_050_000, input: 922_000, output: 128_000 },
        reason: "manual",
      })?.usedTokenCount,
      910_000,
    );
    assert.equal(
      openCode2CompactionDiagnostics({
        usage,
        limits: { context: 1_050_000, input: 922_000, output: 3_000 },
        reason: "auto",
      })?.triggerThreshold,
      919_000,
    );
    assert.deepStrictEqual(
      openCode2CompactionDiagnostics({
        usage,
        limits: { context: 1_050_000, output: 128_000 },
        reason: "auto",
      }),
      {
        usedTokenCount: 902_000,
        inputTokenCount: 272_000,
        contextLimit: 1_050_000,
        outputReserve: 32_000,
        triggerThreshold: 1_018_000,
        triggerReason: "auto",
      },
    );
    assert.deepStrictEqual(
      openCode2CompactionDiagnostics({
        usage,
        limits: { context: 272_000, input: 272_000, output: 128_000 },
        reason: "auto",
      }),
      {
        usedTokenCount: 902_000,
        inputTokenCount: 272_000,
        inputLimit: 272_000,
        contextLimit: 272_000,
        outputReserve: 32_000,
        triggerThreshold: 252_000,
        triggerReason: "auto",
      },
    );
  });

  it("classifies provider failures without persisting raw provider payloads", () => {
    const secret = "gho_abcdefghijklmnopqrstuvwxyz123456";
    const context = openCode2ProviderFailure({
      message: `maximum context length; token=${secret}`,
      code: "ContextLengthExceeded",
    });
    assert.equal(context.code, "provider.context-limit");
    assert.notInclude(context.message, secret);

    const rateLimit = openCode2ProviderFailure({ message: "HTTP 429", code: null });
    assert.equal(rateLimit.code, "provider.rate-limit");
    assert.isTrue(rateLimit.retryable);

    const unavailable = openCode2ProviderFailure({
      message: "Upstream request failed: Endpoint is unavailable.",
      code: "provider.internal",
      statusCode: 503,
    });
    assert.equal(unavailable.code, "provider.unavailable");
    assert.equal(
      unavailable.message,
      "OpenCode 2 lost the model endpoint (HTTP 503). Wait, then retry the turn.",
    );
    assert.isTrue(unavailable.retryable);

    const unknown = openCode2ProviderFailure({
      message: `raw payload token=${secret}`,
      code: "RawProviderFailure",
    });
    assert.equal(unknown.code, "provider.error");
    assert.notInclude(unknown.message, secret);
    assert.notInclude(unknown.message, "raw payload");

    const unknownFinish = openCode2ProviderFailure({
      message: "The provider response ended with an unknown finish reason.",
      code: "provider.invalid-output",
    });
    assert.equal(unknownFinish.code, "provider.invalid-output");
    assert.equal(
      unknownFinish.message,
      "OpenCode 2 ended a model step with an unknown finish reason.",
    );
    assert.isTrue(unknownFinish.retryable);
    const otherInvalidOutput = openCode2ProviderFailure({
      message: "malformed tool arguments",
      code: "provider.invalid-output",
    });
    assert.equal(otherInvalidOutput.code, "provider.error");
    assert.isNull(otherInvalidOutput.retryable);

    assert.equal(
      openCode2ProviderFailure({
        message: "invalid key",
        code: "ProviderAuthError",
      }).code,
      "Integration.Authorization",
    );
    assert.equal(
      openCode2ProviderFailure({
        message: "request rejected",
        code: "APIError",
        statusCode: openCode2ProviderErrorStatus({
          error: { name: "APIError", data: { message: "secret payload", statusCode: 429 } },
        }),
      }).code,
      "provider.rate-limit",
    );
    assert.equal(
      openCode2ProviderFailure({
        message: "request rejected",
        code: "ContextOverflowError",
      }).code,
      "provider.context-limit",
    );
  });

  it("holds a retryable step failure until OpenCode announces another retry", () => {
    assert.isTrue(
      openCode2ShouldHoldExecutionFailure({
        retryable: true,
        hasAnnouncedRetry: false,
      }),
    );
    assert.isFalse(
      openCode2ShouldHoldExecutionFailure({
        retryable: true,
        hasAnnouncedRetry: true,
      }),
    );
    assert.isFalse(
      openCode2ShouldHoldExecutionFailure({
        retryable: false,
        hasAnnouncedRetry: false,
      }),
    );
    assert.isFalse(
      openCode2ShouldHoldExecutionFailure({
        retryable: null,
        hasAnnouncedRetry: false,
      }),
    );
    assert.isFalse(openCode2EventSettlesHeldExecutionFailure("session.retry.scheduled"));
    assert.isFalse(openCode2EventSettlesHeldExecutionFailure("unknown"));
    assert.isFalse(openCode2EventSettlesHeldExecutionFailure("session.usage.updated"));
    assert.isTrue(openCode2EventSettlesHeldExecutionFailure("session.idle"));
    assert.isTrue(openCode2EventSettlesHeldExecutionFailure("session.execution.failed"));
    assert.isFalse(openCode2EventSettlesHeldExecutionFailure("session.execution.interrupted"));
    assert.isFalse(openCode2EventSettlesHeldExecutionFailure("session.error"));
    assert.isTrue(openCode2EventClearsHeldExecutionFailure("session.execution.succeeded"));
    assert.isFalse(openCode2EventClearsHeldExecutionFailure("session.execution.started"));
    assert.equal(normalizeOpenCode2WireType("session.usage.updated"), "unknown");
    assert.isFalse(
      openCode2EventSettlesHeldExecutionFailure(
        normalizeOpenCode2WireType("session.usage.updated"),
      ),
    );
  });

  it("passes through live retry events", () => {
    assert.strictEqual(
      normalizeOpenCode2WireType("session.retry.scheduled"),
      "session.retry.scheduled",
    );
    assert.strictEqual(normalizeOpenCode2WireType("session.next.retried"), "unknown");
    assert.strictEqual(normalizeOpenCode2WireType("session.next.step.failed"), "unknown");
  });

  it("normalizes inbox enqueue and delivery as input admission", () => {
    assert.strictEqual(
      normalizeOpenCode2WireType("session.inbox.enqueued"),
      "session.input.admitted",
    );
    assert.strictEqual(
      normalizeOpenCode2WireType("session.inbox.delivered"),
      "session.input.admitted",
    );
  });

  it("reads 17498 inbox item payloads and treats delivered as promotion", () => {
    const enqueued = v2Event({
      type: "session.inbox.enqueued",
      data: {
        sessionID: "ses_root",
        inboxID: "msg_wake",
        item: {
          type: "synthetic",
          payload: { text: '<subagent state="completed">child completed</subagent>' },
          delivery: "queue",
        },
      },
    });
    const userEnqueued = v2Event({
      type: "session.inbox.enqueued",
      data: {
        sessionID: "ses_root",
        inboxID: "msg_user",
        item: { type: "user", payload: { text: "hello" }, delivery: "steer" },
      },
    });
    const delivered = v2Event({
      type: "session.inbox.delivered",
      data: { sessionID: "ses_root", inboxID: "msg_wake" },
    });
    assert.strictEqual(openCode2WireInputID(enqueued), "msg_wake");
    assert.notEqual(openCode2WireAdmittedInput(enqueued), undefined);
    assert.equal(openCode2WireAdmittedInput(delivered), undefined);
    assert.isTrue(openCode2IsPostSettleWakeAdmission(enqueued, { isChildSession: false }));
    assert.isFalse(openCode2IsPostSettleWakeAdmission(userEnqueued, { isChildSession: false }));
    assert.isFalse(openCode2IsPostSettleWakeAdmission(delivered, { isChildSession: false }));
  });

  it("normalizes current compaction admission and failure events", () => {
    assert.equal(
      normalizeOpenCode2WireType("session.compaction.admitted"),
      "session.compaction.started",
    );
    assert.equal(
      normalizeOpenCode2WireType("session.compaction.failed"),
      "session.compaction.failed",
    );
  });

  it("maps form.created question fields onto the UI question shape", () => {
    const mapped = openCode2FormQuestions({
      id: "form_1",
      title: "Handoff model",
      fields: [
        {
          key: "model",
          title: "Handoff model",
          description: "Which provider/model should the handoff use?",
          options: [
            {
              label: "Inherited: GLM-5.2 (Recommended)",
              value: "inherit",
              description: "Same as current.",
            },
            { label: "Claude Fable 5", value: "fable", description: "claudeAgent." },
          ],
        },
      ],
    });
    assert.deepStrictEqual(mapped.fieldKeys, ["model"]);
    assert.strictEqual(mapped.questions[0]?.header, "Handoff model");
    assert.strictEqual(mapped.questions[0]?.options[0]?.label, "Inherited: GLM-5.2 (Recommended)");
    assert.deepStrictEqual(mapped.optionValuesByLabel[0], {
      "Inherited: GLM-5.2 (Recommended)": "inherit",
      "Claude Fable 5": "fable",
    });
    assert.deepStrictEqual(
      openCode2FormAnswer(
        mapped.fieldKeys,
        [["Inherited: GLM-5.2 (Recommended)"]],
        mapped.optionValuesByLabel,
      ),
      { model: "inherit" },
    );
  });

  it("adopts a missing execution start only after the turn has parts or interrupt", () => {
    assert.isTrue(
      openCode2CanAdoptMissingExecutionStart({
        executionStarted: true,
        interrupted: false,
        partCount: 0,
      }),
    );
    assert.isTrue(
      openCode2CanAdoptMissingExecutionStart({
        executionStarted: false,
        interrupted: false,
        partCount: 1,
      }),
    );
    assert.isTrue(
      openCode2CanAdoptMissingExecutionStart({
        executionStarted: false,
        interrupted: true,
        partCount: 0,
      }),
    );
    assert.isFalse(
      openCode2CanAdoptMissingExecutionStart({
        executionStarted: false,
        interrupted: false,
        partCount: 0,
      }),
    );
  });
});
