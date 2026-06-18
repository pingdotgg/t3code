import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  BackendManager,
  type BackendManagerDependencies,
  resolveMcpToolTimeoutSec,
  resolveStoredBearerTokenSecretKey,
} from "./backendManager.ts";

const vscodeState = vi.hoisted(() => ({
  workspaceFolderPath: "/workspace",
  activeEditorPath: "/workspace/src/file.ts",
  workspaceFolders: [
    {
      name: "workspace",
      uri: {
        scheme: "file",
        authority: "",
        path: "/workspace",
        fsPath: "/workspace",
      },
    },
  ],
  settings: {} as Record<string, unknown>,
  showInputBox: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: {
    activeTextEditor: {
      document: {
        uri: {
          get fsPath() {
            return vscodeState.activeEditorPath;
          },
          get path() {
            return vscodeState.activeEditorPath;
          },
        },
      },
    },
    showInputBox: vscodeState.showInputBox,
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) =>
        key in vscodeState.settings ? vscodeState.settings[key] : fallback,
    }),
    getWorkspaceFolder: (uri: { fsPath: string }) =>
      vscodeState.workspaceFolders.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath)),
    get workspaceFolders() {
      return vscodeState.workspaceFolders;
    },
  },
}));

function makeOutputChannel() {
  return {
    append: vi.fn(),
    appendLine: vi.fn(),
  };
}

function makeSecretStorage(initialValues: Record<string, string> = {}) {
  const values = new Map(Object.entries(initialValues));
  return {
    values,
    secrets: {
      get: vi.fn((key: string) => Promise.resolve(values.get(key))),
      store: vi.fn((key: string, value: string) => {
        values.set(key, value);
        return Promise.resolve();
      }),
      delete: vi.fn((key: string) => {
        values.delete(key);
        return Promise.resolve();
      }),
    },
  };
}

function makeContext(secretStorage = makeSecretStorage()) {
  return {
    extensionPath: "/extension",
    secrets: secretStorage.secrets,
  } as never;
}

const workspaceFolders = [
  {
    key: "file::/workspace",
    name: "workspace",
    cwd: "/workspace",
    uriScheme: "file",
    uriAuthority: "",
  },
] as const;

function makeStoredBearerSecretKey() {
  return resolveStoredBearerTokenSecretKey({
    t3Home: path.join(os.homedir(), ".t3"),
    httpBaseUrl: "http://127.0.0.1:3773/",
    workspaceFolders,
  });
}

function makeDependencies(
  input: Partial<BackendManagerDependencies> = {},
): BackendManagerDependencies {
  return {
    fetch:
      input.fetch ??
      vi.fn<typeof fetch>(async (requestInput) => {
        const url = new URL(
          requestInput instanceof Request ? requestInput.url : requestInput.toString(),
        );
        if (url.pathname === "/.well-known/t3/environment") {
          return new Response(JSON.stringify({ environmentId: "environment-desktop" }), {
            headers: { "content-type": "application/json" },
            status: 200,
          });
        }
        if (url.pathname === "/api/auth/session") {
          return new Response(JSON.stringify({ authenticated: true }), {
            headers: { "content-type": "application/json" },
            status: 200,
          });
        }
        if (url.pathname === "/api/auth/bootstrap/bearer") {
          return new Response(JSON.stringify({ sessionToken: "desktop-bearer-token" }), {
            headers: { "content-type": "application/json" },
            status: 200,
          });
        }
        if (url.pathname === "/api/vscode/workspace-bootstrap") {
          return new Response(
            JSON.stringify({
              environmentId: "environment-desktop",
              bootstrapProjects: [
                {
                  workspaceFolderKey: "file::/workspace",
                  workspaceFolderName: "workspace",
                  cwd: "/workspace",
                  projectId: "project-workspace",
                  bootstrapThreadId: "thread-latest",
                  isActive: true,
                },
              ],
            }),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            },
          );
        }
        if (url.pathname === "/api/auth/session/revoke") {
          return new Response(JSON.stringify({ revoked: true }), { status: 200 });
        }
        throw new Error(`Unexpected request URL: ${url.href}`);
      }),
    mkdirSync: input.mkdirSync ?? vi.fn(),
    pruneVirtualWorkspaceCache:
      input.pruneVirtualWorkspaceCache ??
      vi.fn(() => ({
        deleted: 0,
        kept: 0,
        errors: 0,
      })),
    randomBytes:
      input.randomBytes ??
      (vi.fn(() =>
        Buffer.from("0123456789abcdef"),
      ) as unknown as typeof import("node:crypto").randomBytes),
    runCommand: input.runCommand ?? vi.fn().mockResolvedValue(undefined),
    readDesktopBackendAdvertisements:
      input.readDesktopBackendAdvertisements ??
      vi.fn(() => ({
        advertisements: [
          {
            version: 1 as const,
            backendId: "desktop-backend-1",
            updatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
            httpBaseUrl: "http://127.0.0.1:3773/",
          },
        ],
        malformed: 0,
      })),
    cleanupDesktopBackendAdvertisements: input.cleanupDesktopBackendAdvertisements ?? vi.fn(),
    writeHostMcpAdvertisement: input.writeHostMcpAdvertisement ?? vi.fn(),
    removeHostMcpAdvertisement: input.removeHostMcpAdvertisement ?? vi.fn(),
    cleanupHostMcpAdvertisements:
      input.cleanupHostMcpAdvertisements ?? vi.fn(() => ({ deleted: 0, errors: 0 })),
    promptForPairingToken: input.promptForPairingToken ?? vi.fn().mockResolvedValue("manual-token"),
  };
}

describe("BackendManager", () => {
  let extensionRoot: string;

  beforeEach(() => {
    extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-vscode-extension-"));
    vscodeState.settings = {};
    vscodeState.workspaceFolders = [
      {
        name: "workspace",
        uri: {
          scheme: "file",
          authority: "",
          path: vscodeState.workspaceFolderPath,
          fsPath: vscodeState.workspaceFolderPath,
        },
      },
    ];
    vscodeState.activeEditorPath = "/workspace/src/file.ts";
    vscodeState.showInputBox.mockReset();
  });

  afterEach(() => {
    fs.rmSync(extensionRoot, { force: true, recursive: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("pairs manually, stores the bearer token, and advertises VS Code MCP", async () => {
    const secretStorage = makeSecretStorage();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === "/.well-known/t3/environment") {
        return new Response(JSON.stringify({ environmentId: "environment-desktop" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.pathname === "/api/auth/bootstrap/bearer") {
        return new Response(JSON.stringify({ sessionToken: "desktop-bearer-token" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.pathname === "/api/vscode/workspace-bootstrap") {
        return new Response(
          JSON.stringify({
            bootstrapProjects: [
              {
                workspaceFolderKey: "file::/workspace",
                workspaceFolderName: "workspace",
                cwd: "/workspace",
                projectId: "project-workspace",
                bootstrapThreadId: "thread-latest",
                isActive: true,
              },
            ],
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      }
      throw new Error(`Unexpected request URL: ${url.href}`);
    });
    const promptForPairingToken = vi.fn().mockResolvedValue("manual-token");
    const writeHostMcpAdvertisementMock = vi.fn();
    const manager = new BackendManager(
      makeContext(secretStorage),
      makeOutputChannel() as never,
      makeDependencies({
        fetch: fetchMock,
        promptForPairingToken,
        writeHostMcpAdvertisement: writeHostMcpAdvertisementMock,
      }),
      {
        ensureStarted: vi.fn().mockResolvedValue({
          name: "t3code-vscode-abc",
          socketPath: "/tmp/t3code-vscode.sock",
        }),
      },
    );

    await expect(manager.ensureStarted()).resolves.toEqual({
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
      bearerToken: "desktop-bearer-token",
      cwd: "/workspace",
      t3Home: path.join(os.homedir(), ".t3"),
      environmentId: "environment-desktop",
      workspaceFolders,
      activeWorkspaceFolderKey: "file::/workspace",
      bootstrapProjects: [
        {
          workspaceFolderKey: "file::/workspace",
          workspaceFolderName: "workspace",
          cwd: "/workspace",
          projectId: "project-workspace",
          bootstrapThreadId: "thread-latest",
          isActive: true,
        },
      ],
      initialThreadRoute: "/_chat/environment-desktop/thread-latest",
    });

    expect(promptForPairingToken).toHaveBeenCalledWith({
      httpBaseUrl: "http://127.0.0.1:3773/",
      t3Home: path.join(os.homedir(), ".t3"),
      workspaceFolders,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:3773/api/auth/bootstrap/bearer"),
      expect.objectContaining({
        body: JSON.stringify({ credential: "manual-token" }),
        method: "POST",
      }),
    );
    expect(secretStorage.secrets.store).toHaveBeenCalledWith(
      makeStoredBearerSecretKey(),
      "desktop-bearer-token",
    );
    expect(writeHostMcpAdvertisementMock).toHaveBeenCalledWith({
      t3Home: path.join(os.homedir(), ".t3"),
      advertisement: expect.objectContaining({
        hostKind: "vscode",
        mcpServer: {
          name: "t3code-vscode-abc",
          socketPath: "/tmp/t3code-vscode.sock",
          toolTimeoutSec: 120,
        },
        workspaceFolders,
        activeWorkspaceFolderKey: "file::/workspace",
      }),
    });

    await manager.stop();
    expect(fetchMock).not.toHaveBeenCalledWith(
      new URL("http://127.0.0.1:3773/api/auth/session/revoke"),
      expect.anything(),
    );
  });

  it("reuses a valid stored bearer token without prompting or exchanging a pairing token", async () => {
    const secretStorage = makeSecretStorage({
      [makeStoredBearerSecretKey()]: "stored-bearer-token",
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === "/.well-known/t3/environment") {
        return new Response(JSON.stringify({ environmentId: "environment-desktop" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.pathname === "/api/auth/session") {
        return new Response(JSON.stringify({ authenticated: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.pathname === "/api/vscode/workspace-bootstrap") {
        return new Response(JSON.stringify({ bootstrapProjects: [] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      throw new Error(`Unexpected request URL: ${url.href}`);
    });
    const promptForPairingToken = vi.fn().mockResolvedValue("manual-token");
    const manager = new BackendManager(
      makeContext(secretStorage),
      makeOutputChannel() as never,
      makeDependencies({ fetch: fetchMock, promptForPairingToken }),
    );

    await expect(manager.ensureStarted()).resolves.toMatchObject({
      bearerToken: "stored-bearer-token",
    });

    expect(promptForPairingToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:3773/api/auth/session"),
      expect.objectContaining({
        headers: { authorization: "Bearer stored-bearer-token" },
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      new URL("http://127.0.0.1:3773/api/auth/bootstrap/bearer"),
      expect.anything(),
    );
  });

  it("deletes an invalid stored bearer token before prompting for a new pairing token", async () => {
    const secretStorage = makeSecretStorage({
      [makeStoredBearerSecretKey()]: "stale-bearer-token",
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === "/.well-known/t3/environment") {
        return new Response(JSON.stringify({ environmentId: "environment-desktop" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.pathname === "/api/auth/session") {
        return new Response(JSON.stringify({ authenticated: false }), { status: 401 });
      }
      if (url.pathname === "/api/auth/bootstrap/bearer") {
        return new Response(JSON.stringify({ sessionToken: "fresh-bearer-token" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.pathname === "/api/vscode/workspace-bootstrap") {
        return new Response(JSON.stringify({ bootstrapProjects: [] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      throw new Error(`Unexpected request URL: ${url.href}`);
    });
    const manager = new BackendManager(
      makeContext(secretStorage),
      makeOutputChannel() as never,
      makeDependencies({
        fetch: fetchMock,
        promptForPairingToken: vi.fn().mockResolvedValue("manual-token"),
      }),
    );

    await expect(manager.ensureStarted()).resolves.toMatchObject({
      bearerToken: "fresh-bearer-token",
    });

    expect(secretStorage.secrets.delete).toHaveBeenCalledWith(makeStoredBearerSecretKey());
    expect(secretStorage.secrets.store).toHaveBeenCalledWith(
      makeStoredBearerSecretKey(),
      "fresh-bearer-token",
    );
  });

  it("revokes a newly exchanged bearer session when stopped during workspace bootstrap", async () => {
    let bearerSessionCount = 0;
    let workspaceBootstrapCount = 0;
    let resolveFirstWorkspaceBootstrapStarted!: () => void;
    const firstWorkspaceBootstrapStarted = new Promise<void>((resolve) => {
      resolveFirstWorkspaceBootstrapStarted = resolve;
    });
    const secretStorage = makeSecretStorage();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname === "/.well-known/t3/environment") {
        return new Response(JSON.stringify({ environmentId: "environment-desktop" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.pathname === "/api/auth/bootstrap/bearer") {
        bearerSessionCount += 1;
        return new Response(
          JSON.stringify({ sessionToken: `desktop-bearer-token-${bearerSessionCount}` }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      }
      if (url.pathname === "/api/vscode/workspace-bootstrap") {
        workspaceBootstrapCount += 1;
        if (workspaceBootstrapCount === 1) {
          resolveFirstWorkspaceBootstrapStarted();
          await new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(new Error("aborted"));
            if (init?.signal?.aborted) {
              abort();
              return;
            }
            init?.signal?.addEventListener("abort", abort, { once: true });
          });
        }
        return new Response(
          JSON.stringify({
            bootstrapProjects: [
              {
                workspaceFolderKey: "file::/workspace",
                workspaceFolderName: "workspace",
                cwd: "/workspace",
                projectId: "project-workspace",
                bootstrapThreadId: `thread-${workspaceBootstrapCount}`,
                isActive: true,
              },
            ],
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      }
      if (url.pathname === "/api/auth/session/revoke") {
        return new Response(JSON.stringify({ revoked: true }), { status: 200 });
      }
      throw new Error(`Unexpected request URL: ${url.href}`);
    });
    const manager = new BackendManager(
      makeContext(secretStorage),
      makeOutputChannel() as never,
      makeDependencies({ fetch: fetchMock }),
    );

    const firstStart = manager.ensureStarted();
    await firstWorkspaceBootstrapStarted;
    await manager.stop();
    await expect(firstStart).rejects.toThrow("Desktop backend startup was cancelled.");

    await expect(manager.ensureStarted()).resolves.toMatchObject({
      bearerToken: "desktop-bearer-token-2",
      initialThreadRoute: "/_chat/environment-desktop/thread-2",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:3773/api/auth/session/revoke"),
      expect.objectContaining({
        headers: { authorization: "Bearer desktop-bearer-token-1" },
        method: "POST",
      }),
    );
  });

  it("does not timeout an active slow workspace bootstrap", async () => {
    vi.useFakeTimers();

    let resolveWorkspaceBootstrapStarted!: () => void;
    const workspaceBootstrapStarted = new Promise<void>((resolve) => {
      resolveWorkspaceBootstrapStarted = resolve;
    });
    let resolveWorkspaceBootstrap!: (response: Response) => void;
    let rejectWorkspaceBootstrap!: (error: Error) => void;
    let workspaceBootstrapSignal: AbortSignal | undefined;
    const workspaceBootstrapResponse = new Promise<Response>((resolve, reject) => {
      resolveWorkspaceBootstrap = resolve;
      rejectWorkspaceBootstrap = reject;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname === "/.well-known/t3/environment") {
        return new Response(JSON.stringify({ environmentId: "environment-desktop" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.pathname === "/api/auth/bootstrap/bearer") {
        return new Response(JSON.stringify({ sessionToken: "desktop-bearer-token" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.pathname === "/api/vscode/workspace-bootstrap") {
        workspaceBootstrapSignal = init?.signal ?? undefined;
        const abort = () => rejectWorkspaceBootstrap(new Error("aborted"));
        if (workspaceBootstrapSignal?.aborted) {
          abort();
        } else {
          workspaceBootstrapSignal?.addEventListener("abort", abort, { once: true });
        }
        resolveWorkspaceBootstrapStarted();
        return workspaceBootstrapResponse;
      }
      throw new Error(`Unexpected request URL: ${url.href}`);
    });
    const manager = new BackendManager(
      makeContext(makeSecretStorage()),
      makeOutputChannel() as never,
      makeDependencies({ fetch: fetchMock }),
    );
    const started = manager.ensureStarted();

    await workspaceBootstrapStarted;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(workspaceBootstrapSignal?.aborted).toBe(false);
    resolveWorkspaceBootstrap(
      new Response(
        JSON.stringify({
          bootstrapProjects: [
            {
              workspaceFolderKey: "file::/workspace",
              workspaceFolderName: "workspace",
              cwd: "/workspace",
              projectId: "project-workspace",
              bootstrapThreadId: "thread-slow",
              isActive: true,
            },
          ],
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
    );

    await expect(started).resolves.toMatchObject({
      bearerToken: "desktop-bearer-token",
      initialThreadRoute: "/_chat/environment-desktop/thread-slow",
    });
  });

  it("fails when no desktop backend advertisement is available", async () => {
    const manager = new BackendManager(
      makeContext(makeSecretStorage()),
      makeOutputChannel() as never,
      makeDependencies({
        readDesktopBackendAdvertisements: vi.fn(() => ({
          advertisements: [],
          malformed: 0,
        })),
      }),
    );

    await expect(manager.ensureStarted()).rejects.toThrow(
      "T3 Code for VS Code requires the T3 Code desktop app to be running on this machine.",
    );
  });

  it("normalizes MCP tool timeout settings", () => {
    vscodeState.settings["mcp.toolTimeoutSec"] = 2;
    expect(resolveMcpToolTimeoutSec()).toBe(120);

    vscodeState.settings["mcp.toolTimeoutSec"] = 30;
    expect(resolveMcpToolTimeoutSec()).toBe(30);
  });
});
