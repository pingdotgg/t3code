// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- This supervisor owns a captured ChildProcess, bounded stdio, and forced termination deadlines.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import type { CodeModeCall } from "@t3tools/contracts";
import {
  bridgeError,
  decodeGuestMessage,
  frames,
  frameWriter,
  type GuestMessage,
} from "./CodeModeProtocol.ts";

export type CodeModeInput = {
  code: string;
  tools: ReadonlyArray<string>;
  invoke: (name: string, args: unknown, signal: AbortSignal) => Promise<unknown>;
  signal: AbortSignal;
  calls: Array<CodeModeCall>;
  logs: Array<string>;
  onLog?: (text: string) => void;
  executionId?: string;
  checkpoint?: () => Promise<void>;
  onReady?: (pid: number) => void;
  onStarted?: (host: { pid: number; threadId: number }) => void;
};
type Stats = Extract<GuestMessage, { type: "stats" }>;

export function spawnCodeModeHost(
  runtime = {
    platform: Context.get(Context.empty(), HostProcessPlatform),
    architecture: Context.get(Context.empty(), HostProcessArchitecture),
  },
) {
  const name = runtime.platform === "win32" ? "t3-code-mode-host.exe" : "t3-code-mode-host";
  const key = `${runtime.platform}-${runtime.architecture}`;
  const candidates = process.env.T3CODE_CODE_MODE_HOST_PATH
    ? [process.env.T3CODE_CODE_MODE_HOST_PATH]
    : [
        NodePath.join(import.meta.dirname, "code-mode-host", key, name),
        NodePath.join(import.meta.dirname, "code-mode-host", name),
        NodePath.join(import.meta.dirname, "../code-mode-host", name),
        NodePath.join(NodePath.dirname(process.execPath), "code-mode-host", key, name),
        NodePath.join(NodePath.dirname(process.execPath), "code-mode-host", name),
        NodePath.resolve(import.meta.dirname, "../../dist/code-mode-host", key, name),
        NodePath.resolve(
          import.meta.dirname,
          "../../../../native/code-mode-host/target/release",
          name,
        ),
      ];
  const binary = candidates.find((candidate) => NodeFS.existsSync(candidate));
  if (!binary)
    throw new Error(
      "Native code mode host is missing; run vp run build:code-mode-host in apps/server.",
    );
  // No provider credentials or inherited runtime injection options reach the host.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP", "LANG"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return NodeChildProcess.spawn(binary, [], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** One lazy process per environment. Only new evaluations may use a replacement host. */
export class CodeModeProcess {
  private connection: Connection | undefined;
  private disposed = false;
  private readonly spawn: typeof spawnCodeModeHost;
  constructor(spawn = spawnCodeModeHost) {
    this.spawn = spawn;
  }
  execute(input: CodeModeInput) {
    input.signal.throwIfAborted();
    if (this.disposed) throw new Error("Code mode host is shutting down.");
    this.connection ??= new Connection(this.spawn, (connection) => {
      if (this.connection === connection) this.connection = undefined;
    });
    return this.connection.execute(input);
  }
  async stats() {
    if (!this.connection) return null;
    return this.connection.stats();
  }
  async dispose() {
    this.disposed = true;
    await this.connection?.dispose();
  }
}

class Connection {
  readonly child: ReturnType<typeof spawnCodeModeHost>;
  readonly ready = Promise.withResolvers<void>();
  private readonly closed = Promise.withResolvers<void>();
  private readonly executions = new Map<string, Bridge>();
  private readonly write: ReturnType<typeof frameWriter>;
  private isReady = false;
  private stopping = false;
  private stderr = "";
  private readonly startup: ReturnType<typeof setTimeout>;
  private sample: ReturnType<typeof Promise.withResolvers<Stats>> | undefined;
  private sampleTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(spawn: typeof spawnCodeModeHost, onClose: (connection: Connection) => void) {
    this.child = spawn();
    this.write = frameWriter(this.child.stdin);
    void this.ready.promise.catch(() => {});
    this.startup = setTimeout(() => this.fail(new Error("Code host startup timed out.")), 10_000);
    const read = frames((raw) => {
      const message = decodeGuestMessage(raw);
      if (this.stopping) return;
      if (message.type === "ready") {
        if (this.isReady || message.pid !== this.child.pid)
          throw new Error("Invalid code host readiness.");
        this.isReady = true;
        clearTimeout(this.startup);
        this.ready.resolve();
        return;
      }
      if (!this.isReady) throw new Error("Code host was not ready.");
      if (message.type === "stats") {
        if (
          !this.sample ||
          message.pid !== this.child.pid ||
          message.workers < 0 ||
          message.workers > 8
        )
          throw new Error("Invalid code host statistics.");
        clearTimeout(this.sampleTimer);
        this.sample.resolve(message);
        this.sample = undefined;
        return;
      }
      const execution = this.executions.get(message.executionId);
      if (!execution) throw new Error("Code host sent an unknown execution.");
      execution.receive(message);
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        read(chunk);
      } catch (error) {
        this.fail(error);
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(0, 2_000);
    });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stdout.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", (code, signal) => {
      this.stopping = true;
      clearTimeout(this.startup);
      clearTimeout(this.sampleTimer);
      const error = new Error(
        `Code host exited unexpectedly (${signal ?? code}). ${this.stderr}`.slice(0, 2_000),
      );
      this.ready.reject(error);
      this.sample?.reject(error);
      for (const execution of this.executions.values()) execution.finish(error);
      onClose(this);
      this.closed.resolve();
    });
  }
  fail(error: unknown) {
    if (this.stopping) return;
    this.stopping = true;
    const failure = new Error(
      (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
    );
    this.ready.reject(failure);
    this.sample?.reject(failure);
    for (const execution of this.executions.values()) execution.hostFailure(failure);
    this.child.kill("SIGKILL");
  }
  send(message: unknown) {
    if (this.stopping) return Promise.reject(new Error("Code host is stopping."));
    return this.write(message).catch((error) => {
      this.fail(error);
      throw error;
    });
  }
  execute(input: CodeModeInput) {
    if (this.stopping)
      throw new Error("Code host is stopping; retry a new submission after shutdown.");
    if (this.executions.size >= 8) throw new Error("Code host worker capacity is exhausted.");
    const id = input.executionId ?? NodeCrypto.randomUUID();
    if (this.executions.has(id)) throw new Error("Duplicate code execution.");
    const bridge = new Bridge(this, id, input);
    this.executions.set(id, bridge);
    return bridge.run().finally(() => this.executions.delete(id));
  }
  async stats() {
    await this.ready.promise;
    if (this.sample) return this.sample.promise;
    this.sample = Promise.withResolvers<Stats>();
    const promise = this.sample.promise;
    this.sampleTimer = setTimeout(
      () => this.fail(new Error("Code host health check timed out.")),
      5_000,
    );
    void this.send({ type: "stats" }).catch(() => {});
    return promise;
  }
  async dispose() {
    this.fail(new Error("Code mode host is shutting down."));
    await this.closed.promise;
  }
}

/** Tool dispatch and journals stay in the server, independently of guest lifetime. */
class Bridge {
  private readonly connection: Connection;
  private readonly id: string;
  private readonly input: CodeModeInput;
  private readonly controller = new AbortController();
  private readonly completion = Promise.withResolvers<unknown>();
  private readonly dispatches = new Set<Promise<void>>();
  private readonly ids = new Set<number>();
  private started = false;
  private sent = false;
  private finished = false;
  private failure: Error | undefined;
  private cancelTimer: ReturnType<typeof setTimeout> | undefined;
  private active = 0;
  private journalBytes = 0;
  private readonly abort = () => this.cancel(new Error("Code mode execution cancelled."));
  constructor(connection: Connection, id: string, input: CodeModeInput) {
    this.connection = connection;
    this.id = id;
    this.input = input;
    void this.completion.promise.catch(() => {});
  }
  async run() {
    this.input.signal.addEventListener("abort", this.abort, { once: true });
    if (this.input.signal.aborted) this.abort();
    try {
      await Promise.race([this.connection.ready.promise, this.completion.promise]);
      if (!this.finished) {
        this.input.onReady?.(this.connection.child.pid!);
        this.input.signal.throwIfAborted();
        this.sent = true;
        await this.connection.send({
          type: "start",
          executionId: this.id,
          code: this.input.code,
          tools: this.input.tools,
        });
      }
      return await this.completion.promise;
    } finally {
      this.input.signal.removeEventListener("abort", this.abort);
      clearTimeout(this.cancelTimer);
      this.controller.abort();
      await Promise.all(this.dispatches);
      for (const [index, call] of this.input.calls.entries()) {
        if (call.status === "running")
          this.input.calls[index] = {
            ...call,
            status: "failed",
            result: {
              message: "Host ended before this call returned; accepted effects may still exist.",
            },
          };
      }
    }
  }
  hostFailure(error: Error) {
    this.failure ??= error;
    this.controller.abort();
  }
  finish(error?: Error, value: unknown = null) {
    if (this.finished) return;
    this.finished = true;
    this.failure ??= error;
    clearTimeout(this.cancelTimer);
    this.controller.abort();
    if (this.failure) this.completion.reject(this.failure);
    else this.completion.resolve(value);
  }
  private cancel(error: Error) {
    if (this.finished || this.failure) return;
    this.failure = error;
    this.controller.abort();
    if (!this.sent) {
      this.finish();
      return;
    }
    void this.connection.send({ type: "cancel", executionId: this.id }).catch(() => {});
    // If thread termination or the host event loop wedges, kill the owned process.
    this.cancelTimer = setTimeout(
      () => this.connection.fail(new Error("Code host did not acknowledge worker termination.")),
      1_000,
    );
  }
  receive(message: Exclude<GuestMessage, { type: "ready" | "stats" }>) {
    if (this.finished) throw new Error("Code host sent a message after completion.");
    if (message.type === "done") {
      const json = JSON.stringify(message.value);
      const error =
        Buffer.byteLength(json) > 64 * 1024
          ? new Error("Code host output exceeds 64 KiB.")
          : message.failed
            ? new Error(
                (message.value &&
                typeof message.value === "object" &&
                "message" in message.value &&
                typeof message.value.message === "string"
                  ? message.value.message
                  : String(message.value)
                ).slice(0, 2_000),
              )
            : this.active > 0
              ? new Error("Script returned with unawaited tool calls; await every call.")
              : undefined;
      this.finish(error, message.value);
      return;
    }
    if (this.failure) return;
    if (message.type === "started") {
      if (this.started) throw new Error("Code host started an execution twice.");
      this.started = true;
      this.input.onStarted?.({ pid: this.connection.child.pid!, threadId: message.threadId });
      return;
    }
    if (!this.started) throw new Error("Code worker was not started.");
    if (message.type === "log") {
      if (this.input.logs.length >= 20 || Buffer.byteLength(message.text) > 2_000)
        return this.cancel(new Error("Code host log limit exceeded."));
      this.input.logs.push(message.text);
      this.input.onLog?.(message.text);
      return;
    }
    if (
      !this.input.tools.includes(message.tool) ||
      this.ids.has(message.id) ||
      this.ids.size >= 32 ||
      this.active >= 8
    )
      return this.cancel(new Error("Invalid code host call or call limit exceeded."));
    if (Buffer.byteLength(JSON.stringify(message.args)) > 64 * 1024)
      return this.cancel(new Error("Tool arguments exceed 64 KiB."));
    this.ids.add(message.id);
    this.active++;
    const record: { -readonly [K in keyof CodeModeCall]: CodeModeCall[K] } = {
      tool: message.tool,
      status: "running",
      result: null,
    };
    this.input.calls.push(record);
    const dispatch = (async () => {
      await this.input.checkpoint?.();
      this.controller.signal.throwIfAborted();
      let failed = false,
        result: unknown;
      try {
        result = await this.input.invoke(message.tool, message.args, this.controller.signal);
      } catch (error) {
        failed = true;
        result = bridgeError(error);
      }
      const json = JSON.stringify(result ?? null);
      this.journalBytes += Buffer.byteLength(json);
      if (Buffer.byteLength(json) > 64 * 1024 || this.journalBytes > 256 * 1024)
        throw new Error("Code mode value or journal limit exceeded.");
      record.status = failed ? "failed" : "completed";
      record.result = JSON.parse(json);
      // Save acknowledged results before guest delivery. Acceptance and this file save
      // are not one transaction; a server crash in between leaves an uncertain call.
      await this.input.checkpoint?.();
      this.active--;
      if (!this.finished && !this.failure)
        await this.connection.send({
          type: "reply",
          executionId: this.id,
          id: message.id,
          failed,
          value: record.result,
        });
    })().catch((error) => this.cancel(error instanceof Error ? error : new Error(String(error))));
    this.dispatches.add(dispatch);
    void dispatch.finally(() => this.dispatches.delete(dispatch));
  }
}
