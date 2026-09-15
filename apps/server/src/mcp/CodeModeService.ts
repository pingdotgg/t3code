// @effect-diagnostics globalTimers:off -- This native Promise host owns and clears its deadlines; it does not run Effect timers.
import * as NodeCrypto from "node:crypto";
import type { CodeModeCall, CodeModeExecutionResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
import type { CodeModeInput } from "./CodeModeProcess.ts";
import { CodeModeProcess, spawnCodeModeHost } from "./CodeModeProcess.ts";
import { CodeModeJournal, type JournalRecord } from "./CodeModeJournal.ts";
import { ServerConfig } from "../config.ts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

interface Execution {
  scope: McpInvocationScope;
  controller: AbortController;
  state: CodeModeExecutionResult;
  calls: Array<CodeModeCall>;
  logs: Array<string>;
  done: Promise<void>;
  settled: boolean;
  metadata: Omit<JournalRecord, "state" | "scope">;
  writing: Promise<void>;
  admitted: Promise<void>;
}

/** The environment owns admission, durable receipts and authority. Hosts never replay or reconnect. */
export class CodeModeHost {
  private readonly executions = new Map<string, Execution>();
  private inFlightCalls = 0;
  private disposed = false;
  private recoveryError: string | undefined;

  private readonly processHost: CodeModeProcess;
  private readonly journal: CodeModeJournal | undefined;
  constructor(journal?: CodeModeJournal, processHost = new CodeModeProcess()) {
    this.journal = journal;
    this.processHost = processHost;
  }

  async recover() {
    try {
      for (const record of (await this.journal?.read()) ?? []) {
        const state = {
          ...record.state,
          ...(record.state.status === "running"
            ? {
                status: "failed" as const,
                error: "Server restarted; execution was interrupted and was not replayed.",
              }
            : {}),
          calls: record.state.calls.map((call) =>
            call.status === "running"
              ? {
                  ...call,
                  status: "failed" as const,
                  result: {
                    message:
                      "Dispatch outcome is uncertain; inspect durable thread state before retrying.",
                  },
                }
              : call,
          ),
        };
        const entry: Execution = {
          scope: { ...record.scope, issuedAt: 0, capabilities: new Set() },
          controller: new AbortController(),
          state,
          calls: [...state.calls],
          logs: [...state.logs],
          done: Promise.resolve(),
          settled: true,
          metadata: {
            runId: record.runId,
            requestId: record.requestId,
            codeHash: record.codeHash,
            createdAt: record.createdAt,
          },
          writing: Promise.resolve(),
          admitted: Promise.resolve(),
        };
        this.executions.set(state.executionId, entry);
        await this.checkpoint(entry);
      }
    } catch {
      this.recoveryError =
        "Code mode could not recover its journal; repair it before executing more code.";
    }
  }

  private checkpoint(entry: Execution) {
    if (!this.journal) return Promise.resolve();
    const record: JournalRecord = {
      ...entry.metadata,
      scope: entry.scope,
      state: {
        ...entry.state,
        logs: [...entry.logs],
        calls: entry.calls.map((call) => ({ ...call })),
      },
    };
    entry.writing = entry.writing.then(() => this.journal!.write(record));
    return entry.writing;
  }

  async start(
    input: Omit<CodeModeInput, "calls" | "logs" | "signal"> & {
      scope: McpInvocationScope;
      controller: AbortController;
      timeoutMs: number;
      onSettled: () => void;
      clientRequestId?: string | undefined;
      runId?: string | undefined;
    },
  ) {
    if (this.disposed) throw new Error("Code mode host is shutting down.");
    if (this.recoveryError) throw new Error(this.recoveryError);
    const codeHash = NodeCrypto.createHash("sha256").update(input.code).digest("hex");
    if (input.clientRequestId !== undefined) {
      const existing = Array.from(this.executions.values()).find(
        (entry) =>
          entry.scope.environmentId === input.scope.environmentId &&
          entry.scope.threadId === input.scope.threadId &&
          entry.scope.providerInstanceId === input.scope.providerInstanceId &&
          entry.metadata.requestId === input.clientRequestId,
      );
      if (existing) {
        input.onSettled();
        if (existing.metadata.codeHash !== codeHash)
          throw new Error("clientRequestId already belongs to different code.");
        if (existing.scope.providerSessionId !== input.scope.providerSessionId) {
          if (!existing.settled)
            throw new Error("Execution belongs to a different active session.");
        }
        await existing.admitted;
        return existing.state.executionId;
      }
    }
    const running = Array.from(this.executions.values()).filter((entry) => !entry.settled);
    if (
      running.length >= 8 ||
      running.filter((entry) => entry.scope.providerSessionId === input.scope.providerSessionId)
        .length >= 2
    ) {
      input.onSettled();
      throw new Error("Code mode allows 2 running executions per session and 8 per environment.");
    }
    const evicted: Array<string> = [];
    while (this.executions.size >= 32) {
      const terminal = Array.from(this.executions).find(([, entry]) => entry.settled);
      if (!terminal) break;
      this.executions.delete(terminal[0]);
      evicted.push(terminal[0]);
    }
    const executionId = NodeCrypto.randomUUID();
    const calls: Array<CodeModeCall> = [];
    const logs: Array<string> = [];
    const state: CodeModeExecutionResult = {
      executionId,
      status: "running",
      result: null,
      error: null,
      calls,
      logs,
    };
    const entry: Execution = {
      scope: input.scope,
      controller: input.controller,
      state,
      calls,
      logs,
      done: Promise.resolve(),
      settled: false,
      metadata: {
        requestId: input.clientRequestId ?? null,
        runId: input.runId ?? null,
        codeHash,
        createdAt: performance.timeOrigin + performance.now(),
      },
      writing: Promise.resolve(),
      admitted: Promise.resolve(),
    };
    this.executions.set(executionId, entry);
    const onAbort = () => {
      if (entry.state.status === "running")
        entry.state = {
          ...entry.state,
          status: "cancelled",
          error: "Code mode execution cancelled.",
        };
    };
    input.controller.signal.addEventListener("abort", onAbort, { once: true });
    if (input.controller.signal.aborted) onAbort();
    const timer = setTimeout(() => {
      if (entry.state.status !== "running") return;
      entry.state = { ...entry.state, status: "failed", error: "Code mode execution timed out." };
      entry.controller.abort();
    }, input.timeoutMs);
    entry.admitted = (async () => {
      for (const id of evicted) await this.journal?.remove(id);
      await this.checkpoint(entry);
    })();
    entry.done = (async () => {
      await entry.admitted;
      return this.processHost.execute({
        executionId,
        ...input,
        calls,
        logs,
        signal: input.controller.signal,
        checkpoint: () => this.checkpoint(entry),
        invoke: async (name, args, signal) => {
          if (this.inFlightCalls >= 32)
            throw new Error("Code mode environment call capacity is exhausted.");
          this.inFlightCalls++;
          try {
            return await input.invoke(name, args, signal);
          } finally {
            this.inFlightCalls--;
          }
        },
      });
    })()
      .then(
        (result) => {
          if (entry.state.status === "running")
            entry.state = { ...entry.state, status: "completed", result };
        },
        (error) => {
          if (entry.state.status === "running")
            entry.state = {
              ...entry.state,
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            };
        },
      )
      .finally(async () => {
        clearTimeout(timer);
        input.controller.signal.removeEventListener("abort", onAbort);
        try {
          await this.checkpoint(entry);
        } catch {
          entry.state = {
            ...entry.state,
            status: "failed",
            error: "Code mode journal could not be saved; inspect thread state before retrying.",
          };
        } finally {
          entry.settled = true;
          input.onSettled();
        }
      });
    try {
      await entry.admitted;
    } catch {
      await entry.done;
      throw new Error("Code mode could not persist execution admission.");
    }
    return executionId;
  }

  private owned(executionId: string, scope: McpInvocationScope) {
    const entry = this.executions.get(executionId);
    if (
      !entry ||
      entry.scope.environmentId !== scope.environmentId ||
      entry.scope.threadId !== scope.threadId ||
      (!entry.settled && entry.scope.providerSessionId !== scope.providerSessionId) ||
      entry.scope.providerInstanceId !== scope.providerInstanceId
    ) {
      throw new Error("Code mode execution was not found in this session.");
    }
    return entry;
  }

  async wait(executionId: string, scope: McpInvocationScope, waitMs: number, includeCalls = false) {
    const entry = this.owned(executionId, scope);
    if (entry.state.status === "running" && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entry.done,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, waitMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    return {
      ...entry.state,
      logs: [...entry.logs],
      calls:
        includeCalls || entry.state.status === "failed"
          ? entry.calls.map((call) => ({ ...call }))
          : [],
    };
  }

  async cancel(executionId: string, scope: McpInvocationScope) {
    const entry = this.owned(executionId, scope);
    if (entry.state.status === "running") {
      entry.state = {
        ...entry.state,
        status: "cancelled",
        error: "Code mode execution cancelled.",
      };
      entry.controller.abort();
    }
    await entry.done;
    return this.wait(executionId, scope, 0, true);
  }

  async dispose() {
    this.disposed = true;
    for (const entry of this.executions.values()) entry.controller.abort();
    await Promise.all(Array.from(this.executions.values(), (entry) => entry.done));
    await this.processHost.dispose();
    this.executions.clear();
  }

  invalidateRun(threadId: McpInvocationScope["threadId"], runId?: string) {
    for (const entry of this.executions.values()) {
      if (
        !entry.settled &&
        entry.scope.threadId === threadId &&
        (runId === undefined || entry.metadata.runId === runId)
      )
        entry.controller.abort();
    }
  }
}

export class CodeModeService extends Context.Service<CodeModeService, CodeModeHost>()(
  "t3/mcp/CodeModeService",
) {}

export const layer = Layer.effect(
  CodeModeService,
  Effect.acquireRelease(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const architecture = yield* HostProcessArchitecture;
      const host = new CodeModeHost(
        new CodeModeJournal(path.join(config.stateDir, "code-mode"), platform),
        new CodeModeProcess(() => spawnCodeModeHost({ platform, architecture })),
      );
      yield* Effect.promise(() => host.recover());
      return host;
    }),
    (host) => Effect.promise(() => host.dispose()),
  ),
);

export const memoryLayer = Layer.effect(
  CodeModeService,
  Effect.acquireRelease(
    Effect.sync(() => new CodeModeHost()),
    (host) => Effect.promise(() => host.dispose()),
  ),
);
