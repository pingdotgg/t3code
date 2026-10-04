import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { RpcId } from "../../../packages/protocol/src/index.ts";

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as JsonObject;
}
export function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}
export interface CodexFrame { id?: RpcId; method?: string; params?: JsonObject; result?: unknown; error?: { message?: string } }

/** Owns one stdio app-server. Codex RPC details never escape into the mobile UI. */
export class CodexProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private starting: Promise<void> | null = null;
  private terminating: Promise<void> | null = null;
  private stopped = false;
  private stderr = "";
  private options: { command: string; args?: string[]; env?: NodeJS.ProcessEnv; onFrame: (frame: CodexFrame) => void; onExit: (error: Error) => void };

  constructor(options: CodexProcess["options"]) { this.options = options; }

  async ensure(): Promise<void> {
    if (this.stopped) throw new Error("Runtime is shutting down");
    if (this.terminating) await this.terminating;
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start() {
    const child = spawn(this.options.command, this.options.args ?? ["app-server"], {
      env: this.options.env ?? process.env, stdio: "pipe", shell: false,
    });
    this.child = child;
    this.stderr = "";
    let ended = false;
    const fail = (error: Error) => {
      if (ended) return;
      ended = true;
      if (this.child === child) this.child = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear();
      if (!this.stopped) this.options.onExit(error);
    };
    child.on("error", (error) => fail(new Error(`Cannot start Codex: ${error.message}`)));
    child.on("exit", (code, signal) => fail(new Error(`Codex exited (${signal ?? code}). ${this.stderr}`)));
    child.stdin.on("error", fail);
    child.stderr.on("data", (data: Buffer) => { this.stderr = (this.stderr + data.toString()).slice(-4000); });
    // Codex app-server uses one JSON frame per line. Never parse terminal escape output.
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const frame = object(JSON.parse(line)) as CodexFrame;
        if (frame.id !== undefined && !frame.method) {
          const pending = typeof frame.id === "number" ? this.pending.get(frame.id) : undefined;
          if (!pending) return;
          clearTimeout(pending.timer); this.pending.delete(frame.id as number);
          if (frame.error) pending.reject(new Error(frame.error.message ?? "Codex request failed"));
          else pending.resolve(frame.result);
        } else if (frame.method) this.options.onFrame(frame);
      } catch (error) {
        fail(new Error(`Invalid Codex protocol frame: ${error instanceof Error ? error.message : String(error)}`));
        child.kill();
      }
    });
    try {
      await this.request("initialize", {
        clientInfo: { name: "t3mobile", title: "T3 Mobile", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      this.write({ method: "initialized" });
    } catch (error) { child.kill(); throw error; }
  }

  request(method: string, params: JsonObject): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error("Codex is not running"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out request may already be executing. Terminate and await that
        // app-server before admitting another turn; never replay uncertain work.
        const child = this.child;
        if (child) {
          this.terminating = new Promise<void>((done) => child.once("exit", done)).finally(() => { this.terminating = null; });
          child.kill("SIGKILL");
        }
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out. The provider was stopped; check the project before retrying.`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  respond(id: RpcId, result: unknown) { this.write({ id, result }); }
  reject(id: RpcId) { this.write({ id, error: { code: -32601, message: "Request not supported by T3 Mobile" } }); }
  private write(frame: object) {
    if (!this.child || this.child.stdin.destroyed) throw new Error("Codex is not running");
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }
  async close() {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
}
