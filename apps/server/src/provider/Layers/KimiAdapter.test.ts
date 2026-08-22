// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  KimiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeKimiTurnActivity, type KimiTurnActivity } from "../acp/KimiAcpSupport.ts";
import {
  clearSettledKimiInterruptedTurnIds,
  kimiPromptSettlementBelongsToContext,
  makeKimiAdapter,
} from "./KimiAdapter.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);
const mockAgentCommand = process.execPath;
const KIMI_PROVIDER = ProviderDriverKind.make("kimi");
const KIMI_INSTANCE = ProviderInstanceId.make("kimi");
const KIMI_MOCK_AGENT_SOURCE = String.raw`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const emitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS === "1";
const emitLateUpdateAfterCancel = process.env.T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL === "1";
const exitOnPrompt = process.env.T3_ACP_EXIT_ON_PROMPT === "1";
const terminalCommandJson = process.env.T3_ACP_TERMINAL_COMMAND;
const planFlow = process.env.T3_ACP_PLAN_FLOW === "1";
const permissionAfterCancel = process.env.T3_ACP_PERMISSION_AFTER_CANCEL === "1";
const emitSteerPreparedMarker = process.env.T3_ACP_STEER_PREPARED_MARKER === "1";
const sessionId = "mock-kimi-session-1";
let currentMode = "default";
let currentModel = "default";
let currentReasoning = "medium";
let permissionId = 0;
const pendingPermissions = new Map();
let clientRequestId = 0;
const pendingClientRequests = new Map();
let promptOrdinal = 0;
let cancelRequested = false;
const cancelWaiters = [];
let planDismissals = 0;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function logLine(method, params) {
  if (requestLogPath) {
    appendFileSync(requestLogPath, JSON.stringify({ method, params }) + "\n", "utf8");
  }
}

function sendClientRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = "client-req-" + String(++clientRequestId);
    pendingClientRequests.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const BASH_PERMISSION_OPTIONS = [
  { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
  { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

const EXIT_PLAN_PERMISSION_OPTIONS = [
  { optionId: "plan_approve", name: "Approve", kind: "allow_once" },
  { optionId: "plan_revise", name: "Revise", kind: "reject_once" },
  { optionId: "plan_reject_and_exit", name: "Reject and Exit", kind: "reject_once" },
];

// Mirrors kimi-cli 0.37.2 wire shapes: the tool call carries composed text
// content entries instead of rawInput.
function bashPermissionToolCall() {
  return {
    toolCallId: "tool-bash-" + String(permissionId + 1),
    title: "Bash",
    kind: "execute",
    status: "pending",
    rawInput: {},
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: "Requesting approval to Running: echo mock-approved-command",
        },
      },
    ],
  };
}

function exitPlanModeToolCall() {
  return {
    toolCallId: "tool-exit-plan-" + String(permissionId + 1),
    title: "ExitPlanMode",
    status: "pending",
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: "Plan saved to: D:/mock/plans/mock-plan.md\n\n# Plan: Mock landing page\n\n## Steps\n- write the plan\n- ship it",
        },
      },
      {
        type: "content",
        content: {
          type: "text",
          text: "Requesting approval to Presenting plan and exiting plan mode",
        },
      },
    ],
  };
}

function requestPermission(promptId, toolCall, options) {
  const id = "permission-" + String(++permissionId);
  pendingPermissions.set(id, { promptId, planDecision: toolCall.title === "ExitPlanMode" });
  logLine("mock/permission_request", { id, title: toolCall.title });
  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: { sessionId, toolCall, options },
  });
}

async function runTerminalCommandFlow(promptId) {
  const spec = JSON.parse(terminalCommandJson);
  try {
    const created = await sendClientRequest("terminal/create", {
      sessionId,
      command: spec.command,
      args: spec.args ?? [],
      env: [{ name: "T3_MOCK_TERMINAL_ENV", value: "from-mock-agent" }],
      ...(spec.outputByteLimit !== undefined ? { outputByteLimit: spec.outputByteLimit } : {}),
    });
    if (spec.cancelAfterWait) {
      // Surface "terminal created" so the test can interrupt while this flow
      // is parked in wait_for_exit below.
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "terminal-created" },
          },
        },
      });
    }
    const waitResult = await sendClientRequest("terminal/wait_for_exit", {
      sessionId,
      terminalId: created.terminalId,
    });
    const outputResult = await sendClientRequest("terminal/output", {
      sessionId,
      terminalId: created.terminalId,
    });
    await sendClientRequest("terminal/release", {
      sessionId,
      terminalId: created.terminalId,
    });
    logLine("mock/terminal_result", { created, waitResult, outputResult });
    if (spec.cancelAfterWait) {
      // Signal that the killed terminal stayed readable through release, so
      // the test can assert on the logged results without racing this flow.
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "terminal-finished" },
          },
        },
      });
      // Mirror real Kimi: the prompt only responds once session/cancel
      // arrives, and cancel is honored only after the blocked
      // terminal/wait_for_exit resolves.
      if (cancelRequested) {
        completePrompt(promptId, "cancelled");
      } else {
        cancelWaiters.push(() => completePrompt(promptId, "cancelled"));
      }
      return;
    }
    completePrompt(promptId, "end_turn");
  } catch (err) {
    logLine("mock/terminal_error", { message: String(err) });
    completePrompt(promptId, "end_turn");
  }
}

function configOptions() {
  const options = [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: currentMode,
      options: ["default", "plan", "auto", "yolo"].map((value) => ({ value, name: value })),
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: [
        { value: "default", name: "Default" },
        { value: "gpt-5.4", name: "GPT-5.4" },
      ],
    },
  ];
  if (currentModel === "gpt-5.4") {
    options.push({
      id: "reasoning",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: currentReasoning,
      options: ["low", "medium", "high"].map((value) => ({ value, name: value })),
    });
  }
  return options;
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}

function completePrompt(id, stopReason) {
  result(id, { stopReason });
}

function handlePermissionResponse(message) {
  const pending = pendingPermissions.get(String(message.id));
  if (!pending) return;
  pendingPermissions.delete(String(message.id));
  logLine("mock/permission_response", { id: String(message.id), result: message.result });
  const outcome = message.result?.outcome;
  const selected = outcome?.outcome === "selected";
  if (pending.planDecision) {
    handlePlanDecisionResponse(pending.promptId, outcome, selected);
  } else {
    completePrompt(pending.promptId, selected ? "end_turn" : "cancelled");
  }
  // Deterministic post-response marker: the RPC layer can unwind the prompt
  // client-side on cancel, so tests cannot use prompt settlement to observe
  // that the permission response arrived.
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "permission-resolved" },
      },
    },
  });
}

// Mirrors kimi-cli 0.37.2 observed live: a "cancelled" ExitPlanMode answer
// reads as a dismissed approval dialog, NOT as an end-turn signal, so the
// agent retries the request; after three dismissals it gives up, prints the
// plan as plain text, and ends the turn. A selected plan_approve leaves plan
// mode natively (no config_option_update is emitted) and the same turn
// continues; plan_revise keeps plan mode and presents the plan again.
function handlePlanDecisionResponse(promptId, outcome, selected) {
  if (selected && outcome?.optionId === "plan_approve") {
    currentMode = "default";
    planDismissals = 0;
    completePrompt(promptId, "end_turn");
    return;
  }
  if (selected && outcome?.optionId === "plan_revise") {
    planDismissals = 0;
    requestPermission(promptId, exitPlanModeToolCall(), EXIT_PLAN_PERMISSION_OPTIONS);
    return;
  }
  planDismissals += 1;
  if (planDismissals < 3) {
    requestPermission(promptId, exitPlanModeToolCall(), EXIT_PLAN_PERMISSION_OPTIONS);
    return;
  }
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "plan-printed-after-dismissals" },
      },
    },
  });
  completePrompt(promptId, "end_turn");
}

function notifyConfigOptions() {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: configOptions() },
    },
  });
}

function handleRequest(message) {
  if (requestLogPath) {
    appendFileSync(requestLogPath, JSON.stringify(message) + "\n", "utf8");
  }
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      result(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      return;
    case "authenticate":
      result(message.id, {});
      return;
    case "session/new":
      result(message.id, { sessionId, configOptions: configOptions() });
      return;
    case "session/load":
      result(message.id, { configOptions: configOptions() });
      return;
    case "session/set_mode":
      currentMode = String(params.modeId);
      result(message.id, {});
      notifyConfigOptions();
      return;
    case "session/set_model":
      currentModel = String(params.modelId);
      result(message.id, {});
      return;
    case "session/set_config_option":
      if (params.configId === "mode") currentMode = String(params.value);
      if (params.configId === "model") currentModel = String(params.value);
      if (params.configId === "reasoning") currentReasoning = String(params.value);
      result(message.id, { configOptions: configOptions() });
      notifyConfigOptions();
      if (emitSteerPreparedMarker && params.configId === "model") {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "steer-prepared" },
            },
          },
        });
      }
      return;
    case "session/prompt": {
      if (exitOnPrompt) {
        process.exit(7);
      }
      promptOrdinal += 1;
      if (terminalCommandJson) {
        const spec = JSON.parse(terminalCommandJson);
        if (spec.cancelAfterWait && promptOrdinal > 1) {
          // Only the first prompt blocks on the never-exiting terminal;
          // follow-ups behave normally so the session stays usable.
          completePrompt(message.id, "end_turn");
          return;
        }
        runTerminalCommandFlow(message.id);
        return;
      }
      if (permissionAfterCancel) {
        if (promptOrdinal > 1) {
          // Only the first prompt parks; follow-ups behave normally so the
          // session stays usable after the interrupt.
          completePrompt(message.id, "end_turn");
          return;
        }
        // Surface that the prompt is parked so the test interrupts
        // deterministically, then wait for session/cancel: the drained
        // waiter fires a late permission request BEFORE answering the
        // prompt; the post-stop gate must cancel it without opening an
        // approval card.
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "prompt-parked" },
            },
          },
        });
        cancelWaiters.push(() =>
          requestPermission(message.id, bashPermissionToolCall(), BASH_PERMISSION_OPTIONS),
        );
        return;
      }
      if (planFlow && promptOrdinal === 1) {
        // The first prompt ends in the plan decision; follow-ups are tool gates.
        requestPermission(message.id, exitPlanModeToolCall(), EXIT_PLAN_PERMISSION_OPTIONS);
        return;
      }
      if (!emitToolCalls && !planFlow) {
        completePrompt(message.id, "end_turn");
        return;
      }
      requestPermission(message.id, bashPermissionToolCall(), BASH_PERMISSION_OPTIONS);
      return;
    }
    case "session/cancel":
      result(message.id, {});
      cancelRequested = true;
      for (const [id, pending] of pendingPermissions) {
        pendingPermissions.delete(id);
        completePrompt(pending.promptId, "cancelled");
      }
      for (const waiter of cancelWaiters.splice(0)) {
        waiter();
      }
      if (emitLateUpdateAfterCancel) {
        setImmediate(() =>
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "late after cancel" },
              },
            },
          }),
        );
      }
      return;
    default:
      error(message.id, "Unsupported method: " + String(message.method));
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method) {
    handleRequest(message);
    return;
  }
  const pendingClient = pendingClientRequests.get(String(message.id));
  if (pendingClient) {
    pendingClientRequests.delete(String(message.id));
    if (message.error) {
      pendingClient.reject(new Error(JSON.stringify(message.error)));
    } else {
      pendingClient.resolve(message.result);
    }
    return;
  }
  handlePermissionResponse(message);
});
`;

async function makeMockKimiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-mock-"));
  const windows = NodePath.sep === "\\";
  const agentPath = NodePath.join(dir, "mock-kimi-agent.mjs");
  const wrapperPath = NodePath.join(dir, windows ? "fake-kimi.cmd" : "fake-kimi");
  const entries = Object.entries(extraEnv ?? {});
  const script = windows
    ? [
        "@echo off",
        ...entries.map(([key, value]) => `set "${key}=${value}"`),
        `"${mockAgentCommand}" "${agentPath}" %*`,
      ].join("\r\n")
    : [
        "#!/bin/sh",
        ...entries.map(([key, value]) => `export ${key}=${JSON.stringify(value)}`),
        `exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(agentPath)} "$@"`,
      ].join("\n");
  await NodeFSP.writeFile(agentPath, KIMI_MOCK_AGENT_SOURCE, "utf8");
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  if (!windows) {
    await NodeFSP.chmod(wrapperPath, 0o755);
  }
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const kimiAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kimi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeKimiAdapter>[1]) =>
  makeKimiAdapter(decodeKimiSettings({ enabled: true, binaryPath }), options).pipe(Effect.orDie);

const startTestSession = (
  adapter: Effect.Success<ReturnType<typeof makeKimiAdapter>>,
  threadId: ThreadId,
  runtimeMode: "approval-required" | "full-access" = "approval-required",
) =>
  adapter.startSession({
    threadId,
    provider: KIMI_PROVIDER,
    cwd: process.cwd(),
    runtimeMode,
  });

function terminalEvents(events: ReadonlyArray<ProviderRuntimeEvent>, threadId: ThreadId) {
  return events.filter(
    (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
      event.type === "turn.completed" && String(event.threadId) === String(threadId),
  );
}

it("requires a settlement to match the live Kimi turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    kimiPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isFalse(
    kimiPromptSettlementBelongsToContext({
      liveAcpSessionId: "replacement-session",
      expectedAcpSessionId: "stale-session",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    kimiPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it("clears interrupted turn ids after a newer turn settles", () => {
  const interruptedTurnIds = new Set([TurnId.make("interrupted-1"), TurnId.make("interrupted-2")]);
  clearSettledKimiInterruptedTurnIds(interruptedTurnIds);
  assert.strictEqual(interruptedTurnIds.size, 0);
});

it.layer(kimiAdapterTestLayer)("KimiAdapterLive", (it) => {
  it.effect("tracks activity through a supervised prompt completion", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-activity-completion");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const turnActivity = yield* makeKimiTurnActivity;
      const adapter = yield* makeTestAdapter(wrapperPath, { turnActivity });
      const events: ProviderRuntimeEvent[] = [];
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "request.opened"
              ? Deferred.succeed(requestOpened, event).pipe(Effect.asVoid)
              : event.type === "turn.completed"
                ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
                : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId);
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "complete with approval", attachments: [] })
        .pipe(Effect.forkChild);
      const opened = yield* Deferred.await(requestOpened).pipe(Effect.timeout("5 seconds"));
      assert.equal(yield* turnActivity.activeCount, 1);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "accept",
      );
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("5 seconds"));

      assert.lengthOf(terminalEvents(events, threadId), 1);
      assert.equal(yield* turnActivity.activeCount, 0);
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* adapter.stopSession(threadId);
      assert.equal(yield* turnActivity.activeCount, 0);
      yield* Fiber.interrupt(eventsFiber);
    }),
  );

  it.effect("auto-approves only full-access yolo prompts", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-yolo-auto-approval");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const turnActivity = yield* makeKimiTurnActivity;
      const adapter = yield* makeTestAdapter(wrapperPath, { turnActivity });
      const events: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId, "full-access");
      yield* adapter.sendTurn({ threadId, input: "auto approve", attachments: [] });
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("5 seconds"));

      assert.lengthOf(
        events.filter((event) => event.type === "request.opened"),
        0,
      );
      assert.lengthOf(terminalEvents(events, threadId), 1);
      assert.equal(yield* turnActivity.activeCount, 0);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("returns activity to idle when prompt preparation fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-preparation-failure-idle");
      const wrapperPath = yield* Effect.promise(() => makeMockKimiWrapper());
      const turnActivity = yield* makeKimiTurnActivity;
      const adapter = yield* makeTestAdapter(wrapperPath, { turnActivity });
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId);
      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "invalid attachment",
          attachments: [
            {
              type: "image",
              id: "missing-image",
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        }),
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(yield* turnActivity.activeCount, 0);
      assert.lengthOf(terminalEvents(events, threadId), 0);
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("interrupts during preparation before starting the prompt RPC", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-interrupt-during-preparation");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-preparation-interrupt-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const baseActivity = yield* makeKimiTurnActivity;
      const markedActive = yield* Deferred.make<void>();
      const turnActivity: KimiTurnActivity = {
        ...baseActivity,
        markActive: (activeThreadId) =>
          baseActivity
            .markActive(activeThreadId)
            .pipe(Effect.andThen(Deferred.succeed(markedActive, undefined)), Effect.asVoid),
      };
      const adapter = yield* makeTestAdapter(wrapperPath, { turnActivity });
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId);
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "interrupt preparation", attachments: [] })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(markedActive).pipe(Effect.timeout("5 seconds"));
      yield* Effect.yieldNow;
      const activeSession = (yield* adapter.listSessions()).find(
        (entry) => entry.threadId === threadId,
      );
      assert.isDefined(activeSession?.activeTurnId);
      yield* adapter
        .interruptTurn(threadId, activeSession?.activeTurnId)
        .pipe(Effect.timeout("5 seconds"));
      yield* Fiber.await(sendTurnFiber).pipe(Effect.timeout("5 seconds"));
      for (let attempt = 0; attempt < 4; attempt += 1) {
        yield* Effect.yieldNow;
      }

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.notInclude(
        requests.map((request) => request.method),
        "session/prompt",
      );
      assert.lengthOf(
        events.filter(
          (event) => event.type === "turn.started" && String(event.threadId) === String(threadId),
        ),
        0,
      );
      assert.lengthOf(terminalEvents(events, threadId), 0);
      assert.equal(yield* turnActivity.activeCount, 0);
      const readySession = (yield* adapter.listSessions()).find(
        (entry) => entry.threadId === threadId,
      );
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("steers an in-flight turn and only the last prompt settles it", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-steer-then-complete");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const baseActivity = yield* makeKimiTurnActivity;
      const activityMarks = yield* Ref.make(0);
      const twoPromptsActive = yield* Deferred.make<void>();
      const turnActivity: KimiTurnActivity = {
        ...baseActivity,
        markActive: (activeThreadId) =>
          baseActivity
            .markActive(activeThreadId)
            .pipe(
              Effect.andThen(
                Ref.updateAndGet(activityMarks, (count) => count + 1).pipe(
                  Effect.flatMap((count) =>
                    count === 2
                      ? Deferred.succeed(twoPromptsActive, undefined).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
              ),
            ),
      };
      const adapter = yield* makeTestAdapter(wrapperPath, { turnActivity });
      const events: ProviderRuntimeEvent[] = [];
      const firstRequest =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const secondRequest =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const requestCount = yield* Ref.make(0);
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "request.opened") {
            const count = yield* Ref.updateAndGet(requestCount, (current) => current + 1);
            yield* Deferred.succeed(count === 1 ? firstRequest : secondRequest, event).pipe(
              Effect.ignore,
            );
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId);
      const firstFiber = yield* adapter
        .sendTurn({ threadId, input: "first prompt", attachments: [] })
        .pipe(Effect.forkChild);
      const firstOpened = yield* Deferred.await(firstRequest).pipe(Effect.timeout("5 seconds"));
      const secondFiber = yield* adapter
        .sendTurn({ threadId, input: "steer prompt", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(twoPromptsActive).pipe(Effect.timeout("5 seconds"));
      assert.equal(yield* turnActivity.activeCount, 1);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(firstOpened.requestId)),
        "accept",
      );
      const firstResult = yield* Fiber.join(firstFiber).pipe(Effect.timeout("5 seconds"));
      assert.isFalse(yield* Deferred.isDone(turnCompleted));
      assert.equal(yield* turnActivity.activeCount, 1);
      const secondOpened = yield* Deferred.await(secondRequest).pipe(Effect.timeout("5 seconds"));

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(secondOpened.requestId)),
        "accept",
      );
      const secondResult = yield* Fiber.join(secondFiber).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("5 seconds"));

      assert.equal(String(firstResult.turnId), String(secondResult.turnId));
      assert.lengthOf(
        events.filter(
          (event) => event.type === "turn.started" && String(event.threadId) === String(threadId),
        ),
        1,
      );
      assert.lengthOf(terminalEvents(events, threadId), 1);
      assert.equal(yield* turnActivity.activeCount, 0);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not run a queued steer after the active turn is interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-queued-steer-after-interrupt");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-queued-steer-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_STEER_PREPARED_MARKER: "1",
        }),
      );
      const baseActivity = yield* makeKimiTurnActivity;
      const activityMarks = yield* Ref.make(0);
      const twoPromptsActive = yield* Deferred.make<void>();
      const turnActivity: KimiTurnActivity = {
        ...baseActivity,
        markActive: (activeThreadId) =>
          baseActivity
            .markActive(activeThreadId)
            .pipe(
              Effect.andThen(
                Ref.updateAndGet(activityMarks, (count) => count + 1).pipe(
                  Effect.flatMap((count) =>
                    count === 2
                      ? Deferred.succeed(twoPromptsActive, undefined).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
              ),
            ),
      };
      const steerPrepared = yield* Deferred.make<void>();
      const adapter = yield* makeTestAdapter(wrapperPath, {
        turnActivity,
        nativeEventLogger: {
          filePath: "memory://kimi-queued-steer-native-events",
          write: (record: unknown) =>
            JSON.stringify(record).includes("steer-prepared")
              ? Deferred.succeed(steerPrepared, undefined).pipe(Effect.asVoid)
              : Effect.void,
          close: () => Effect.void,
        },
      });
      const requestOpened = yield* Deferred.make<void>();
      const turnStarted = yield* Deferred.make<TurnId>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requestOpened, undefined).pipe(Effect.asVoid)
          : event.type === "turn.started" && event.turnId !== undefined
            ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.asVoid)
            : Effect.void,
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId);
      const firstFiber = yield* adapter
        .sendTurn({ threadId, input: "active prompt", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(requestOpened).pipe(Effect.timeout("5 seconds"));
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("5 seconds"));
      const steerFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "queued steer",
          attachments: [],
          modelSelection: {
            instanceId: KIMI_INSTANCE,
            model: "gpt-5.4",
            options: [{ id: "reasoning", value: "high" }],
          },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(twoPromptsActive).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(steerPrepared).pipe(Effect.timeout("5 seconds"));
      for (let attempt = 0; attempt < 16; attempt += 1) {
        yield* Effect.yieldNow;
      }

      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.join(firstFiber).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.await(steerFiber).pipe(Effect.timeout("5 seconds"));

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.lengthOf(
        requests.filter((request) => request.method === "session/prompt"),
        1,
      );
      assert.strictEqual(yield* turnActivity.activeCount, 0);
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);
      assert.strictEqual(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not let an interrupted prompt settlement consume a follow-up slot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-interrupt-follow-up-race");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const turnActivity = yield* makeKimiTurnActivity;
      const adapter = yield* makeTestAdapter(wrapperPath, { turnActivity });
      const events: ProviderRuntimeEvent[] = [];
      const firstRequest =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const secondRequest =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const requestCount = yield* Ref.make(0);
      const firstTerminal = yield* Deferred.make<void>();
      const secondTerminal = yield* Deferred.make<void>();
      const terminalCount = yield* Ref.make(0);
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
          }
          if (event.type === "request.opened") {
            const count = yield* Ref.updateAndGet(requestCount, (current) => current + 1);
            yield* Deferred.succeed(count === 1 ? firstRequest : secondRequest, event).pipe(
              Effect.ignore,
            );
          }
          if (event.type === "turn.completed") {
            const count = yield* Ref.updateAndGet(terminalCount, (current) => current + 1);
            yield* Deferred.succeed(count === 1 ? firstTerminal : secondTerminal, undefined).pipe(
              Effect.ignore,
            );
          }
        }),
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId);
      const firstFiber = yield* adapter
        .sendTurn({ threadId, input: "interrupt this prompt", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstRequest).pipe(Effect.timeout("5 seconds"));
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("5 seconds"));
      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(firstTerminal).pipe(Effect.timeout("5 seconds"));

      const followUpFiber = yield* adapter
        .sendTurn({ threadId, input: "complete follow-up", attachments: [] })
        .pipe(Effect.forkChild);
      const followUpOpened = yield* Deferred.await(secondRequest).pipe(Effect.timeout("5 seconds"));
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(followUpOpened.requestId)),
        "accept",
      );
      const followUp = yield* Fiber.join(followUpFiber).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.join(firstFiber).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(secondTerminal).pipe(Effect.timeout("5 seconds"));

      const completed = terminalEvents(events, threadId);
      assert.notEqual(String(firstTurnId), String(followUp.turnId));
      assert.deepEqual(
        completed.map((event) => [String(event.turnId), event.payload.state]),
        [
          [String(firstTurnId), "cancelled"],
          [String(followUp.turnId), "completed"],
        ],
      );
      assert.equal(yield* turnActivity.activeCount, 0);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("drops late output and duplicate settlement after interrupt", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-late-output-after-interrupt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: "1",
        }),
      );
      const lateNativeUpdate = yield* Deferred.make<void>();
      const turnActivity = yield* makeKimiTurnActivity;
      const adapter = yield* makeTestAdapter(wrapperPath, {
        turnActivity,
        nativeEventLogger: {
          filePath: "memory://kimi-cancelled-native-events",
          write: (record: unknown) =>
            JSON.stringify(record).includes("late after cancel")
              ? Deferred.succeed(lateNativeUpdate, undefined).pipe(Effect.asVoid)
              : Effect.void,
          close: () => Effect.void,
        },
      });
      const events: ProviderRuntimeEvent[] = [];
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const turnStarted = yield* Deferred.make<TurnId>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "request.opened"
              ? Deferred.succeed(requestOpened, event).pipe(Effect.asVoid)
              : event.type === "turn.started" && event.turnId !== undefined
                ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.asVoid)
                : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId);
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel before late output", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(requestOpened).pipe(Effect.timeout("5 seconds"));
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("5 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(lateNativeUpdate).pipe(Effect.timeout("5 seconds"));
      for (let attempt = 0; attempt < 8; attempt += 1) {
        yield* Effect.yieldNow;
      }

      const completed = terminalEvents(events, threadId);
      const cancelledIndex = events.findIndex(
        (event) =>
          event.type === "turn.completed" &&
          String(event.turnId) === String(turnId) &&
          event.payload.state === "cancelled",
      );
      const outputTypes = new Set([
        "content.delta",
        "item.started",
        "item.updated",
        "item.completed",
        "turn.plan.updated",
      ]);
      const outputAfterCancel = events
        .slice(cancelledIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && outputTypes.has(event.type),
        );

      assert.lengthOf(completed, 1);
      assert.equal(completed[0]?.payload.state, "cancelled");
      assert.deepEqual(outputAfterCancel, []);
      assert.equal(yield* turnActivity.activeCount, 0);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("returns activity to idle after prompt failure", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-prompt-failure-idle");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({ T3_ACP_EXIT_ON_PROMPT: "1" }),
      );
      const turnActivity = yield* makeKimiTurnActivity;
      const adapter = yield* makeTestAdapter(wrapperPath, { turnActivity });
      const events: ProviderRuntimeEvent[] = [];
      const failed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" && event.payload.state === "failed"
              ? Deferred.succeed(failed, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId);
      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "fail prompt", attachments: [] }),
      );
      yield* Deferred.await(failed).pipe(Effect.timeout("5 seconds"));

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.lengthOf(terminalEvents(events, threadId), 1);
      assert.equal(terminalEvents(events, threadId)[0]?.payload.state, "failed");
      assert.equal(yield* turnActivity.activeCount, 0);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("returns activity to idle when a running session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-stop-session-idle");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const turnActivity = yield* makeKimiTurnActivity;
      const adapter = yield* makeTestAdapter(wrapperPath, { turnActivity });
      const requestOpened = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requestOpened, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId);
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "stop active session", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(requestOpened).pipe(Effect.timeout("5 seconds"));
      assert.equal(yield* turnActivity.activeCount, 1);

      yield* adapter.stopSession(threadId);
      assert.equal(yield* turnActivity.activeCount, 0);
      assert.isFalse(yield* adapter.hasSession(threadId));

      yield* Fiber.interrupt(sendTurnFiber);
      yield* Fiber.interrupt(eventsFiber);
    }),
  );

  it.effect("applies mode then model then refreshed thinking before prompt", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-pre-prompt-order");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-pre-prompt-order-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* startTestSession(adapter, threadId);
      const initialRequests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      yield* adapter.sendTurn({
        threadId,
        input: "ordered configuration",
        attachments: [],
        interactionMode: "plan",
        modelSelection: {
          instanceId: KIMI_INSTANCE,
          model: "gpt-5.4",
          options: [{ id: "reasoning", value: "high" }],
        },
      });
      const requests = (yield* Effect.promise(() => readJsonLines(requestLogPath))).slice(
        initialRequests.length,
      );
      const operations = requests.flatMap((request) => {
        if (request.method === "session/prompt") {
          return ["prompt"];
        }
        if (request.method !== "session/set_config_option") {
          return [];
        }
        const params = request.params as Record<string, unknown> | undefined;
        return [`${String(params?.configId)}:${String(params?.value)}`];
      });

      assert.deepEqual(operations, ["mode:plan", "model:gpt-5.4", "reasoning:high", "prompt"]);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("executes agent terminal commands through the ACP client terminal", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-terminal-execution");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-terminal-exec-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off - free-form mock agent fixture config.
          T3_ACP_TERMINAL_COMMAND: JSON.stringify({
            command: mockAgentCommand,
            args: [
              "-e",
              "process.stdout.write('terminal says ' + process.env.T3_MOCK_TERMINAL_ENV);process.exit(5)",
            ],
          }),
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* startTestSession(adapter, threadId);
      yield* adapter.sendTurn({ threadId, input: "run the build", attachments: [] });
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));

      // The chat session's initialize (the one followed by session/new) must
      // advertise the terminal capability. Probes may log their own
      // initialize with terminal: false; those must not flip either way.
      const sessionNewIndex = requests.findIndex((request) => request.method === "session/new");
      assert.isAtLeast(sessionNewIndex, 0);
      const sessionInitialize = requests
        .slice(0, sessionNewIndex)
        .toReversed()
        .find((request) => request.method === "initialize");
      const initializeParams = sessionInitialize?.params as
        | { clientCapabilities?: { terminal?: boolean } }
        | undefined;
      assert.strictEqual(initializeParams?.clientCapabilities?.terminal, true);

      assert.isUndefined(requests.find((request) => request.method === "mock/terminal_error"));
      const result = requests.find((request) => request.method === "mock/terminal_result");
      const params = result?.params as {
        created: { terminalId: string };
        waitResult: Record<string, unknown>;
        outputResult: { output: string; truncated: boolean; exitStatus?: { exitCode?: number } };
      };
      assert.isString(params.created.terminalId);
      // The wait_for_exit response must carry exitCode at the TOP level and
      // never a nested exitStatus (Kimi reads the nested shape as exit -1).
      assert.strictEqual(params.waitResult.exitCode, 5);
      assert.notProperty(params.waitResult, "exitStatus");
      assert.include(params.outputResult.output, "terminal says from-mock-agent");
      assert.isFalse(params.outputResult.truncated);
      assert.strictEqual(params.outputResult.exitStatus?.exitCode, 5);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("interrupt kills the terminals blocking the agent in wait_for_exit", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-interrupt-terminal-wait");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-terminal-interrupt-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off - free-form mock agent fixture config.
          T3_ACP_TERMINAL_COMMAND: JSON.stringify({
            command: mockAgentCommand,
            // No arrow `=>` here: the Windows wrapper passes this JSON through
            // cmd's `set`, where `>` would be parsed as a redirection.
            args: ["-e", "setInterval(function () {}, 1000)"],
            cancelAfterWait: true,
          }),
        }),
      );
      const terminalFinished = yield* Deferred.make<void>();
      const adapter = yield* makeTestAdapter(wrapperPath, {
        // The adapter drops post-cancel session updates from the event stream,
        // but the native event log still observes them: the mock agent's
        // "terminal-finished" update is the deterministic signal that it
        // logged its terminal results after the kill.
        nativeEventLogger: {
          filePath: "memory://kimi-terminal-interrupt-native-events",
          write: (record: unknown) =>
            JSON.stringify(record).includes("terminal-finished")
              ? Deferred.succeed(terminalFinished, undefined).pipe(Effect.asVoid)
              : Effect.void,
          close: () => Effect.void,
        },
      });
      const events: ProviderRuntimeEvent[] = [];
      const terminalCreated = yield* Deferred.make<void>();
      const turnStarted = yield* Deferred.make<TurnId>();
      const firstTurnCompleted = yield* Deferred.make<void>();
      const secondTurnCompleted = yield* Deferred.make<void>();
      const completedCount = yield* Ref.make(0);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "content.delta" && String(event.threadId) === String(threadId)) {
            yield* Deferred.succeed(terminalCreated, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(turnStarted, event.turnId).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            const count = yield* Ref.updateAndGet(completedCount, (current) => current + 1);
            yield* Deferred.succeed(
              count === 1 ? firstTurnCompleted : secondTurnCompleted,
              undefined,
            ).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId);
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "serve forever", attachments: [] })
        .pipe(Effect.forkChild);
      // The mock agent notifies after terminal/create, right before parking in
      // terminal/wait_for_exit on the never-exiting command.
      yield* Deferred.await(terminalCreated).pipe(Effect.timeout("5 seconds"));
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("5 seconds"));

      // Without killing the session's terminals this deadlocks: the agent
      // waits on wait_for_exit and cannot process session/cancel.
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(firstTurnCompleted).pipe(Effect.timeout("5 seconds"));

      assert.deepEqual(
        terminalEvents(events, threadId).map((event) => [
          String(event.turnId),
          event.payload.state,
        ]),
        [[String(turnId), "cancelled"]],
      );

      // The session survives the interrupt: a follow-up turn on the same
      // session prompts the agent and completes normally.
      yield* adapter.sendTurn({ threadId, input: "follow up", attachments: [] });
      yield* Deferred.await(secondTurnCompleted).pipe(Effect.timeout("5 seconds"));
      assert.deepEqual(
        terminalEvents(events, threadId).map((event) => event.payload.state),
        ["cancelled", "completed"],
      );

      // The killed terminal stayed readable through output and release: the
      // mock agent signals "terminal-finished" only after logging its
      // terminal results, and the interrupted wait_for_exit reported the
      // SIGTERM kill.
      yield* Deferred.await(terminalFinished).pipe(Effect.timeout("5 seconds"));
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isUndefined(requests.find((request) => request.method === "mock/terminal_error"));
      const result = requests.find((request) => request.method === "mock/terminal_result");
      const params = result?.params as {
        waitResult: Record<string, unknown>;
        outputResult: { exitStatus?: { signal?: string } };
      };
      assert.strictEqual(params.waitResult.signal, "SIGTERM");
      assert.notProperty(params.waitResult, "exitStatus");
      assert.strictEqual(params.outputResult.exitStatus?.signal, "SIGTERM");

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "gates the plan decision on the native approval card and re-syncs the mode on the next build turn",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("kimi-plan-flow-native-gate");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-plan-flow-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockKimiWrapper({
            T3_ACP_PLAN_FLOW: "1",
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);
        const events: ProviderRuntimeEvent[] = [];
        const cardDeferreds = [
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>(),
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>(),
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>(),
        ];
        const turnDeferreds = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ];
        const openedCount = yield* Ref.make(0);
        const completedCount = yield* Ref.make(0);
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "request.opened") {
              const count = yield* Ref.updateAndGet(openedCount, (current) => current + 1);
              const deferred = cardDeferreds[count - 1];
              if (deferred) {
                yield* Deferred.succeed(deferred, event).pipe(Effect.ignore);
              }
            }
            if (event.type === "turn.completed") {
              const count = yield* Ref.updateAndGet(completedCount, (current) => current + 1);
              const deferred = turnDeferreds[count - 1];
              if (deferred) {
                yield* Deferred.succeed(deferred, undefined).pipe(Effect.ignore);
              }
            }
          }),
        ).pipe(Effect.forkChild);

        const modeSelectionsFromLog = async () =>
          (await readJsonLines(requestLogPath)).flatMap((request) => {
            if (request.method !== "session/set_config_option") {
              return [];
            }
            const params = request.params as Record<string, unknown> | undefined;
            return params?.configId === "mode" ? [String(params.value)] : [];
          });

        yield* startTestSession(adapter, threadId);
        const firstFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "plan the work",
            attachments: [],
            interactionMode: "plan",
          })
          .pipe(Effect.forkChild);

        // The plan decision is a user decision: it parks on a normal approval
        // card whose detail is the plan markdown, and never rides T3's
        // proposed-plan flow.
        const planCard = yield* Deferred.await(cardDeferreds[0]!).pipe(Effect.timeout("5 seconds"));
        assert.equal(
          planCard.payload.detail,
          "# Plan: Mock landing page\n\n## Steps\n- write the plan\n- ship it",
        );
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(String(planCard.requestId)),
          "accept",
        );
        yield* Fiber.join(firstFiber).pipe(Effect.timeout("5 seconds"));
        yield* Deferred.await(turnDeferreds[0]!).pipe(Effect.timeout("5 seconds"));

        // Approving answers the native plan_approve option, so kimi-cli leaves
        // plan mode itself and the turn completes instead of cancelling. The
        // mock mirrors the real CLI's retry-on-dismissal, so a cancelled
        // answer would show up here as repeated ExitPlanMode requests.
        const planPhaseRequests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        assert.lengthOf(
          planPhaseRequests.filter(
            (request) =>
              request.method === "mock/permission_request" &&
              (request.params as { title?: string } | undefined)?.title === "ExitPlanMode",
          ),
          1,
        );
        const planResponse = planPhaseRequests.find(
          (request) => request.method === "mock/permission_response",
        );
        const planResponseParams = planResponse?.params as
          | { result?: { outcome?: { outcome?: string; optionId?: string } } }
          | undefined;
        assert.deepEqual(planResponseParams?.result?.outcome, {
          outcome: "selected",
          optionId: "plan_approve",
        });
        assert.lengthOf(
          events.filter((event) => event.type === "turn.proposed.completed"),
          0,
        );
        assert.deepEqual(
          terminalEvents(events, threadId).map((event) => event.payload.state),
          ["completed"],
        );

        // The CLI left plan mode natively and silently while the composer
        // still says Plan. Re-pushing plan is swallowed by the shared ACP
        // runtime's own tracked mode, so this follow-up runs in the post-exit
        // mode without any mode RPC (documented limitation; the next build
        // turn re-syncs).
        const secondFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "plan the follow-up",
            attachments: [],
            interactionMode: "plan",
          })
          .pipe(Effect.forkChild);
        const toolCard = yield* Deferred.await(cardDeferreds[1]!).pipe(Effect.timeout("5 seconds"));
        assert.include(toolCard.payload.detail, "echo mock-approved-command");
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(String(toolCard.requestId)),
          "accept",
        );
        yield* Fiber.join(secondFiber).pipe(Effect.timeout("5 seconds"));
        yield* Deferred.await(turnDeferreds[1]!).pipe(Effect.timeout("5 seconds"));
        assert.deepEqual(yield* Effect.promise(modeSelectionsFromLog), ["plan"]);

        // A build turn pushes the runtime-derived mode again, which re-syncs
        // the tracked mode with the CLI's actual post-exit state.
        const thirdFiber = yield* adapter
          .sendTurn({ threadId, input: "keep building", attachments: [] })
          .pipe(Effect.forkChild);
        const buildCard = yield* Deferred.await(cardDeferreds[2]!).pipe(
          Effect.timeout("5 seconds"),
        );
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(String(buildCard.requestId)),
          "accept",
        );
        yield* Fiber.join(thirdFiber).pipe(Effect.timeout("5 seconds"));
        yield* Deferred.await(turnDeferreds[2]!).pipe(Effect.timeout("5 seconds"));

        assert.deepEqual(yield* Effect.promise(modeSelectionsFromLog), ["plan", "default"]);
        assert.lengthOf(
          events.filter((event) => event.type === "turn.proposed.completed"),
          0,
        );
        assert.deepEqual(
          terminalEvents(events, threadId).map((event) => event.payload.state),
          ["completed", "completed", "completed"],
        );

        yield* Fiber.interrupt(eventsFiber);
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("full-access still pauses for the plan decision, then auto-approves tool gates", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-full-access-plan-carve-out");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-plan-carve-out-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
          T3_ACP_PLAN_FLOW: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const events: ProviderRuntimeEvent[] = [];
      const planCardOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const firstTurnCompleted = yield* Deferred.make<void>();
      const secondTurnCompleted = yield* Deferred.make<void>();
      const completedCount = yield* Ref.make(0);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "request.opened") {
            yield* Deferred.succeed(planCardOpened, event).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            const count = yield* Ref.updateAndGet(completedCount, (current) => current + 1);
            yield* Deferred.succeed(
              count === 1 ? firstTurnCompleted : secondTurnCompleted,
              undefined,
            ).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId, "full-access");
      const firstFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "plan the work",
          attachments: [],
          interactionMode: "plan",
        })
        .pipe(Effect.forkChild);

      // Even under full access the plan decision is a user decision: it parks
      // on an approval card and is never auto-approved.
      const planCard = yield* Deferred.await(planCardOpened).pipe(Effect.timeout("5 seconds"));
      assert.include(planCard.payload.detail, "# Plan: Mock landing page");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(planCard.requestId)),
        "accept",
      );
      yield* Fiber.join(firstFiber).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(firstTurnCompleted).pipe(Effect.timeout("5 seconds"));

      // The follow-up turn auto-approves the tool gate without any card.
      yield* adapter.sendTurn({ threadId, input: "implement it", attachments: [] });
      yield* Deferred.await(secondTurnCompleted).pipe(Effect.timeout("5 seconds"));

      assert.lengthOf(
        events.filter((event) => event.type === "request.opened"),
        1,
      );
      assert.lengthOf(
        events.filter((event) => event.type === "turn.proposed.completed"),
        0,
      );
      assert.deepEqual(
        terminalEvents(events, threadId).map((event) => event.payload.state),
        ["completed", "completed"],
      );
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const permissionResponses = requests
        .filter((request) => request.method === "mock/permission_response")
        .map(
          (request) =>
            (request.params as { result?: { outcome?: { outcome?: string; optionId?: string } } })
              .result?.outcome,
        );
      assert.deepEqual(permissionResponses, [
        { outcome: "selected", optionId: "plan_approve" },
        { outcome: "selected", optionId: "approve_always" },
      ]);
      // Session start binds yolo, the plan turn switches to plan, and the
      // follow-up turn re-pushes the runtime mode because the CLI left plan
      // natively on approval.
      const modeSelections = requests.flatMap((request) => {
        if (request.method !== "session/set_config_option") {
          return [];
        }
        const params = request.params as Record<string, unknown> | undefined;
        return params?.configId === "mode" ? [String(params.value)] : [];
      });
      assert.deepEqual(modeSelections, ["yolo", "plan", "yolo"]);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("re-opens the plan card on revise, then completes on approval", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-plan-flow-revise");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-plan-revise-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
          T3_ACP_PLAN_FLOW: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const firstCardOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const secondCardOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const openedCount = yield* Ref.make(0);
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (event.type === "request.opened") {
            const count = yield* Ref.updateAndGet(openedCount, (current) => current + 1);
            yield* Deferred.succeed(count === 1 ? firstCardOpened : secondCardOpened, event).pipe(
              Effect.ignore,
            );
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId);
      const turnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "plan the work",
          attachments: [],
          interactionMode: "plan",
        })
        .pipe(Effect.forkChild);

      // Declining picks the revise option, so the CLI stays in plan mode and
      // presents the plan again as a fresh card.
      const firstCard = yield* Deferred.await(firstCardOpened).pipe(Effect.timeout("5 seconds"));
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(firstCard.requestId)),
        "decline",
      );
      const secondCard = yield* Deferred.await(secondCardOpened).pipe(Effect.timeout("5 seconds"));
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(secondCard.requestId)),
        "accept",
      );
      yield* Fiber.join(turnFiber).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("5 seconds"));

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.lengthOf(
        requests.filter(
          (request) =>
            request.method === "mock/permission_request" &&
            (request.params as { title?: string } | undefined)?.title === "ExitPlanMode",
        ),
        2,
      );
      const permissionResponses = requests
        .filter((request) => request.method === "mock/permission_response")
        .map(
          (request) =>
            (request.params as { result?: { outcome?: { outcome?: string; optionId?: string } } })
              .result?.outcome,
        );
      assert.deepEqual(permissionResponses, [
        { outcome: "selected", optionId: "plan_revise" },
        { outcome: "selected", optionId: "plan_approve" },
      ]);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("auto-approves tool gates under full-access while the native mode is plan", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-full-access-plan-tool-gate");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const events: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId, "full-access");
      // Plan interaction keeps the native mode on plan; a tool-gate request
      // arriving in that state must still be auto-approved for full access.
      yield* adapter.sendTurn({
        threadId,
        input: "run a command",
        attachments: [],
        interactionMode: "plan",
      });
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("5 seconds"));

      assert.lengthOf(
        events.filter((event) => event.type === "request.opened"),
        0,
      );
      assert.deepEqual(
        terminalEvents(events, threadId).map((event) => event.payload.state),
        ["completed"],
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancels permission requests that arrive after the turn was interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-permission-after-cancel");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-permission-after-cancel-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
          T3_ACP_PERMISSION_AFTER_CANCEL: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const latePermissionRequest = yield* Deferred.make<void>();
      const latePermissionResolved = yield* Deferred.make<void>();
      const adapter = yield* makeTestAdapter(wrapperPath, {
        // Post-cancel session updates never reach the runtime event stream by
        // design; the native log still observes the late request itself and
        // the mock's post-response marker.
        nativeEventLogger: {
          filePath: "memory://kimi-permission-after-cancel-native-events",
          write: (record: unknown) => {
            const serialized = JSON.stringify(record);
            return serialized.includes("session/request_permission")
              ? Deferred.succeed(latePermissionRequest, undefined).pipe(Effect.asVoid)
              : serialized.includes("permission-resolved")
                ? Deferred.succeed(latePermissionResolved, undefined).pipe(Effect.asVoid)
                : Effect.void;
          },
          close: () => Effect.void,
        },
      });
      const events: ProviderRuntimeEvent[] = [];
      const promptParked = yield* Deferred.make<void>();
      const turnStarted = yield* Deferred.make<TurnId>();
      const firstTurnCompleted = yield* Deferred.make<void>();
      const secondTurnCompleted = yield* Deferred.make<void>();
      const completedCount = yield* Ref.make(0);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "content.delta" && String(event.threadId) === String(threadId)) {
            yield* Deferred.succeed(promptParked, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(turnStarted, event.turnId).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            const count = yield* Ref.updateAndGet(completedCount, (current) => current + 1);
            yield* Deferred.succeed(
              count === 1 ? firstTurnCompleted : secondTurnCompleted,
              undefined,
            ).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId);
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hold until stopped", attachments: [] })
        .pipe(Effect.forkChild);
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("5 seconds"));
      // The mock notifies once it parked the prompt, so the interrupt lands
      // while the prompt is genuinely in flight.
      yield* Deferred.await(promptParked).pipe(Effect.timeout("5 seconds"));

      // The mock answers session/cancel by firing a late permission request
      // before completing the prompt. The interrupted-turn gate must cancel
      // it without ever emitting request.opened.
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(latePermissionRequest).pipe(Effect.timeout("5 seconds"));
      // The mock only completes the prompt after the permission response
      // arrives, so the joined fiber proves the gate answered cancelled.
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(firstTurnCompleted).pipe(Effect.timeout("5 seconds"));

      assert.lengthOf(
        events.filter((event) => event.type === "request.opened"),
        0,
      );
      assert.deepEqual(
        terminalEvents(events, threadId).map((event) => [
          String(event.turnId),
          event.payload.state,
        ]),
        [[String(turnId), "cancelled"]],
      );
      // Wait for the mock's post-response marker: the RPC layer unwinds the
      // prompt client-side on cancel, so prompt settlement does not prove the
      // mock saw the gate's cancelled answer.
      yield* Deferred.await(latePermissionResolved).pipe(Effect.timeout("5 seconds"));
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const lateResponse = requests.find(
        (request) => request.method === "mock/permission_response",
      );
      const lateResponseParams = lateResponse?.params as
        | { result?: { outcome?: { outcome?: string } } }
        | undefined;
      assert.equal(lateResponseParams?.result?.outcome?.outcome, "cancelled");

      // The session survives: a follow-up turn prompts and completes normally.
      yield* adapter
        .sendTurn({ threadId, input: "follow up", attachments: [] })
        .pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(secondTurnCompleted).pipe(Effect.timeout("5 seconds"));
      assert.deepEqual(
        terminalEvents(events, threadId).map((event) => event.payload.state),
        ["cancelled", "completed"],
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});
