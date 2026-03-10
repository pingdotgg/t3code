import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  TerminalService,
  type PlaygroundSession,
  type TerminalCleanupError,
  type TerminalServiceShape,
} from "../terminal";
import { CodexService } from "./app-server.service";
import type {
  CodexAccountSnapshot,
  CodexCompletedTurn,
  CodexDeviceAuthSnapshot,
  CodexLiveEvent,
  CodexSessionListener,
  CodexPendingApprovalRequest,
  CodexPendingUserInputRequest,
  CodexServiceShape,
  CodexSessionSnapshot,
  CodexStoredThread,
} from "./app-server.types";
import {
  CodexCommandError,
  CodexDeviceAuthNotFoundError,
  CodexDeviceAuthParseError,
  CodexProtocolError,
  CodexRequestTimeoutError,
  CodexResponseError,
  CodexSessionNotFoundError,
  CodexWaitForLoginError,
  CodexWaitForTurnError,
} from "./app-server.errors";
import {
  CODEX_BOOT_SENTINEL,
  DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
  DEFAULT_LOGIN_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  consumePtyLines,
  createAppServerBootCommand,
  createCodexHomePath,
  createDeviceAuthBootCommand,
  createInitializeParams,
  createJsonRpcRequest,
  createJsonRpcResult,
  createPtyFrameState,
  createRequestId,
  tryExtractDeviceAuthChallenge,
  tryParseJsonRpcLine,
  type JsonRpcResponseShape,
} from "./app-server.protocol";
import { resolveCodexModel } from "./app-server.model";

interface PendingRequestState {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingTurnState {
  threadId: string;
  promise: Promise<CodexCompletedTurn>;
  resolve: (value: CodexCompletedTurn) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  onDelta?: (delta: string) => void | Promise<void>;
}

interface InternalApprovalRequest extends CodexPendingApprovalRequest {
  rpcId: string | number;
}

interface InternalUserInputRequest extends CodexPendingUserInputRequest {
  rpcId: string | number;
}

interface SessionState {
  snapshot: CodexSessionSnapshot;
  pty: PlaygroundSession;
  frameState: ReturnType<typeof createPtyFrameState>;
  listeners: Set<CodexSessionListener>;
  nextRequestId: number;
  nextEventSequence: number;
  pendingRequests: Map<string | number, PendingRequestState>;
  pendingApprovals: Map<string, InternalApprovalRequest>;
  pendingUserInputs: Map<string, InternalUserInputRequest>;
  pendingTurns: Map<string, PendingTurnState>;
  completedTurns: Map<string, CodexCompletedTurn>;
  bootReady: Promise<void>;
  resolveBootReady: () => void;
}

interface DeviceAuthState {
  snapshot: CodexDeviceAuthSnapshot;
  pty: PlaygroundSession;
  frameState: ReturnType<typeof createPtyFrameState>;
  rawOutput: string;
  challengeReady: Promise<CodexDeviceAuthSnapshot>;
  resolveChallengeReady: (snapshot: CodexDeviceAuthSnapshot) => void;
  rejectChallengeReady: (error: unknown) => void;
  completion: Promise<CodexDeviceAuthSnapshot>;
  resolveCompletion: (snapshot: CodexDeviceAuthSnapshot) => void;
  rejectCompletion: (error: unknown) => void;
}

const MAX_SESSION_EVENTS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readObject(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readArray(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function truncate(value: string, maxLength = 240): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function createDeferred<Value>() {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<Value>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

function createUnknownAccountSnapshot(): CodexAccountSnapshot {
  return {
    type: "unknown",
    planType: null,
    requiresOpenaiAuth: true,
  };
}

function deriveCodexHomePath(
  sandboxId: string,
  worktreePath: string,
  codexHomePath?: string,
): string {
  return codexHomePath?.trim() || createCodexHomePath(sandboxId, worktreePath);
}

function createSessionProtocolError(sessionId: string, message: string, cause?: unknown) {
  return new CodexProtocolError({
    message,
    sessionId,
    cause,
  });
}

function normalizeSessionSnapshot(state: SessionState): CodexSessionSnapshot {
  return {
    ...state.snapshot,
    pendingApprovalRequests: [...state.pendingApprovals.values()].map((request) => ({
      requestId: request.requestId,
      method: request.method,
      params: request.params,
    })),
    pendingUserInputRequests: [...state.pendingUserInputs.values()].map((request) => ({
      requestId: request.requestId,
      method: request.method,
      params: request.params,
    })),
    recentEvents: [...state.snapshot.recentEvents],
    protocolErrors: [...state.snapshot.protocolErrors],
  };
}

function notifySessionListeners(state: SessionState, liveEvent: CodexLiveEvent | null = null) {
  const event = {
    session: normalizeSessionSnapshot(state),
    liveEvent,
  };

  for (const listener of state.listeners) {
    void Promise.resolve(listener(event)).catch(() => undefined);
  }
}

function appendProtocolError(state: SessionState, message: string) {
  state.snapshot = {
    ...state.snapshot,
    protocolErrors: [...state.snapshot.protocolErrors, message].slice(-20),
  };
  appendLiveEvent(state, "local", "protocol/error", { message }, message);
  notifySessionListeners(state);
}

function isEchoedClientRequest(
  state: SessionState,
  method: string,
  rpcId: string | number,
): boolean {
  const pending = state.pendingRequests.get(rpcId);
  return pending?.method === method;
}

function resolveThreadId(
  params: Record<string, unknown>,
  snapshot: CodexSessionSnapshot,
): string | null {
  const thread = readObject(params, "thread");
  const msg = readObject(params, "msg");

  return (
    readString(params, "threadId") ??
    readString(thread ?? {}, "id") ??
    readString(msg ?? {}, "thread_id") ??
    readString(msg ?? {}, "threadId") ??
    snapshot.activeThreadId
  );
}

function resolveTurnId(params: Record<string, unknown>): string | null {
  const turn = readObject(params, "turn");
  const msg = readObject(params, "msg");

  return (
    readString(params, "turnId") ??
    readString(turn ?? {}, "id") ??
    readString(msg ?? {}, "turn_id") ??
    readString(msg ?? {}, "turnId") ??
    null
  );
}

function resolveItemId(params: Record<string, unknown>): string | null {
  const item = readObject(params, "item");
  const msg = readObject(params, "msg");

  return (
    readString(params, "itemId") ??
    readString(item ?? {}, "id") ??
    readString(msg ?? {}, "item_id") ??
    readString(msg ?? {}, "itemId") ??
    null
  );
}

function resolveRequestId(params: Record<string, unknown>): string | null {
  const msg = readObject(params, "msg");

  return (
    readString(params, "requestId") ??
    readString(msg ?? {}, "request_id") ??
    readString(msg ?? {}, "requestId") ??
    null
  );
}

function readDeltaText(params: Record<string, unknown>): string | null {
  const content = readObject(params, "content");
  const msg = readObject(params, "msg");

  return (
    readString(params, "delta") ??
    readString(params, "text") ??
    readString(content ?? {}, "text") ??
    readString(msg ?? {}, "delta") ??
    null
  );
}

function summarizeItemLifecycle(method: string, params: Record<string, unknown>): string | null {
  const item = readObject(params, "item") ?? params;
  const itemType = readString(item, "type") ?? readString(item, "kind");
  const status =
    readString(item, "status") ??
    (method === "item/started"
      ? "inProgress"
      : method === "item/completed"
        ? "completed"
        : undefined);
  const title =
    readString(item, "title") ?? readString(item, "command") ?? readString(item, "description");

  const parts = [itemType, status, title].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  return parts.length > 0 ? parts.join(" | ") : null;
}

function summarizePlanUpdate(params: Record<string, unknown>): string | null {
  const explanation = readString(params, "explanation");
  if (explanation) {
    return truncate(explanation);
  }

  const steps = readArray(params, "plan")
    .map((entry) => (isRecord(entry) ? readString(entry, "step") : undefined))
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  return steps.length > 0 ? truncate(steps.join(" | ")) : null;
}

function summarizeAccountUpdate(params: Record<string, unknown>): string | null {
  const authMode = readString(params, "authMode");
  const planType = readString(params, "planType");
  const parts = [authMode, planType].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  return parts.length > 0 ? parts.join(" | ") : null;
}

function summarizeThreadStatus(params: Record<string, unknown>): string | null {
  const status = readObject(params, "status");
  const parts = [readString(status ?? {}, "type"), readString(status ?? {}, "state")].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  return parts.length > 0 ? parts.join(" | ") : null;
}

function summarizeRequest(method: string, params: Record<string, unknown>): string | null {
  const detail =
    readString(params, "title") ??
    readString(params, "reason") ??
    readString(params, "prompt") ??
    readString(params, "command");

  if (detail) {
    return truncate(detail);
  }

  if (method === "item/tool/requestUserInput") {
    const questions = readArray(params, "questions")
      .map((entry) => (isRecord(entry) ? readString(entry, "question") : undefined))
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    return questions.length > 0 ? truncate(questions.join(" | ")) : null;
  }

  return null;
}

function summarizeEvent(method: string, params: Record<string, unknown>): string | null {
  if (
    method === "item/agentMessage/delta" ||
    method === "item/reasoning/textDelta" ||
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/commandExecution/outputDelta" ||
    method === "item/fileChange/outputDelta" ||
    method === "item/plan/delta"
  ) {
    const delta = readDeltaText(params);
    return delta ? truncate(delta) : null;
  }

  if (method === "item/started" || method === "item/completed") {
    return summarizeItemLifecycle(method, params);
  }

  if (method === "turn/plan/updated") {
    return summarizePlanUpdate(params);
  }

  if (method === "turn/diff/updated") {
    const diff =
      readString(params, "unifiedDiff") ??
      readString(params, "diff") ??
      readString(params, "patch");
    return diff ? truncate(diff) : null;
  }

  if (method === "turn/completed") {
    const turn = readObject(params, "turn");
    const error = readObject(turn ?? {}, "error");
    const parts = [readString(turn ?? {}, "status"), readString(error ?? {}, "message")].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );

    return parts.length > 0 ? truncate(parts.join(" | ")) : null;
  }

  if (method === "account/updated") {
    return summarizeAccountUpdate(params);
  }

  if (method === "thread/status/changed") {
    return summarizeThreadStatus(params);
  }

  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/tool/requestUserInput"
  ) {
    return summarizeRequest(method, params);
  }

  if (method === "item/mcpToolCall/progress") {
    const parts = [readString(params, "toolName"), readString(params, "summary")].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );

    return parts.length > 0 ? truncate(parts.join(" | ")) : null;
  }

  const status = readString(params, "status");
  return status ? truncate(status) : null;
}

function appendLiveEvent(
  state: SessionState,
  source: CodexLiveEvent["source"],
  method: string,
  payload: unknown,
  summaryOverride?: string | null,
) {
  const params = isRecord(payload) ? payload : {};
  const sequence = state.nextEventSequence;
  state.nextEventSequence += 1;

  const event: CodexLiveEvent = {
    eventId: `${state.snapshot.sessionId}:${sequence}`,
    sequence,
    timestamp: Date.now(),
    source,
    method,
    threadId: resolveThreadId(params, state.snapshot),
    turnId: resolveTurnId(params),
    itemId: resolveItemId(params),
    requestId: resolveRequestId(params),
    summary: summaryOverride !== undefined ? summaryOverride : summarizeEvent(method, params),
    payload,
  };

  state.snapshot = {
    ...state.snapshot,
    recentEvents: [...state.snapshot.recentEvents, event].slice(-MAX_SESSION_EVENTS),
  };
  notifySessionListeners(state, event);
}

function toStoredThread(value: unknown): CodexStoredThread {
  const record = isRecord(value) ? value : {};
  const turns = readArray(record, "turns");

  return {
    id: readString(record, "id") ?? "",
    preview: readString(record, "preview") ?? "",
    ephemeral: readBoolean(record, "ephemeral") === true,
    modelProvider: readString(record, "modelProvider") ?? "",
    createdAt: readNumber(record, "createdAt") ?? 0,
    updatedAt: readNumber(record, "updatedAt") ?? 0,
    status: record.status,
    path: readString(record, "path") ?? null,
    cwd: readString(record, "cwd") ?? "",
    cliVersion: readString(record, "cliVersion") ?? "",
    source: record.source,
    agentNickname: readString(record, "agentNickname") ?? null,
    agentRole: readString(record, "agentRole") ?? null,
    gitInfo: record.gitInfo,
    name: readString(record, "name") ?? null,
    turns: turns.map((turnValue) => {
      const turn = isRecord(turnValue) ? turnValue : {};
      return {
        id: readString(turn, "id") ?? "",
        items: readArray(turn, "items"),
        status: readString(turn, "status") ?? "",
        error: turn.error,
      };
    }),
  };
}

function toAccountSnapshot(value: unknown): CodexAccountSnapshot {
  const result = isRecord(value) ? value : {};
  const accountValue = isRecord(result.account) ? result.account : undefined;
  const accountType = accountValue ? readString(accountValue, "type") : undefined;

  return {
    type: accountType === "apiKey" ? "apiKey" : accountType === "chatgpt" ? "chatgpt" : "unknown",
    planType: accountValue ? (readString(accountValue, "planType") ?? null) : null,
    requiresOpenaiAuth: readBoolean(result, "requiresOpenaiAuth") !== false,
  };
}

function rejectPendingSessionWork(state: SessionState, error: unknown) {
  for (const pending of state.pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  state.pendingRequests.clear();

  for (const pendingTurn of state.pendingTurns.values()) {
    clearTimeout(pendingTurn.timeout);
    pendingTurn.reject(error);
  }
  state.pendingTurns.clear();
}

function getSessionState(sessions: Map<string, SessionState>, sessionId: string): SessionState {
  const state = sessions.get(sessionId);
  if (!state) {
    throw new CodexSessionNotFoundError({
      message: `Codex session ${sessionId} was not found.`,
      sessionId,
    });
  }
  return state;
}

function getDeviceAuthState(
  deviceAuths: Map<string, DeviceAuthState>,
  loginId: string,
): DeviceAuthState {
  const state = deviceAuths.get(loginId);
  if (!state) {
    throw new CodexDeviceAuthNotFoundError({
      message: `Codex device auth ${loginId} was not found.`,
      loginId,
    });
  }
  return state;
}

function createTimeoutPromise<Value>(
  createError: () => unknown,
  timeoutMs: number,
): Promise<Value> {
  return new Promise<Value>((_resolve, reject) => {
    setTimeout(() => reject(createError()), timeoutMs);
  });
}

function makeCodexService(terminalService: TerminalServiceShape): CodexServiceShape {
  const sessions = new Map<string, SessionState>();
  const deviceAuths = new Map<string, DeviceAuthState>();

  async function sendJsonRpcRequest<Result>(
    state: SessionState,
    method: string,
    params: unknown,
  ): Promise<Result> {
    const requestId = state.nextRequestId;
    state.nextRequestId += 1;

    return new Promise<Result>((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pendingRequests.delete(requestId);
        reject(
          new CodexRequestTimeoutError({
            message: `Timed out waiting for ${method} in session ${state.snapshot.sessionId}.`,
            sessionId: state.snapshot.sessionId,
            method,
          }),
        );
      }, DEFAULT_CODEX_REQUEST_TIMEOUT_MS);

      state.pendingRequests.set(requestId, {
        method,
        resolve: (value) => resolve(value as Result),
        reject,
        timeout,
      });

      void Effect.runPromise(
        state.pty.sendInput(`${createJsonRpcRequest(requestId, method, params)}\n`),
      ).catch((cause) => {
        clearTimeout(timeout);
        state.pendingRequests.delete(requestId);
        reject(
          createSessionProtocolError(
            state.snapshot.sessionId,
            `Failed to write ${method} to Codex app-server.`,
            cause,
          ),
        );
      });
    });
  }

  async function handleSessionResponse(state: SessionState, response: JsonRpcResponseShape) {
    const pending = state.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    state.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(
        new CodexResponseError({
          message:
            response.error.message ??
            `Codex request ${pending.method} failed for session ${state.snapshot.sessionId}.`,
          sessionId: state.snapshot.sessionId,
          method: pending.method,
          code: response.error.code,
          cause: response.error.data,
        }),
      );
      return;
    }

    pending.resolve(response.result);
  }

  async function handleSessionNotification(state: SessionState, method: string, params: unknown) {
    if (!isRecord(params)) {
      return;
    }

    appendLiveEvent(state, "notification", method, params);

    if (method === "account/updated") {
      const authMode = readString(params, "authMode");
      const planType = readString(params, "planType");
      state.snapshot = {
        ...state.snapshot,
        account: {
          ...state.snapshot.account,
          type:
            authMode === "apiKey"
              ? "apiKey"
              : authMode === "chatgpt"
                ? "chatgpt"
                : state.snapshot.account.type,
          planType: planType ?? state.snapshot.account.planType,
        },
      };
      notifySessionListeners(state);
      return;
    }

    if (method === "thread/started") {
      const thread = toStoredThread(params.thread);
      state.snapshot = {
        ...state.snapshot,
        activeThreadId: thread.id,
      };
      notifySessionListeners(state);
      return;
    }

    if (method === "turn/started") {
      const turn = isRecord(params.turn) ? params.turn : undefined;
      state.snapshot = {
        ...state.snapshot,
        activeThreadId: readString(params, "threadId") ?? state.snapshot.activeThreadId,
        activeTurnId: turn
          ? (readString(turn, "id") ?? state.snapshot.activeTurnId)
          : state.snapshot.activeTurnId,
      };
      notifySessionListeners(state);
      return;
    }

    if (method === "item/agentMessage/delta") {
      const turnId = readString(params, "turnId");
      const delta = readString(params, "delta");
      if (!turnId || !delta) {
        return;
      }

      const pendingTurn = state.pendingTurns.get(turnId);
      if (pendingTurn?.onDelta) {
        await pendingTurn.onDelta(delta);
      }
      return;
    }

    if (method === "turn/completed") {
      const turn = isRecord(params.turn) ? params.turn : undefined;
      const turnId = turn ? readString(turn, "id") : undefined;
      if (!turnId) {
        return;
      }

      const completedTurn: CodexCompletedTurn = {
        threadId: readString(params, "threadId") ?? state.snapshot.activeThreadId ?? "",
        turnId,
        status: turn ? (readString(turn, "status") ?? "") : "",
        error: turn?.error,
      };

      const pendingTurn = state.pendingTurns.get(turnId);
      if (pendingTurn) {
        clearTimeout(pendingTurn.timeout);
        state.pendingTurns.delete(turnId);
        pendingTurn.resolve(completedTurn);
      } else {
        state.completedTurns.set(turnId, completedTurn);
      }

      state.snapshot = {
        ...state.snapshot,
        activeTurnId: null,
      };
      notifySessionListeners(state);
    }
  }

  async function handleSessionServerRequest(
    state: SessionState,
    method: string,
    rpcId: string | number,
    params: unknown,
  ) {
    const requestId = String(rpcId);
    appendLiveEvent(
      state,
      "request",
      method,
      isRecord(params) ? { ...params, requestId } : { requestId },
    );

    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      state.pendingApprovals.set(requestId, {
        requestId,
        rpcId,
        method,
        params,
      });
      notifySessionListeners(state);
      return;
    }

    if (method === "item/tool/requestUserInput") {
      state.pendingUserInputs.set(requestId, {
        requestId,
        rpcId,
        method,
        params,
      });
      notifySessionListeners(state);
      return;
    }

    appendProtocolError(
      state,
      `Unhandled server request ${method} in session ${state.snapshot.sessionId}.`,
    );
  }

  async function handleSessionChunk(state: SessionState, chunk: Uint8Array) {
    const framed = consumePtyLines(state.frameState, chunk);
    state.frameState = framed.state;

    for (const rawLine of framed.lines) {
      const line = rawLine.trim();
      if (line === CODEX_BOOT_SENTINEL) {
        state.resolveBootReady();
        continue;
      }

      const envelope = tryParseJsonRpcLine(rawLine);
      if (!envelope) {
        continue;
      }

      if (envelope.type === "response") {
        await handleSessionResponse(state, envelope.value);
        continue;
      }

      if (envelope.type === "notification") {
        await handleSessionNotification(state, envelope.value.method, envelope.value.params);
        continue;
      }

      if (isEchoedClientRequest(state, envelope.value.method, envelope.value.id)) {
        continue;
      }

      await handleSessionServerRequest(
        state,
        envelope.value.method,
        envelope.value.id,
        envelope.value.params,
      );
    }
  }

  async function handleDeviceAuthChunk(state: DeviceAuthState, chunk: Uint8Array) {
    const framed = consumePtyLines(state.frameState, chunk);
    state.frameState = framed.state;
    state.rawOutput += new TextDecoder().decode(chunk);

    const challenge = tryExtractDeviceAuthChallenge(state.rawOutput);
    if (!challenge) {
      return;
    }

    if (state.snapshot.verificationUri && state.snapshot.userCode) {
      return;
    }

    state.snapshot = {
      ...state.snapshot,
      verificationUri: challenge.verificationUri,
      userCode: challenge.userCode,
    };
    state.resolveChallengeReady(state.snapshot);
  }

  function watchSession(state: SessionState) {
    void Effect.runPromise(state.pty.wait).then(
      (result) => {
        if (state.snapshot.status !== "stopped") {
          state.snapshot = {
            ...state.snapshot,
            status: result.exitCode === 0 ? "stopped" : "error",
            activeTurnId: null,
          };
        }
        notifySessionListeners(state);

        rejectPendingSessionWork(
          state,
          createSessionProtocolError(
            state.snapshot.sessionId,
            `Codex app-server exited for session ${state.snapshot.sessionId}.`,
            result,
          ),
        );
      },
      (cause) => {
        state.snapshot = {
          ...state.snapshot,
          status: "error",
          activeTurnId: null,
        };
        notifySessionListeners(state);
        rejectPendingSessionWork(
          state,
          createSessionProtocolError(
            state.snapshot.sessionId,
            `Codex app-server crashed for session ${state.snapshot.sessionId}.`,
            cause,
          ),
        );
      },
    );
  }

  function watchDeviceAuth(state: DeviceAuthState) {
    void Effect.runPromise(state.pty.wait).then(
      (result) => {
        if (result.exitCode === 0) {
          state.snapshot = {
            ...state.snapshot,
            status: "completed",
            error: null,
          };
          state.resolveCompletion(state.snapshot);
          return;
        }

        const message =
          result.error ??
          `Codex device auth exited with code ${typeof result.exitCode === "number" ? result.exitCode : 1}.`;
        state.snapshot = {
          ...state.snapshot,
          status: "failed",
          error: message,
        };
        state.rejectChallengeReady(
          new CodexDeviceAuthParseError({
            message,
            loginId: state.snapshot.loginId,
          }),
        );
        state.rejectCompletion(
          new CodexWaitForLoginError({
            message,
            loginId: state.snapshot.loginId,
            cause: result,
          }),
        );
      },
      (cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        state.snapshot = {
          ...state.snapshot,
          status: "failed",
          error: message,
        };
        state.rejectChallengeReady(
          new CodexDeviceAuthParseError({
            message,
            loginId: state.snapshot.loginId,
          }),
        );
        state.rejectCompletion(
          new CodexWaitForLoginError({
            message,
            loginId: state.snapshot.loginId,
            cause,
          }),
        );
      },
    );
  }

  return {
    startSession(options) {
      return Effect.tryPromise({
        try: async () => {
          const sessionId = createRequestId("codex-session");
          const codexHomePath = deriveCodexHomePath(
            options.sandboxId,
            options.worktreePath,
            options.codexHomePath,
          );

          let state: SessionState | undefined;

          const pty = await Effect.runPromise(
            terminalService.openSandboxPtySession({
              sandboxId: options.sandboxId,
              cwd: options.worktreePath,
              cols: options.cols,
              rows: options.rows,
              deleteSandboxOnCleanup: false,
              envs: {
                CODEX_HOME: codexHomePath,
              },
              onData: async (chunk) => {
                if (state) {
                  await handleSessionChunk(state, chunk);
                }
              },
            }),
          );

          const boot = createDeferred<void>();
          state = {
            snapshot: {
              sessionId,
              sandboxId: options.sandboxId,
              worktreePath: options.worktreePath,
              codexHomePath,
              ptySessionId: pty.sessionId,
              status: "starting",
              account: createUnknownAccountSnapshot(),
              activeThreadId: null,
              activeTurnId: null,
              pendingApprovalRequests: [],
              pendingUserInputRequests: [],
              recentEvents: [],
              protocolErrors: [],
            },
            pty,
            frameState: createPtyFrameState(),
            listeners: new Set(),
            nextRequestId: 1,
            nextEventSequence: 1,
            pendingRequests: new Map(),
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
            pendingTurns: new Map(),
            completedTurns: new Map(),
            bootReady: boot.promise,
            resolveBootReady: () => boot.resolve(),
          };

          sessions.set(sessionId, state);
          watchSession(state);

          await Effect.runPromise(pty.sendInput(`${createAppServerBootCommand(codexHomePath)}\n`));
          await Promise.race([
            state.bootReady,
            createTimeoutPromise(
              () =>
                createSessionProtocolError(
                  sessionId,
                  `Timed out waiting for Codex app-server to boot in session ${sessionId}.`,
                ),
              DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
            ),
          ]);

          await sendJsonRpcRequest(state, "initialize", createInitializeParams());
          const account = toAccountSnapshot(
            await sendJsonRpcRequest(state, "account/read", { refreshToken: false }),
          );

          state.snapshot = {
            ...state.snapshot,
            status: "ready",
            account,
          };
          notifySessionListeners(state);

          return normalizeSessionSnapshot(state);
        },
        catch: (cause) => {
          if (
            cause instanceof CodexProtocolError ||
            cause instanceof CodexRequestTimeoutError ||
            cause instanceof CodexResponseError
          ) {
            return cause;
          }

          return new CodexCommandError({
            message: `Failed to start Codex app-server in sandbox ${options.sandboxId}.`,
            sandboxId: options.sandboxId,
            cwd: options.worktreePath,
            cause,
          });
        },
      });
    },
    stopSession(sessionId) {
      return Effect.tryPromise({
        try: async () => {
          const state = getSessionState(sessions, sessionId);
          sessions.delete(sessionId);
          rejectPendingSessionWork(
            state,
            createSessionProtocolError(sessionId, `Codex session ${sessionId} was stopped.`),
          );
          await Effect.runPromise(state.pty.cleanup);
        },
        catch: (cause) => cause as CodexSessionNotFoundError | TerminalCleanupError,
      });
    },
    getSession(sessionId) {
      return Effect.try({
        try: () => normalizeSessionSnapshot(getSessionState(sessions, sessionId)),
        catch: (cause) => cause as CodexSessionNotFoundError,
      });
    },
    subscribeSession(sessionId, listener) {
      return Effect.try({
        try: () => {
          const state = getSessionState(sessions, sessionId);
          state.listeners.add(listener);
          void Promise.resolve(
            listener({
              session: normalizeSessionSnapshot(state),
              liveEvent: null,
            }),
          ).catch(() => undefined);
          return () => {
            state.listeners.delete(listener);
          };
        },
        catch: (cause) => cause as CodexSessionNotFoundError,
      });
    },
    listSessions() {
      return Effect.succeed([...sessions.values()].map((state) => normalizeSessionSnapshot(state)));
    },
    startDeviceAuth(options) {
      return Effect.tryPromise({
        try: async (): Promise<CodexDeviceAuthSnapshot> => {
          const loginId = createRequestId("codex-login");
          const codexHomePath = deriveCodexHomePath(
            options.sandboxId,
            options.worktreePath,
            options.codexHomePath,
          );

          let state: DeviceAuthState | undefined;

          const pty = await Effect.runPromise(
            terminalService.openSandboxPtySession({
              sandboxId: options.sandboxId,
              cwd: options.worktreePath,
              cols: options.cols,
              rows: options.rows,
              deleteSandboxOnCleanup: false,
              envs: {
                CODEX_HOME: codexHomePath,
              },
              onData: async (chunk) => {
                if (state) {
                  await handleDeviceAuthChunk(state, chunk);
                }
              },
            }),
          );

          const challenge = createDeferred<CodexDeviceAuthSnapshot>();
          const completion = createDeferred<CodexDeviceAuthSnapshot>();
          state = {
            snapshot: {
              loginId,
              sandboxId: options.sandboxId,
              worktreePath: options.worktreePath,
              codexHomePath,
              ptySessionId: pty.sessionId,
              verificationUri: null,
              userCode: null,
              status: "pending",
              error: null,
            },
            pty,
            frameState: createPtyFrameState(),
            rawOutput: "",
            challengeReady: challenge.promise,
            resolveChallengeReady: challenge.resolve,
            rejectChallengeReady: challenge.reject,
            completion: completion.promise,
            resolveCompletion: completion.resolve,
            rejectCompletion: completion.reject,
          };

          deviceAuths.set(loginId, state);
          watchDeviceAuth(state);

          await Effect.runPromise(pty.sendInput(`${createDeviceAuthBootCommand(codexHomePath)}\n`));

          return await Promise.race([
            state.challengeReady,
            createTimeoutPromise<CodexDeviceAuthSnapshot>(
              () =>
                new CodexDeviceAuthParseError({
                  message: `Timed out waiting for the Codex device auth challenge for ${loginId}.`,
                  loginId,
                }),
              DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
            ),
          ]);
        },
        catch: (cause) => {
          if (cause instanceof CodexDeviceAuthParseError) {
            return cause;
          }

          return new CodexCommandError({
            message: `Failed to start Codex device auth in sandbox ${options.sandboxId}.`,
            sandboxId: options.sandboxId,
            cwd: options.worktreePath,
            cause,
          });
        },
      });
    },
    getDeviceAuth(loginId) {
      return Effect.try({
        try: () => getDeviceAuthState(deviceAuths, loginId).snapshot,
        catch: (cause) => cause as CodexDeviceAuthNotFoundError,
      });
    },
    awaitDeviceAuth(loginId, timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS) {
      return Effect.tryPromise({
        try: async (): Promise<CodexDeviceAuthSnapshot> => {
          const state = getDeviceAuthState(deviceAuths, loginId);
          return await Promise.race([
            state.completion,
            createTimeoutPromise<CodexDeviceAuthSnapshot>(
              () =>
                new CodexWaitForLoginError({
                  message: `Timed out waiting for device auth ${loginId}.`,
                  loginId,
                }),
              timeoutMs,
            ),
          ]);
        },
        catch: (cause) => cause as CodexDeviceAuthNotFoundError | CodexWaitForLoginError,
      });
    },
    cancelDeviceAuth(loginId) {
      return Effect.tryPromise({
        try: async () => {
          const state = getDeviceAuthState(deviceAuths, loginId);
          deviceAuths.delete(loginId);
          state.snapshot = {
            ...state.snapshot,
            status: "cancelled",
            error: null,
          };
          state.rejectChallengeReady(
            new CodexDeviceAuthParseError({
              message: `Device auth ${loginId} was cancelled.`,
              loginId,
            }),
          );
          state.rejectCompletion(
            new CodexWaitForLoginError({
              message: `Device auth ${loginId} was cancelled.`,
              loginId,
            }),
          );
          await Effect.runPromise(state.pty.cleanup);
        },
        catch: (cause) => cause as CodexDeviceAuthNotFoundError | TerminalCleanupError,
      });
    },
    readAccount(sessionId) {
      return Effect.tryPromise({
        try: async () => {
          const state = getSessionState(sessions, sessionId);
          const account = toAccountSnapshot(
            await sendJsonRpcRequest(state, "account/read", { refreshToken: false }),
          );
          state.snapshot = {
            ...state.snapshot,
            account,
          };
          notifySessionListeners(state);
          return account;
        },
        catch: (cause) =>
          cause as
            | CodexSessionNotFoundError
            | CodexProtocolError
            | CodexRequestTimeoutError
            | CodexResponseError,
      });
    },
    loginWithApiKey(sessionId, apiKey) {
      return Effect.tryPromise({
        try: async () => {
          const state = getSessionState(sessions, sessionId);
          await sendJsonRpcRequest(state, "account/login/start", {
            type: "apiKey",
            apiKey,
          });
          const account = toAccountSnapshot(
            await sendJsonRpcRequest(state, "account/read", { refreshToken: false }),
          );
          state.snapshot = {
            ...state.snapshot,
            account,
          };
          notifySessionListeners(state);
          return account;
        },
        catch: (cause) =>
          cause as
            | CodexSessionNotFoundError
            | CodexProtocolError
            | CodexRequestTimeoutError
            | CodexResponseError,
      });
    },
    openThread(options) {
      return Effect.tryPromise({
        try: async () => {
          const state = getSessionState(sessions, options.sessionId);
          const method = options.threadId ? "thread/resume" : "thread/start";
          const model = resolveCodexModel(options.model);
          const params = options.threadId
            ? {
                threadId: options.threadId,
                cwd: options.cwd ?? state.snapshot.worktreePath,
                model,
                modelProvider: options.modelProvider ?? null,
                serviceTier: options.serviceTier ?? null,
                approvalPolicy: options.approvalPolicy ?? null,
                sandbox: options.sandbox ?? null,
                persistExtendedHistory: options.persistExtendedHistory ?? false,
              }
            : {
                cwd: options.cwd ?? state.snapshot.worktreePath,
                model,
                modelProvider: options.modelProvider ?? null,
                serviceTier: options.serviceTier ?? null,
                approvalPolicy: options.approvalPolicy ?? null,
                sandbox: options.sandbox ?? null,
                ephemeral: options.ephemeral ?? false,
                experimentalRawEvents: options.experimentalRawEvents ?? false,
                persistExtendedHistory: options.persistExtendedHistory ?? false,
              };

          const result = await sendJsonRpcRequest<{ readonly thread: unknown }>(
            state,
            method,
            params,
          );
          const thread = toStoredThread(result.thread);
          state.snapshot = {
            ...state.snapshot,
            activeThreadId: thread.id,
          };
          notifySessionListeners(state);
          return thread;
        },
        catch: (cause) =>
          cause as
            | CodexSessionNotFoundError
            | CodexProtocolError
            | CodexRequestTimeoutError
            | CodexResponseError,
      });
    },
    sendTurn(options) {
      return Effect.tryPromise({
        try: async () => {
          const state = getSessionState(sessions, options.sessionId);
          const threadId = options.threadId ?? state.snapshot.activeThreadId;
          if (!threadId) {
            throw createSessionProtocolError(
              options.sessionId,
              "No active thread is available for turn/start.",
            );
          }

          const result = await sendJsonRpcRequest<{ readonly turn: unknown }>(state, "turn/start", {
            threadId,
            input: [
              {
                type: "text",
                text: options.prompt,
                text_elements: [],
              },
            ],
            cwd: options.cwd ?? null,
            model: resolveCodexModel(options.model),
            serviceTier: options.serviceTier ?? null,
            effort: options.effort ?? null,
            summary: options.summary ?? null,
          });

          const turnRecord = isRecord(result.turn) ? result.turn : {};
          const turnId = readString(turnRecord, "id");
          if (!turnId) {
            throw createSessionProtocolError(
              options.sessionId,
              "turn/start did not return a turn id.",
            );
          }

          const pending = createDeferred<CodexCompletedTurn>();
          const timeout = setTimeout(() => {
            state.pendingTurns.delete(turnId);
            pending.reject(
              new CodexWaitForTurnError({
                message: `Timed out waiting for turn ${turnId} in session ${options.sessionId}.`,
                sessionId: options.sessionId,
                turnId,
              }),
            );
          }, DEFAULT_TURN_TIMEOUT_MS);

          state.pendingTurns.set(turnId, {
            threadId,
            promise: pending.promise,
            resolve: pending.resolve,
            reject: pending.reject,
            timeout,
            onDelta: options.onAgentMessageDelta,
          });

          const completed = state.completedTurns.get(turnId);
          if (completed) {
            clearTimeout(timeout);
            state.completedTurns.delete(turnId);
            state.pendingTurns.delete(turnId);
            pending.resolve(completed);
          }

          state.snapshot = {
            ...state.snapshot,
            activeThreadId: threadId,
            activeTurnId: turnId,
          };
          notifySessionListeners(state);

          return {
            threadId,
            turnId,
          };
        },
        catch: (cause) => {
          if (cause instanceof CodexWaitForTurnError) {
            return cause;
          }
          return cause as
            | CodexSessionNotFoundError
            | CodexProtocolError
            | CodexRequestTimeoutError
            | CodexResponseError;
        },
      });
    },
    awaitTurn(sessionId, turnId, timeoutMs = DEFAULT_TURN_TIMEOUT_MS) {
      return Effect.tryPromise({
        try: async (): Promise<CodexCompletedTurn> => {
          const state = getSessionState(sessions, sessionId);
          const completed = state.completedTurns.get(turnId);
          if (completed) {
            state.completedTurns.delete(turnId);
            return completed;
          }

          const pending = state.pendingTurns.get(turnId);
          if (!pending) {
            throw new CodexWaitForTurnError({
              message: `Turn ${turnId} is not active in session ${sessionId}.`,
              sessionId,
              turnId,
            });
          }

          return await Promise.race([
            pending.promise,
            createTimeoutPromise<CodexCompletedTurn>(
              () =>
                new CodexWaitForTurnError({
                  message: `Timed out waiting for turn ${turnId} in session ${sessionId}.`,
                  sessionId,
                  turnId,
                }),
              timeoutMs,
            ),
          ]);
        },
        catch: (cause) => cause as CodexSessionNotFoundError | CodexWaitForTurnError,
      });
    },
    interruptTurn(sessionId, turnId) {
      return Effect.tryPromise({
        try: async () => {
          const state = getSessionState(sessions, sessionId);
          const resolvedTurnId = turnId ?? state.snapshot.activeTurnId;
          const threadId = state.snapshot.activeThreadId;
          if (!resolvedTurnId || !threadId) {
            return;
          }

          await sendJsonRpcRequest(state, "turn/interrupt", {
            threadId,
            turnId: resolvedTurnId,
          });
        },
        catch: (cause) =>
          cause as
            | CodexSessionNotFoundError
            | CodexProtocolError
            | CodexRequestTimeoutError
            | CodexResponseError,
      });
    },
    respondToApproval(sessionId, requestId, decision) {
      return Effect.tryPromise({
        try: async () => {
          const state = getSessionState(sessions, sessionId);
          const pending = state.pendingApprovals.get(requestId);
          if (!pending) {
            throw createSessionProtocolError(
              sessionId,
              `Approval request ${requestId} was not found.`,
            );
          }

          state.pendingApprovals.delete(requestId);
          appendLiveEvent(
            state,
            "local",
            "item/requestApproval/decision",
            {
              requestId,
              decision,
            },
            decision,
          );
          notifySessionListeners(state);
          await Effect.runPromise(
            state.pty.sendInput(`${createJsonRpcResult(pending.rpcId, { decision })}\n`),
          );
        },
        catch: (cause) =>
          cause as
            | CodexSessionNotFoundError
            | CodexProtocolError
            | CodexRequestTimeoutError
            | CodexResponseError,
      });
    },
    respondToUserInput(sessionId, requestId, answers) {
      return Effect.tryPromise({
        try: async () => {
          const state = getSessionState(sessions, sessionId);
          const pending = state.pendingUserInputs.get(requestId);
          if (!pending) {
            throw createSessionProtocolError(
              sessionId,
              `User input request ${requestId} was not found.`,
            );
          }

          state.pendingUserInputs.delete(requestId);
          appendLiveEvent(state, "local", "item/tool/requestUserInput/answered", {
            requestId,
            answers,
          });
          notifySessionListeners(state);
          await Effect.runPromise(
            state.pty.sendInput(
              `${createJsonRpcResult(pending.rpcId, {
                answers: Object.fromEntries(
                  Object.entries(answers).map(([key, value]) => [key, { answers: [...value] }]),
                ),
              })}\n`,
            ),
          );
        },
        catch: (cause) =>
          cause as
            | CodexSessionNotFoundError
            | CodexProtocolError
            | CodexRequestTimeoutError
            | CodexResponseError,
      });
    },
    listStoredThreads(options) {
      return Effect.tryPromise({
        try: async () => {
          const state = getSessionState(sessions, options.sessionId);
          const result = await sendJsonRpcRequest<{
            readonly data: readonly unknown[];
            readonly nextCursor: string | null;
          }>(state, "thread/list", {
            cursor: options.cursor ?? null,
            limit: options.limit ?? null,
            archived: options.archived ?? null,
            cwd: options.cwd ?? state.snapshot.worktreePath,
            sourceKinds: options.sourceKinds ?? ["appServer"],
          });

          return {
            data: result.data.map((thread) => toStoredThread(thread)),
            nextCursor: result.nextCursor,
          };
        },
        catch: (cause) =>
          cause as
            | CodexSessionNotFoundError
            | CodexProtocolError
            | CodexRequestTimeoutError
            | CodexResponseError,
      });
    },
    readStoredThread(options) {
      return Effect.tryPromise({
        try: async () => {
          const state = getSessionState(sessions, options.sessionId);
          const result = await sendJsonRpcRequest<{ readonly thread: unknown }>(
            state,
            "thread/read",
            {
              threadId: options.threadId,
              includeTurns: true,
            },
          );
          return toStoredThread(result.thread);
        },
        catch: (cause) =>
          cause as
            | CodexSessionNotFoundError
            | CodexProtocolError
            | CodexRequestTimeoutError
            | CodexResponseError,
      });
    },
    rollbackThread(sessionId, numTurns) {
      return Effect.tryPromise({
        try: async () => {
          const state = getSessionState(sessions, sessionId);
          const threadId = state.snapshot.activeThreadId;
          if (!threadId) {
            throw createSessionProtocolError(
              sessionId,
              "No active thread is available for rollback.",
            );
          }

          const result = await sendJsonRpcRequest<{ readonly thread: unknown }>(
            state,
            "thread/rollback",
            {
              threadId,
              numTurns,
            },
          );
          return toStoredThread(result.thread);
        },
        catch: (cause) =>
          cause as
            | CodexSessionNotFoundError
            | CodexProtocolError
            | CodexRequestTimeoutError
            | CodexResponseError,
      });
    },
  };
}

export function makeCodexServiceLayer(): Layer.Layer<CodexService, never, TerminalService> {
  return Layer.effect(
    CodexService,
    Effect.gen(function* () {
      const terminalService = yield* TerminalService;
      return makeCodexService(terminalService);
    }),
  );
}

export const CodexServiceLive = makeCodexServiceLayer;
