import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  type AgentConfig,
  type AgentExit,
  type OutputChunk,
  agentConfigSchema,
} from "@acme/contracts";
import type { IPty } from "node-pty";

export interface ProcessManagerEvents {
  output: [chunk: OutputChunk];
  exit: [exit: AgentExit];
}

export class ProcessManager extends EventEmitter<ProcessManagerEvents> {
  private sessions = new Map<string, ChildProcess>();
  private ptySessions = new Map<string, IPty>();

  spawn(raw: AgentConfig): string {
    const config = agentConfigSchema.parse(raw);
    const sessionId = randomUUID();

    if (config.usePty) {
      return this.spawnPty(sessionId, config);
    }

    return this.spawnProcess(sessionId, config);
  }

  private spawnProcess(sessionId: string, config: AgentConfig): string {
    const child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: config.env ? { ...process.env, ...config.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.sessions.set(sessionId, child);

    child.stdout?.on("data", (data: Buffer) => {
      this.emit("output", {
        sessionId,
        stream: "stdout",
        data: data.toString(),
      });
    });

    child.stderr?.on("data", (data: Buffer) => {
      this.emit("output", {
        sessionId,
        stream: "stderr",
        data: data.toString(),
      });
    });

    child.on("exit", (code, signal) => {
      this.sessions.delete(sessionId);
      this.emit("exit", {
        sessionId,
        code: code ?? null,
        signal: signal ?? null,
      });
    });

    return sessionId;
  }

  private spawnPty(sessionId: string, config: AgentConfig): string {
    const pty = require("node-pty") as typeof import("node-pty");

    const ptyProcess = pty.spawn(config.command, config.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: config.cwd ?? process.cwd(),
      env: (config.env ? { ...process.env, ...config.env } : process.env) as Record<string, string>,
    });

    this.ptySessions.set(sessionId, ptyProcess);

    ptyProcess.onData((data) => {
      this.emit("output", {
        sessionId,
        stream: "stdout",
        data,
      });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.ptySessions.delete(sessionId);
      this.emit("exit", {
        sessionId,
        code: exitCode,
        signal: signal !== undefined ? String(signal) : null,
      });
    });

    return sessionId;
  }

  write(sessionId: string, data: string): void {
    const child = this.sessions.get(sessionId);
    if (child) {
      child.stdin?.write(data);
      return;
    }

    const pty = this.ptySessions.get(sessionId);
    if (pty) {
      pty.write(data);
      return;
    }

    throw new Error(`No session: ${sessionId}`);
  }

  kill(sessionId: string): void {
    const child = this.sessions.get(sessionId);
    if (child) {
      child.kill();
      return;
    }

    const pty = this.ptySessions.get(sessionId);
    if (pty) {
      pty.kill();
      return;
    }
  }

  killAll(): void {
    for (const child of this.sessions.values()) {
      child.kill();
    }
    this.sessions.clear();

    for (const pty of this.ptySessions.values()) {
      pty.kill();
    }
    this.ptySessions.clear();
  }
}
