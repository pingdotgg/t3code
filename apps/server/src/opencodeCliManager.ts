import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { Readable, Writable } from "node:stream";

import { normalizeModelSlug } from "@t3tools/shared/model";
import { buildPopupSafeEnv } from "./cliEnvironment";

export interface OpencodeStreamEvent {
  readonly type: "session/update" | "session/request_permission" | "error";
  readonly [key: string]: unknown;
}

export type OpencodeSessionModeId = "default" | "plan";

export interface OpencodeSessionContext {
  readonly sessionId: string;
  readonly threadId: string;
  model: string;
  cwd: string;
  opencodeSessionId?: string;
  status: "idle" | "running" | "stopped";
  activeTurnId: string | null;
  activeProcess: ChildProcess | null;
  currentMode: OpencodeSessionModeId;
  pendingApprovals: Set<string>;
}

export interface OpencodeStartSessionInput {
  readonly threadId: string;
  readonly model: string;
  readonly cwd: string;
  readonly resumeCursor?: { sessionId: string };
}

export interface OpencodeSendTurnInput {
  readonly threadId: string;
  readonly text: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly interactionMode?: "default" | "plan";
}

export interface OpencodeTurnResult {
  readonly turnId: string;
  readonly threadId: string;
  readonly resumeCursor?: { sessionId: string };
}

interface OpencodeAcpConnection {
  initialize(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  newSession(params: { cwd: string; mcpServers: ReadonlyArray<unknown> }): Promise<{ sessionId: string }>;
  loadSession(params: { sessionId: string; cwd: string }): Promise<{ sessionId: string }>;
  prompt(params: { sessionId: string; prompt: ReadonlyArray<{ type: "text"; text: string }>; mode?: "default" | "plan" }): Promise<{ stopReason?: string }>;
  cancel(params: { sessionId: string }): Promise<void>;
}

export class OpencodeCliManager extends EventEmitter {
  private readonly sessions = new Map<string, OpencodeSessionContext>();
  private readonly threadIdByOpencodeSessionId = new Map<string, string>();
  private readonly pendingAcpApprovals = new Map<string, (decision: "approved" | "rejected") => void>();
  private activeConnection: OpencodeAcpConnection | null = null;
  private activeProcess: ChildProcess | null = null;
  private initializePromise: Promise<void> | null = null;

  constructor() {
    super();
  }

  async startSession(input: OpencodeStartSessionInput): Promise<OpencodeSessionContext> {
    const context: OpencodeSessionContext = {
      sessionId: randomUUID(),
      threadId: input.threadId,
      model: normalizeModelSlug(input.model, "opencode") ?? input.model,
      cwd: input.cwd,
      status: "idle",
      activeTurnId: null,
      activeProcess: null,
      currentMode: "default",
      pendingApprovals: new Set(),
      ...(input.resumeCursor?.sessionId ? { opencodeSessionId: input.resumeCursor.sessionId } : {}),
    };

    this.sessions.set(input.threadId, context);
    if (context.opencodeSessionId) {
      this.threadIdByOpencodeSessionId.set(context.opencodeSessionId, context.threadId);
    }

    this.emit("event", {
      type: "session",
      method: "session/started",
      kind: "lifecycle",
      threadId: input.threadId,
      sessionId: context.sessionId,
      provider: "opencode",
    });

    return context;
  }

  async sendTurn(input: OpencodeSendTurnInput): Promise<OpencodeTurnResult> {
    const context = this.sessions.get(input.threadId);
    if (!context) {
      throw new Error(`No Opencode session for thread: ${input.threadId}`);
    }
    if (context.status === "stopped") {
      throw new Error(`Opencode session is stopped for thread: ${input.threadId}`);
    }

    const trimmedText = input.text.trim();
    if (trimmedText.length === 0) {
      throw new Error("Turn input must include text.");
    }

    context.cwd = input.cwd ?? context.cwd;
    context.model = input.model ?? context.model;
    context.currentMode = input.interactionMode ?? "default";

    const turnId = `turn_${randomUUID().slice(0, 8)}`;
    context.activeTurnId = turnId;
    context.status = "running";

    this.emit("event", {
      type: "turn",
      method: "turn/started",
      kind: "lifecycle",
      threadId: input.threadId,
      turnId,
      provider: "opencode",
      model: context.model,
    });

    void this.runTurnCli(context, turnId, trimmedText);

    return {
      turnId,
      threadId: input.threadId,
      ...(context.opencodeSessionId ? { resumeCursor: { sessionId: context.opencodeSessionId } } : {}),
    };
  }

  private async runTurnCli(context: OpencodeSessionContext, turnId: string, text: string): Promise<void> {
    try {
      const args = ["run", text, "--format", "json"];
      if (context.opencodeSessionId) {
        args.push("--session", context.opencodeSessionId);
      }
      if (context.model) {
        args.push("--model", context.model);
      }

      const child = spawn("opencode", args, {
        cwd: context.cwd,
        env: buildPopupSafeEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      context.activeProcess = child;
      const rl = createInterface({ input: child.stdout });

      rl.on("line", (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.sessionID && !context.opencodeSessionId) {
            context.opencodeSessionId = msg.sessionID;
            this.emit("event", {
              type: "session",
              method: "session/configured",
              kind: "lifecycle",
              threadId: context.threadId,
              sessionId: context.sessionId,
              provider: "opencode",
              resumeCursor: { sessionId: context.opencodeSessionId },
            });
          }

          if (msg.type === "text" && msg.part?.text) {
            this.emit("event", {
              type: "message",
              method: "opencode/message",
              kind: "data",
              threadId: context.threadId,
              turnId,
              provider: "opencode",
              content: msg.part.text,
            });
          }

          if (msg.type === "tool_use" && msg.part?.tool) {
            const toolPart = msg.part;
            const toolCallId = toolPart.callID || `call_${randomUUID().slice(0, 8)}`;
            const status = toolPart.state?.status || "pending";
            
            this.emit("event", {
              type: "tool_use",
              method: "opencode/tool_use",
              kind: "data",
              threadId: context.threadId,
              turnId,
              provider: "opencode",
              tool_id: toolCallId,
              tool_name: toolPart.tool,
              parameters: toolPart.state?.input,
            });

            if (status === "completed" || status === "error") {
              this.emit("event", {
                type: "tool_result",
                method: "opencode/tool_result",
                kind: status === "error" ? "error" : "data",
                threadId: context.threadId,
                turnId,
                provider: "opencode",
                tool_id: toolCallId,
                tool_name: toolPart.tool,
                status: status,
                output: toolPart.state?.output,
              });
            }
          }
        } catch (e) {
          // ignore
        }
      });

      const exitCode = await new Promise<number>((resolve) => {
        child.on("exit", (code) => resolve(code ?? 0));
      });

      this.emit("event", {
        type: "turn",
        method: "turn/ended",
        kind: "lifecycle",
        threadId: context.threadId,
        turnId,
        provider: "opencode",
        exitCode,
      });

    } catch (error) {
      this.emit("event", {
        type: "error",
        method: "turn/error",
        kind: "error",
        threadId: context.threadId,
        turnId,
        provider: "opencode",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      context.status = "idle";
      context.activeTurnId = null;
      context.activeProcess = null;
    }
  }

  private async ensureConnection(): Promise<OpencodeAcpConnection> {
    if (this.activeConnection) {
      return this.activeConnection;
    }

    if (this.initializePromise) {
      await this.initializePromise;
      return this.activeConnection!;
    }

    this.initializePromise = (async () => {
      const child = spawn("opencode", ["acp"], {
        env: buildPopupSafeEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });

      this.activeProcess = child;

      child.on("error", (err) => {
        this.emit("error", err);
      });

      child.on("exit", (code) => {
        this.activeConnection = null;
        this.activeProcess = null;
        this.initializePromise = null;
        if (code !== 0 && code !== null) {
          this.emit("error", new Error(`Opencode ACP exited with code ${code}`));
        }
      });

      // Simple JSON-RPC over stdio implementation
      const connection: OpencodeAcpConnection = {
        initialize: (params) => this.sendRequest(child, "session/initialize", params),
        newSession: (params) => this.sendRequest(child, "session/new", params),
        loadSession: (params) => this.sendRequest(child, "session/load", params),
        prompt: (params) => this.sendRequest(child, "session/prompt", params),
        cancel: (params) => this.sendRequest(child, "session/cancel", params),
      };

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        try {
          const msg = JSON.parse(line);
          this.handleIncomingMessage(msg);
        } catch (e) {
          // ignore
        }
      });

      await connection.initialize({ capabilities: {} });
      this.activeConnection = connection;
    })();

    await this.initializePromise;
    return this.activeConnection!;
  }

  private pendingRequests = new Map<number, { resolve: (val: any) => void, reject: (err: Error) => void }>();
  private nextRequestId = 1;

  private async sendRequest(child: ChildProcess, method: string, params: any): Promise<any> {
    const id = this.nextRequestId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      child.stdin!.write(JSON.stringify(msg) + "\n");
    });
  }

  private handleIncomingMessage(msg: any) {
    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const { resolve, reject } = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || "Unknown JSON-RPC error"));
      } else {
        resolve(msg.result);
      }
      return;
    }

    if (msg.method === "session/update") {
      this.handleSessionUpdate(msg.params);
    } else if (msg.method === "session/request_permission") {
      this.handlePermissionRequest(msg.params, msg.id);
    }
  }

  private handleSessionUpdate(params: any) {
    const threadId = this.threadIdByOpencodeSessionId.get(params.sessionId);
    if (!threadId) return;
    const context = this.sessions.get(threadId);
    if (!context || !context.activeTurnId) return;

    const update = params.update;
    const turnId = context.activeTurnId;

    if (update.agent_message_chunk) {
      this.emit("event", {
        type: "message",
        method: "opencode/message",
        kind: "data",
        threadId,
        turnId,
        provider: "opencode",
        content: update.agent_message_chunk,
      });
    }

    if (update.tool_call_update) {
      const toolCall = update.tool_call_update;
      this.emit("event", {
        type: "tool_update",
        method: "opencode/tool_update",
        kind: "data",
        threadId,
        turnId,
        provider: "opencode",
        tool_id: toolCall.toolCallId,
        tool_name: toolCall.title,
        status: toolCall.status,
        output: toolCall.output,
        tool_kind: toolCall.kind,
      });

      if (toolCall.status === "completed" || toolCall.status === "error") {
        this.emit("event", {
          type: "tool_result",
          method: "opencode/tool_result",
          kind: toolCall.status === "error" ? "error" : "data",
          threadId,
          turnId,
          provider: "opencode",
          tool_id: toolCall.toolCallId,
          tool_name: toolCall.title,
          status: toolCall.status,
          output: toolCall.output || toolCall.error,
        });
      }
    }
  }

  private async handlePermissionRequest(params: any, id: number) {
    const threadId = this.threadIdByOpencodeSessionId.get(params.sessionId);
    if (!threadId) return;
    const context = this.sessions.get(threadId);
    if (!context) return;

    const requestId = `acp_${randomUUID().slice(0, 8)}`;
    context.pendingApprovals.add(requestId);

    this.emit("event", {
      type: "approval",
      method: "opencode/approval_requested",
      kind: "data",
      threadId: context.threadId,
      requestId,
      provider: "opencode",
      message: params.message || "Permission required",
    });

    const decision = await new Promise<"approved" | "rejected">((resolve) => {
      this.pendingAcpApprovals.set(requestId, resolve);
    });

    this.pendingAcpApprovals.delete(requestId);

    const outcome = decision === "approved" ? "allowed" : "denied";
    this.activeProcess!.stdin!.write(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { outcome }
    }) + "\n");
  }

  respondToRequest(threadId: string, requestId: string, decision: "approved" | "rejected"): void {
    const resolver = this.pendingAcpApprovals.get(requestId);
    if (resolver) {
      resolver(decision);
    }
  }

  interruptTurn(threadId: string): void {
    const context = this.sessions.get(threadId);
    if (context?.opencodeSessionId && this.activeConnection) {
      void this.activeConnection.cancel({ sessionId: context.opencodeSessionId });
    }
  }

  stopSession(threadId: string): void {
    const context = this.sessions.get(threadId);
    if (context) {
      this.interruptTurn(threadId);
      this.sessions.delete(threadId);
    }
  }

  stopAll(): void {
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
    if (this.activeProcess) {
      this.activeProcess.kill();
      this.activeProcess = null;
      this.activeConnection = null;
    }
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  listSessions(): OpencodeSessionContext[] {
    return Array.from(this.sessions.values());
  }
}

function killChildTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall through to direct kill.
    }
  }

  try {
    child.kill("SIGTERM");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Process is already dead.
    }
  }
}
