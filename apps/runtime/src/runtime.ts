import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { RpcId, RuntimeStatus, ServerMessage, Session, UserQuestion } from "../../../packages/protocol/src/index.ts";
import { CodexProcess, object, string, type CodexFrame, type JsonObject } from "./codex.ts";
import { SessionStore } from "./store.ts";

const LIMIT = 200_000;
const text = (value: unknown) => typeof value === "string" ? value : "";
const rpcId = (value: unknown): RpcId => {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("Invalid request identifier");
  return value;
};
const detail = (value: JsonObject) => text(value.command) || text(value.reason) || JSON.stringify(value, null, 2).slice(0, 12000);

/** Sessions, provider requests, persistence and turn ownership sit behind one interface. */
export class Runtime {
  private sessions = new Map<string, Session>();
  private resumed = new Set<string>();
  private locks = new Set<string>();
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private codex: CodexProcess;
  private store: SessionStore;
  private command: string;
  private emit: (message: ServerMessage) => void;
  private closing = false;

  constructor(options: { directory: string; command: string; args?: string[]; env?: NodeJS.ProcessEnv; emit: (message: ServerMessage) => void }) {
    this.command = options.command;
    this.emit = options.emit;
    this.store = new SessionStore(options.directory);
    this.codex = new CodexProcess({ command: options.command, args: options.args, env: options.env,
      onFrame: (frame) => this.frame(frame), onExit: (error) => this.exited(error) });
  }
  async load() { for (const session of await this.store.load()) this.sessions.set(session.id, session); }
  snapshot(): ServerMessage { return { event: "snapshot", sessions: [...this.sessions.values()] }; }

  async dispatch(raw: unknown): Promise<unknown> {
    if (this.closing) throw new Error("Runtime is shutting down");
    const request = object(raw);
    const method = string(request.method);
    if (method === "status") return this.status();
    if (method === "sessions/list") return [...this.sessions.values()];
    const params = object(request.params);
    if (method === "session/create") return this.create(params);
    const sessionId = string(params.sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Unknown session");
    // Approval/question callbacks must be able to resolve a turn awaiting user input.
    if (method === "approval/respond") return this.approve(session, params);
    if (method === "question/respond") return this.answer(session, params);
    if (method === "turn/interrupt") {
      if (session.status !== "running" || !session.turnId) throw new Error("No active turn to interrupt");
      await this.codex.request("turn/interrupt", { threadId: session.threadId, turnId: session.turnId });
      return null;
    }
    if (method !== "turn/start") throw new Error("Unknown method");
    if (this.locks.has(sessionId) || session.status === "running") throw new Error("This session already has an active turn");
    const prompt = string(params.text).trim();
    if (!prompt || prompt.length > 32_000) throw new Error("Prompt must contain 1–32000 characters");
    this.locks.add(sessionId);
    try {
      await this.codex.ensure();
      if (!this.resumed.has(sessionId)) {
        const configuration = { cwd: session.cwd, approvalPolicy: "untrusted", sandbox: session.fullAccess ? "danger-full-access" : "read-only" };
        if (session.messages.length === 0) {
          // Codex only persists a thread after its first turn. An untouched local
          // session survives restarts, so recreate its empty provider thread.
          const started = object(await this.codex.request("thread/start", configuration));
          session.threadId = string(object(started.thread).id);
        } else {
          await this.codex.request("thread/resume", { threadId: session.threadId, ...configuration });
        }
        this.resumed.add(sessionId);
      }
      const message = { id: randomUUID(), role: "user" as const, text: prompt };
      session.messages.push(message);
      session.status = "running"; session.error = null; session.diff = "";
      try {
        await this.publish(session);
      } catch (error) {
        // Nothing reached Codex. Keep an empty thread eligible for recreation.
        session.messages = session.messages.filter((entry) => entry.id !== message.id);
        session.status = "error"; session.turnId = null; session.error = String(error);
        this.emit({ event: "session", session });
        throw error;
      }
      try {
        const response = object(await this.codex.request("turn/start", { threadId: session.threadId, input: [{ type: "text", text: prompt, text_elements: [] }] }));
        const turn = object(response.turn);
        if (session.status === "running") session.turnId = string(turn.id);
      } catch (error) {
        session.status = "error"; session.turnId = null; session.error = error instanceof Error ? error.message : String(error);
        this.emit({ event: "session", session });
        try { await this.store.save([...this.sessions.values()]); } catch { /* The request still reports the original failure. */ }
        throw error;
      }
      // A successful start remains active even when its snapshot cannot be saved.
      try { await this.publish(session); } catch (error) {
        this.emit({ event: "session", session });
        this.emit({ event: "runtime/error", message: `Cannot save sessions: ${String(error)}` });
      }
      return session;
    } finally { this.locks.delete(sessionId); }
  }

  async status(): Promise<RuntimeStatus> {
    try {
      const { stdout } = await promisify(execFile)(this.command, ["--version"], { timeout: 5000, maxBuffer: 4096 });
      return { codexAvailable: true, version: stdout.trim(), error: null };
    } catch (error) {
      return { codexAvailable: false, version: null, error: `Codex is unavailable. Install it and log in from Termux. ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async create(params: JsonObject): Promise<Session> {
    const cwdInput = string(params.cwd);
    if (!isAbsolute(cwdInput)) throw new Error("Use an absolute Termux project path");
    if (typeof params.fullAccess !== "boolean") throw new Error("Choose the project access mode explicitly");
    const cwd = await realpath(cwdInput);
    if (!(await stat(cwd)).isDirectory()) throw new Error("Project path must be a directory");
    await this.codex.ensure();
    const response = object(await this.codex.request("thread/start", {
      cwd, approvalPolicy: "untrusted", sandbox: params.fullAccess ? "danger-full-access" : "read-only", ephemeral: false,
    }));
    const thread = object(response.thread);
    const session: Session = {
      id: string(thread.id), threadId: string(thread.id), title: cwd.split("/").filter(Boolean).at(-1) || "Project", cwd,
      status: "idle", turnId: null, messages: [], tools: [], approvals: [], questions: [], diff: "", error: null,
      fullAccess: params.fullAccess,
    };
    this.sessions.set(session.id, session); this.resumed.add(session.id);
    await this.publish(session);
    return session;
  }

  private async approve(session: Session, params: JsonObject) {
    const id = rpcId(params.requestId);
    const approval = session.approvals.find((a) => a.id === id);
    if (!approval) throw new Error("Approval is no longer active");
    const decision = string(params.decision);
    if (!approval.choices.includes(decision)) throw new Error("Invalid approval decision");
    this.codex.respond(id, { decision });
    session.approvals = session.approvals.filter((a) => a.id !== id);
    await this.publish(session); return null;
  }

  private async answer(session: Session, params: JsonObject) {
    const id = rpcId(params.requestId);
    const pending = session.questions.find((q) => q.id === id);
    if (!pending) throw new Error("Question is no longer active");
    const input = object(params.answers);
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of pending.questions) {
      const value = input[question.id];
      if (!Array.isArray(value) || value.length === 0 || value.some((a) => typeof a !== "string" || a.length > 8000)) throw new Error("Answer every question");
      answers[question.id] = { answers: value as string[] };
    }
    this.codex.respond(id, { answers });
    session.questions = session.questions.filter((q) => q.id !== id);
    await this.publish(session); return null;
  }

  private frame(frame: CodexFrame) {
    const params = frame.params ?? {};
    const session = [...this.sessions.values()].find((s) => s.threadId === text(params.threadId));
    if (!session) { if (frame.id !== undefined) this.codex.reject(frame.id); return; }
    const method = frame.method;
    if (frame.id !== undefined) {
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        session.approvals.push({ id: frame.id, method, detail: detail(params), choices: ["accept", "decline", "cancel"] });
      } else if (method === "item/tool/requestUserInput") {
        const questions = Array.isArray(params.questions) ? params.questions : [];
        session.questions.push({ id: frame.id, questions: questions.map((q) => {
          const value = object(q);
          return { id: string(value.id), header: text(value.header), question: string(value.question), options: value.options } as UserQuestion;
        }) });
      } else { this.codex.reject(frame.id); return; }
      this.schedule(session); return;
    }
    if (method === "turn/started") {
      session.status = "running"; session.turnId = string(object(params.turn).id);
    } else if (method === "turn/completed") {
      const turn = object(params.turn);
      session.status = turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "error" : "idle";
      session.error = turn.error ? text(object(turn.error).message) || "Codex turn failed" : null;
      session.turnId = null; session.approvals = []; session.questions = [];
    } else if (method === "item/agentMessage/delta") {
      const id = string(params.itemId);
      let message = session.messages.find((m) => m.id === id);
      if (!message) { message = { id, role: "assistant", text: "" }; session.messages.push(message); }
      message.text = (message.text + text(params.delta)).slice(-LIMIT);
    } else if (method === "item/started" || method === "item/completed") {
      const item = object(params.item);
      const id = string(item.id);
      if (item.type === "agentMessage") {
        const existing = session.messages.find((m) => m.id === id);
        if (existing) { if (typeof item.text === "string") existing.text = item.text.slice(-LIMIT); }
        else session.messages.push({ id, role: "assistant", text: text(item.text).slice(-LIMIT) });
      } else if (item.type === "commandExecution" || item.type === "fileChange" || item.type === "mcpToolCall") {
        const existing = session.tools.find((t) => t.id === id);
        const tool = { id, kind: text(item.type), title: text(item.command) || text(item.tool) || "File changes",
          output: text(item.aggregatedOutput).slice(-LIMIT), status: text(item.status) || (method === "item/completed" ? "completed" : "running") };
        if (existing) Object.assign(existing, { ...tool, output: tool.output || existing.output });
        else session.tools.push(tool);
        session.tools = session.tools.slice(-100);
      }
    } else if (method === "item/commandExecution/outputDelta") {
      const tool = session.tools.find((t) => t.id === params.itemId);
      if (tool) tool.output = (tool.output + text(params.delta)).slice(-LIMIT);
    } else if (method === "turn/diff/updated") session.diff = text(params.diff).slice(-LIMIT);
    else if (method === "error") {
      session.error = params.error ? text(object(params.error).message) : "Codex reported an error";
      if (!params.willRetry) { session.status = "error"; session.turnId = null; session.approvals = []; session.questions = []; }
    } else return;
    this.schedule(session);
  }

  private schedule(session: Session) {
    this.dirty.add(session.id);
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = null;
      for (const id of this.dirty) { const s = this.sessions.get(id); if (s) this.emit({ event: "session", session: s }); }
      this.dirty.clear();
      void this.store.save([...this.sessions.values()]).catch((error: unknown) => this.emit({ event: "runtime/error", message: `Cannot save sessions: ${String(error)}` }));
    }, 80);
  }
  private async publish(session: Session) {
    await this.store.save([...this.sessions.values()]);
    this.emit({ event: "session", session });
  }
  private exited(error: Error) {
    this.resumed.clear();
    for (const session of this.sessions.values()) {
      if (session.status === "running") {
        session.status = "error"; session.error = error.message; session.turnId = null;
        session.approvals = []; session.questions = []; this.schedule(session);
      }
    }
    this.emit({ event: "runtime/error", message: error.message });
  }
  async close() {
    this.closing = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.codex.close();
    await this.store.save([...this.sessions.values()]);
  }
}
