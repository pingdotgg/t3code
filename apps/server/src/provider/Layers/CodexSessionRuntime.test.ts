import * as NodeAssert from "node:assert/strict";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { describe, it } from "@effect/vitest";
import { DEFAULT_MODEL, ThreadId, TurnId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  buildTurnStartParams,
  findActiveCodexTurnId,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  openCodexThread,
  resolveCodexInterruptTurnId,
  shouldPreferActiveCodexTurnCandidate,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

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

function makeThreadReadResponse(
  turns: EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"],
): EffectCodexSchema.V2ThreadReadResponse {
  return {
    thread: {
      cliVersion: "0.0.0-test",
      createdAt: 1,
      cwd: "/tmp/project",
      ephemeral: false,
      id: "provider-thread-1",
      modelProvider: "openai",
      preview: "test thread",
      sessionId: "session-1",
      source: "appServer",
      status: { type: "active", activeFlags: [] },
      turns,
      updatedAt: 2,
    },
  };
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

describe("findActiveCodexTurnId", () => {
  it("selects the most recently started in-progress turn", () => {
    const snapshot = makeThreadReadResponse([
      { id: "turn-active-new", status: "inProgress", startedAt: 30, items: [] },
      { id: "turn-completed", status: "completed", startedAt: 20, items: [] },
      { id: "turn-active-old", status: "inProgress", startedAt: 10, items: [] },
    ]);

    NodeAssert.equal(findActiveCodexTurnId(snapshot), "turn-active-new");
  });

  it("selects a later in-progress turn without a start timestamp", () => {
    const snapshot = makeThreadReadResponse([
      { id: "turn-active-old", status: "inProgress", startedAt: 10, items: [] },
      { id: "turn-active-new", status: "inProgress", items: [] },
    ]);

    NodeAssert.equal(findActiveCodexTurnId(snapshot), "turn-active-new");
  });

  it("selects a later timestamped turn after one without a timestamp", () => {
    const snapshot = makeThreadReadResponse([
      { id: "turn-active-old", status: "inProgress", items: [] },
      { id: "turn-active-new", status: "inProgress", startedAt: 10, items: [] },
    ]);

    NodeAssert.equal(findActiveCodexTurnId(snapshot), "turn-active-new");
  });

  it("returns undefined when no turn is active", () => {
    const response = makeThreadReadResponse([]);
    NodeAssert.equal(findActiveCodexTurnId(response), undefined);
  });

  it.effect("requests turns when resolving an interrupt without a projected turn id", () => {
    let requestedParams: CodexRpc.ClientRequestParamsByMethod["thread/read"] | undefined;

    return Effect.gen(function* () {
      const turnId = yield* resolveCodexInterruptTurnId({
        providerThreadId: "provider-thread-1",
        requestedTurnId: undefined,
        sessionActiveTurnId: undefined,
        readThread: (params) => {
          requestedParams = params;
          return Effect.succeed(
            makeThreadReadResponse([
              { id: "turn-active", status: "inProgress", startedAt: 10, items: [] },
            ]),
          );
        },
      });

      NodeAssert.deepStrictEqual(requestedParams, {
        threadId: "provider-thread-1",
        includeTurns: true,
      });
      NodeAssert.equal(turnId, "turn-active");
    });
  });

  it.effect("does not revive a stale projected turn after a successful empty read", () =>
    Effect.gen(function* () {
      const turnId = yield* resolveCodexInterruptTurnId({
        providerThreadId: "provider-thread-1",
        requestedTurnId: undefined,
        sessionActiveTurnId: TurnId.make("turn-stale"),
        readThread: () => Effect.succeed(makeThreadReadResponse([])),
      });

      NodeAssert.equal(turnId, undefined);
    }),
  );

  it.effect("falls back to the projected turn when the live lookup fails", () =>
    Effect.gen(function* () {
      const projectedTurnId = TurnId.make("turn-projected");
      const turnId = yield* resolveCodexInterruptTurnId({
        providerThreadId: "provider-thread-1",
        requestedTurnId: undefined,
        sessionActiveTurnId: projectedTurnId,
        readThread: () => Effect.fail("lookup failed"),
      });

      NodeAssert.equal(turnId, projectedTurnId);
    }),
  );

  it.effect("bounds the live lookup and falls back to the projected turn on timeout", () =>
    Effect.gen(function* () {
      const projectedTurnId = TurnId.make("turn-projected");
      const resolution = yield* resolveCodexInterruptTurnId({
        providerThreadId: "provider-thread-1",
        requestedTurnId: undefined,
        sessionActiveTurnId: projectedTurnId,
        readThread: () => Effect.never,
      }).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      NodeAssert.equal(yield* Fiber.join(resolution), projectedTurnId);
    }),
  );
});

describe("shouldPreferActiveCodexTurnCandidate", () => {
  it("selects the first candidate", () => {
    NodeAssert.equal(shouldPreferActiveCodexTurnCandidate({ startedAt: 10 }, undefined), true);
  });

  it("orders timestamped turns by start time and lets a later equal entry win", () => {
    NodeAssert.equal(
      shouldPreferActiveCodexTurnCandidate({ startedAt: 20 }, { startedAt: 10 }),
      true,
    );
    NodeAssert.equal(
      shouldPreferActiveCodexTurnCandidate({ startedAt: 10 }, { startedAt: 20 }),
      false,
    );
    NodeAssert.equal(
      shouldPreferActiveCodexTurnCandidate({ startedAt: 10 }, { startedAt: 10 }),
      true,
    );
  });

  it("lets the later provider entry win when either timestamp is absent", () => {
    for (const [candidate, selected] of [
      [{}, { startedAt: 10 }],
      [{ startedAt: null }, { startedAt: 10 }],
      [{ startedAt: 10 }, {}],
      [{ startedAt: 10 }, { startedAt: null }],
    ] as const) {
      NodeAssert.equal(shouldPreferActiveCodexTurnCandidate(candidate, selected), true);
    }
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
