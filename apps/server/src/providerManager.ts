import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import {
  type ProviderCheckpoint,
  type ProviderEvent,
  type ProviderInterruptTurnInput,
  type ProviderListCheckpointsInput,
  type ProviderListCheckpointsResult,
  type ProviderRevertToCheckpointInput,
  type ProviderRevertToCheckpointResult,
  type ProviderRespondToRequestInput,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderStopSessionInput,
  type ProviderTurnStartResult,
  providerInterruptTurnInputSchema,
  providerListCheckpointsInputSchema,
  providerRevertToCheckpointInputSchema,
  providerRespondToRequestInputSchema,
  providerSendTurnInputSchema,
  providerSessionStartInputSchema,
  providerStopSessionInputSchema,
} from "@t3tools/contracts";
import type { CodexThreadTurnSnapshot } from "./codexAppServerManager";
import { CodexAppServerManager } from "./codexAppServerManager";

export interface ProviderManagerEvents {
  event: [event: ProviderEvent];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function trimToPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
}

function summarizeUserMessageContent(content: unknown[]): string | undefined {
  const segments: string[] = [];

  for (const part of content) {
    const record = asObject(part);
    const type = asString(record?.type);
    if (!type) continue;

    if (type === "text") {
      const text = asString(record?.text);
      if (text && text.trim().length > 0) {
        segments.push(text.trim());
      }
      continue;
    }

    if (type === "image") {
      segments.push("[Image attachment]");
      continue;
    }

    if (type === "localImage") {
      segments.push("[Local image attachment]");
      continue;
    }
  }

  if (segments.length === 0) {
    return undefined;
  }
  return trimToPreview(segments.join(" "));
}

function summarizeTurn(turn: CodexThreadTurnSnapshot): {
  messageCountDelta: number;
  preview?: string;
} {
  let messageCountDelta = 0;
  let preview: string | undefined;

  for (const item of turn.items) {
    const record = asObject(item);
    const type = asString(record?.type);
    if (!type) continue;

    if (type === "userMessage") {
      messageCountDelta += 1;
      if (!preview) {
        const content = asArray(record?.content);
        preview = summarizeUserMessageContent(content);
      }
      continue;
    }

    if (type === "agentMessage") {
      messageCountDelta += 1;
      if (!preview) {
        const text = asString(record?.text);
        if (text && text.trim().length > 0) {
          preview = trimToPreview(text);
        }
      }
    }
  }

  return {
    messageCountDelta,
    ...(preview ? { preview } : {}),
  };
}

function buildCheckpoints(turns: CodexThreadTurnSnapshot[]): ProviderCheckpoint[] {
  const checkpoints: ProviderCheckpoint[] = [];
  let messageCount = 0;
  const isEmpty = turns.length === 0;
  checkpoints.push({
    id: "root",
    turnCount: 0,
    messageCount: 0,
    label: "Start of conversation",
    isCurrent: isEmpty,
  });

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn) continue;
    const turnSummary = summarizeTurn(turn);
    messageCount += turnSummary.messageCountDelta;
    checkpoints.push({
      id: turn.id,
      turnCount: index + 1,
      messageCount,
      label: `Turn ${index + 1}`,
      ...(turnSummary.preview ? { preview: turnSummary.preview } : {}),
      isCurrent: index === turns.length - 1,
    });
  }

  return checkpoints;
}

export class ProviderManager extends EventEmitter<ProviderManagerEvents> {
  private readonly codex = new CodexAppServerManager();
  private readonly threadLogsDir: string;
  private readonly threadLogStreams = new Map<string, fs.WriteStream>();
  private readonly sessionThreadIds = new Map<string, string>();
  private readonly pendingEventsBySession = new Map<string, ProviderEvent[]>();
  private disposed = false;
  private readonly onCodexEvent = (event: ProviderEvent) => {
    if (this.disposed) {
      return;
    }

    this.routeEventToThreadLog(event);
    this.emit("event", event);
  };

  constructor() {
    super();

    const logsDir = path.resolve(process.cwd(), ".logs");
    this.threadLogsDir = path.join(logsDir, "threads");
    fs.mkdirSync(this.threadLogsDir, { recursive: true });

    this.codex.on("event", this.onCodexEvent);
  }

  async startSession(raw: ProviderSessionStartInput): Promise<ProviderSession> {
    const input = providerSessionStartInputSchema.parse(raw);
    if (input.provider !== "codex") {
      throw new Error(`Provider '${input.provider}' is not implemented yet.`);
    }

    const session = await this.codex.startSession(input);
    if (session.threadId) {
      this.sessionThreadIds.set(session.sessionId, session.threadId);
      this.flushPendingSessionEvents(session.sessionId, session.threadId);
    }
    return session;
  }

  async sendTurn(raw: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const input = providerSendTurnInputSchema.parse(raw);
    if (!this.codex.hasSession(input.sessionId)) {
      throw new Error(`Unknown provider session: ${input.sessionId}`);
    }

    return this.codex.sendTurn(input);
  }

  async interruptTurn(raw: ProviderInterruptTurnInput): Promise<void> {
    const input = providerInterruptTurnInputSchema.parse(raw);
    if (!this.codex.hasSession(input.sessionId)) {
      throw new Error(`Unknown provider session: ${input.sessionId}`);
    }

    await this.codex.interruptTurn(input.sessionId, input.turnId);
  }

  async respondToRequest(raw: ProviderRespondToRequestInput): Promise<void> {
    const input = providerRespondToRequestInputSchema.parse(raw);
    if (!this.codex.hasSession(input.sessionId)) {
      throw new Error(`Unknown provider session: ${input.sessionId}`);
    }

    await this.codex.respondToRequest(input.sessionId, input.requestId, input.decision);
  }

  stopSession(raw: ProviderStopSessionInput): void {
    const input = providerStopSessionInputSchema.parse(raw);
    this.codex.stopSession(input.sessionId);
    this.sessionThreadIds.delete(input.sessionId);
    this.pendingEventsBySession.delete(input.sessionId);
  }

  listSessions(): ProviderSession[] {
    return this.codex.listSessions();
  }

  async listCheckpoints(raw: ProviderListCheckpointsInput): Promise<ProviderListCheckpointsResult> {
    const input = providerListCheckpointsInputSchema.parse(raw);
    if (!this.codex.hasSession(input.sessionId)) {
      throw new Error(`Unknown provider session: ${input.sessionId}`);
    }

    const snapshot = await this.codex.readThread(input.sessionId);
    return {
      threadId: snapshot.threadId,
      checkpoints: buildCheckpoints(snapshot.turns),
    };
  }

  async revertToCheckpoint(
    raw: ProviderRevertToCheckpointInput,
  ): Promise<ProviderRevertToCheckpointResult> {
    const input = providerRevertToCheckpointInputSchema.parse(raw);
    if (!this.codex.hasSession(input.sessionId)) {
      throw new Error(`Unknown provider session: ${input.sessionId}`);
    }

    const beforeSnapshot = await this.codex.readThread(input.sessionId);
    const currentTurnCount = beforeSnapshot.turns.length;
    if (input.turnCount > currentTurnCount) {
      throw new Error(
        `Checkpoint turn count ${input.turnCount} exceeds current turn count ${currentTurnCount}.`,
      );
    }

    const requestedRollbackTurns = currentTurnCount - input.turnCount;
    const afterSnapshot =
      requestedRollbackTurns > 0
        ? await this.codex.rollbackThread(input.sessionId, requestedRollbackTurns)
        : beforeSnapshot;
    const checkpoints = buildCheckpoints(afterSnapshot.turns);
    const currentCheckpoint =
      checkpoints.find((checkpoint) => checkpoint.isCurrent) ??
      checkpoints[checkpoints.length - 1] ??
      checkpoints[0];
    const rolledBackTurns = Math.max(0, currentTurnCount - afterSnapshot.turns.length);

    return {
      threadId: afterSnapshot.threadId,
      turnCount: currentCheckpoint?.turnCount ?? 0,
      messageCount: currentCheckpoint?.messageCount ?? 0,
      rolledBackTurns,
      checkpoints,
    };
  }

  stopAll(): void {
    this.codex.stopAll();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.codex.off("event", this.onCodexEvent);
    for (const stream of this.threadLogStreams.values()) {
      stream.end();
    }
    this.threadLogStreams.clear();
    this.sessionThreadIds.clear();
    this.pendingEventsBySession.clear();
  }

  private routeEventToThreadLog(event: ProviderEvent): void {
    const threadId = this.resolveThreadId(event);
    if (!threadId) {
      const pending = this.pendingEventsBySession.get(event.sessionId) ?? [];
      pending.push(event);
      this.pendingEventsBySession.set(event.sessionId, pending.slice(-100));
      return;
    }

    this.flushPendingSessionEvents(event.sessionId, threadId);
    this.writeThreadEvent(threadId, event);
  }

  private flushPendingSessionEvents(sessionId: string, threadId: string): void {
    const pending = this.pendingEventsBySession.get(sessionId);
    if (!pending || pending.length === 0) {
      return;
    }

    for (const event of pending) {
      this.writeThreadEvent(threadId, event);
    }
    this.pendingEventsBySession.delete(sessionId);
  }

  private resolveThreadId(event: ProviderEvent): string | undefined {
    const fromPayload = this.readThreadIdFromPayload(event.payload);
    const threadId = event.threadId ?? fromPayload ?? this.sessionThreadIds.get(event.sessionId);

    if (threadId) {
      this.sessionThreadIds.set(event.sessionId, threadId);
    }

    return threadId;
  }

  private readThreadIdFromPayload(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }

    const record = payload as Record<string, unknown>;
    const direct = record.threadId;
    if (typeof direct === "string" && direct.length > 0) {
      return direct;
    }

    const thread = record.thread;
    if (!thread || typeof thread !== "object") {
      return undefined;
    }

    const nested = (thread as Record<string, unknown>).id;
    if (typeof nested === "string" && nested.length > 0) {
      return nested;
    }

    return undefined;
  }

  private writeThreadEvent(threadId: string, event: ProviderEvent): void {
    const stream = this.getOrCreateThreadLogStream(threadId);
    stream.write(`${JSON.stringify(event)}\n`);
  }

  private getOrCreateThreadLogStream(threadId: string): fs.WriteStream {
    const cached = this.threadLogStreams.get(threadId);
    if (cached) {
      return cached;
    }

    const safeThreadId = threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const stream = fs.createWriteStream(
      path.join(this.threadLogsDir, `${safeThreadId}.events.ndjson`),
      { flags: "a" },
    );
    this.threadLogStreams.set(threadId, stream);
    return stream;
  }
}
