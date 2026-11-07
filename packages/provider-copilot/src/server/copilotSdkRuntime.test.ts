import type {
  CopilotClient,
  CopilotSession,
  ModelInfo,
  PermissionRequest,
  SessionEvent,
} from "@github/copilot-sdk";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type * as AcpSchema from "effect-acp/compat";
import * as AcpErrors from "effect-acp/errors";

import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";

import {
  isCopilotLostSessionError,
  makeCopilotSubagentRouting,
} from "@t3tools/provider-acp-registry/server/copilotAcp";
import {
  COPILOT_SDK_COMPACT_METHOD,
  COPILOT_SDK_ROLLBACK_METHOD,
  COPILOT_SDK_STEER_METHOD,
  COPILOT_SDK_STOP_TASK_METHOD,
  copilotInvestigationDecision,
  copilotInvestigationToolDecision,
  copilotPermissionDecision,
  copilotSdkClosesAssistantMessage,
  copilotSdkForkBoundary,
  copilotSdkForkFromTurn,
  copilotSdkHistoryMessage,
  copilotSdkInjectedSteerId,
  copilotSdkMcpAppDocument,
  copilotSdkMcpServers,
  copilotSdkProposedPlan,
  copilotSlashCommand,
  copilotWindowsExecutable,
  generateCopilotText,
  makeCopilotSdkEventTranslator,
  makeCopilotSdkRuntime,
  type CopilotSdkClient,
  type CopilotSdkCommandResult,
  type CopilotSdkSession,
} from "./copilotSdkRuntime.ts";

const event = (type: string, data: unknown = {}, agentId?: string) =>
  ({ type, data, ...(agentId === undefined ? {} : { agentId }) }) as unknown as SessionEvent;

function makeFakes() {
  const calls: Array<string> = [];
  const sent: Array<unknown> = [];
  let listener: (event: SessionEvent) => void = () => undefined;
  let pingFailure: Error | undefined;
  let pingHangs = false;
  let sourceHistory: ReadonlyArray<SessionEvent> = [];
  let compactSucceeds = true;
  let history: ReadonlyArray<SessionEvent> = [];
  let sessionConfig: Parameters<CopilotSdkClient["createSession"]>[0] | undefined;
  let commandResult: CopilotSdkCommandResult = { kind: "text", text: "Session Usage" };
  let models: ReadonlyArray<ModelInfo> = [];
  let currentEffort: string | undefined = "medium";
  const session: CopilotSdkSession = {
    sessionId: "session-1",
    on: (handler) => {
      listener = handler;
      return () => undefined;
    },
    send: async ({ prompt, attachments }) => {
      calls.push(`send:${prompt}`);
      if (attachments !== undefined) sent.push(attachments);
      return `message:${prompt}`;
    },
    abort: async () => {
      calls.push("abort");
    },
    interruptMainTurn: async (flushQueued) => {
      calls.push(`interrupt:${flushQueued}`);
    },
    currentModel: async () => ({
      modelId: "model-a",
      ...(currentEffort === undefined ? {} : { reasoningEffort: currentEffort }),
    }),
    switchModel: async () => undefined,
    setReasoningEffort: async (reasoningEffort) => {
      calls.push(`effort:${reasoningEffort}`);
    },
    setMode: async () => undefined,
    setApproveAll: async () => undefined,
    history: async () => history,
    disconnect: async () => undefined,
    truncate: async (eventId) => {
      calls.push(`truncate:${eventId}`);
    },
    compact: async () => {
      calls.push("compact");
      return { success: compactSucceeds };
    },
    commands: async () => [{ name: "usage", description: "Show usage" }],
    invokeCommand: async (name, input) => {
      calls.push(`invoke:${name}:${input ?? ""}`);
      return commandResult;
    },
    mcpAppTools: async () => [],
    callMcpAppTool: async () => ({}),
    readMcpAppResource: async () => ({}),
    cancelTask: async (toolCallId) => {
      calls.push(`cancel:${toolCallId}`);
      return toolCallId === "task-1";
    },
  };
  const client: CopilotSdkClient = {
    start: async () => undefined,
    ping: async () => {
      if (pingFailure !== undefined) throw pingFailure;
      if (pingHangs) await new Promise(() => undefined);
    },
    authStatus: async () => ({ isAuthenticated: true }),
    serverCommands: async () => [],
    listModels: async () => models,
    createSession: async (config) => {
      sessionConfig = config;
      return session;
    },
    resumeSession: async () => session,
    sessionHistory: async (sessionId) => {
      calls.push(`sessionHistory:${sessionId}`);
      return sourceHistory;
    },
    generateText: async () => "",
    fork: async (sessionId, toEventId) => {
      calls.push(`fork:${sessionId}:${toEventId ?? "head"}`);
      return "session-2";
    },
    stop: async () => undefined,
    forceStop: async () => undefined,
  };
  return {
    calls,
    client,
    emit: (next: SessionEvent) => listener(next),
    failPing: (error: Error) => {
      pingFailure = error;
    },
    hangPing: () => {
      pingHangs = true;
    },
    setSourceHistory: (events: ReadonlyArray<SessionEvent>) => {
      sourceHistory = events;
    },
    sessionConfig: () => sessionConfig!,
    sentAttachments: () => sent,
    setHistory: (events: ReadonlyArray<SessionEvent>) => {
      history = events;
    },
    failCompact: () => {
      compactSucceeds = false;
    },
    setCommandResult: (result: CopilotSdkCommandResult) => {
      commandResult = result;
    },
    setModels: (next: ReadonlyArray<ModelInfo>, effort: string | undefined) => {
      models = next;
      currentEffort = effort;
    },
  };
}

const startPrompt = Effect.fn("startPrompt")(function* (
  runtime: Effect.Success<ReturnType<typeof makeCopilotSdkRuntime>>,
) {
  yield* runtime.start();
  const dispatched = yield* Deferred.make<void>();
  const fiber = yield* runtime
    .prompt({ prompt: [{ type: "text", text: "go" }] }, { dispatched })
    .pipe(Effect.forkChild);
  yield* Deferred.await(dispatched);
  return fiber;
});

it("translates tool events into the ACP updates Copilot's native layer sends", () => {
  const translate = makeCopilotSdkEventTranslator();
  const path = "/repo/f1.ts";
  assert.deepEqual(
    translate(
      event("tool.execution_start", {
        toolCallId: "edit-1",
        toolName: "edit",
        toolTitle: "Editing file",
        arguments: { path, old_str: "a", new_str: "b" },
      }),
    ),
    [
      {
        sessionUpdate: "tool_call",
        toolCallId: "edit-1",
        title: "Editing file",
        kind: "edit",
        status: "pending",
        rawInput: { path, old_str: "a", new_str: "b" },
        locations: [{ path }],
      },
    ],
  );
  assert.deepEqual(
    translate(
      event("tool.execution_complete", {
        toolCallId: "edit-1",
        success: true,
        result: { content: "updated" },
      }),
    ),
    [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "completed",
        content: [{ type: "diff", path, oldText: "a", newText: "b" }],
        rawOutput: { content: "updated" },
      },
    ],
  );
  assert.deepEqual(
    translate(
      event(
        "tool.execution_start",
        {
          toolCallId: "bash-1",
          toolName: "bash",
          arguments: { command: "echo hi", description: "Echo hi" },
        },
        "agent-a",
      ),
    ),
    [
      {
        sessionUpdate: "tool_call",
        toolCallId: "bash-1",
        title: "Echo hi",
        kind: "execute",
        status: "pending",
        rawInput: { command: "echo hi", description: "Echo hi" },
        _meta: { "github.com/copilot": { agentId: "agent-a" } },
      },
    ],
  );
  assert.deepEqual(
    translate(
      event("tool.execution_complete", {
        toolCallId: "bash-1",
        success: false,
        error: { message: "boom" },
      }),
    ),
    [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "bash-1",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "boom" } }],
        rawOutput: { message: "boom" },
      },
    ],
  );
});

it("fails the main agent's running tools on abort and leaves agent tools alone", () => {
  const translate = makeCopilotSdkEventTranslator();
  translate(event("tool.execution_start", { toolCallId: "main", toolName: "bash" }));
  translate(event("tool.execution_start", { toolCallId: "done", toolName: "bash" }));
  translate(event("tool.execution_complete", { toolCallId: "done", success: true }));
  translate(event("tool.execution_start", { toolCallId: "child", toolName: "bash" }, "agent-a"));
  translate(
    event("tool.execution_start", {
      toolCallId: "nested",
      toolName: "bash",
      parentToolCallId: "task-1",
    }),
  );

  assert.deepEqual(translate(event("abort", { reason: "user_initiated" })), [
    { sessionUpdate: "tool_call_update", toolCallId: "main", status: "failed" },
  ]);
  assert.deepEqual(translate(event("abort", { reason: "user_initiated" })), []);
});

// regression: a reply stayed hidden until a background agent let the turn end
it("closes the text segment only when the main agent finishes a message", () => {
  const translate = makeCopilotSdkEventTranslator();
  const closes = (data: unknown) =>
    translate(event("assistant.message", data)).some((update) =>
      copilotSdkClosesAssistantMessage({ sessionId: "s", update }),
    );
  assert.isTrue(closes({ content: "reply" }));
  assert.isFalse(closes({ content: "agent reply", parentToolCallId: "task-1" }));
});

it("surfaces a finished plan as a proposal", () => {
  const [update] = makeCopilotSdkEventTranslator()(
    event("exit_plan_mode.requested", {
      requestId: "r1",
      summary: "Add a file",
      planContent: "# Plan",
      actions: [],
      recommendedAction: "interactive",
    }),
  );
  assert.strictEqual(copilotSdkProposedPlan({ sessionId: "s", update: update! }), "# Plan");
  const [ordinaryTool] = makeCopilotSdkEventTranslator()(
    event("tool.execution_start", {
      toolCallId: "t1",
      toolName: "edit",
      arguments: { planContent: "not a plan" },
    }),
  );
  assert.isUndefined(copilotSdkProposedPlan({ sessionId: "s", update: ordinaryTool! }));
});

it("reads a slash command from behind T3's instruction prefix", () => {
  assert.deepEqual(copilotSlashCommand("/usage"), { name: "usage", input: undefined });
  assert.deepEqual(copilotSlashCommand("/review the auth code"), {
    name: "review",
    input: "the auth code",
  });
  assert.deepEqual(
    copilotSlashCommand("<t3_code_instructions>\nrules\n</t3_code_instructions>\n\n/usage"),
    {
      name: "usage",
      input: undefined,
    },
  );
  assert.isUndefined(copilotSlashCommand("use /usage please"));
  assert.isUndefined(copilotSlashCommand("/etc/hosts is a file"));
});

// `toEventId` is exclusive: stopping at the turn's own message would drop the turn from the fork.
it("forks a turn at the next user message, or at the head after the last turn", () => {
  const history = [
    { id: "u1", type: "user.message" },
    { id: "a1", type: "assistant.message" },
    { id: "u2", type: "user.message" },
    { id: "a2", type: "assistant.message" },
  ] as ReadonlyArray<Pick<SessionEvent, "id" | "type">>;
  assert.strictEqual(copilotSdkForkBoundary(history, "u1"), "u2");
  assert.isUndefined(copilotSdkForkBoundary(history, "u2"));
  const [update] = makeCopilotSdkEventTranslator()({
    ...event("user.message", { messageId: "m-1" }),
    id: "u1",
  } as SessionEvent);
  assert.strictEqual(
    copilotSdkForkFromTurn.nativeTurnId({ sessionId: "s", update: update! }),
    "u1",
  );
});

it.effect("reports a stopped subagent as cancelled, not completed", () =>
  Effect.gen(function* () {
    const finished: Array<string> = [];
    let onEvent: (payload: unknown) => Effect.Effect<void, never> = () => Effect.void;
    yield* makeCopilotSubagentRouting().registerExtensions({
      runtime: {
        handleExtNotification: (_method: string, _schema: unknown, handler: typeof onEvent) =>
          Effect.sync(() => {
            onEvent = handler;
          }),
      },
      finishSubagent: (notice: { readonly status: string }) =>
        Effect.sync(() => {
          finished.push(notice.status);
        }),
    } as unknown as AcpAdapterV2ExtensionContext);

    const end = (data: Record<string, unknown>) =>
      onEvent({ sessionId: "s", type: "subagent.completed", data: { toolCallId: "t", ...data } });
    yield* end({ cancelled: true });
    yield* end({});

    assert.deepEqual(finished, ["cancelled", "completed"]);
  }),
);

// The document can reach 5 MiB, and tool output is stored on the turn item.
it("hands an MCP tool's UI document over without keeping it in the tool output", () => {
  const translate = makeCopilotSdkEventTranslator();
  const started = translate(
    event("tool.execution_start", {
      toolCallId: "app-1",
      toolName: "weather-show_weather",
      mcpServerName: "weather",
      mcpToolName: "show_weather",
      arguments: { city: "Paris" },
    }),
  )[0] as { readonly _meta?: unknown };
  assert.deepEqual(started._meta, { serverId: "weather", toolName: "show_weather" });

  const uiResource = { uri: "ui://weather/card", mimeType: "text/html", text: "<h1>Hi</h1>" };
  const finished = translate(
    event("tool.execution_complete", {
      toolCallId: "app-1",
      success: true,
      result: { content: "Sunny", structuredContent: { sky: "sunny" }, uiResource },
    }),
  )[0] as { readonly _meta?: unknown; readonly rawOutput?: unknown };

  assert.deepEqual(finished.rawOutput, { content: "Sunny", structuredContent: { sky: "sunny" } });
  assert.deepEqual(copilotSdkMcpAppDocument(finished._meta, finished.rawOutput), {
    resourceUri: "ui://weather/card",
    contents: [uiResource],
    result: {
      content: [{ type: "text", text: "Sunny" }],
      structuredContent: { sky: "sunny" },
    },
  });
  assert.isUndefined(copilotSdkMcpAppDocument({}, finished.rawOutput));
});

it("marks each user message so the adapter can confirm a steer landed", () => {
  const [update] = makeCopilotSdkEventTranslator()(event("user.message", { messageId: "m-1" }));
  assert.strictEqual(
    copilotSdkInjectedSteerId({ sessionId: "s", update: update! } as AcpSchema.SessionNotification),
    "m-1",
  );
});

it("keeps only remote MCP servers with their headers", () => {
  assert.deepEqual(
    copilotSdkMcpServers([
      {
        type: "http",
        name: "t3-code",
        url: "http://127.0.0.1/mcp",
        headers: [{ name: "Authorization", value: "Bearer token" }],
      },
      { name: "stdio", command: "node", args: [], env: [] },
    ] as ReadonlyArray<AcpSchema.McpServer>),
    {
      "t3-code": {
        type: "http",
        url: "http://127.0.0.1/mcp",
        headers: { Authorization: "Bearer token" },
        tools: ["*"],
      },
    },
  );
});

it("lets an investigation run plain git reads and read the checkout, and nothing else", () => {
  const shell = (fullCommandText: string, hasWriteFileRedirection = false) =>
    ({ kind: "shell", fullCommandText, hasWriteFileRedirection }) as PermissionRequest;
  const read = (path: string) => ({ kind: "read", path }) as PermissionRequest;
  const decide = (request: PermissionRequest) =>
    copilotInvestigationDecision(request, "/repo").kind;

  for (const allowed of [
    shell("git diff --stat abc123...HEAD"),
    shell("git log --oneline --format=%H abc123..HEAD"),
    shell("git diff abc123...HEAD -- src/a.ts"),
    shell("git show HEAD:src/a.ts"),
    read("/repo"),
    read("/repo/src/a.ts"),
    read("src/a.ts"),
  ]) {
    assert.strictEqual(decide(allowed), "approve-once");
  }
  for (const refused of [
    shell("git diff --output=/tmp/x"),
    shell("git diff --outp=/tmp/x"),
    shell("git diff -o /tmp/x"),
    shell("git diff --ext-diff"),
    shell("git diff --no-index /etc/passwd /dev/null"),
    shell("git diff /etc/passwd README.md"),
    shell("git diff ../secret README.md"),
    shell("git diff -- ../secret README.md"),
    shell("git diff ~/secret README.md"),
    shell("git diff C:/secret README.md"),
    shell("git diff -O/etc/passwd"),
    shell("git log --textconv"),
    shell("git diff | sh"),
    shell("git diff; rm -rf ."),
    shell("git diff $(rm x)"),
    shell("git diff > out", true),
    shell("git checkout main"),
    shell("git -c core.pager=sh diff"),
    shell("rm -rf ."),
    read("/etc/passwd"),
    read("../secrets"),
    read("/repo/../secrets"),
    read("/repository/other"),
    { kind: "write" } as PermissionRequest,
    { kind: "url" } as PermissionRequest,
    { kind: "mcp" } as PermissionRequest,
  ]) {
    assert.strictEqual(decide(refused), "reject");
  }
});

// Copilot skips the permission request for these, so the hook alone stops them.
it("refuses tool calls Copilot would run without asking", async () => {
  const links: Record<string, string> = { "/repo/out": "/etc/passwd" };
  const decide = async (toolName: string, toolArgs: unknown) =>
    (
      await copilotInvestigationToolDecision(
        { toolName, toolArgs },
        "/repo",
        async (path) => links[path] ?? path,
      )
    ).permissionDecision;

  for (const [toolName, toolArgs, expected] of [
    ["bash", { command: "git log --oneline a..HEAD" }, "allow"],
    ["view", { path: "/repo/a.ts" }, "allow"],
    ["grep", { pattern: "x" }, "allow"],
    ["grep", { pattern: "x", paths: "src", output_mode: "content", "-n": true }, "allow"],
    ["grep", { pattern: "../not-a-path", glob: "**/*.ts" }, "allow"],
    ["glob", { pattern: "src/**/*.ts" }, "allow"],
    ["bash", { command: "git diff --output=leak.txt" }, "deny"],
    ["bash", { command: "git diff ../secret a.ts" }, "deny"],
    ["bash", { command: "ls" }, "deny"],
    ["bash", {}, "deny"],
    ["grep", { pattern: "x", path: "/etc" }, "deny"],
    ["grep", { pattern: "x", glob: "../**" }, "deny"],
    ["glob", { pattern: "/etc/*" }, "deny"],
    ["glob", { pattern: "{a,/etc}/*" }, "deny"],
    ["glob", { pattern: "../*" }, "deny"],
    ["view", { path: "/repo/../secrets" }, "deny"],
    ["view", { path: "/repo/out" }, "deny"],
    ["grep", { pattern: "x", paths: "out" }, "deny"],
    ["grep", { pattern: "x", paths: ["src", "out"] }, "deny"],
    ["grep", { pattern: "x", somethingNew: "/etc" }, "deny"],
    ["edit", { path: "/repo/a.ts" }, "deny"],
  ] as const) {
    assert.strictEqual(await decide(toolName, toolArgs), expected, JSON.stringify(toolArgs));
  }
});

it("swaps npm's Windows shim for the binary behind it", () => {
  const root = "C:\\npm\\prefix";
  const nested = `${root}\\node_modules\\@github\\copilot\\node_modules\\@github\\copilot-win32-x64\\copilot.exe`;
  const hoisted = `${root}\\node_modules\\@github\\copilot-win32-x64\\copilot.exe`;
  const resolve = (command: string, ...present: Array<string>) =>
    copilotWindowsExecutable(command, "x64", (path) => present.includes(path));

  assert.strictEqual(resolve(`${root}\\copilot.cmd`, nested), nested);
  assert.strictEqual(resolve(`${root}\\copilot.CMD`, hoisted), hoisted);
  assert.strictEqual(resolve(`${root}\\copilot.cmd`), `${root}\\copilot.cmd`);
  assert.strictEqual(resolve("C:\\tools\\copilot.exe"), "C:\\tools\\copilot.exe");
});

it("rejects a permission unless an allow option was selected", () => {
  const selected = (optionId: string) =>
    copilotPermissionDecision({ outcome: { outcome: "selected", optionId } });
  assert.deepEqual(selected("allow_once"), { kind: "approve-once" });
  assert.deepEqual(selected("allow_always"), { kind: "approve-for-session" });
  assert.deepEqual(selected("reject_once"), { kind: "reject" });
  assert.deepEqual(
    copilotPermissionDecision({
      outcome: { outcome: "selected", optionId: "reject_once" },
      _meta: { feedback: "use pnpm instead" },
    }),
    { kind: "reject", feedback: "use pnpm instead" },
  );
  assert.deepEqual(copilotPermissionDecision({ outcome: { outcome: "cancelled" } }), {
    kind: "reject",
  });
});

it.effect("steers a working main agent by queueing, then interrupting only its turn", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    const prompt = yield* startPrompt(runtime);
    fakes.emit(event("assistant.turn_start"));

    const steered = yield* runtime.request(COPILOT_SDK_STEER_METHOD, { text: "change course" });

    assert.deepEqual(steered, { messageId: "message:change course" });
    assert.deepEqual(fakes.calls, ["send:go", "send:change course", "interrupt:true"]);
    // The steer's own abort must not end the prompt: its follow-up turn is still to come.
    fakes.emit(event("abort", { reason: "user_initiated" }));
    fakes.emit(event("assistant.turn_start"));
    fakes.emit(event("assistant.idle"));
    fakes.emit(event("session.idle"));
    assert.strictEqual((yield* Fiber.join(prompt)).stopReason, "end_turn");
  }).pipe(Effect.scoped),
);

// regression: interrupting after the main agent finished loses the queued message
it.effect("applies a reasoning level when Copilot reports no current one", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    fakes.setModels(
      [{ id: "model-a", name: "A", supportedReasoningEfforts: ["low", "high"] } as ModelInfo],
      undefined,
    );
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    yield* runtime.start();
    const options = yield* runtime.getConfigOptions;
    assert.isTrue(options.some((option) => option.id === "reasoning_effort"));
    yield* runtime.setConfigOption("reasoning_effort", "low");
    assert.include(fakes.calls, "effort:low");
  }).pipe(Effect.scoped),
);

it.effect("sends without interrupting once the main agent has finished", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    const prompt = yield* startPrompt(runtime);
    fakes.emit(event("assistant.turn_start"));
    fakes.emit(event("assistant.idle"));

    yield* runtime.request(COPILOT_SDK_STEER_METHOD, { text: "change course" });

    assert.deepEqual(fakes.calls, ["send:go", "send:change course"]);
    fakes.emit(event("session.idle"));
    yield* Fiber.join(prompt);
  }).pipe(Effect.scoped),
);

it.effect("reports a real cancel after an earlier steer finished", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    const prompt = yield* startPrompt(runtime);
    fakes.emit(event("assistant.turn_start"));
    yield* runtime.request(COPILOT_SDK_STEER_METHOD, { text: "change course" });
    fakes.emit(event("assistant.turn_start"));

    yield* runtime.cancel;
    fakes.emit(event("session.idle", { aborted: true }));

    assert.strictEqual((yield* Fiber.join(prompt)).stopReason, "cancelled");
  }).pipe(Effect.scoped),
);

it.effect("settles a turn only after its output reached the adapter", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    const seen: Array<string> = [];
    yield* runtime.handleSessionUpdate((notification) =>
      Effect.yieldNow.pipe(
        Effect.andThen(
          Effect.sync(() => {
            seen.push(notification.update.sessionUpdate);
          }),
        ),
      ),
    );
    const prompt = yield* startPrompt(runtime);

    fakes.emit(event("assistant.message_delta", { deltaContent: "last words" }));
    fakes.emit(event("session.idle"));
    yield* Fiber.join(prompt);

    assert.strictEqual(seen.at(-1), "agent_message_chunk");
  }).pipe(Effect.scoped),
);

it.effect("fails the prompt with an error the lost-session restart recognises", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    const prompt = yield* startPrompt(runtime);

    fakes.emit(
      event("session.error", {
        errorType: "internal",
        message: "session event delivery failed: session not found: session-1",
      }),
    );

    const failure = yield* Fiber.join(prompt).pipe(Effect.flip);
    assert.isTrue(isCopilotLostSessionError(failure));
  }).pipe(Effect.scoped),
);

it.effect("fails an open prompt and reports termination when the runtime dies", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const terminated = yield* Deferred.make<AcpErrors.AcpError>();
    const runtime = yield* makeCopilotSdkRuntime({
      cwd: "/repo",
      client: fakes.client,
      onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
    });
    const prompt = yield* startPrompt(runtime);

    fakes.failPing(new Error("connection closed"));
    yield* TestClock.adjust("10 seconds");

    const failure = yield* Fiber.join(prompt).pipe(Effect.flip);
    assert.strictEqual(failure, yield* Deferred.await(terminated));
  }).pipe(Effect.scoped),
);

it.effect("reports termination when the runtime stops answering pings", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const terminated = yield* Deferred.make<AcpErrors.AcpError>();
    const runtime = yield* makeCopilotSdkRuntime({
      cwd: "/repo",
      client: fakes.client,
      onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
    });
    const prompt = yield* startPrompt(runtime);

    fakes.hangPing();
    yield* TestClock.adjust("40 seconds");

    const failure = yield* Fiber.join(prompt).pipe(Effect.flip);
    assert.strictEqual(failure, yield* Deferred.await(terminated));
  }).pipe(Effect.scoped),
);

it.effect("keeps the prompt open when only a sub-agent fails", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    const prompt = yield* startPrompt(runtime);

    fakes.emit(event("session.error", { errorType: "query", message: "agent failed" }, "agent-1"));
    fakes.emit(event("session.idle"));

    assert.strictEqual((yield* Fiber.join(prompt)).stopReason, "end_turn");
  }).pipe(Effect.scoped),
);

it("replays complete messages from history, leaving out sub-agents", () => {
  assert.deepEqual(
    copilotSdkHistoryMessage(
      event("user.message", {
        content: "<t3_code_instructions>\nrules\n</t3_code_instructions>\n\nhi",
      }),
    ),
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } },
  );
  assert.deepEqual(copilotSdkHistoryMessage(event("user.message", { content: "hi" })), {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "hi" },
  });
  assert.deepEqual(
    copilotSdkHistoryMessage(event("assistant.message", { content: "yo", messageId: "m1" })),
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "yo" },
      messageId: "m1",
    },
  );
  assert.deepEqual(
    copilotSdkHistoryMessage(event("assistant.reasoning", { content: "hm", reasoningId: "r1" })),
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "hm" },
      messageId: "r1",
    },
  );
  for (const hidden of [
    event("assistant.message", { content: "", messageId: "m2" }),
    event("assistant.message", { content: "x", messageId: "m3", parentToolCallId: "t" }),
    event("user.message", { content: "task" }, "agent-1"),
  ]) {
    assert.isUndefined(copilotSdkHistoryMessage(hidden));
  }
});

it.effect("rebuilds messages when resuming a session", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    fakes.setHistory([
      event("user.message", { content: "hi" }),
      event("assistant.message", { content: "yo", messageId: "m1" }),
    ]);
    const runtime = yield* makeCopilotSdkRuntime({
      cwd: "/repo",
      client: fakes.client,
      resumeSessionId: "session-1",
    });
    const seen: Array<AcpSchema.SessionUpdate> = [];
    yield* runtime.handleSessionUpdate((notification) =>
      Effect.sync(() => {
        seen.push(notification.update);
      }),
    );

    yield* runtime.start();

    assert.deepEqual(
      seen.flatMap((update) =>
        update.sessionUpdate === "user_message_chunk" ||
        update.sessionUpdate === "agent_message_chunk"
          ? [update.sessionUpdate]
          : [],
      ),
      ["user_message_chunk", "agent_message_chunk"],
    );
  }).pipe(Effect.scoped),
);

it.effect("forks another session using that session's own history", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    fakes.setSourceHistory([
      { id: "u1", type: "user.message" } as SessionEvent,
      { id: "u2", type: "user.message" } as SessionEvent,
    ]);
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    yield* runtime.start();

    yield* runtime.forkSession("source", undefined, copilotSdkForkFromTurn.forkMeta("u1"));

    assert.deepEqual(fakes.calls, ["sessionHistory:source", "fork:source:u2"]);
  }).pipe(Effect.scoped),
);

it.effect("refuses to fork from a turn its session does not have", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    yield* runtime.start();

    const failure = yield* runtime
      .forkSession("source", undefined, copilotSdkForkFromTurn.forkMeta("gone"))
      .pipe(Effect.flip);

    assert.include(failure.message, "gone");
    assert.deepEqual(fakes.calls, ["sessionHistory:source"]);
  }).pipe(Effect.scoped),
);

it("limits only an investigation to read-only tools behind the hook", async () => {
  const configs: Array<Parameters<CopilotClient["createSession"]>[0]> = [];
  const client = {
    start: async () => undefined,
    createSession: async (config: (typeof configs)[number]) => {
      configs.push(config);
      return {
        sessionId: "text",
        sendAndWait: async () => undefined,
        disconnect: async () => undefined,
      } as unknown as CopilotSession;
    },
    deleteSession: async () => undefined,
    stop: async () => [],
  };
  const input = { cwd: "/repo", model: "m", prompt: "p", timeoutMs: 1 };

  await generateCopilotText(client, input);
  await generateCopilotText(client, { ...input, investigate: true });

  assert.deepEqual(configs[0]?.availableTools, []);
  assert.isUndefined(configs[0]?.hooks);
  assert.deepEqual(configs[1]?.availableTools, ["view", "grep", "glob", "bash"]);
  assert.isDefined(configs[1]?.hooks?.onPreToolUse);
});

it("stops the client when a text generation session cannot start", async () => {
  let stopped = false;
  const generated = generateCopilotText(
    {
      start: async () => undefined,
      createSession: async () => {
        throw new Error("no session");
      },
      deleteSession: async () => undefined,
      stop: async () => {
        stopped = true;
        return [];
      },
    },
    { cwd: "/repo", model: "m", prompt: "p", timeoutMs: 1 },
  );

  await generated.then(
    () => assert.fail("expected generation to fail"),
    (error) => assert.include(String(error), "no session"),
  );
  assert.isTrue(stopped);
});

it.effect("runs a known slash command through invoke and shows its output", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    const seen: Array<AcpSchema.SessionUpdate> = [];
    yield* runtime.handleSessionUpdate((notification) =>
      Effect.sync(() => {
        seen.push(notification.update);
      }),
    );
    yield* runtime.start();

    const result = yield* runtime.prompt({ prompt: [{ type: "text", text: "/usage" }] });

    assert.strictEqual(result.stopReason, "end_turn");
    assert.deepEqual(fakes.calls, ["invoke:usage:"]);
    assert.deepEqual(
      seen.map((update) => update.sessionUpdate),
      ["available_commands_update", "agent_message_chunk"],
    );
  }).pipe(Effect.scoped),
);

it.effect("sends the prompt a slash command expands to", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    fakes.setCommandResult({ kind: "agent-prompt", prompt: "expanded", displayPrompt: "/usage" });
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    yield* runtime.start();
    const dispatched = yield* Deferred.make<void>();
    const prompt = yield* runtime
      .prompt(
        {
          prompt: [
            { type: "text", text: "/usage" },
            { type: "image", data: "aGk=", mimeType: "image/png" },
          ],
        },
        { dispatched },
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(dispatched);
    fakes.emit(event("session.idle"));
    yield* Fiber.join(prompt);

    assert.deepEqual(fakes.calls, ["invoke:usage:", "send:expanded"]);
    assert.deepEqual(fakes.sentAttachments(), [
      [{ type: "blob", data: "aGk=", mimeType: "image/png" }],
    ]);
  }).pipe(Effect.scoped),
);

it.effect("sends an unknown slash command to the model as text", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    yield* runtime.start();
    const dispatched = yield* Deferred.make<void>();
    const prompt = yield* runtime
      .prompt({ prompt: [{ type: "text", text: "/not-a-command" }] }, { dispatched })
      .pipe(Effect.forkChild);
    yield* Deferred.await(dispatched);
    fakes.emit(event("session.idle"));
    yield* Fiber.join(prompt);

    assert.deepEqual(fakes.calls, ["send:/not-a-command"]);
  }).pipe(Effect.scoped),
);

it.effect("reports a failed compaction", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    fakes.failCompact();
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    yield* runtime.start();

    const failure = yield* runtime.request(COPILOT_SDK_COMPACT_METHOD, {}).pipe(
      Effect.as(""),
      Effect.catch((error) => Effect.succeed(error.message)),
    );

    assert.include(failure, "could not compact");
  }).pipe(Effect.scoped),
);

it.effect("fails to stop a task Copilot does not report as cancelled", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    yield* runtime.start();

    yield* runtime.request(COPILOT_SDK_STOP_TASK_METHOD, { taskId: "task-1" });
    const failure = yield* runtime
      .request(COPILOT_SDK_STOP_TASK_METHOD, { taskId: "finished" })
      .pipe(
        Effect.as(""),
        Effect.catch((error) => Effect.succeed(error.message)),
      );

    assert.include(failure, "no running task");
  }).pipe(Effect.scoped),
);

it.effect("totals the main agent's usage across a turn and ignores subagents", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    const prompt = yield* startPrompt(runtime);
    fakes.emit(event("assistant.usage", { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 }));
    fakes.emit(event("assistant.usage", { inputTokens: 5, outputTokens: 1 }));
    fakes.emit(event("assistant.usage", { inputTokens: 99, parentToolCallId: "task-1" }));
    fakes.emit(event("session.idle"));

    assert.deepEqual((yield* Fiber.join(prompt)).usage, {
      inputTokens: 15,
      outputTokens: 3,
      cachedReadTokens: 4,
      totalTokens: 18,
    });
  }).pipe(Effect.scoped),
);

// regression: an unacknowledged answer shows "Answer delivery not confirmed" and fails the turn
it.effect("reports each permission and question answer as sent, and keeps question choices", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const sent: Array<string> = [];
    const runtime = yield* makeCopilotSdkRuntime({
      cwd: "/repo",
      client: fakes.client,
      onOutgoingResponse: (requestId) =>
        Effect.sync(() => {
          sent.push(requestId);
        }),
    });
    const contexts: Array<string> = [];
    let schema: unknown;
    yield* runtime.handleRequestPermission((_, context) =>
      Effect.sync(() => {
        contexts.push(context.requestId);
        return { outcome: { outcome: "selected", optionId: "reject_once" } };
      }),
    );
    yield* runtime.handleElicitation((request, context) =>
      Effect.sync(() => {
        contexts.push(context.requestId);
        schema = "requestedSchema" in request ? request.requestedSchema : undefined;
        return { action: "accept", content: { answer: "red" } };
      }),
    );
    yield* runtime.start();
    const { onPermissionRequest, onUserInputRequest } = fakes.sessionConfig();

    const decision = yield* Effect.promise(async () =>
      onPermissionRequest!({ kind: "shell", toolCallId: "t1" } as PermissionRequest, {
        sessionId: "session-1",
      }),
    );
    const answer = yield* Effect.promise(async () =>
      onUserInputRequest!(
        { question: "Pick", choices: ["red", "blue"], allowFreeform: true },
        { sessionId: "session-1" },
      ),
    );

    assert.deepEqual(decision, { kind: "reject" });
    assert.deepEqual(answer, { answer: "red", wasFreeform: false });
    assert.deepEqual(sent, contexts);
    assert.deepEqual(
      (schema as { properties: { answer: { enum: Array<string> } } }).properties.answer.enum,
      ["red", "blue"],
    );
  }).pipe(Effect.scoped),
);

it.effect("rewinds to just after a turn, keeping that turn", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    fakes.setHistory([
      { ...event("user.message"), id: "u1" } as SessionEvent,
      { ...event("assistant.message"), id: "a1" } as SessionEvent,
      { ...event("user.message"), id: "u2" } as SessionEvent,
    ]);
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    yield* runtime.start();

    yield* runtime.request(COPILOT_SDK_ROLLBACK_METHOD, { turnEventId: "u1" });
    yield* runtime.request(COPILOT_SDK_ROLLBACK_METHOD, { turnEventId: "u2" });

    assert.deepEqual(fakes.calls, ["truncate:u2"]);
  }).pipe(Effect.scoped),
);

it.effect("fails a rewind to a turn the session does not have", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    fakes.setHistory([{ id: "u1", type: "user.message" } as SessionEvent]);
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    yield* runtime.start();

    const failure = yield* runtime
      .request(COPILOT_SDK_ROLLBACK_METHOD, { turnEventId: "gone" })
      .pipe(
        Effect.as(""),
        Effect.catch((error) => Effect.succeed(error.message)),
      );

    assert.include(failure, "gone");
    assert.deepEqual(fakes.calls, []);
  }).pipe(Effect.scoped),
);

it.effect("carries a steer's images to Copilot", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    const runtime = yield* makeCopilotSdkRuntime({ cwd: "/repo", client: fakes.client });
    const prompt = yield* startPrompt(runtime);
    fakes.emit(event("assistant.turn_start"));

    yield* runtime.request(COPILOT_SDK_STEER_METHOD, {
      text: "see this",
      images: [{ data: "aGk=", mimeType: "image/png" }],
    });

    assert.deepEqual(fakes.sentAttachments(), [
      [{ type: "blob", data: "aGk=", mimeType: "image/png" }],
    ]);
    fakes.emit(event("session.idle"));
    yield* Fiber.join(prompt);
  }).pipe(Effect.scoped),
);
