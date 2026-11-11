import { uuidV4Unsafe } from "effect/crypto/SecureRandom";

import {
  CursorServerConnection,
  RemoteCallError,
  type CursorServerEndpoint,
} from "./connection.ts";

export { ConnectionClosedError, RemoteCallError } from "./connection.ts";

/** Cursor's hosted agents clone their repository here. */
export const CURSOR_CLOUD_WORKSPACE_ROOT = "/workspace";

export type RemoteFileType = "File" | "Directory" | "SymbolicLink" | "Unknown";

export interface RemoteStat {
  readonly type: RemoteFileType;
  readonly size: number;
  readonly mtime: number;
}

export interface RemoteExecInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
}

export interface RemoteExecResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface RemotePtyInput {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface RemotePty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (exitCode: number) => void): () => void;
}

const FILE_TYPE_FILE = 1;
const FILE_TYPE_DIRECTORY = 2;
const FILE_TYPE_SYMBOLIC_LINK = 64;
// ptyHost pauses a terminal past 100k unacknowledged characters; VS Code acks in 5k batches.
const PTY_ACK_CHARS = 5_000;

const fileType = (bits: number): RemoteFileType =>
  bits & FILE_TYPE_SYMBOLIC_LINK
    ? "SymbolicLink"
    : bits & FILE_TYPE_DIRECTORY
      ? "Directory"
      : bits & FILE_TYPE_FILE
        ? "File"
        : "Unknown";

interface PtyListeners {
  readonly data: Set<(data: string) => void>;
  readonly exit: Set<(exitCode: number) => void>;
  ready?: (pid: number) => void;
  unacked: number;
  exited?: number;
}

/** What T3 uses of a VM; the connection lifecycle stays with whoever opened it. */
export type CursorCloudMachineApi = Pick<
  CursorCloudMachine,
  | "stat"
  | "readdir"
  | "readFile"
  | "writeFile"
  | "mkdir"
  | "delete"
  | "rename"
  | "exec"
  | "spawnPty"
>;

/** Filesystem, command, and terminal access to one Cursor cloud VM. */
export class CursorCloudMachine {
  private readonly ptys = new Map<number, PtyListeners>();
  private readonly connection: CursorServerConnection;
  private readonly authority: string;

  private constructor(connection: CursorServerConnection, authority: string) {
    this.connection = connection;
    this.authority = authority;
    connection.listen("remoteterminal", "$onProcessDataEvent", (raw) => {
      const { id, event } = raw as { id: number; event: string | { data: string } };
      const pty = this.ptys.get(id);
      if (!pty) return;
      const data = typeof event === "string" ? event : event.data;
      for (const callback of pty.data) callback(data);
      pty.unacked += data.length;
      if (pty.unacked >= PTY_ACK_CHARS) {
        const count = pty.unacked;
        pty.unacked = 0;
        void connection
          .call("remoteterminal", "$acknowledgeDataEvent", [id, count])
          .catch(() => {});
      }
    });
    connection.listen("remoteterminal", "$onProcessReadyEvent", (raw) => {
      const { id, event } = raw as { id: number; event: { pid?: number } };
      this.ptys.get(id)?.ready?.(event.pid ?? 0);
    });
    connection.listen("remoteterminal", "$onProcessExitEvent", (raw) => {
      const { id, event } = raw as { id: number; event: number | undefined };
      const pty = this.ptys.get(id);
      if (!pty) return;
      pty.exited = event ?? 0;
      for (const callback of pty.exit) callback(pty.exited);
      this.ptys.delete(id);
    });
    connection.onClose(() => {
      for (const pty of this.ptys.values()) {
        for (const callback of pty.exit) callback(pty.exited ?? 1);
      }
      this.ptys.clear();
    });
  }

  static async connect(
    endpoint: CursorServerEndpoint,
    options: { readonly agentId: string; readonly commit: string },
  ): Promise<CursorCloudMachine> {
    const authority = `background-composer+${options.agentId}`;
    const connection = await CursorServerConnection.open(endpoint, {
      commit: options.commit,
      authority,
    });
    return new CursorCloudMachine(connection, authority);
  }

  get closed() {
    return this.connection.closed;
  }

  /** Open terminals and running commands; an idle connection can close without losing work. */
  get activeProcesses() {
    return this.ptys.size;
  }

  onClose(callback: () => void) {
    return this.connection.onClose(callback);
  }

  close() {
    this.connection.close();
  }

  private uri(path: string) {
    return { scheme: "vscode-remote", authority: this.authority, path };
  }

  async stat(path: string): Promise<RemoteStat> {
    const stat = (await this.connection.call("remoteFilesystem", "stat", [this.uri(path)])) as {
      type: number;
      size: number;
      mtime: number;
    };
    return { type: fileType(stat.type), size: stat.size, mtime: stat.mtime };
  }

  async readdir(path: string): Promise<ReadonlyArray<{ name: string; type: RemoteFileType }>> {
    const entries = (await this.connection.call("remoteFilesystem", "readdir", [
      this.uri(path),
    ])) as Array<[string, number]>;
    return entries.map(([name, type]) => ({ name, type: fileType(type) }));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const content = await this.connection.call("remoteFilesystem", "readFile", [this.uri(path)]);
    if (!(content instanceof Uint8Array))
      throw new RemoteCallError({ message: "Invalid file contents" });
    return content;
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    await this.connection.call("remoteFilesystem", "writeFile", [
      this.uri(path),
      content,
      { create: true, overwrite: true, unlock: false, atomic: false },
    ]);
  }

  async mkdir(path: string): Promise<void> {
    await this.connection.call("remoteFilesystem", "mkdir", [this.uri(path)]);
  }

  async delete(path: string, recursive: boolean): Promise<void> {
    await this.connection.call("remoteFilesystem", "delete", [
      this.uri(path),
      { recursive, useTrash: false, atomic: false },
    ]);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.connection.call("remoteFilesystem", "rename", [
      this.uri(from),
      this.uri(to),
      { overwrite: true },
    ]);
  }

  async spawnPty(input: RemotePtyInput): Promise<RemotePty> {
    const created = (await this.connection.call("remoteterminal", "$createProcess", {
      configuration: {
        "terminal.integrated.env.linux": {},
        "terminal.integrated.cwd": "",
        "terminal.integrated.detectLocale": "auto",
      },
      resolvedVariables: {},
      envVariableCollections: [],
      shellLaunchConfig: {
        executable: input.executable,
        args: input.args,
        cwd: input.cwd,
        env: input.env ?? {},
      },
      workspaceId: "t3-code",
      workspaceName: "T3 Code",
      workspaceFolders: [],
      activeWorkspaceFolder: null,
      activeFileResource: undefined,
      shouldPersistTerminal: false,
      options: {
        shellIntegration: { enabled: false, suggestEnabled: false, nonce: "" },
        windowsEnableConpty: false,
        windowsUseConptyDll: false,
        environmentVariableCollections: undefined,
        workspaceFolder: undefined,
        isScreenReaderOptimized: false,
      },
      cols: input.cols,
      rows: input.rows,
      unicodeVersion: "11",
      resolverEnv: {},
    })) as { persistentTerminalId: number };
    const id = created.persistentTerminalId;
    const listeners: PtyListeners = { data: new Set(), exit: new Set(), unacked: 0 };
    this.ptys.set(id, listeners);
    const ready = new Promise<number>((resolve) => {
      listeners.ready = resolve;
    });
    const launchError = (await this.connection.call("remoteterminal", "$start", [id])) as
      | { message?: string }
      | undefined;
    if (launchError?.message) {
      this.ptys.delete(id);
      throw new RemoteCallError({
        message: launchError.message,
        remoteName: "TerminalLaunchError",
      });
    }
    const pid = await Promise.race([
      ready,
      new Promise<number>((resolve) => listeners.exit.add(() => resolve(0))),
    ]);
    const call = (command: string, args: unknown[]) =>
      void this.connection.call("remoteterminal", command, args).catch(() => {});
    return {
      pid,
      write: (data) => call("$input", [id, data]),
      resize: (cols, rows) => call("$resize", [id, cols, rows]),
      kill: () => call("$shutdown", [id, true]),
      onData: (callback) => {
        listeners.data.add(callback);
        return () => listeners.data.delete(callback);
      },
      onExit: (callback) => {
        if (listeners.exited !== undefined) {
          callback(listeners.exited);
          return () => {};
        }
        listeners.exit.add(callback);
        return () => listeners.exit.delete(callback);
      },
    };
  }

  /** Runs a command to completion with byte-exact output; PTYs mangle line endings, files do not. */
  async exec(input: RemoteExecInput, signal?: AbortSignal): Promise<RemoteExecResult> {
    const base = `/tmp/t3-exec-${uuidV4Unsafe()}`;
    const files = { out: `${base}.out`, err: `${base}.err`, in: `${base}.in` };
    if (input.stdin !== undefined) await this.writeFile(files.in, input.stdin);
    try {
      const pty = await this.spawnPty({
        executable: "/bin/bash",
        args: [
          "-c",
          // No `exec`: with every stream redirected nothing holds the PTY, and ptyHost reports
          // the exit before the command finishes. bash stays attached and exits with its status.
          'cd -- "$1" || exit 127; shift; "$@" >"$T3_OUT" 2>"$T3_ERR" <"$T3_IN"',
          "t3-exec",
          input.cwd,
          input.command,
          ...input.args,
        ],
        cwd: "/",
        cols: 200,
        rows: 24,
        env: {
          ...input.env,
          T3_OUT: files.out,
          T3_ERR: files.err,
          T3_IN: input.stdin === undefined ? "/dev/null" : files.in,
        },
      });
      const exitCode = await new Promise<number>((resolve) => {
        const abort = () => pty.kill();
        signal?.addEventListener("abort", abort, { once: true });
        pty.onExit((code) => {
          signal?.removeEventListener("abort", abort);
          resolve(code);
        });
      });
      const [stdout, stderr] = await Promise.all([
        this.readFile(files.out).catch(() => new Uint8Array()),
        this.readFile(files.err).catch(() => new Uint8Array()),
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      void Promise.all(
        Object.values(files).map((path) => this.delete(path, false).catch(() => {})),
      );
    }
  }
}
