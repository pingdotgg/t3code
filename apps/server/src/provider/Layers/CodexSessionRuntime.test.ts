import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import {
  DEFAULT_MODEL,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderSession,
} from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildTurnStartParams,
  buildTurnSteerParams,
  type CodexActiveTurnState,
  CodexSessionRuntimeTurnSteerRejectedError,
  type CodexSessionRuntimeSendTurnInput,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  openCodexThread,
  sendCodexTurn,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);
const isCodexSessionRuntimeTurnSteerRejectedError = Schema.is(
  CodexSessionRuntimeTurnSteerRejectedError,
);

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
  });

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  it("prefers the product-native preview tools in both collaboration modes", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});

describe("buildTurnSteerParams", () => {
  it.effect("carries the required active turn id and the message only", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnSteerParams({
        threadId: "provider-thread-1",
        expectedTurnId: TurnId.make("turn-active"),
        prompt: "Also update the changelog",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        expectedTurnId: "turn-active",
        input: [
          {
            type: "text",
            text: "Also update the changelog",
          },
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      });
    }),
  );
});
const PROVIDER_THREAD_ID = "provider-thread-1";
const ACTIVE_TURN_ID = TurnId.make("turn-active");

function makeCodexSession(overrides: Partial<ProviderSession>): ProviderSession {
  return {
    provider: ProviderDriverKind.make("codex"),
    status: "ready",
    runtimeMode: "full-access",
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    threadId: ThreadId.make("thread-1"),
    resumeCursor: { threadId: PROVIDER_THREAD_ID },
    createdAt: "2026-04-18T00:00:00.000Z",
    updatedAt: "2026-04-18T00:00:00.000Z",
    ...overrides,
  };
}

function makeActiveTurn(overrides: Partial<CodexActiveTurnState> = {}): CodexActiveTurnState {
  return {
    turnId: ACTIVE_TURN_ID,
    model: "gpt-5.3-codex",
    effort: undefined,
    serviceTier: undefined,
    interactionMode: undefined,
    interrupting: false,
    ...overrides,
  };
}

/** Session + turn record for a thread that is genuinely mid-turn. */
const runningSession = Effect.all({
  sessionRef: Ref.make(makeCodexSession({ status: "running", activeTurnId: ACTIVE_TURN_ID })),
  activeTurnRef: Ref.make<CodexActiveTurnState | undefined>(makeActiveTurn()),
});

const idleSession = Effect.all({
  sessionRef: Ref.make(makeCodexSession({ status: "ready" })),
  activeTurnRef: Ref.make<CodexActiveTurnState | undefined>(undefined),
});

interface RecordedTurnCall {
  readonly method: string;
  readonly payload: unknown;
}

function makeTurnClient(input: {
  readonly calls: Array<RecordedTurnCall>;
  readonly startedTurnId?: string;
  readonly steer?: (
    payload: EffectCodexSchema.V2TurnSteerParams,
  ) => Effect.Effect<EffectCodexSchema.V2TurnSteerResponse, CodexErrors.CodexAppServerError>;
  readonly onTurnStart?: () => Effect.Effect<void>;
}) {
  return {
    raw: {
      request: (method: string, payload?: unknown) => {
        input.calls.push({ method, payload });
        return (input.onTurnStart ? input.onTurnStart() : Effect.void).pipe(
          Effect.as({
            turn: {
              id: input.startedTurnId ?? "turn-started",
              items: [],
              status: "inProgress",
            },
          } as unknown),
        ) as Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
      },
    },
    request: (_method: "turn/steer", payload: EffectCodexSchema.V2TurnSteerParams) => {
      input.calls.push({ method: "turn/steer", payload });
      return input.steer
        ? input.steer(payload)
        : Effect.succeed({ turnId: payload.expectedTurnId });
    },
  };
}

const failSteer = (error: CodexErrors.CodexAppServerRequestError) => () => Effect.fail(error);

const sendTurnInput = { input: "Also update the changelog" } as const;

const send = (input: {
  readonly calls: Array<RecordedTurnCall>;
  readonly sessionRef: Ref.Ref<ProviderSession>;
  readonly activeTurnRef: Ref.Ref<CodexActiveTurnState | undefined>;
  readonly turn?: CodexSessionRuntimeSendTurnInput;
  readonly startedTurnId?: string;
  readonly steer?: (
    payload: EffectCodexSchema.V2TurnSteerParams,
  ) => Effect.Effect<EffectCodexSchema.V2TurnSteerResponse, CodexErrors.CodexAppServerError>;
  readonly onTurnStart?: () => Effect.Effect<void>;
}) =>
  sendCodexTurn({
    client: makeTurnClient({
      calls: input.calls,
      ...(input.startedTurnId ? { startedTurnId: input.startedTurnId } : {}),
      ...(input.steer ? { steer: input.steer } : {}),
      ...(input.onTurnStart ? { onTurnStart: input.onTurnStart } : {}),
    }),
    sessionRef: input.sessionRef,
    activeTurnRef: input.activeTurnRef,
    threadId: ThreadId.make("thread-1"),
    runtimeMode: "full-access",
    turn: input.turn ?? sendTurnInput,
  });

describe("sendCodexTurn", () => {
  it.effect("steers the running turn instead of starting a second one", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* runningSession;
      const sessionBefore = yield* Ref.get(sessionRef);

      const result = yield* send({ calls, sessionRef, activeTurnRef });

      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["turn/steer"],
      );
      NodeAssert.deepStrictEqual(calls[0]?.payload, {
        threadId: PROVIDER_THREAD_ID,
        expectedTurnId: "turn-active",
        input: [
          {
            type: "text",
            text: "Also update the changelog",
          },
        ],
      });
      NodeAssert.equal(result.turnId, "turn-active");
      NodeAssert.equal(result.steered, true);
      NodeAssert.deepStrictEqual(yield* Ref.get(sessionRef), sessionBefore);
    }),
  );

  it.effect("reports the running turn so nothing downstream projects a new turn", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* runningSession;

      const result = yield* send({ calls, sessionRef, activeTurnRef });

      // A new turn is only ever projected from a `turn/started` notification,
      // which the app-server does not send for a steer. Returning the running
      // turn's id keeps the caller's active-turn record pointed at the turn
      // that `turn/interrupt` accepts.
      NodeAssert.deepStrictEqual(result, {
        threadId: "thread-1",
        turnId: "turn-active",
        resumeCursor: { threadId: PROVIDER_THREAD_ID },
        steered: true,
      });
    }),
  );

  it.effect("starts a turn when the session is idle", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* idleSession;

      const result = yield* send({ calls, sessionRef, activeTurnRef });

      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["turn/start"],
      );
      NodeAssert.equal(result.turnId, "turn-started");
      NodeAssert.equal(result.steered, false);
      const session = yield* Ref.get(sessionRef);
      NodeAssert.equal(session.status, "running");
      NodeAssert.equal(session.activeTurnId, "turn-started");
      // The turn's settings become the baseline a later mid-turn send is
      // checked against.
      NodeAssert.deepStrictEqual(yield* Ref.get(activeTurnRef), {
        turnId: "turn-started",
        model: "gpt-5.3-codex",
        effort: undefined,
        serviceTier: undefined,
        interactionMode: undefined,
        interrupting: false,
      });
    }),
  );

  it.effect("prefers the start response's turn id over a racing turn/started", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* idleSession;

      // `turn/started` wins the race against the turn/start response and
      // publishes a different id. Captured against codex-cli 0.147.0, the
      // server validates `expectedTurnId` and `turn/interrupt` against the
      // id it returned in the response, so that one has to win.
      const result = yield* send({
        calls,
        sessionRef,
        activeTurnRef,
        startedTurnId: "turn-from-response",
        onTurnStart: () =>
          Ref.update(sessionRef, (session) => ({
            ...session,
            status: "running" as const,
            activeTurnId: TurnId.make("turn-from-notification"),
          })),
      });

      NodeAssert.equal(result.turnId, "turn-from-response");
      NodeAssert.equal((yield* Ref.get(sessionRef)).activeTurnId, "turn-from-response");
      NodeAssert.equal((yield* Ref.get(activeTurnRef))?.turnId, "turn-from-response");
    }),
  );

  it.effect("rejects retryably instead of starting while Stop awaits terminal lifecycle", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const sessionRef = yield* Ref.make(
        makeCodexSession({ status: "running", activeTurnId: ACTIVE_TURN_ID }),
      );
      const activeTurnRef = yield* Ref.make<CodexActiveTurnState | undefined>(
        makeActiveTurn({ interrupting: true }),
      );

      const error = yield* send({ calls, sessionRef, activeTurnRef }).pipe(Effect.flip);

      NodeAssert.ok(isCodexSessionRuntimeTurnSteerRejectedError(error));
      NodeAssert.equal(error.reason, "turn-interrupting");
      NodeAssert.equal(error.retryable, true);
      NodeAssert.deepStrictEqual(calls, []);
    }),
  );

  it.effect("does not start a phantom turn when the running turn's settings are unknown", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const sessionRef = yield* Ref.make(
        makeCodexSession({ status: "running", activeTurnId: ACTIVE_TURN_ID }),
      );
      const activeTurnRef = yield* Ref.make<CodexActiveTurnState | undefined>(undefined);

      const error = yield* send({ calls, sessionRef, activeTurnRef }).pipe(Effect.flip);

      NodeAssert.ok(isCodexSessionRuntimeTurnSteerRejectedError(error));
      NodeAssert.equal(error.reason, "rejected");
      NodeAssert.match(error.message, /metadata is unavailable/);
      NodeAssert.deepStrictEqual(calls, []);
    }),
  );

  for (const change of [
    { label: "model", turn: { ...sendTurnInput, model: "gpt-5.4" }, setting: "the model" },
    {
      label: "reasoning effort",
      turn: { ...sendTurnInput, effort: "high" },
      setting: "reasoning effort",
    },
    {
      label: "interaction mode",
      turn: { ...sendTurnInput, interactionMode: "plan" },
      setting: "the interaction mode",
    },
    {
      label: "service tier",
      turn: { ...sendTurnInput, serviceTier: "priority" },
      setting: "the service tier",
    },
  ] as const) {
    it.effect(`refuses to silently drop a ${change.label} switch mid-turn`, () =>
      Effect.gen(function* () {
        const calls: Array<RecordedTurnCall> = [];
        const { sessionRef, activeTurnRef } = yield* runningSession;
        const sessionBefore = yield* Ref.get(sessionRef);

        const error = yield* send({
          calls,
          sessionRef,
          activeTurnRef,
          turn: change.turn as CodexSessionRuntimeSendTurnInput,
        }).pipe(Effect.flip);

        NodeAssert.ok(isCodexSessionRuntimeTurnSteerRejectedError(error));
        NodeAssert.equal(error.reason, "turn-settings-changed");
        NodeAssert.equal(error.changedSetting, change.setting);
        NodeAssert.equal(error.retryable, false);
        // Refused before any RPC: the message is not sent anywhere.
        NodeAssert.deepStrictEqual(calls, []);
        NodeAssert.deepStrictEqual(yield* Ref.get(sessionRef), sessionBefore);
      }),
    );
  }

  it.effect("steers when the send repeats the settings the turn already runs with", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const sessionRef = yield* Ref.make(
        makeCodexSession({ status: "running", activeTurnId: ACTIVE_TURN_ID }),
      );
      const activeTurnRef = yield* Ref.make<CodexActiveTurnState | undefined>(
        makeActiveTurn({ effort: "high", interactionMode: "default" }),
      );

      const result = yield* send({
        calls,
        sessionRef,
        activeTurnRef,
        turn: {
          ...sendTurnInput,
          model: "gpt-5.3-codex",
          effort: "high",
          interactionMode: "default",
        },
      });

      NodeAssert.equal(result.steered, true);
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["turn/steer"],
      );
    }),
  );

  it.effect("records the effective default effort used by interaction mode", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* idleSession;

      yield* send({
        calls,
        sessionRef,
        activeTurnRef,
        turn: { ...sendTurnInput, interactionMode: "default" },
      });
      const repeated = yield* send({
        calls,
        sessionRef,
        activeTurnRef,
        turn: { ...sendTurnInput, effort: "medium", interactionMode: "default" },
      });

      NodeAssert.equal(repeated.steered, true);
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["turn/start", "turn/steer"],
      );
      NodeAssert.equal((yield* Ref.get(activeTurnRef))?.effort, "medium");
    }),
  );

  it.effect("re-issues after a no-active refusal only when the runtime has become idle", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* runningSession;

      const result = yield* send({
        calls,
        sessionRef,
        activeTurnRef,
        steer: () =>
          Ref.update(sessionRef, (session) => ({
            ...session,
            status: "ready" as const,
            activeTurnId: undefined,
          })).pipe(
            Effect.andThen(Ref.set(activeTurnRef, undefined)),
            Effect.andThen(
              Effect.fail(
                new CodexErrors.CodexAppServerRequestError({
                  code: -32600,
                  errorMessage: "no active turn to steer",
                }),
              ),
            ),
          ),
      });

      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["turn/steer", "turn/start"],
      );
      NodeAssert.equal(result.turnId, "turn-started");
      NodeAssert.equal(result.steered, false);
    }),
  );

  it.effect("does not start after a no-active refusal while the runtime still sees a turn", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* runningSession;

      const error = yield* send({
        calls,
        sessionRef,
        activeTurnRef,
        steer: failSteer(
          new CodexErrors.CodexAppServerRequestError({
            code: -32600,
            errorMessage: "no active turn to steer",
          }),
        ),
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexSessionRuntimeTurnSteerRejectedError(error));
      NodeAssert.equal(error.retryable, false);
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["turn/steer"],
      );
    }),
  );

  it.effect("reconciles a found active turn without starting a phantom turn", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* runningSession;
      const foundTurnId = "019fe4fe-eaeb-7a02-b448-18071e35f6f9";

      const error = yield* send({
        calls,
        sessionRef,
        activeTurnRef,
        steer: failSteer(
          new CodexErrors.CodexAppServerRequestError({
            code: -32600,
            errorMessage: `expected active turn id \`${ACTIVE_TURN_ID}\` but found \`${foundTurnId}\``,
          }),
        ),
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexSessionRuntimeTurnSteerRejectedError(error));
      NodeAssert.equal(error.retryable, false);
      NodeAssert.equal((yield* Ref.get(sessionRef)).activeTurnId, foundTurnId);
      NodeAssert.equal((yield* Ref.get(activeTurnRef))?.turnId, foundTurnId);
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["turn/steer"],
      );
    }),
  );

  it.effect("keeps a refusal terminal when the session still sees the turn running", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* runningSession;
      const sessionBefore = yield* Ref.get(sessionRef);

      // Neither captured precondition message: re-issuing could double post.
      const error = yield* send({
        calls,
        sessionRef,
        activeTurnRef,
        steer: failSteer(
          new CodexErrors.CodexAppServerRequestError({
            code: -32600,
            errorMessage: "steering is disabled",
          }),
        ),
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexSessionRuntimeTurnSteerRejectedError(error));
      NodeAssert.equal(error.reason, "rejected");
      NodeAssert.equal(error.retryable, false);
      NodeAssert.equal(error.detail, "steering is disabled");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["turn/steer"],
      );
      NodeAssert.deepStrictEqual(yield* Ref.get(sessionRef), sessionBefore);
    }),
  );

  it.effect("keeps a precondition-shaped message terminal under another code", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* runningSession;

      const error = yield* send({
        calls,
        sessionRef,
        activeTurnRef,
        steer: failSteer(
          new CodexErrors.CodexAppServerRequestError({
            code: -32603,
            errorMessage: "no active turn to steer",
          }),
        ),
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexSessionRuntimeTurnSteerRejectedError(error));
      NodeAssert.equal(error.reason, "rejected");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["turn/steer"],
      );
    }),
  );

  it.effect("classifies the schema-declared activeTurnNotSteerable refusal", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* runningSession;
      const sessionBefore = yield* Ref.get(sessionRef);

      // Schema-declared, wire-unproven: no capture of this refusal exists.
      const error = yield* send({
        calls,
        sessionRef,
        activeTurnRef,
        steer: failSteer(
          new CodexErrors.CodexAppServerRequestError({
            code: -32600,
            errorMessage: "active turn cannot be steered",
            data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } } },
          }),
        ),
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexSessionRuntimeTurnSteerRejectedError(error));
      NodeAssert.equal(error.reason, "active-turn-not-steerable");
      NodeAssert.equal(error.turnKind, "review");
      NodeAssert.equal(error.retryable, false);
      NodeAssert.match(error.message, /running a review turn/);
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["turn/steer"],
      );
      NodeAssert.deepStrictEqual(yield* Ref.get(sessionRef), sessionBefore);
    }),
  );

  it.effect("never re-issues an activeTurnNotSteerable refusal worded like a stale one", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* runningSession;

      // The variant wins over the message prefix: a `/review` turn is still
      // running, so re-issuing would post into it.
      const error = yield* send({
        calls,
        sessionRef,
        activeTurnRef,
        steer: failSteer(
          new CodexErrors.CodexAppServerRequestError({
            code: -32600,
            errorMessage: "no active turn to steer",
            data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "compact" } } },
          }),
        ),
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexSessionRuntimeTurnSteerRejectedError(error));
      NodeAssert.equal(error.reason, "active-turn-not-steerable");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["turn/steer"],
      );
    }),
  );

  it.effect("never renders a placeholder turn kind the app-server did not name", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* runningSession;

      const error = yield* send({
        calls,
        sessionRef,
        activeTurnRef,
        steer: failSteer(
          new CodexErrors.CodexAppServerRequestError({
            code: -32600,
            errorMessage: "active turn cannot be steered",
            data: { codexErrorInfo: { activeTurnNotSteerable: {} } },
          }),
        ),
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexSessionRuntimeTurnSteerRejectedError(error));
      NodeAssert.equal(error.reason, "active-turn-not-steerable");
      NodeAssert.equal(error.turnKind, undefined);
      NodeAssert.doesNotMatch(error.message, /unknown/);
    }),
  );

  it.effect("rejects when the app-server steers a turn we did not ask for", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* runningSession;
      const sessionBefore = yield* Ref.get(sessionRef);

      const error = yield* send({
        calls,
        sessionRef,
        activeTurnRef,
        steer: () => Effect.succeed({ turnId: "turn-other" }),
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexSessionRuntimeTurnSteerRejectedError(error));
      NodeAssert.equal(error.reason, "turn-id-mismatch");
      NodeAssert.equal(error.steeredTurnId, "turn-other");
      // The message may have landed on that turn, so it is never re-issued.
      NodeAssert.equal(error.retryable, false);
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["turn/steer"],
      );
      NodeAssert.deepStrictEqual(yield* Ref.get(sessionRef), sessionBefore);
    }),
  );

  it.effect("keeps a failed fallback typed as the turn-start failure it is", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedTurnCall> = [];
      const { sessionRef, activeTurnRef } = yield* runningSession;

      const error = yield* sendCodexTurn({
        client: {
          raw: {
            request: (method: string, payload?: unknown) => {
              calls.push({ method, payload });
              return Effect.fail(
                new CodexErrors.CodexAppServerProcessExitedError({ code: 1 }),
              ) as Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
            },
          },
          request: (_method: "turn/steer", payload: EffectCodexSchema.V2TurnSteerParams) => {
            calls.push({ method: "turn/steer", payload });
            return Ref.update(sessionRef, (session) => ({
              ...session,
              status: "ready" as const,
              activeTurnId: undefined,
            })).pipe(
              Effect.andThen(Ref.set(activeTurnRef, undefined)),
              Effect.andThen(
                Effect.fail(
                  new CodexErrors.CodexAppServerRequestError({
                    code: -32600,
                    errorMessage: "no active turn to steer",
                  }),
                ),
              ),
            );
          },
        },
        sessionRef,
        activeTurnRef,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        turn: sendTurnInput,
      }).pipe(Effect.flip);

      // Disguising this as a steer rejection would cost the adapter its
      // session-closed classification.
      NodeAssert.equal(error._tag, "CodexAppServerProcessExitedError");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["turn/steer", "turn/start"],
      );
    }),
  );
});
