// @effect-diagnostics globalTimers:off -- Node IPC deadlines are owned by the child process lifecycle.
// @effect-diagnostics nodeBuiltinImport:off -- Owns the extension subprocess and its Node IPC boundary.
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { ownWindowsProcessTree } from "./windowsProcessTree.ts";
import { extensionDiagnostic } from "./diagnostic.ts";
export interface ExtensionHostLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export class ExtensionRequestTimeoutError extends Schema.TaggedError<ExtensionRequestTimeoutError>()(
  "ExtensionRequestTimeoutError",
  { operation: Schema.String },
) {
  override get message() {
    return `Extension ${this.operation} operation timed out.`;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class ExtensionProcess {
  private readonly platform: NodeJS.Platform;
  private readonly child: NodeChildProcess.ChildProcess;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      operation: string;
    }
  >();
  private readonly hostCalls = new Map<number, { controller: AbortController; owner: unknown }>();
  private nextId = 0;
  private stopping = false;
  private exited = false;
  private closeWindowsJob: (() => void) | undefined;
  readonly ready: Promise<void>;

  constructor(options: {
    cwd: string;
    platform: NodeJS.Platform;
    launch: ExtensionHostLaunch;
    hostCall: (method: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
    event: (event: unknown) => void;
    failed: () => void;
    log: (chunk: string) => void;
  }) {
    this.platform = options.platform;
    this.child = NodeChildProcess.spawn(options.launch.command, [...options.launch.args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.launch.env },
      detached: this.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child.stdout?.on("data", (data: Buffer) => options.log(data.toString()));
    this.child.stderr?.on("data", (data: Buffer) => options.log(data.toString()));
    const exited = () => {
      if (this.exited) return;
      this.exited = true;
      this.killTree("SIGKILL");
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Extension host stopped."));
      }
      this.pending.clear();
      for (const call of this.hostCalls.values()) call.controller.abort();
      this.hostCalls.clear();
      if (!this.stopping) options.failed();
    };
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Extension host startup timed out."));
        this.killTree("SIGKILL");
      }, 15_000);
      this.child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      this.child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Extension host exited during startup."));
      });
      this.child.on("message", (message: unknown) => {
        if (!isRecord(message)) return;
        if (message.type === "ready") {
          clearTimeout(timer);
          resolve();
        }
        if (message.type === "event" && !this.stopping) options.event(message.event);
        const requestId = message.requestId;
        if (typeof requestId !== "number") return;
        if (message.type === "host-cancel") {
          this.hostCalls.get(requestId)?.controller.abort();
          return;
        }
        if (message.type === "host-request" && typeof message.method === "string") {
          if (
            this.hostCalls.has(requestId) ||
            (this.stopping &&
              (typeof message.owner !== "number" ||
                this.pending.get(message.owner)?.operation !== "dispose"))
          )
            return;
          const controller = new AbortController();
          this.hostCalls.set(requestId, { controller, owner: message.owner });
          const deadline = setTimeout(() => controller.abort(), 30_000);
          void options
            .hostCall(message.method, message.input, controller.signal)
            .then(
              (result) => this.send({ type: "host-response", requestId, result }),
              (cause: unknown) => {
                const detail = extensionDiagnostic(cause);
                options.log(`T3 service call ${message.method} failed: ${detail}\n`);
                this.send({ type: "host-response", requestId, error: detail });
              },
            )
            .finally(() => {
              clearTimeout(deadline);
              this.hostCalls.delete(requestId);
            });
        }
        if (message.type !== "response") return;
        const request = this.pending.get(requestId);
        this.pending.delete(requestId);
        if (!request) return;
        clearTimeout(request.timer);
        if (typeof message.error === "string") request.reject(new Error(message.error));
        else request.resolve(message.result);
      });
      try {
        if (this.platform === "win32" && this.child.pid)
          this.closeWindowsJob = ownWindowsProcessTree(this.child.pid);
      } catch (cause) {
        reject(cause);
        this.killTree("SIGKILL");
      }
    });
    this.child.once("exit", exited);
    this.child.once("error", exited);
  }

  private send(message: NodeChildProcess.Serializable) {
    if (this.child.connected) this.child.send(message, () => {});
  }

  private killTree(signal: NodeJS.Signals) {
    try {
      if (this.platform !== "win32" && this.child.pid) signalProcessGroup(this.child.pid, signal);
      else if (signal === "SIGKILL" && this.closeWindowsJob) this.closeWindowsJob();
      else if (!this.exited) this.child.kill(signal);
    } catch (cause) {
      if (!isRecord(cause) || cause.code !== "ESRCH") throw cause;
    }
  }

  request(operation: string, payload: unknown, timeout = 60_000): Promise<unknown> {
    if (!this.child.connected) return Promise.reject(new Error("Extension host is not connected."));
    const requestId = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        for (const call of this.hostCalls.values())
          if (call.owner === requestId) call.controller.abort();
        this.send({ type: "cancel-request", requestId });
        reject(new ExtensionRequestTimeoutError({ operation }));
      }, timeout);
      this.pending.set(requestId, { resolve, reject, timer, operation });
      this.child.send({ type: "request", requestId, operation, payload }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  async terminate(): Promise<void> {
    this.stopping = true;
    for (const call of this.hostCalls.values()) call.controller.abort();
    if (this.exited) return;
    await new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
      this.killTree("SIGKILL");
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const call of this.hostCalls.values()) call.controller.abort();
    if (this.exited) return;
    try {
      await this.request("dispose", null, 3000);
    } catch {
      /* Shutdown continues after a failed cleanup callback. */
    }
    await new Promise<void>((resolve) => {
      if (this.exited) {
        resolve();
        return;
      }
      const timer = setTimeout(() => this.killTree("SIGKILL"), 3000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.killTree("SIGTERM");
    });
  }
}
