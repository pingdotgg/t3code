import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  buildTurnStartParams,
  classifyCodexStderrLine,
  formatCodexProcessExitError,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  openCodexThread,
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

describe("buildTurnStartParams", () => {
  it.effect("keeps invalid turn values only in the schema cause", () =>
    Effect.gen(function* () {
      const secret = "codex-turn-input-secret-sentinel";
      const error = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip);
      const { cause, ...directDiagnostics } = error;

      NodeAssert.equal(error.operation, "decode-request-payload");
      NodeAssert.equal(error.method, "turn/start");
      NodeAssert.ok((error.issueCount ?? 0) > 0);
      NodeAssert.ok(error.issueKinds?.includes("Pointer"));
      NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
      NodeAssert.ok(Schema.isSchemaError(cause));
      NodeAssert.doesNotMatch(error.message, new RegExp(secret));
      NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
    }),
  );

  it.effect("includes plan collaboration mode when requested", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      });

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
            developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
          },
        },
      });
    }),
  );

  it.effect("includes default collaboration mode and image attachments", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
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
      });

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
            developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
          },
        },
      });
    }),
  );

  it.effect("injects configured routing only for Ultra turns", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Run the workflow",
        model: "gpt-5.6-sol",
        effort: "ultra",
        interactionMode: "default",
        workflowModelRouting: {
          explore: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-luna",
          },
          implement: null,
          verify: null,
        },
      });

      const instructions = params.collaborationMode?.settings.developer_instructions;
      NodeAssert.match(instructions ?? "", /codex\/gpt-5\.6-luna/);
      NodeAssert.match(instructions ?? "", /delegate_task/);
    }),
  );

  it.effect("upgrades auto-accept sandbox policy inside a worktree", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-worktree",
        runtimeMode: "auto-accept-edits",
        isWorktree: true,
        prompt: "Implement it",
      });

      NodeAssert.equal(params.approvalPolicy, "on-request");
      NodeAssert.deepStrictEqual(params.sandboxPolicy, {
        type: "dangerFullAccess",
      });
    }),
  );

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

  it.effect("omits collaboration mode when interaction mode is absent", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      });

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
    }),
  );
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

describe("formatCodexProcessExitError", () => {
  it("reports non-zero exits without stderr", () => {
    NodeAssert.equal(formatCodexProcessExitError(7), "Codex App Server exited with code 7.");
  });

  it("appends stderr when available", () => {
    NodeAssert.equal(
      formatCodexProcessExitError(7, "fatal: boom"),
      "Codex App Server exited with code 7.\nLast stderr:\nfatal: boom",
    );
  });
});

describe("classifyCodexStderrLine", () => {
  it("drops structured warning logs instead of surfacing them as chat runtime warnings", () => {
    NodeAssert.equal(
      classifyCodexStderrLine(
        '{"timestamp":"2026-07-13T06:41:55.975915Z","level":"WARN","fields":{"message":"Model personality requested but model does not support it"}}',
      ),
      null,
    );
    NodeAssert.equal(
      classifyCodexStderrLine(
        '{"timestamp":"2026-07-13T06:41:56.071135Z","level":"WARN","fields":{"message":"failed to warm featured plugin ids cache"}}',
      ),
      null,
    );
    NodeAssert.equal(
      classifyCodexStderrLine(
        '{"timestamp":"2026-07-13T06:41:56.634533Z","level":"WARN","fields":{"message":"Ignoring interface.defaultPrompt[0]: provider does not accept this option"}}',
      ),
      null,
    );
  });

  it("drops known noisy structured error logs produced during startup stream teardown", () => {
    NodeAssert.equal(
      classifyCodexStderrLine(
        '{"timestamp":"2026-07-13T06:41:56.103641Z","level":"ERROR","fields":{"message":"fail to get common stream: Unexpected end of file"}}',
      ),
      null,
    );
    NodeAssert.equal(
      classifyCodexStderrLine(
        '{"timestamp":"2026-07-13T06:41:56.117852Z","level":"ERROR","fields":{"message":"sse client event stream terminated with incomplete response body"}}',
      ),
      null,
    );
  });

  it("keeps actionable structured error logs with a concise message", () => {
    NodeAssert.deepStrictEqual(
      classifyCodexStderrLine(
        '{"timestamp":"2026-07-13T06:41:56.103641Z","level":"ERROR","fields":{"message":"failed to connect to websocket"}}',
      ),
      { message: "failed to connect to websocket" },
    );
  });

  it("keeps non-log stderr so OS and transport failures remain visible", () => {
    NodeAssert.deepStrictEqual(
      classifyCodexStderrLine("The filename or extension is too long. (os error 206)"),
      { message: "The filename or extension is too long. (os error 206)" },
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
  it.effect("upgrades the thread sandbox for an auto-accept worktree", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start"; payload: unknown }> = [];
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/start") {
            calls.push({ method, payload });
          }
          return Effect.succeed(
            makeThreadOpenResponse("worktree-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-worktree"),
        runtimeMode: "auto-accept-edits",
        isWorktree: true,
        cwd: "/tmp/project-worktree",
        requestedModel: undefined,
        serviceTier: undefined,
        resumeThreadId: undefined,
      });

      NodeAssert.deepStrictEqual(calls[0]?.payload, {
        cwd: "/tmp/project-worktree",
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      });
    }),
  );

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
