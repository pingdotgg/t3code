import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BackendManager,
  type BackendManagerDependencies,
  type BackendSpawn,
} from "./backendManager.ts";

const vscodeState = vi.hoisted(() => ({
  workspaceFolderPath: "/workspace",
  activeEditorPath: "/workspace/src/file.ts",
  settings: {} as Record<string, unknown>,
}));

vi.mock("vscode", () => ({
  window: {
    activeTextEditor: {
      document: {
        uri: {
          fsPath: vscodeState.activeEditorPath,
        },
      },
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => vscodeState.settings[key],
    }),
    getWorkspaceFolder: () => ({
      uri: {
        fsPath: vscodeState.workspaceFolderPath,
      },
    }),
    workspaceFolders: [
      {
        uri: {
          fsPath: vscodeState.workspaceFolderPath,
        },
      },
    ],
  },
}));

function makeOutputChannel() {
  return {
    append: vi.fn(),
    appendLine: vi.fn(),
  };
}

function makeChildProcess(onBootstrap: (value: string) => void): ChildProcessWithoutNullStreams {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdio: unknown[];
  };

  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit("exit", 0, null);
    return true;
  });
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdio = [
    null,
    stdout,
    stderr,
    {
      write: vi.fn(),
      end: vi.fn(onBootstrap),
    },
  ];

  return child as unknown as ChildProcessWithoutNullStreams;
}

function makeDependencies(input: {
  readonly spawn: BackendSpawn;
  readonly fetch?: typeof fetch;
  readonly findAvailablePort?: () => Promise<number>;
  readonly mkdirSync?: typeof fs.mkdirSync;
  readonly randomBytes?: typeof import("node:crypto").randomBytes;
}): BackendManagerDependencies {
  return {
    fetch:
      input.fetch ??
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ sessionToken: "vscode-bearer-token" }), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        ),
    findAvailablePort: input.findAvailablePort ?? vi.fn().mockResolvedValue(49111),
    mkdirSync: input.mkdirSync ?? vi.fn(),
    randomBytes:
      input.randomBytes ??
      (vi.fn(() =>
        Buffer.from("0123456789abcdef01234567"),
      ) as unknown as typeof import("node:crypto").randomBytes),
    spawn: input.spawn,
  };
}

describe("BackendManager", () => {
  let extensionRoot: string;

  beforeEach(() => {
    extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-vscode-extension-"));
    fs.mkdirSync(path.join(extensionRoot, "dist", "server"), { recursive: true });
    fs.writeFileSync(path.join(extensionRoot, "dist", "server", "bin.mjs"), "");
    vscodeState.settings = {};
  });

  afterEach(() => {
    fs.rmSync(extensionRoot, { force: true, recursive: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("starts the bundled backend with desktop bootstrap data on fd 3", async () => {
    let bootstrapJson = "";
    const spawnMock = vi.fn<BackendSpawn>(() =>
      makeChildProcess((value) => {
        bootstrapJson = value;
      }),
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionToken: "vscode-bearer-token" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
    const mkdirSyncMock = vi.fn<typeof fs.mkdirSync>();
    const manager = new BackendManager(
      { extensionPath: extensionRoot } as never,
      makeOutputChannel() as never,
      makeDependencies({
        fetch: fetchMock,
        mkdirSync: mkdirSyncMock,
        spawn: spawnMock,
      }),
    );

    await expect(manager.ensureStarted()).resolves.toEqual({
      httpBaseUrl: "http://127.0.0.1:49111",
      wsBaseUrl: "ws://127.0.0.1:49111",
      bootstrapToken: "303132333435363738396162636465663031323334353637",
      bearerToken: "vscode-bearer-token",
      cwd: "/workspace",
      t3Home: path.join(os.homedir(), ".t3"),
    });

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [
        path.join(extensionRoot, "dist", "server", "bin.mjs"),
        "--bootstrap-fd",
        "3",
        "--auto-bootstrap-project-from-cwd",
        "/workspace",
      ],
      expect.objectContaining({
        cwd: "/workspace",
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      }),
    );
    expect(spawnMock.mock.calls[0]?.[2]?.env?.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(mkdirSyncMock).toHaveBeenCalledWith(path.join(os.homedir(), ".t3"), {
      recursive: true,
    });
    expect(JSON.parse(bootstrapJson)).toEqual({
      mode: "desktop",
      noBrowser: true,
      port: 49111,
      t3Home: path.join(os.homedir(), ".t3"),
      host: "127.0.0.1",
      desktopBootstrapToken: "303132333435363738396162636465663031323334353637",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:49111/.well-known/t3/environment"),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:49111/api/auth/bootstrap/bearer"),
      {
        body: JSON.stringify({
          credential: "303132333435363738396162636465663031323334353637",
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
  });

  it("uses an explicitly configured server command without leaking inherited backend env", async () => {
    vscodeState.settings["server.command"] = "/usr/local/bin/t3";
    vscodeState.settings["server.args"] = ["serve"];
    vscodeState.settings["server.cwd"] = "/configured/server";
    vscodeState.settings.home = "/custom/t3-home";
    vi.stubEnv("T3CODE_PORT", "3999");

    const spawnMock = vi.fn<BackendSpawn>(() => makeChildProcess(() => {}));
    const manager = new BackendManager(
      { extensionPath: extensionRoot } as never,
      makeOutputChannel() as never,
      makeDependencies({ spawn: spawnMock }),
    );

    await manager.ensureStarted();

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/t3",
      ["serve", "--bootstrap-fd", "3", "--auto-bootstrap-project-from-cwd", "/workspace"],
      expect.objectContaining({
        cwd: "/configured/server",
      }),
    );
    expect(spawnMock.mock.calls[0]?.[2]?.env?.T3CODE_PORT).toBeUndefined();
    expect(spawnMock.mock.calls[0]?.[2]?.env?.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("reuses the active backend connection after readiness succeeds", async () => {
    const spawnMock = vi.fn<BackendSpawn>(() => makeChildProcess(() => {}));
    const manager = new BackendManager(
      { extensionPath: extensionRoot } as never,
      makeOutputChannel() as never,
      makeDependencies({ spawn: spawnMock }),
    );

    await manager.ensureStarted();
    await manager.ensureStarted();

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
