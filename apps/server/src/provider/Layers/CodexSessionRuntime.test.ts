import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildMcpApprovalResponse,
  buildDirectComputerUseThreadConfig,
  buildPermissionsApprovalResponse,
  buildTurnStartParams,
  hasConfiguredMcpServer,
  isComputerUseMcpApproval,
  isMcpToolApproval,
  isRecoverableThreadResumeError,
  mcpApprovalRequestKind,
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

describe("buildPermissionsApprovalResponse", () => {
  const permissions = {
    network: { enabled: true },
    fileSystem: {
      entries: [{ access: "write" as const, path: { type: "path" as const, path: "/tmp" } }],
    },
  };

  it("grants the requested execution context for this turn", () => {
    NodeAssert.deepStrictEqual(buildPermissionsApprovalResponse(permissions, "accept"), {
      permissions,
      scope: "turn",
    });
  });

  it("persists an accepted execution context only for acceptForSession", () => {
    NodeAssert.deepStrictEqual(buildPermissionsApprovalResponse(permissions, "acceptForSession"), {
      permissions,
      scope: "session",
    });
  });

  it("denies every requested capability on decline or cancellation", () => {
    for (const decision of ["decline", "cancel"] as const) {
      NodeAssert.deepStrictEqual(buildPermissionsApprovalResponse(permissions, decision), {
        permissions: {},
        scope: "turn",
      });
    }
  });
});

describe("MCP tool approval", () => {
  const request = {
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      connector_id: "computer-use",
      persist: ["session", "always"],
    },
    message: "Allow Computer Use to control this desktop?",
    mode: "form" as const,
    requestedSchema: { type: "object" as const, properties: {} },
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
  };

  it("recognizes only the Computer Use connector approval", () => {
    NodeAssert.equal(isComputerUseMcpApproval(request), true);
    NodeAssert.equal(
      isComputerUseMcpApproval({
        ...request,
        _meta: { ...request._meta, connector_id: "calendar" },
      }),
      false,
    );
  });

  it("recognizes generic MCP tool guardian approvals without a connector id", () => {
    const genericRequest = {
      ...request,
      _meta: { codex_approval_kind: "mcp_tool_call" as const },
      message: "Allow node_repl to run this tool call?",
      serverName: "node_repl",
    };

    NodeAssert.equal(isMcpToolApproval(genericRequest), true);
    NodeAssert.equal(isComputerUseMcpApproval(genericRequest), false);
    NodeAssert.equal(mcpApprovalRequestKind(genericRequest), "tool");
    NodeAssert.equal(mcpApprovalRequestKind(request), "permissions");
  });

  it("does not recognize URL or unrelated form elicitations as MCP tool approvals", () => {
    NodeAssert.equal(
      isMcpToolApproval({
        ...request,
        mode: "url",
        url: "https://example.com/approve",
        elicitationId: "elicitation-1",
      }),
      false,
    );
    const unrelatedRequest = {
      ...request,
      _meta: { connector_id: "computer-use" },
    };
    NodeAssert.equal(isMcpToolApproval(unrelatedRequest), false);
    NodeAssert.equal(mcpApprovalRequestKind(unrelatedRequest), undefined);
    NodeAssert.equal(
      mcpApprovalRequestKind({
        ...request,
        mode: "url",
        url: "https://example.com/approve",
        elicitationId: "elicitation-1",
      }),
      undefined,
    );
  });

  it("maps approval decisions to MCP actions and session persistence", () => {
    NodeAssert.deepStrictEqual(buildMcpApprovalResponse("accept"), { action: "accept" });
    NodeAssert.deepStrictEqual(buildMcpApprovalResponse("acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
    });
    NodeAssert.deepStrictEqual(buildMcpApprovalResponse("decline"), { action: "decline" });
    NodeAssert.deepStrictEqual(buildMcpApprovalResponse("cancel"), { action: "cancel" });
  });

  it("builds a Windows thread override without Desktop's native pipe", () => {
    const config = {
      mcp_servers: {
        node_repl: {
          command: "node_repl.exe",
          args: [],
          startup_timeout_sec: 120,
          tool_timeout_sec: "",
          env: {
            NODE_REPL_NODE_PATH: "node.exe",
            SKY_CUA_NATIVE_PIPE: "1",
            SKY_CUA_NATIVE_PIPE_DIRECTORY: "desktop-owned-pipe",
          },
        },
      },
    };

    NodeAssert.deepStrictEqual(buildDirectComputerUseThreadConfig(config, "win32"), {
      "mcp_servers.node_repl": {
        command: "node_repl.exe",
        args: [],
        startup_timeout_sec: 120,
        env: {
          NODE_REPL_NODE_PATH: "node.exe",
        },
      },
    });
    NodeAssert.equal(buildDirectComputerUseThreadConfig(config, "linux"), undefined);
  });

  it("prepends the trusted T3 Computer Use shim without replacing configured roots or hashes", () => {
    const config = {
      mcp_servers: {
        node_repl: {
          command: "node_repl.exe",
          env: {
            NODE_REPL_NODE_MODULE_DIRS: "C:\\original\\node_modules",
            NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: "existing-hash",
            SKY_CUA_NATIVE_PIPE: "1",
          },
        },
      },
    };

    NodeAssert.deepStrictEqual(
      buildDirectComputerUseThreadConfig(config, "win32", {
        nodeModulesRoot: "C:\\shim\\node_modules",
        pipePath: "\\\\.\\pipe\\t3code-cua-test",
        trustedModuleSha256: "shim-hash",
      }),
      {
        "mcp_servers.node_repl": {
          command: "node_repl.exe",
          env: {
            NODE_REPL_NODE_MODULE_DIRS: "C:\\shim\\node_modules;C:\\original\\node_modules",
            NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: "existing-hash,shim-hash",
            T3_CODEX_COMPUTER_USE_PIPE_PATH: "\\\\.\\pipe\\t3code-cua-test",
          },
        },
      },
    );
  });

  it("does not create an incomplete node_repl transport", () => {
    NodeAssert.equal(buildDirectComputerUseThreadConfig({}, "win32"), undefined);
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
        config: {
          "mcp_servers.node_repl": {
            command: "node_repl.exe",
            env: { NODE_REPL_NODE_PATH: "node.exe" },
          },
        },
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
      for (const call of calls) {
        NodeAssert.deepStrictEqual((call.payload as { config?: unknown }).config, {
          "mcp_servers.node_repl": {
            command: "node_repl.exe",
            env: { NODE_REPL_NODE_PATH: "node.exe" },
          },
        });
      }
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
