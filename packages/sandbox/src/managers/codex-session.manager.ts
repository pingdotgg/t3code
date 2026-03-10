import * as Effect from "effect/Effect";

import type {
  CodexApprovalDecision,
  CodexLiveEvent,
  CodexServiceShape,
  CodexSessionSnapshot,
  CodexStoredThread,
} from "../services/codex";

export interface ManagedCodexSessionOptions {
  readonly key: string;
  readonly sandboxId: string;
  readonly worktreePath: string;
}

export type CodexManagerEvent = {
  readonly key: string;
  readonly session: CodexSessionSnapshot;
  readonly liveEvent: CodexLiveEvent | null;
};

export class CodexSessionManager {
  private readonly sessionIdByKey = new Map<string, string>();
  private readonly unsubscriberBySessionId = new Map<string, () => void>();
  private readonly listeners = new Set<(event: CodexManagerEvent) => void | Promise<void>>();

  constructor(private readonly codexService: CodexServiceShape) {}

  onEvent(listener: (event: CodexManagerEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listSessions(): Promise<readonly CodexSessionSnapshot[]> {
    return Effect.runPromise(this.codexService.listSessions());
  }

  async ensureSession(options: ManagedCodexSessionOptions): Promise<CodexSessionSnapshot> {
    const existingSessionId = this.sessionIdByKey.get(options.key);
    if (existingSessionId) {
      try {
        return await Effect.runPromise(this.codexService.getSession(existingSessionId));
      } catch {
        this.cleanupSessionRegistration(options.key, existingSessionId);
      }
    }

    const session = await Effect.runPromise(
      this.codexService.startSession({
        sandboxId: options.sandboxId,
        worktreePath: options.worktreePath,
      }),
    );

    this.sessionIdByKey.set(options.key, session.sessionId);
    await this.attachSessionListener(options.key, session.sessionId);
    return session;
  }

  async getSessionByKey(key: string): Promise<CodexSessionSnapshot | null> {
    const sessionId = this.sessionIdByKey.get(key);
    if (!sessionId) {
      return null;
    }

    try {
      return await Effect.runPromise(this.codexService.getSession(sessionId));
    } catch {
      this.cleanupSessionRegistration(key, sessionId);
      return null;
    }
  }

  async resetSession(key: string): Promise<void> {
    const sessionId = this.sessionIdByKey.get(key);
    if (!sessionId) {
      return;
    }

    try {
      await Effect.runPromise(this.codexService.stopSession(sessionId));
    } catch {
      // Best-effort cleanup. The session may already be gone if the sandbox restarted.
    } finally {
      this.cleanupSessionRegistration(key, sessionId);
    }
  }

  async listThreads(options: ManagedCodexSessionOptions): Promise<readonly CodexStoredThread[]> {
    const session = await this.ensureSession(options);
    const result = await Effect.runPromise(
      this.codexService.listStoredThreads({
        sessionId: session.sessionId,
        cwd: options.worktreePath,
      }),
    );

    return result.data;
  }

  async openThread(
    options: ManagedCodexSessionOptions & {
      readonly threadId?: string;
    },
  ): Promise<{ readonly session: CodexSessionSnapshot; readonly thread: CodexStoredThread }> {
    const session = await this.ensureSession(options);
    const thread = await Effect.runPromise(
      this.codexService.openThread({
        sessionId: session.sessionId,
        threadId: options.threadId,
        cwd: options.worktreePath,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        persistExtendedHistory: true,
        experimentalRawEvents: true,
      }),
    );

    const updatedSession = await Effect.runPromise(this.codexService.getSession(session.sessionId));

    return {
      session: updatedSession,
      thread,
    };
  }

  async readThread(sessionId: string, threadId: string): Promise<CodexStoredThread> {
    return Effect.runPromise(
      this.codexService.readStoredThread({
        sessionId,
        threadId,
      }),
    );
  }

  async sendTurn(
    key: string,
    threadId: string,
    prompt: string,
    effort?: "low" | "medium" | "high" | "xhigh",
  ): Promise<{
    readonly session: CodexSessionSnapshot;
    readonly threadId: string;
    readonly turnId: string;
  }> {
    const session = await this.requireSessionByKey(key);
    const result = await Effect.runPromise(
      this.codexService.sendTurn({
        sessionId: session.sessionId,
        threadId,
        prompt,
        effort: effort ?? null,
      }),
    );

    const updatedSession = await Effect.runPromise(this.codexService.getSession(session.sessionId));

    return {
      session: updatedSession,
      threadId: result.threadId,
      turnId: result.turnId,
    };
  }

  async interruptTurn(key: string): Promise<void> {
    const session = await this.requireSessionByKey(key);
    await Effect.runPromise(this.codexService.interruptTurn(session.sessionId));
  }

  async respondToApproval(
    sessionId: string,
    requestId: string,
    decision: CodexApprovalDecision,
  ): Promise<void> {
    await Effect.runPromise(this.codexService.respondToApproval(sessionId, requestId, decision));
  }

  async respondToUserInput(
    sessionId: string,
    requestId: string,
    answers: Record<string, readonly string[]>,
  ): Promise<void> {
    await Effect.runPromise(this.codexService.respondToUserInput(sessionId, requestId, answers));
  }

  private async requireSessionByKey(key: string): Promise<CodexSessionSnapshot> {
    const session = await this.getSessionByKey(key);
    if (!session) {
      throw new Error(`Codex session for ${key} was not found.`);
    }

    return session;
  }

  private async attachSessionListener(key: string, sessionId: string): Promise<void> {
    if (this.unsubscriberBySessionId.has(sessionId)) {
      return;
    }

    const unsubscribe = await Effect.runPromise(
      this.codexService.subscribeSession(sessionId, async (event) => {
        await this.emit({
          key,
          session: event.session,
          liveEvent: event.liveEvent,
        });
      }),
    );

    this.unsubscriberBySessionId.set(sessionId, unsubscribe);
  }

  private cleanupSessionRegistration(key: string, sessionId: string): void {
    this.sessionIdByKey.delete(key);
    this.unsubscriberBySessionId.get(sessionId)?.();
    this.unsubscriberBySessionId.delete(sessionId);
  }

  private async emit(event: CodexManagerEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}
