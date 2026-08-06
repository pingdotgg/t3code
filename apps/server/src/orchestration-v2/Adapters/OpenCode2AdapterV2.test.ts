import type { V2Event } from "@opencode-ai/sdk-next/v2";
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
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import {
  openCode2AutoPermissionReply,
  openCode2ChildTurnItemOrdinals,
  openCode2EnvironmentWithPermission,
  openCode2EnvironmentWithT3Mcp,
  openCode2EventEndsExecution,
  openCode2ForkParameters,
  openCode2InterruptedThreadDisposition,
  openCode2IsCancelledPostSettleWake,
  openCode2IsPostSettleWakeAdmission,
  openCode2PendingWorkForSession,
  openCode2PermissionAutoReply,
  openCode2PermissionAutoReplyForSession,
  openCode2QuestionId,
  openCode2SessionSelectionParameters,
  openCode2SessionErrorMessage,
  openCode2SessionErrorStatus,
  openCode2SessionErrorTargetSessionIds,
  openCode2CanAdoptMissingExecutionStart,
  openCode2ShouldForceInterruptFinalize,
  openCode2ShouldResubscribeStalledStream,
  openCode2ShouldSettleTurn,
  openCode2ToolNeedsTerminalOverride,
  normalizeOpenCode2PermissionEvent,
  OPENCODE2_EVENT_STALL_MS,
  OPENCODE2_INTERRUPT_SETTLE_TIMEOUT_MS,
  OPENCODE2_PROMOTED_INPUT_ID_LIMIT,
  OPENCODE2_RETIRED_SUPPRESS_WAKE_LIMIT,
  pruneOpenCode2PromotedInputIds,
  pruneOpenCode2RetiredSuppressWakes,
  rememberOpenCode2SessionPermission,
  removeOpenCode2Session,
  unwrapOpenCode2Data,
} from "./OpenCode2AdapterV2.ts";

const v2Event = (event: unknown) => event as V2Event;

const t3McpSession = {
  environmentId: EnvironmentId.make("environment:test"),
  threadId: ThreadId.make("thread:test"),
  providerSessionId: "provider-session:test",
  providerInstanceId: ProviderInstanceId.make("opencode2"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer test-token",
};
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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

describe("OpenCode 2 post-settle wake classification", () => {
  const syntheticAdmission = v2Event({
    type: "session.input.admitted",
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
          type: "session.input.admitted",
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
          type: "session.input.admitted",
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
          type: "session.input.admitted",
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
      type: "session.input.admitted",
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
        type: "session.input.admitted",
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
            type: "session.input.admitted",
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
          type: "session.input.admitted",
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
            type: "session.input.admitted",
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
      type: "session.input.admitted",
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
          type: "session.input.admitted",
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
          type: "session.input.admitted",
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
          type: "session.input.admitted",
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
        v2Event({ type: "session.execution.started", data: { sessionID: "ses_root" } }),
      ),
    );
    for (const type of [
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.idle",
    ] as const) {
      assert.isTrue(
        openCode2EventEndsExecution(v2Event({ type, data: { sessionID: "ses_root" } })),
      );
    }
  });
});

describe("OpenCode 2 wake evidence bounds", () => {
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

describe("openCode2EnvironmentWithT3Mcp", () => {
  it.effect("merges a per-thread server into process-local inline config", () =>
    Effect.gen(function* () {
      const environment = {
        CUSTOM_ENV: "preserved",
        OPENCODE_CONFIG_CONTENT: encodeJson({
          agent: { build: { mode: "primary" } },
          mcp: {
            existing: {
              type: "local",
              command: ["existing-mcp"],
            },
          },
        }),
      };
      const result = yield* openCode2EnvironmentWithT3Mcp(environment, t3McpSession);
      const resultEnvironment: NodeJS.ProcessEnv = result;

      assert.strictEqual(resultEnvironment.CUSTOM_ENV, "preserved");
      assert.deepStrictEqual(decodeJson(result.OPENCODE_CONFIG_CONTENT ?? ""), {
        agent: { build: { mode: "primary" } },
        mcp: {
          existing: {
            type: "local",
            command: ["existing-mcp"],
          },
          "t3-code": {
            type: "remote",
            url: t3McpSession.endpoint,
            headers: { Authorization: t3McpSession.authorizationHeader },
            oauth: false,
          },
        },
      });
      assert.notStrictEqual(result, environment);
    }),
  );

  it.effect("rejects inline config whose MCP field cannot be merged safely", () =>
    Effect.gen(function* () {
      const failure = yield* openCode2EnvironmentWithT3Mcp(
        { OPENCODE_CONFIG_CONTENT: encodeJson({ mcp: false }) },
        t3McpSession,
      ).pipe(Effect.flip);

      assert.isDefined(failure);
    }),
  );

  it.effect("creates inline config when content is absent or empty", () =>
    Effect.gen(function* () {
      const environments: Array<NodeJS.ProcessEnv> = [{}, { OPENCODE_CONFIG_CONTENT: "" }];
      for (const environment of environments) {
        const result = yield* openCode2EnvironmentWithT3Mcp(environment, t3McpSession);
        assert.deepStrictEqual(decodeJson(result.OPENCODE_CONFIG_CONTENT ?? ""), {
          mcp: {
            "t3-code": {
              type: "remote",
              url: t3McpSession.endpoint,
              headers: { Authorization: t3McpSession.authorizationHeader },
              oauth: false,
            },
          },
        });
      }
    }),
  );
});

describe("openCode2EnvironmentWithPermission", () => {
  const policy = (overrides: Record<string, unknown>) =>
    ({
      cwd: "/tmp",
      interactionMode: "default",
      runtimeMode: "default",
      ...overrides,
    }) as never;

  it.effect("injects allow while preserving inline MCP config for implicit full access", () =>
    Effect.gen(function* () {
      const environment = {
        OPENCODE_CONFIG_CONTENT: encodeJson({
          mcp: {
            existing: {
              type: "local",
              command: ["existing-mcp"],
            },
          },
        }),
      };
      const result = yield* openCode2EnvironmentWithPermission(
        environment,
        policy({ runtimeMode: "full-access" }),
      );

      assert.deepStrictEqual(decodeJson(result.OPENCODE_CONFIG_CONTENT ?? ""), {
        permission: "allow",
        mcp: {
          existing: {
            type: "local",
            command: ["existing-mcp"],
          },
        },
      });
    }),
  );

  it.effect("does not inject allow when the policy requires approval", () =>
    Effect.gen(function* () {
      const environment = {
        OPENCODE_CONFIG_CONTENT: encodeJson({
          mcp: {
            existing: {
              type: "local",
              command: ["existing-mcp"],
            },
          },
        }),
      };
      const result = yield* openCode2EnvironmentWithPermission(
        environment,
        policy({ approvalPolicy: "on-request", runtimeMode: "full-access" }),
      );

      assert.strictEqual(result, environment);
      assert.deepStrictEqual(decodeJson(result.OPENCODE_CONFIG_CONTENT ?? ""), {
        mcp: {
          existing: {
            type: "local",
            command: ["existing-mcp"],
          },
        },
      });
    }),
  );

  it.effect("injects allow when content is absent or empty", () =>
    Effect.gen(function* () {
      const environments: Array<NodeJS.ProcessEnv> = [{}, { OPENCODE_CONFIG_CONTENT: "" }];
      for (const environment of environments) {
        const result = yield* openCode2EnvironmentWithPermission(
          environment,
          policy({ runtimeMode: "full-access" }),
        );
        assert.deepStrictEqual(decodeJson(result.OPENCODE_CONFIG_CONTENT ?? ""), {
          permission: "allow",
        });
      }
    }),
  );
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

  it.effect("pins the thread for its durable pending input without listing shells", () =>
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
      assert.isFalse(listedShells);
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
