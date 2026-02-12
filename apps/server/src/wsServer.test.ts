import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, afterEach, vi } from "vitest";
import { createServer } from "./wsServer";
import WebSocket from "ws";

import { WS_CHANNELS, WS_METHODS, type WsPush, type WsResponse } from "@t3tools/contracts";
import { ProjectRegistry } from "./projectRegistry";

interface PendingMessages {
  queue: unknown[];
  waiters: Array<(message: unknown) => void>;
}

const pendingBySocket = new WeakMap<WebSocket, PendingMessages>();

function connectWs(port: number, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
    const pending: PendingMessages = { queue: [], waiters: [] };
    pendingBySocket.set(ws, pending);

    ws.on("message", (raw) => {
      const parsed = JSON.parse(String(raw));
      const waiter = pending.waiters.shift();
      if (waiter) {
        waiter(parsed);
        return;
      }
      pending.queue.push(parsed);
    });

    ws.once("open", () => resolve(ws));
    ws.once("error", () => reject(new Error("WebSocket connection failed")));
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  const pending = pendingBySocket.get(ws);
  if (!pending) {
    return Promise.reject(new Error("WebSocket not initialized"));
  }

  const queued = pending.queue.shift();
  if (queued !== undefined) {
    return Promise.resolve(queued);
  }

  return new Promise((resolve) => {
    pending.waiters.push(resolve);
  });
}

async function sendRequest(ws: WebSocket, method: string, params?: unknown): Promise<WsResponse> {
  const id = crypto.randomUUID();
  const message = JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) });
  ws.send(message);

  // Wait for response with matching id
  while (true) {
    const parsed = (await waitForMessage(ws)) as Record<string, unknown>;
    if (parsed.id === id) {
      return parsed as WsResponse;
    }
  }
}

describe("WebSocket Server", () => {
  let server: ReturnType<typeof createServer> | null = null;
  const connections: WebSocket[] = [];
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createTestServer(
    options: {
      cwd?: string;
      devUrl?: string;
      authToken?: string;
      stateDir?: string;
      gitManager?: {
        status: (input: { cwd: string }) => Promise<unknown>;
        runStackedAction: (input: { cwd: string; action: string }) => Promise<unknown>;
      };
    } = {},
  ): ReturnType<typeof createServer> {
    const stateDir = options.stateDir ?? makeTempDir("t3code-ws-state-");
    return createServer({
      port: 0,
      cwd: options.cwd ?? "/test/project",
      ...(options.devUrl ? { devUrl: options.devUrl } : {}),
      ...(options.authToken ? { authToken: options.authToken } : {}),
      projectRegistry: new ProjectRegistry(stateDir),
      ...(options.gitManager ? { gitManager: options.gitManager as never } : {}),
    });
  }

  afterEach(async () => {
    for (const ws of connections) {
      ws.close();
    }
    connections.length = 0;
    if (server) {
      await server.stop();
    }
    server = null;
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("sends welcome message on connect", async () => {
    server = createTestServer({ cwd: "/test/project" });
    // Get the actual port after listen
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const ws = await connectWs(port);
    connections.push(ws);

    const message = (await waitForMessage(ws)) as WsPush;
    expect(message.type).toBe("push");
    expect(message.channel).toBe(WS_CHANNELS.serverWelcome);
    expect(message.data).toEqual({
      cwd: "/test/project",
      projectName: "project",
    });
  });

  it("logs outbound websocket push events in dev mode", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {
      // Keep test output clean while verifying websocket logs.
    });

    server = createTestServer({
      cwd: "/test/project",
      devUrl: "http://localhost:5173",
    });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    expect(
      logSpy.mock.calls.some(([message]) => {
        if (typeof message !== "string") return false;
        return (
          message.includes("[ws]") &&
          message.includes("outgoing push") &&
          message.includes(`channel="${WS_CHANNELS.serverWelcome}"`)
        );
      }),
    ).toBe(true);
  });

  it("responds to server.getConfig", async () => {
    server = createTestServer({ cwd: "/my/workspace" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome message
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ cwd: "/my/workspace" });
  });

  it("returns error for unknown methods", async () => {
    server = createTestServer({ cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome
    await waitForMessage(ws);

    const response = await sendRequest(ws, "nonexistent.method");
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("Unknown method");
  });

  it("responds to providers.listSessions with empty array", async () => {
    server = createTestServer({ cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.providersListSessions);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual([]);
  });

  it("handles invalid JSON gracefully", async () => {
    server = createTestServer({ cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome
    await waitForMessage(ws);

    // Send garbage
    ws.send("not json at all");

    const response = (await waitForMessage(ws)) as WsResponse;
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("Invalid request format");
  });

  it("supports projects list/add/dedupe/remove", async () => {
    const stateDir = makeTempDir("t3code-ws-projects-state-");
    const firstProjectCwd = makeTempDir("t3code-ws-project-a-");

    server = createTestServer({ stateDir, cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const emptyList = await sendRequest(ws, WS_METHODS.projectsList);
    expect(emptyList.error).toBeUndefined();
    expect(emptyList.result).toEqual([]);

    const created = await sendRequest(ws, WS_METHODS.projectsAdd, {
      cwd: firstProjectCwd,
    });
    expect(created.error).toBeUndefined();
    expect((created.result as { created: boolean }).created).toBe(true);

    const duplicate = await sendRequest(ws, WS_METHODS.projectsAdd, {
      cwd: firstProjectCwd,
    });
    expect(duplicate.error).toBeUndefined();
    expect((duplicate.result as { created: boolean }).created).toBe(false);

    const listed = await sendRequest(ws, WS_METHODS.projectsList);
    expect(listed.error).toBeUndefined();
    const listedProjects = listed.result as Array<{ id: string; cwd: string }>;
    expect(listedProjects).toHaveLength(1);

    const projectId = listedProjects[0]?.id;
    expect(projectId).toBeTruthy();
    if (!projectId) return;

    const removed = await sendRequest(ws, WS_METHODS.projectsRemove, {
      id: projectId,
    });
    expect(removed.error).toBeUndefined();

    const afterRemove = await sendRequest(ws, WS_METHODS.projectsList);
    expect(afterRemove.error).toBeUndefined();
    expect(afterRemove.result).toEqual([]);
  });

  it("responds to git.status via the git manager", async () => {
    const gitManager = {
      status: vi.fn().mockResolvedValue({
        branch: "feature/test",
        hasWorkingTreeChanges: true,
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
      }),
      runStackedAction: vi.fn(),
    };

    server = createTestServer({ cwd: "/test", gitManager });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.gitStatus, {
      cwd: "/test",
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      branch: "feature/test",
      hasWorkingTreeChanges: true,
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
    });
    expect(gitManager.status).toHaveBeenCalledWith({ cwd: "/test" });
  });

  it("returns errors from git.runStackedAction", async () => {
    const gitManager = {
      status: vi.fn(),
      runStackedAction: vi
        .fn()
        .mockRejectedValue(new Error("Cannot push from detached HEAD.")),
    };

    server = createTestServer({ cwd: "/test", gitManager });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.gitRunStackedAction, {
      cwd: "/test",
      action: "commit_push",
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("detached HEAD");
    expect(gitManager.runStackedAction).toHaveBeenCalledWith({
      cwd: "/test",
      action: "commit_push",
    });
  });

  it("prunes missing projects on startup", async () => {
    const stateDir = makeTempDir("t3code-ws-prune-state-");
    const existing = makeTempDir("t3code-ws-existing-project-");
    const missing = path.join(stateDir, "definitely-missing");
    const now = new Date().toISOString();
    const projectsFile = path.join(stateDir, "projects.json");

    fs.writeFileSync(
      projectsFile,
      JSON.stringify(
        {
          version: 1,
          projects: [
            {
              id: "project-existing",
              cwd: existing,
              name: "existing",
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "project-missing",
              cwd: missing,
              name: "missing",
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
        null,
        2,
      ),
    );

    server = createTestServer({ stateDir, cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsList);
    expect(response.error).toBeUndefined();
    const listed = response.result as Array<{ id: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("project-existing");
  });

  it("rejects websocket connections without a valid auth token", async () => {
    server = createTestServer({ cwd: "/test", authToken: "secret-token" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    await expect(connectWs(port)).rejects.toThrow("WebSocket connection failed");

    const authorizedWs = await connectWs(port, "secret-token");
    connections.push(authorizedWs);
    const welcome = (await waitForMessage(authorizedWs)) as WsPush;
    expect(welcome.channel).toBe(WS_CHANNELS.serverWelcome);
  });
});
