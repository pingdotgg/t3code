#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeTimersPromises from "node:timers/promises";

const scenarioNames = new Set(
  `default rpc-roundtrip permission permission-empty-options permission-unknown-options permission-accept-only park-hitl permission-flood permission-flood-retirement permission-flood-turn-boundary ask-user hang-turn hang-first-turn late-terminal interrupt-late-terminal-order usage-reset
  exit-hitl interrupt-race fail-init fail-update-settings hang-update-settings fail-add-user-message fail-interrupt load-spec-mode-report steering-coalesced steering-separate exit-mid-turn unknown-notification omit-usage start-race spec-autonomy-handoff
  spec-handoff spec-successor-permission late-spec-approval foreign-spec-envelope future-terminal-reason compaction child-session hanging-child-session
  child-session-exit taskless-progress report-selected-model incomplete-items shared-tool-isolation`.split(
    /\s+/,
  ),
);
const currentScenario = process.env.T3_DROID_MOCK_SCENARIO ?? "default";
if (!scenarioNames.has(currentScenario)) {
  throw new Error(`Unknown T3_DROID_MOCK_SCENARIO: ${currentScenario}`);
}

const env = {
  permissionResponseFile: process.env.T3_DROID_MOCK_PERMISSION_RESPONSE_FILE,
  permissionFloodReadyFile: process.env.T3_DROID_MOCK_PERMISSION_FLOOD_READY_FILE,
  permissionFloodProbeIndex: process.env.T3_DROID_MOCK_PERMISSION_FLOOD_PROBE_INDEX,
  startRaceDir: process.env.T3_DROID_MOCK_START_RACE_DIR,
  interruptOrderDir: process.env.T3_DROID_MOCK_INTERRUPT_ORDER_DIR,
  settingsLogPath: process.env.T3_DROID_MOCK_SETTINGS_LOG,
  requestLogPath: process.env.T3_DROID_MOCK_REQUEST_LOG,
  coordinationDir: process.env.T3_DROID_MOCK_COORDINATION_DIR,
};
const permissionModes: Record<string, "default" | "empty" | "unknown" | "accept-only"> = {
  "rpc-roundtrip": "default",
  permission: "default",
  "permission-empty-options": "empty",
  "permission-unknown-options": "unknown",
  "permission-accept-only": "accept-only",
  "park-hitl": "default",
};
const permissionFloodCount =
  currentScenario === "permission-flood" ||
  currentScenario === "permission-flood-retirement" ||
  currentScenario === "permission-flood-turn-boundary"
    ? Number(process.env.T3_DROID_MOCK_PERMISSION_FLOOD_COUNT ?? "24")
    : 0;

const sessions = {
  initialized: "mock-session-1",
  known: "mock-session-known",
  rewound: "mock-session-rewound",
  successor: "mock-session-spec-successor",
  child: "mock-session-child",
};
const protocol = {
  jsonrpc: "2.0",
  factoryApiVersion: "1.0.0",
  factoryProtocolVersion: "1.187.0",
};
const models = [
  {
    id: "mock-fast",
    displayName: "Mock Fast",
    shortDisplayName: "Fast",
    modelProvider: "factory",
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    isCustom: false,
  },
  {
    id: "mock-deep",
    displayName: "Mock Deep",
    shortDisplayName: "Deep",
    modelProvider: "factory",
    supportedReasoningEfforts: ["medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
    isCustom: false,
  },
];
const tokenUsage = {
  inputTokens: 20,
  outputTokens: 8,
  cacheCreationTokens: 1,
  cacheReadTokens: 4,
  thinkingTokens: 3,
};
const autonomyLevels = ["off", "low", "medium", "high"];
const decisionOptions = [
  { label: "Allow once", value: "proceed_once" },
  { label: "Deny", value: "cancel" },
];
const specTool = (id: string) => ({
  toolUse: {
    type: "tool_use",
    id,
    input: { plan: "Implement the approved plan." },
    name: "ExitSpecMode",
  },
  details: {
    type: "exit_spec_mode",
    plan: "Implement the approved plan.",
    title: "Approved plan",
  },
});
const execTool = (id: string, command: string, risk = false) => ({
  toolUse: { type: "tool_use", id, input: { command }, name: "Execute" },
  ...(risk ? { confirmationType: "exec" } : {}),
  details: {
    type: "exec",
    fullCommand: command,
    command: "echo",
    ...(risk ? { impactLevel: "low", riskLevelReason: "The mock command only prints text." } : {}),
  },
});
const permissionParams = (
  tool: ReturnType<typeof specTool> | ReturnType<typeof execTool>,
  options: ReadonlyArray<{ readonly label: string; readonly value: string }>,
) => ({ toolUses: [tool], options });

let currentSessionId = sessions.initialized;
let previousSessionId: string | undefined;
let emitPostLoadStraggler = false;
let serverRequestId = 0;
let turnSequence = 0;
let firstTurnId: string | undefined;
let currentSettings = {
  modelId: "mock-fast",
  reasoningEffort: "medium",
  specModeModelId: "mock-spec-default",
  specModeReasoningEffort: "max",
  interactionMode: "auto",
  autonomyLevel: "off",
};
let activeTurn: { readonly turnId: string; completed: boolean } | undefined;
let interruptRequestBlocked = false;
let interruptSequence = 0;
let sharedToolRole: "delayed" | "execute" | undefined;
const pendingServerRequests = new Map<
  string,
  { readonly resolve: (result: unknown) => void; readonly reject: (error: Error) => void }
>();
let holdNativeServerResponses = false;
const heldNativeServerResponses: Array<Record<string, unknown>> = [];

if (currentScenario === "shared-tool-isolation") {
  if (!env.coordinationDir) {
    throw new Error("shared-tool-isolation requires T3_DROID_MOCK_COORDINATION_DIR");
  }
  try {
    NodeFS.writeFileSync(NodePath.join(env.coordinationDir, "shared-tool-first"), "", {
      flag: "wx",
    });
    sharedToolRole = "delayed";
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    sharedToolRole = "execute";
  }
}
if (env.startRaceDir) {
  NodeFS.writeFileSync(NodePath.join(env.startRaceDir, `pid-${process.pid}`), String(process.pid));
  process.once("exit", () => {
    NodeFS.writeFileSync(NodePath.join(env.startRaceDir!, `exit-${process.pid}`), "");
  });
}

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ...protocol, ...message })}\n`);
}
function respond(id: string, result: unknown): void {
  write({ type: "response", id, result });
}
function fail(id: string, code: number, message: string): void {
  write({ type: "response", id, error: { code, message } });
}
function notifyForSession(sessionId: string, notification: Record<string, unknown>): void {
  write({
    type: "notification",
    method: "droid.session_notification",
    params: { sessionId, notification },
  });
}
function notify(notification: Record<string, unknown>): void {
  notifyForSession(currentSessionId, notification);
}
function item(
  type: string,
  messageId: string,
  blockIndex: number,
  fields: Record<string, unknown> = {},
  sessionId?: string,
): void {
  const notification = { type, messageId, blockIndex, ...fields };
  if (sessionId) notifyForSession(sessionId, notification);
  else notify(notification);
}
function textDelta(messageId: string, textDelta: string, blockIndex = 1, sessionId?: string): void {
  item("assistant_text_delta", messageId, blockIndex, { textDelta }, sessionId);
}
function textComplete(messageId: string, blockIndex = 1, sessionId?: string): void {
  item("assistant_text_complete", messageId, blockIndex, {}, sessionId);
}
function toolCall(id: string, name: string, input: Record<string, unknown>): void {
  notify({ type: "tool_call", toolUse: { type: "tool_use", id, input, name } });
}
function toolResult(messageId: string, toolUseId: string, text: string): void {
  notify({
    type: "tool_result",
    messageId,
    toolUseId,
    content: [{ type: "text", text }],
  });
}
function usageChanged(lastCallTokenUsage: Record<string, number>): void {
  notify({
    type: "session_token_usage_changed",
    sessionId: currentSessionId,
    tokenUsage,
    inclusiveTokenUsage: tokenUsage,
    lastCallTokenUsage,
  });
}
function requestClient(method: string, params: unknown): Promise<unknown> {
  const id = `server-${++serverRequestId}`;
  write({ type: "request", id, method, params });
  return new Promise((resolve, reject) => pendingServerRequests.set(id, { resolve, reject }));
}
function initializeResult() {
  return {
    sessionId: currentSessionId,
    session: { messages: [] },
    availableModels: models,
    settings: { ...currentSettings, availableAutonomyLevels: autonomyLevels },
  };
}
function emitTerminalForSession(
  sessionId: string,
  reason: string,
  turnId: string,
  usage = tokenUsage,
): void {
  notifyForSession(sessionId, {
    type: "agent_turn_completed",
    reason,
    turnId,
    tokenUsage: usage,
    cumulativeTokenUsage: usage,
    durationMs: 10,
  });
}
function emitTurnCompleted(
  reason: string,
  turnId: string,
  options?: { readonly emitUsage?: boolean; readonly terminalUsage?: typeof tokenUsage },
): void {
  if (!activeTurn || activeTurn.turnId !== turnId || activeTurn.completed) return;
  activeTurn.completed = true;
  if (options?.emitUsage !== false && currentScenario !== "omit-usage") {
    usageChanged({ inputTokens: 7, cacheReadTokens: 2, outputTokens: 3 });
  }
  emitTerminalForSession(currentSessionId, reason, turnId, options?.terminalUsage);
  notify({ type: "droid_working_state_changed", newState: "idle" });
  activeTurn = undefined;
}
async function writeJsonReceipt(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await NodeFSP.writeFile(tempPath, JSON.stringify(value), "utf8");
  await NodeFSP.rename(tempPath, filePath);
}
async function waitForFile(filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const watcher = NodeFS.watch(NodePath.dirname(filePath), (_eventType, filename) => {
      if (String(filename) === NodePath.basename(filePath))
        void NodeFSP.access(filePath).then(finish, () => {});
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      watcher.close();
      resolve();
    };
    watcher.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    void NodeFSP.access(filePath).then(finish, () => {});
  });
}
function applyExitSpecModeOutcome(selectedOption: unknown): void {
  const selected = typeof selectedOption === "string" ? selectedOption : "";
  const autonomyLevel =
    /^(?:proceed_auto_run|proceed_new_session)_(high|medium|low)$/.exec(selected)?.[1] ?? "off";
  currentSettings = { ...currentSettings, autonomyLevel, interactionMode: "auto" };
  if (env.settingsLogPath) {
    NodeFS.appendFileSync(
      env.settingsLogPath,
      `${JSON.stringify({ exitSpecModeSelectedOption: selected, resultingAutonomyLevel: autonomyLevel })}\n`,
    );
  }
}
function permissionOptions() {
  switch (permissionModes[currentScenario]) {
    case "empty":
      return [];
    case "unknown":
      return [{ label: "Unexpected", value: "unexpected" }];
    case "accept-only":
      return decisionOptions.slice(0, 1);
    default:
      return decisionOptions;
  }
}
async function requestDecision(params: unknown): Promise<{ selectedOption?: unknown }> {
  return (await requestClient("droid.request_permission", params)) as {
    selectedOption?: unknown;
  };
}

async function runLateTerminal(turnId: string): Promise<boolean> {
  if (currentScenario !== "late-terminal") return false;
  if (turnSequence === 1) {
    firstTurnId = turnId;
    return true;
  }
  textDelta(`replacement-${turnId}`, "replacement output", 0);
  usageChanged({ inputTokens: 3, cacheReadTokens: 1, outputTokens: 2 });
  if (firstTurnId) {
    emitTerminalForSession(currentSessionId, "completed", firstTurnId, {
      inputTokens: 900,
      outputTokens: 90,
      cacheCreationTokens: 0,
      cacheReadTokens: 9,
      thinkingTokens: 0,
    });
  }
  textComplete(`replacement-${turnId}`, 0);
  emitTurnCompleted("completed", turnId, { emitUsage: false });
  return true;
}
async function runSpecScenario(turnId: string): Promise<boolean> {
  const tool = specTool(`exit-spec-tool-${turnId}`);
  if (currentScenario === "spec-autonomy-handoff") {
    tool.toolUse.id = `exit-spec-autonomy-tool-${turnId}`;
    const result = await requestDecision(
      permissionParams(tool, [
        { label: "Proceed with implementation", value: "proceed_once" },
        { label: "Proceed, and allow file edits (Low)", value: "proceed_auto_run_low" },
        {
          label: "Proceed, and allow reversible commands (Medium)",
          value: "proceed_auto_run_medium",
        },
        { label: "Proceed, and allow all commands (High)", value: "proceed_auto_run_high" },
        { label: "Proceed in a new session (no autonomy)", value: "proceed_new_session" },
        { label: "Proceed in a new session (High autonomy)", value: "proceed_new_session_high" },
        { label: "No, keep iterating on spec", value: "cancel" },
      ]),
    );
    if (result.selectedOption === "cancel") emitTurnCompleted("permission_rejected", turnId);
    else {
      applyExitSpecModeOutcome(result.selectedOption);
      textDelta(`assistant-inline-impl-${turnId}`, "in-session implementation", 0);
      textComplete(`assistant-inline-impl-${turnId}`, 0);
      emitTurnCompleted("completed", turnId);
    }
    return true;
  }
  if (currentScenario === "spec-handoff") {
    const result = await requestDecision(
      permissionParams(tool, [
        { label: "Implement", value: "proceed_new_session_high" },
        { label: "Cancel", value: "cancel" },
      ]),
    );
    if (result.selectedOption === "cancel") emitTurnCompleted("permission_rejected", turnId);
    else {
      applyExitSpecModeOutcome(result.selectedOption);
      textDelta(`assistant-successor-${turnId}`, "implementation successor", 0, sessions.successor);
      textComplete(`assistant-successor-${turnId}`, 0, sessions.successor);
      emitTerminalForSession(sessions.successor, "completed", `successor-${turnId}`);
      emitTurnCompleted("spec_handoff", turnId);
    }
    return true;
  }
  if (currentScenario === "spec-successor-permission") {
    const handoff = await requestDecision(
      permissionParams(tool, [
        { label: "Implement", value: "proceed_new_session_high" },
        { label: "Cancel", value: "cancel" },
      ]),
    );
    if (handoff.selectedOption === "cancel") {
      emitTurnCompleted("permission_rejected", turnId);
      return true;
    }
    applyExitSpecModeOutcome(handoff.selectedOption);
    const successorPermission = await requestDecision({
      ...permissionParams(
        execTool(`successor-permission-tool-${turnId}`, "echo successor", true),
        decisionOptions,
      ),
      sessionId: sessions.successor,
    });
    if (successorPermission.selectedOption === "cancel") {
      emitTurnCompleted("permission_rejected", turnId);
      return true;
    }
    textDelta(
      `assistant-successor-permission-${turnId}`,
      "approved successor",
      0,
      sessions.successor,
    );
    textComplete(`assistant-successor-permission-${turnId}`, 0, sessions.successor);
    emitTerminalForSession(sessions.successor, "completed", `successor-${turnId}`);
    emitTurnCompleted("spec_handoff", turnId);
    return true;
  }
  if (currentScenario === "late-spec-approval" && turnSequence === 1) {
    tool.toolUse.id = `late-exit-spec-tool-${turnId}`;
    void requestDecision(
      permissionParams(tool, [
        { label: "Implement", value: "proceed_once" },
        { label: "Cancel", value: "cancel" },
      ]),
    ).then((result) => {
      if (result.selectedOption === "cancel") return;
      textDelta(
        `assistant-late-successor-${turnId}`,
        "late implementation successor",
        0,
        sessions.successor,
      );
      emitTerminalForSession(sessions.successor, "completed", `late-successor-${turnId}`);
    });
    const settleFile = process.env.T3_DROID_MOCK_LATE_SPEC_SETTLE_FILE;
    if (settleFile) await waitForFile(settleFile);
    emitTurnCompleted("completed", turnId);
    return true;
  }
  return false;
}
function emitForeignSpecTraffic(turnId: string): void {
  if (
    currentScenario !== "foreign-spec-envelope" &&
    !(currentScenario === "late-spec-approval" && turnSequence > 1)
  ) {
    return;
  }
  textDelta(
    `assistant-foreign-${turnId}`,
    "unapproved implementation successor",
    0,
    sessions.successor,
  );
  emitTerminalForSession(sessions.successor, "completed", `foreign-${turnId}`);
}
async function runChildScenario(turnId: string): Promise<boolean> {
  if (currentScenario === "child-session") {
    notify({
      type: "child_session_available",
      childSessionId: sessions.child,
      toolUseId: `child-task-${turnId}`,
      description: "Mock delegated task",
      timestamp: 1,
    });
    notify({
      type: "tool_progress_update",
      toolUseId: `child-task-${turnId}`,
      toolName: "Task",
      update: {
        type: "message",
        text: "Inspecting delegated files",
        subagentSessionId: sessions.child,
      },
    });
    textDelta(`assistant-child-${turnId}`, "child-only output", 0, sessions.child);
    notify({ type: "tool_result", toolUseId: `child-task-${turnId}`, isError: false });
    return false;
  }
  if (currentScenario !== "hanging-child-session" && currentScenario !== "child-session-exit") {
    return false;
  }
  notify({
    type: "child_session_available",
    childSessionId: sessions.child,
    description: "Mock delegated task",
    timestamp: 1,
  });
  if (currentScenario === "child-session-exit") {
    await new Promise<void>((resolve, reject) =>
      process.stdout.write("", (error) => (error ? reject(error) : resolve())),
    );
    process.exit(7);
  }
  return true;
}
async function runPermissionFlow(turnId: string): Promise<boolean> {
  if (permissionModes[currentScenario]) {
    let result: { selectedOption?: unknown };
    try {
      result = await requestDecision(
        permissionParams(
          execTool(`permission-tool-${turnId}`, "echo mock", true),
          permissionOptions(),
        ),
      );
      if (env.permissionResponseFile) {
        await writeJsonReceipt(env.permissionResponseFile, {
          selectedOption: result.selectedOption,
        });
      }
    } catch (error) {
      if (currentScenario === "park-hitl") return true;
      if (!env.permissionResponseFile) throw error;
      await writeJsonReceipt(env.permissionResponseFile, {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
    notify({
      type: "permission_resolved",
      requestId: `permission-${turnId}`,
      toolUseIds: [`permission-tool-${turnId}`],
      selectedOption: typeof result.selectedOption === "string" ? result.selectedOption : "cancel",
    });
    if (result.selectedOption === "cancel") {
      emitTurnCompleted("permission_rejected", turnId);
      return true;
    }
  }
  if (
    permissionFloodCount > 0 &&
    (currentScenario !== "permission-flood-turn-boundary" || turnSequence === 1)
  ) {
    const requests: Array<Promise<unknown>> = [];
    for (let index = 0; index < permissionFloodCount; index += 1) {
      requests.push(
        requestClient(
          "droid.request_permission",
          permissionParams(
            execTool(`permission-flood-tool-${turnId}-${index}`, `echo ${index}`, true),
            decisionOptions,
          ),
        ),
      );
      await NodeTimersPromises.setTimeout(5);
    }
    if (env.permissionFloodReadyFile) NodeFS.writeFileSync(env.permissionFloodReadyFile, "");
    if (currentScenario === "permission-flood-turn-boundary") {
      if (!env.coordinationDir) {
        throw new Error("permission-flood-turn-boundary requires T3_DROID_MOCK_COORDINATION_DIR");
      }
      const probeIndex = Number(env.permissionFloodProbeIndex);
      for (const [index, request] of requests.entries()) {
        void request.catch(() =>
          index === probeIndex
            ? NodeFSP.writeFile(NodePath.join(env.coordinationDir!, "stale-request-rejected"), "")
            : undefined,
        );
      }
      emitTurnCompleted("completed", turnId);
      return true;
    }
    if (currentScenario === "permission-flood-retirement") {
      if (!env.coordinationDir) {
        throw new Error("permission-flood-retirement requires T3_DROID_MOCK_COORDINATION_DIR");
      }
      holdNativeServerResponses = true;
      void waitForFile(NodePath.join(env.coordinationDir, "release-native-responses")).then(() => {
        holdNativeServerResponses = false;
        for (const response of heldNativeServerResponses.splice(0)) {
          handleMessage(response);
        }
      });
    }
    await Promise.all(requests);
  }
  return false;
}

async function runTurn(turnId: string): Promise<void> {
  turnSequence += 1;
  activeTurn = { turnId, completed: false };
  if (emitPostLoadStraggler && previousSessionId) {
    emitPostLoadStraggler = false;
    textDelta(`assistant-stale-${turnId}`, "stale pre-rewind output", 0, previousSessionId);
  }
  notify({ type: "droid_working_state_changed", newState: "thinking" });
  item("thinking_text_delta", `assistant-${turnId}`, 0, { textDelta: "Mock thinking" });
  if (currentScenario === "exit-mid-turn") process.exit(7);
  if (currentScenario === "unknown-notification" || currentScenario === "rpc-roundtrip") {
    notify({ type: "future_mock_notification", futurePayload: { supported: true } });
  }
  if (await runLateTerminal(turnId)) return;
  if (currentScenario === "usage-reset") {
    if (turnSequence === 1) usageChanged({ inputTokens: 70, cacheReadTokens: 20, outputTokens: 9 });
    emitTurnCompleted("completed", turnId, { emitUsage: false });
    return;
  }
  if (currentScenario === "exit-hitl") {
    if (!env.coordinationDir) throw new Error("exit-hitl requires T3_DROID_MOCK_COORDINATION_DIR");
    void requestClient(
      "droid.request_permission",
      permissionParams(execTool(`exit-hitl-tool-${turnId}`, "echo parked"), [
        { label: "Allow once", value: "proceed_once" },
      ]),
    ).catch(() => {});
    await waitForFile(NodePath.join(env.coordinationDir, "release-exit"));
    process.exit(7);
  }
  if (await runSpecScenario(turnId)) return;
  emitForeignSpecTraffic(turnId);
  if (currentScenario === "future-terminal-reason") {
    emitTurnCompleted("future_terminal_reason", turnId);
    emitTerminalForSession(currentSessionId, "completed", turnId);
    return;
  }
  if (currentScenario === "compaction") {
    notify({
      type: "session_compacted",
      summaryId: "mock-summary-1",
      removedCount: 3,
      visibleBoundaryMessageId: null,
    });
    usageChanged({ inputTokens: 5, cacheReadTokens: 1, outputTokens: 2 });
  }
  if (await runChildScenario(turnId)) return;
  if (currentScenario === "taskless-progress") {
    notify({
      type: "tool_progress_update",
      toolUseId: `parent-tool-${turnId}`,
      toolName: "Execute",
      update: { type: "status", status: "running" },
    });
  }
  if (currentScenario === "load-spec-mode-report" || currentScenario === "report-selected-model") {
    const report =
      currentScenario === "load-spec-mode-report"
        ? currentSettings.interactionMode
        : currentSettings.interactionMode === "spec"
          ? `${currentSettings.specModeModelId}:${currentSettings.specModeReasoningEffort}`
          : `${currentSettings.modelId}:${currentSettings.reasoningEffort}`;
    item("thinking_text_complete", `assistant-${turnId}`, 0, { durationMs: 5 });
    textDelta(`assistant-${turnId}`, report);
    textComplete(`assistant-${turnId}`);
    emitTurnCompleted("completed", turnId);
    return;
  }
  if (currentScenario === "incomplete-items") {
    textDelta(`assistant-${turnId}`, "terminal without item completions");
    toolCall(`incomplete-tool-${turnId}`, "Execute", { command: "echo incomplete" });
    emitTurnCompleted("completed", turnId);
    return;
  }
  if (sharedToolRole === "delayed") {
    toolCall("shared-tool-use", "Read", { path: "README.md" });
    return;
  }
  if (sharedToolRole === "execute") {
    toolCall("shared-tool-use", "Execute", { command: "echo shared" });
    toolResult(`assistant-${turnId}`, "shared-tool-use", "shared command output");
  }
  if (currentScenario === "steering-coalesced" || currentScenario === "steering-separate") {
    toolCall(`steering-tool-${turnId}`, "Execute", { command: "echo steering" });
    return;
  }
  if (await runPermissionFlow(turnId)) return;
  if (currentScenario === "ask-user" || currentScenario === "rpc-roundtrip") {
    await requestClient("droid.ask_user", {
      toolCallId: `ask-${turnId}`,
      questions: [
        {
          index: 1,
          topic: "Scope",
          question: "Which scope?",
          options: ["workspace", "session"],
        },
      ],
    });
  }
  if (currentScenario === "rpc-roundtrip") {
    toolCall(`tool-${turnId}`, "Read", { path: "README.md" });
    toolResult(`assistant-${turnId}`, `tool-${turnId}`, "mock file contents");
  }
  item("thinking_text_complete", `assistant-${turnId}`, 0, { durationMs: 5 });
  textDelta(`assistant-${turnId}`, "hello from ");
  textDelta(`assistant-${turnId}`, "droid mock");
  textComplete(`assistant-${turnId}`);
  if (
    currentScenario === "hang-turn" ||
    (currentScenario === "permission-flood-turn-boundary" && turnSequence === 2) ||
    currentScenario === "interrupt-race" ||
    currentScenario === "fail-interrupt" ||
    (currentScenario === "interrupt-late-terminal-order" && turnSequence <= 2) ||
    (currentScenario === "hang-first-turn" && turnSequence === 1)
  ) {
    return;
  }
  emitTurnCompleted("completed", turnId);
}

const loadedMessages = {
  default: [
    { id: "loaded-user-1", role: "user", content: [{ type: "text", text: "loaded prompt" }] },
    {
      id: "loaded-assistant-1",
      role: "assistant",
      content: [{ type: "text", text: "loaded response" }],
    },
  ],
  steering: [
    {
      id: "loaded-opening-user",
      role: "user",
      content: [{ type: "text", text: "loaded opening prompt" }],
    },
    { id: "loaded-steer-user", role: "user", content: [{ type: "text", text: "loaded steer" }] },
    {
      id: "loaded-assistant-1",
      role: "assistant",
      content: [{ type: "text", text: "loaded response" }],
    },
  ],
};
function parseUserMessage(params: unknown): { messageId: string; text: string } | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const values = params as { messageId?: unknown; text?: unknown };
  return typeof values.messageId === "string" &&
    values.messageId.length > 0 &&
    typeof values.text === "string"
    ? { messageId: values.messageId, text: values.text }
    : undefined;
}
function emitSteeringMessage(messageId: string, text: string): void {
  notify({
    type: "create_message",
    message: { id: messageId, role: "user", content: [{ type: "text", text }] },
  });
}
async function handleAddUserMessage(id: string, params: unknown): Promise<void> {
  const userMessage = parseUserMessage(params);
  if (!userMessage) {
    fail(id, -32602, "add_user_message requires messageId and text");
    return;
  }
  if (currentScenario === "start-race" && env.startRaceDir) {
    await NodeFSP.writeFile(NodePath.join(env.startRaceDir, "thread-lock-held"), "");
    await waitForFile(NodePath.join(env.startRaceDir, "release-thread-lock"));
  }
  if (env.interruptOrderDir && interruptRequestBlocked) {
    await NodeFSP.writeFile(
      NodePath.join(env.interruptOrderDir, "turn-started-before-interrupt"),
      "",
    );
  }
  if (currentScenario === "fail-add-user-message") {
    fail(id, -32603, "Mock add_user_message failure");
    return;
  }
  respond(id, {});
  if (sharedToolRole === "delayed" && activeTurn && !activeTurn.completed) {
    const openingTurnId = activeTurn.turnId;
    emitSteeringMessage(userMessage.messageId, userMessage.text);
    toolResult(`assistant-${openingTurnId}`, "shared-tool-use", "shared file contents");
    emitTurnCompleted("completed", openingTurnId);
    return;
  }
  if (currentScenario === "steering-coalesced" && activeTurn && !activeTurn.completed) {
    const openingTurnId = activeTurn.turnId;
    emitSteeringMessage(userMessage.messageId, userMessage.text);
    textDelta(`assistant-${openingTurnId}`, "steered output");
    textComplete(`assistant-${openingTurnId}`);
    emitTurnCompleted("completed", openingTurnId);
    return;
  }
  if (currentScenario === "steering-separate" && activeTurn && !activeTurn.completed) {
    emitTurnCompleted("completed", activeTurn.turnId);
  }
  void runTurn(userMessage.messageId);
}
async function initialize(id: string): Promise<void> {
  if (currentScenario === "fail-init") {
    fail(id, -32603, "Mock initialization failure");
    return;
  }
  if (env.startRaceDir) {
    try {
      await NodeFSP.writeFile(NodePath.join(env.startRaceDir, "first-init"), "", { flag: "wx" });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      await NodeFSP.writeFile(NodePath.join(env.startRaceDir, "replacement-init-started"), "");
      await waitForFile(NodePath.join(env.startRaceDir, "release-replacement-init"));
    }
  }
  previousSessionId = undefined;
  currentSessionId = sessions.initialized;
  respond(id, initializeResult());
}
function loadSession(id: string, params: unknown): void {
  const sessionId =
    typeof params === "object" &&
    params !== null &&
    "sessionId" in params &&
    typeof params.sessionId === "string"
      ? params.sessionId
      : "";
  if (!sessionId) {
    fail(id, -32602, "load_session requires sessionId");
    return;
  }
  if (sessionId !== sessions.known && sessionId !== sessions.rewound) {
    fail(id, -32004, "Mock session not found");
    return;
  }
  previousSessionId = currentSessionId;
  currentSessionId = sessionId;
  if (currentScenario === "load-spec-mode-report") {
    currentSettings = { ...currentSettings, interactionMode: "spec" };
  }
  if (sessionId === sessions.rewound) emitPostLoadStraggler = true;
  const loadSteering =
    currentScenario === "steering-coalesced" || currentScenario === "steering-separate";
  respond(id, {
    session: {
      title: "Loaded mock session",
      messages: loadSteering ? loadedMessages.steering : loadedMessages.default,
    },
    settings: {
      ...currentSettings,
      ...(currentScenario === "fail-update-settings" ? { autonomyLevel: "high" } : {}),
      availableAutonomyLevels: autonomyLevels,
    },
    availableModels: models,
    tokenUsage,
  });
}
async function interrupt(id: string): Promise<void> {
  if (currentScenario === "fail-interrupt") {
    fail(id, -32603, "Mock interrupt failure");
    return;
  }
  if (currentScenario === "interrupt-late-terminal-order") {
    if (!env.interruptOrderDir) {
      throw new Error("interrupt-late-terminal-order requires T3_DROID_MOCK_INTERRUPT_ORDER_DIR");
    }
    interruptSequence += 1;
    const sequence = interruptSequence;
    await NodeFSP.writeFile(
      NodePath.join(env.interruptOrderDir, `interrupt-${sequence}-received`),
      "",
    );
    if (sequence === 1) {
      const interruptedTurnId = activeTurn?.turnId;
      if (interruptedTurnId !== undefined) firstTurnId = interruptedTurnId;
      respond(id, {});
      await waitForFile(NodePath.join(env.interruptOrderDir, "release-interrupt-1"));
      if (interruptedTurnId !== undefined) {
        emitTerminalForSession(currentSessionId, "cancelled", interruptedTurnId);
        if (activeTurn?.turnId === interruptedTurnId) activeTurn = undefined;
      }
      return;
    }
    if (sequence === 2) {
      const interruptedTurnId = activeTurn?.turnId;
      respond(id, {});
      if (firstTurnId !== undefined) {
        emitTerminalForSession(currentSessionId, "cancelled", firstTurnId);
      }
      notify({ type: "session_title_updated", title: "late old terminal observed" });
      await waitForFile(NodePath.join(env.interruptOrderDir, "release-interrupt-2"));
      if (interruptedTurnId !== undefined) {
        emitTerminalForSession(currentSessionId, "cancelled", interruptedTurnId);
        if (activeTurn?.turnId === interruptedTurnId) activeTurn = undefined;
      }
      return;
    }
  }
  if (env.interruptOrderDir) {
    interruptRequestBlocked = true;
    await NodeFSP.writeFile(NodePath.join(env.interruptOrderDir, "interrupt-received"), "");
    await waitForFile(NodePath.join(env.interruptOrderDir, "release-interrupt"));
    interruptRequestBlocked = false;
  }
  if (activeTurn) {
    emitTurnCompleted(
      currentScenario === "interrupt-race" ? "completed" : "cancelled",
      activeTurn.turnId,
    );
  }
  respond(id, {});
}
async function updateSettings(id: string, params: unknown): Promise<void> {
  if (currentScenario === "fail-update-settings") {
    fail(id, -32603, "Mock settings update failure");
    return;
  }
  if (currentScenario === "hang-update-settings") {
    if (!env.coordinationDir) {
      throw new Error("hang-update-settings requires T3_DROID_MOCK_COORDINATION_DIR");
    }
    await NodeFSP.writeFile(NodePath.join(env.coordinationDir, "settings-requested"), "");
    await new Promise<void>(() => {});
  }
  if (env.settingsLogPath)
    NodeFS.appendFileSync(env.settingsLogPath, `${JSON.stringify(params)}\n`);
  if (typeof params === "object" && params !== null)
    currentSettings = { ...currentSettings, ...params };
  respond(id, {});
  notify({ type: "settings_updated", settings: currentSettings });
}
async function handleRequest(message: {
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}): Promise<void> {
  if (env.requestLogPath) {
    NodeFS.appendFileSync(
      env.requestLogPath,
      `${JSON.stringify({ method: message.method, params: message.params })}\n`,
    );
  }
  switch (message.method) {
    case "droid.initialize_session":
      await initialize(message.id);
      return;
    case "droid.load_session":
      loadSession(message.id, message.params);
      return;
    case "droid.add_user_message":
      await handleAddUserMessage(message.id, message.params);
      return;
    case "droid.interrupt_session":
      await interrupt(message.id);
      return;
    case "droid.update_session_settings":
      await updateSettings(message.id, message.params);
      return;
    case "droid.list_models":
      respond(message.id, { models });
      return;
    case "droid.list_commands":
      respond(message.id, {
        commands: [
          { name: "review", description: "Review the current changes", argumentHint: "[path]" },
        ],
      });
      return;
    case "droid.list_skills":
      respond(message.id, {
        skills: [
          {
            name: "mock-skill",
            description: "A mock skill",
            location: "personal",
            filePath: "/mock/SKILL.md",
            enabled: true,
          },
        ],
        projectAvailable: true,
      });
      return;
    case "droid.execute_rewind":
      respond(message.id, {
        newSessionId: sessions.rewound,
        restoredCount: 1,
        deletedCount: 1,
        failedRestoreCount: 0,
        failedDeleteCount: 0,
      });
      return;
    default:
      fail(message.id, -32601, `Unknown mock method: ${message.method}`);
  }
}

function handleMessage(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Mock peer received a non-object JSON-RPC message");
  }
  const message = raw as Record<string, unknown>;
  if (
    message.jsonrpc !== protocol.jsonrpc ||
    message.factoryApiVersion !== protocol.factoryApiVersion ||
    typeof message.factoryProtocolVersion !== "string"
  ) {
    throw new Error("Mock peer received an invalid Factory JSON-RPC envelope");
  }
  if (message.type === "response" && typeof message.id === "string") {
    if (holdNativeServerResponses) {
      heldNativeServerResponses.push(message);
      return;
    }
    const hasResult = "result" in message;
    const hasError = "error" in message;
    if (hasResult === hasError)
      throw new Error("Mock peer received an invalid JSON-RPC response variant");
    const pending = pendingServerRequests.get(message.id);
    if (!pending) return;
    pendingServerRequests.delete(message.id);
    if (hasError && typeof message.error === "object" && message.error !== null) {
      pending.reject(new Error(JSON.stringify(message.error)));
    } else pending.resolve(message.result);
    return;
  }
  if (
    message.type === "request" &&
    typeof message.id === "string" &&
    typeof message.method === "string"
  ) {
    void handleRequest({ id: message.id, method: message.method, params: message.params });
    return;
  }
  throw new Error("Mock peer received an invalid JSON-RPC message shape");
}

const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line.trim()) handleMessage(JSON.parse(line));
});
input.once("close", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
