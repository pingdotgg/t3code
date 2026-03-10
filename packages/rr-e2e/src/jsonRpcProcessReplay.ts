import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { resolveInteraction } from "./interactionResolver.ts";
import type { ReplayFixture } from "./types.ts";

export interface ReplayJsonRpcRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface ReplayJsonRpcSpawnInput {
  readonly binaryPath: string;
  readonly cwd: string;
}

export interface ReplayJsonRpcVersionCheckResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface ReplayJsonRpcProcessController {
  readonly spawnAppServer: (input: ReplayJsonRpcSpawnInput) => ReplayJsonRpcChildProcess;
  readonly runVersionCheck: (input: unknown) => ReplayJsonRpcVersionCheckResult;
  readonly kill: (child: ReplayJsonRpcChildProcess) => void;
}

export interface CreateReplayJsonRpcProcessControllerOptions {
  readonly requestService: string;
  readonly versionCheckService: string;
  readonly requestContext: (
    input: ReplayJsonRpcSpawnInput,
    request: ReplayJsonRpcRequest,
  ) => unknown;
}

export class ReplayJsonRpcChildProcess extends EventEmitter<{
  error: [error: Error];
  exit: [code: number | null, signal: NodeJS.Signals | null];
}> {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable & { writable: boolean };
  readonly pid = undefined;

  killed = false;
  private inputBuffer = "";

  constructor(
    private readonly onRequest: (
      request: ReplayJsonRpcRequest,
      child: ReplayJsonRpcChildProcess,
    ) => void,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          this.handleStdinChunk(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
          callback();
        } catch (error) {
          const normalized =
            error instanceof Error
              ? error
              : new Error(`Failed to process replay JSON-RPC stdin: ${String(error)}`);
          this.emit("error", normalized);
          callback(normalized);
        }
      },
    }) as Writable & { writable: boolean };
  }

  kill(): boolean {
    if (this.killed) {
      return false;
    }
    this.killed = true;
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }

  writeJsonLine(message: unknown): void {
    if (!this.killed) {
      this.stdout.write(`${JSON.stringify(message)}\n`);
    }
  }

  private handleStdinChunk(chunk: string): void {
    this.inputBuffer += chunk;
    while (true) {
      const newlineIndex = this.inputBuffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = this.inputBuffer.slice(0, newlineIndex).trim();
      this.inputBuffer = this.inputBuffer.slice(newlineIndex + 1);
      if (!line) continue;

      const message = JSON.parse(line) as unknown;
      if (typeof message !== "object" || message === null || !("method" in message)) continue;
      if (
        !("id" in message) ||
        (typeof message.id !== "string" && typeof message.id !== "number")
      ) {
        continue;
      }
      const method = (message as { method: unknown }).method;
      if (typeof method !== "string") continue;

      this.onRequest(
        {
          id: message.id,
          method,
          ...("params" in message ? { params: (message as { params?: unknown }).params } : {}),
        },
        this,
      );
    }
  }
}

function toReplayError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function createReplayJsonRpcProcessController(
  fixture: ReplayFixture,
  state: Record<string, unknown>,
  options: CreateReplayJsonRpcProcessControllerOptions,
): ReplayJsonRpcProcessController {
  return {
    spawnAppServer: (input) =>
      new ReplayJsonRpcChildProcess((request, child) => {
        let result: unknown;
        let notifications: ReadonlyArray<unknown> = [];
        try {
          const resolved = resolveInteraction<unknown>(
            fixture,
            options.requestService,
            options.requestContext(input, request),
            state,
          );
          result = resolved.result;
          notifications = resolved.notifications;
        } catch (error) {
          queueMicrotask(() => {
            child.writeJsonLine({
              id: request.id,
              error: { message: toReplayError(error).message },
            });
          });
          return;
        }

        queueMicrotask(() => {
          child.writeJsonLine({ id: request.id, result });
          for (const notification of notifications) {
            child.writeJsonLine(notification);
          }
        });
      }),
    runVersionCheck: (input) => {
      try {
        return resolveInteraction<ReplayJsonRpcVersionCheckResult>(
          fixture,
          options.versionCheckService,
          input,
          state,
        ).result;
      } catch (error) {
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: toReplayError(error),
        };
      }
    },
    kill: (child) => {
      child.kill();
    },
  };
}
