import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import {
  type ProviderEvent,
  type ProviderInterruptTurnInput,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderStopSessionInput,
  type ProviderTurnStartResult,
  providerInterruptTurnInputSchema,
  providerSendTurnInputSchema,
  providerSessionStartInputSchema,
  providerStopSessionInputSchema,
} from "@acme/contracts";
import { CodexAppServerManager } from "./codexAppServerManager";

export interface ProviderManagerEvents {
  event: [event: ProviderEvent];
}

export class ProviderManager extends EventEmitter<ProviderManagerEvents> {
  private readonly codex = new CodexAppServerManager();
  private readonly logStream: fs.WriteStream;
  private disposed = false;
  private readonly onCodexEvent = (event: ProviderEvent) => {
    if (this.disposed) {
      return;
    }

    this.logStream.write(`${JSON.stringify(event)}\n`);
    this.emit("event", event);
  };

  constructor() {
    super();

    const logsDir = path.resolve(process.cwd(), ".logs");
    fs.mkdirSync(logsDir, { recursive: true });
    this.logStream = fs.createWriteStream(path.join(logsDir, "events.txt"), {
      flags: "a",
    });

    this.codex.on("event", this.onCodexEvent);
  }

  async startSession(raw: ProviderSessionStartInput): Promise<ProviderSession> {
    const input = providerSessionStartInputSchema.parse(raw);
    if (input.provider !== "codex") {
      throw new Error(`Provider '${input.provider}' is not implemented yet.`);
    }

    return this.codex.startSession(input);
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

  stopSession(raw: ProviderStopSessionInput): void {
    const input = providerStopSessionInputSchema.parse(raw);
    this.codex.stopSession(input.sessionId);
  }

  listSessions(): ProviderSession[] {
    return this.codex.listSessions();
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
    this.logStream.end();
  }
}
