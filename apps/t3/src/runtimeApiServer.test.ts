import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { WS_EVENT_CHANNELS, type WsResponseMessage, type WsServerMessage } from "@acme/contracts";
import { startRuntimeApiServer } from "./runtimeApiServer";

function withTimeout<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for websocket message."));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function connectClient(url: string) {
  const queuedMessages: WsServerMessage[] = [];
  const pendingResolvers: Array<(message: WsServerMessage) => void> = [];
  const socket = new WebSocket(url);
  socket.on("message", (raw) => {
    let parsed: WsServerMessage;
    try {
      parsed = JSON.parse(raw.toString()) as WsServerMessage;
    } catch {
      return;
    }

    const pending = pendingResolvers.shift();
    if (pending) {
      pending(parsed);
      return;
    }

    queuedMessages.push(parsed);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error) => reject(error));
  });

  const nextMessage = async () => {
    const queued = queuedMessages.shift();
    if (queued) {
      return queued;
    }

    return withTimeout(
      new Promise<WsServerMessage>((resolve) => {
        pendingResolvers.push(resolve);
      }),
    );
  };

  return {
    socket,
    nextMessage,
  };
}

async function sendRequest(
  socket: WebSocket,
  nextMessage: () => Promise<WsServerMessage>,
  id: string,
  method: string,
  params?: unknown,
): Promise<WsResponseMessage> {
  socket.send(
    JSON.stringify({
      type: "request",
      id,
      method,
      params,
    }),
  );

  const waitForMatchingResponse = async (): Promise<WsResponseMessage> => {
    const message = await nextMessage();
    if (message.type !== "response" || message.id !== id) {
      return waitForMatchingResponse();
    }
    return message;
  };

  return waitForMatchingResponse();
}

async function waitForAgentEvent(
  nextMessage: () => Promise<WsServerMessage>,
  channel: string,
  sessionId: string,
) {
  const message = await nextMessage();
  if (message.type !== "event" || message.channel !== channel) {
    return waitForAgentEvent(nextMessage, channel, sessionId);
  }
  const payload = message.payload as {
    sessionId?: string;
  };
  if (payload.sessionId !== sessionId) {
    return waitForAgentEvent(nextMessage, channel, sessionId);
  }

  return message;
}

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  const snapshot = [...servers];
  servers.length = 0;
  await Promise.all(snapshot.map((server) => server.close()));
});

describe("runtimeApiServer", () => {
  it("fails startup when websocket port is already in use", async () => {
    const blockingServer = createNetServer();
    await new Promise<void>((resolve, reject) => {
      blockingServer.listen(0, "127.0.0.1", () => resolve());
      blockingServer.once("error", (error) => reject(error));
    });
    const address = blockingServer.address();
    if (!address || typeof address !== "object") {
      throw new Error("Expected blocking server to have an address.");
    }

    try {
      await expect(
        startRuntimeApiServer({
          port: address.port,
          launchCwd: process.cwd(),
        }),
      ).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        blockingServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("rejects startup when runtime port is negative", async () => {
    await expect(
      startRuntimeApiServer({
        port: -1,
        launchCwd: process.cwd(),
      }),
    ).rejects.toThrow("Invalid runtime port");
  });

  it("rejects startup when runtime port exceeds max range", async () => {
    await expect(
      startRuntimeApiServer({
        port: 70_000,
        launchCwd: process.cwd(),
      }),
    ).rejects.toThrow("Invalid runtime port");
  });

  it("rejects startup when runtime port is non-integer", async () => {
    await expect(
      startRuntimeApiServer({
        port: 4317.5,
        launchCwd: process.cwd(),
      }),
    ).rejects.toThrow("Invalid runtime port");
  });

  it("rejects startup when runtime port is NaN", async () => {
    await expect(
      startRuntimeApiServer({
        port: Number.NaN,
        launchCwd: process.cwd(),
      }),
    ).rejects.toThrow("Invalid runtime port");
  });

  it("rejects startup when runtime port is not a number", async () => {
    await expect(
      startRuntimeApiServer({
        port: "4317" as unknown as number,
        launchCwd: process.cwd(),
      }),
    ).rejects.toThrow("Invalid runtime port");
  });

  it("rejects startup when runtime port is null", async () => {
    await expect(
      startRuntimeApiServer({
        port: null as unknown as number,
        launchCwd: process.cwd(),
      }),
    ).rejects.toThrow("Invalid runtime port");
  });

  it("rejects startup when runtime port is infinite", async () => {
    await expect(
      startRuntimeApiServer({
        port: Number.POSITIVE_INFINITY,
        launchCwd: process.cwd(),
      }),
    ).rejects.toThrow("Invalid runtime port");
  });

  it("allows runtime server close to be called multiple times", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });

    await expect(server.close()).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("allows concurrent runtime server close calls", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });

    await expect(Promise.all([server.close(), server.close(), server.close()])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("terminates connected websocket clients when runtime closes", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const closed = withTimeout(
      new Promise<{ code: number }>((resolve) => {
        client.socket.once("close", (code) => resolve({ code }));
      }),
    );

    await server.close();
    const closeEvent = await closed;
    expect([1000, 1001, 1005, 1006]).toContain(closeEvent.code);
  });

  it("rejects startup when launchCwd does not exist", async () => {
    const missingPath = path.join(process.cwd(), `missing-launch-cwd-${Date.now()}`);
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: missingPath,
      }),
    ).rejects.toThrow("Invalid launchCwd does not exist");
  });

  it("rejects startup when launchCwd is empty", async () => {
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: "",
      }),
    ).rejects.toThrow("Invalid launchCwd must be a non-empty path");
  });

  it("rejects startup when launchCwd is only whitespace", async () => {
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: "   ",
      }),
    ).rejects.toThrow("Invalid launchCwd must be a non-empty path");
  });

  it("rejects startup when launchCwd is not a string", async () => {
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: 123 as unknown as string,
      }),
    ).rejects.toThrow("Invalid launchCwd must be a non-empty path");
  });

  it("rejects startup when launchCwd is null", async () => {
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: null as unknown as string,
      }),
    ).rejects.toThrow("Invalid launchCwd must be a non-empty path");
  });

  it("rejects startup when launchCwd is not a directory", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-launch-cwd-file-"));
    const filePath = path.join(tempDir, "launch.txt");
    writeFileSync(filePath, "not-a-directory", "utf8");
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: filePath,
      }),
    ).rejects.toThrow("Invalid launchCwd is not a directory");
  });

  it("rejects non-positive bootstrap timeout configuration", async () => {
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: process.cwd(),
        bootstrapSessionTimeoutMs: 0,
      }),
    ).rejects.toThrow("Invalid bootstrapSessionTimeoutMs");
  });

  it("rejects non-integer bootstrap timeout configuration", async () => {
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: process.cwd(),
        bootstrapSessionTimeoutMs: 1.5,
      }),
    ).rejects.toThrow("Invalid bootstrapSessionTimeoutMs");
  });

  it("rejects NaN bootstrap timeout configuration", async () => {
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: process.cwd(),
        bootstrapSessionTimeoutMs: Number.NaN,
      }),
    ).rejects.toThrow("Invalid bootstrapSessionTimeoutMs");
  });

  it("rejects non-number bootstrap timeout configuration", async () => {
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: process.cwd(),
        bootstrapSessionTimeoutMs: "1000" as unknown as number,
      }),
    ).rejects.toThrow("Invalid bootstrapSessionTimeoutMs");
  });

  it("rejects infinite bootstrap timeout configuration", async () => {
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: process.cwd(),
        bootstrapSessionTimeoutMs: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow("Invalid bootstrapSessionTimeoutMs");
  });

  it("rejects overly large bootstrap timeout configuration", async () => {
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: process.cwd(),
        bootstrapSessionTimeoutMs: 120_001,
      }),
    ).rejects.toThrow("Invalid bootstrapSessionTimeoutMs");
  });

  it("accepts bootstrap timeout at configured upper bound", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
      bootstrapSessionTimeoutMs: 120_000,
    });
    servers.push(server);
  });

  it("accepts bootstrap timeout at configured lower bound", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
      bootstrapSessionTimeoutMs: 1,
    });
    servers.push(server);
  });

  it("rejects empty auth token configuration", async () => {
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: process.cwd(),
        authToken: "   ",
      }),
    ).rejects.toThrow("Invalid runtime auth token");
  });

  it("rejects non-string auth token configuration", async () => {
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: process.cwd(),
        authToken: 123 as unknown as string,
      }),
    ).rejects.toThrow("Invalid runtime auth token");
  });

  it("rejects null auth token configuration", async () => {
    await expect(
      startRuntimeApiServer({
        port: 0,
        launchCwd: process.cwd(),
        authToken: null as unknown as string,
      }),
    ).rejects.toThrow("Invalid runtime auth token");
  });

  it("accepts websocket connections without token when auth is disabled", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    const hello = await client.nextMessage();
    expect(hello.type).toBe("hello");
    if (hello.type !== "hello") {
      throw new Error("Expected hello message.");
    }
    expect(hello.version).toBe(1);
    expect(hello.launchCwd).toBe(process.cwd());

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "todos-no-auth-1",
      "todos.list",
    );
    expect(response.ok).toBe(true);
    client.socket.close();
  });

  it("trims configured auth token before validating connections", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
      authToken: "  secret-token  ",
    });
    servers.push(server);

    const wsUrl = new URL(server.wsUrl);
    expect(wsUrl.searchParams.get("token")).toBe("secret-token");

    const client = await connectClient(server.wsUrl);
    const hello = await client.nextMessage();
    expect(hello.type).toBe("hello");
    client.socket.close();
  });

  it("trims non-space surrounding whitespace from auth tokens", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
      authToken: "\n\tsecret-token\t\n",
    });
    servers.push(server);

    const wsUrl = new URL(server.wsUrl);
    expect(wsUrl.searchParams.get("token")).toBe("secret-token");

    const client = await connectClient(server.wsUrl);
    const hello = await client.nextMessage();
    expect(hello.type).toBe("hello");
    client.socket.close();
  });

  it("encodes auth token query parameter in runtime websocket URL", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
      authToken: "token with spaces/?&",
    });
    servers.push(server);

    const wsUrl = new URL(server.wsUrl);
    expect(wsUrl.searchParams.get("token")).toBe("token with spaces/?&");

    const client = await connectClient(server.wsUrl);
    const hello = await client.nextMessage();
    expect(hello.type).toBe("hello");
    client.socket.close();
  });

  it("normalizes relative launch cwd in app.health response", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: ".",
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "health-relative-cwd",
      "app.health",
    );
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error("Expected health response to succeed.");
    }

    const payload = response.result as {
      status: string;
      launchCwd: string;
      sessionCount: number;
      activeClientConnected: boolean;
    };
    expect(payload.status).toBe("ok");
    expect(payload.launchCwd).toBe(process.cwd());
    expect(payload.sessionCount).toBeGreaterThanOrEqual(0);
    expect(payload.activeClientConnected).toBe(true);
    client.socket.close();
  });

  it("responds to todos.list over websocket RPC", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    const hello = await client.nextMessage();
    expect(hello.type).toBe("hello");

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "todos-1",
      "todos.list",
    );
    expect(response.ok).toBe(true);
    expect(Array.isArray(response.result)).toBe(true);

    client.socket.close();
  });

  it("responds to providers.listSessions over websocket RPC", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "providers-list-1",
      "providers.listSessions",
    );
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error("Expected providers.listSessions response to succeed.");
    }
    expect(Array.isArray(response.result)).toBe(true);

    client.socket.close();
  });

  it("handles shell.openInEditor file-manager requests", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "shell-open-fm-1",
      "shell.openInEditor",
      {
        cwd: process.cwd(),
        editor: "file-manager",
      },
    );
    expect(response.ok).toBe(true);
    expect(response.result).toBeNull();

    client.socket.close();
  });

  it("handles shell.openInEditor cursor requests", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "shell-open-cursor-1",
      "shell.openInEditor",
      {
        cwd: process.cwd(),
        editor: "cursor",
      },
    );
    expect(response.ok).toBe(true);
    expect(response.result).toBeNull();

    client.socket.close();
  });

  it("accepts relative shell.openInEditor cwd paths", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "shell-open-relative-1",
      "shell.openInEditor",
      {
        cwd: ".",
        editor: "file-manager",
      },
    );
    expect(response.ok).toBe(true);
    expect(response.result).toBeNull();

    client.socket.close();
  });

  it("resolves relative shell.openInEditor cwd paths from launch cwd", async () => {
    const launchCwd = mkdtempSync(path.join(os.tmpdir(), "t3-shell-launch-cwd-"));
    const nestedDir = path.join(launchCwd, "nested");
    mkdirSync(nestedDir, { recursive: true });

    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd,
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "shell-open-relative-launch-cwd-1",
      "shell.openInEditor",
      {
        cwd: "nested",
        editor: "file-manager",
      },
    );
    expect(response.ok).toBe(true);
    expect(response.result).toBeNull();

    client.socket.close();
  });

  it("responds to dialogs.pickFolder requests", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "dialog-pick-folder-1",
      "dialogs.pickFolder",
    );
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error("Expected dialogs.pickFolder response to succeed.");
    }
    expect(response.result === null || typeof response.result === "string").toBe(true);

    client.socket.close();
  });

  it("ignores malformed client messages and continues processing", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    client.socket.send("not-json");
    client.socket.send(JSON.stringify({ type: "request", id: "", method: "" }));

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "todos-after-malformed",
      "todos.list",
    );
    expect(response.ok).toBe(true);

    client.socket.close();
  });

  it("closes oversized websocket payloads and remains available", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const firstClient = await connectClient(server.wsUrl);
    await firstClient.nextMessage();

    const firstClose = withTimeout(
      new Promise<number>((resolve) => {
        firstClient.socket.once("close", (code) => resolve(code));
      }),
      10_000,
    );
    firstClient.socket.send("x".repeat(6 * 1024 * 1024));
    const closeCode = await firstClose;
    expect([1006, 1009]).toContain(closeCode);

    const secondClient = await connectClient(server.wsUrl);
    await secondClient.nextMessage();

    const response = await sendRequest(
      secondClient.socket,
      secondClient.nextMessage,
      "todos-after-large-payload",
      "todos.list",
    );
    expect(response.ok).toBe(true);
    secondClient.socket.close();
  });

  it("accepts buffer-encoded websocket request payloads", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    client.socket.send(
      Buffer.from(
        JSON.stringify({
          type: "request",
          id: "buffer-todos-1",
          method: "todos.list",
        }),
      ),
    );

    const response = await withTimeout(
      (async (): Promise<WsResponseMessage> => {
        const message = await client.nextMessage();
        if (message.type === "response" && message.id === "buffer-todos-1") {
          return message;
        }
        return Promise.reject(new Error("Expected matching todos response."));
      })(),
    );
    expect(response.ok).toBe(true);
    expect(Array.isArray(response.result)).toBe(true);

    client.socket.close();
  });

  it("accepts arraybuffer-encoded websocket request payloads", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const encoded = new TextEncoder().encode(
      JSON.stringify({
        type: "request",
        id: "arraybuffer-todos-1",
        method: "todos.list",
      }),
    );
    client.socket.send(encoded.buffer);

    const response = await withTimeout(
      (async (): Promise<WsResponseMessage> => {
        const message = await client.nextMessage();
        if (message.type === "response" && message.id === "arraybuffer-todos-1") {
          return message;
        }
        return Promise.reject(new Error("Expected matching todos response."));
      })(),
    );
    expect(response.ok).toBe(true);
    expect(Array.isArray(response.result)).toBe(true);

    client.socket.close();
  });

  it("accepts uint8array-encoded websocket request payloads", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const encoded = new TextEncoder().encode(
      JSON.stringify({
        type: "request",
        id: "uint8array-todos-1",
        method: "todos.list",
      }),
    );
    client.socket.send(encoded);

    const response = await withTimeout(
      (async (): Promise<WsResponseMessage> => {
        const message = await client.nextMessage();
        if (message.type === "response" && message.id === "uint8array-todos-1") {
          return message;
        }
        return Promise.reject(new Error("Expected matching todos response."));
      })(),
    );
    expect(response.ok).toBe(true);
    expect(Array.isArray(response.result)).toBe(true);

    client.socket.close();
  });

  it("replaces an existing websocket client with a new one", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const firstClient = await connectClient(server.wsUrl);
    await firstClient.nextMessage();

    const firstClose = new Promise<{ code: number; reason: string }>((resolve) => {
      firstClient.socket.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      );
    });

    const secondClient = await connectClient(server.wsUrl);
    await secondClient.nextMessage();

    const closed = await withTimeout(firstClose);
    expect(closed.code).toBe(4000);
    expect(closed.reason).toBe("replaced-by-new-client");

    const response = await sendRequest(
      secondClient.socket,
      secondClient.nextMessage,
      "todos-2",
      "todos.list",
    );
    expect(response.ok).toBe(true);

    secondClient.socket.close();
  });

  it("replaces active authorized client when another authorized client connects", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
      authToken: "secret-token",
    });
    servers.push(server);

    const firstClient = await connectClient(server.wsUrl);
    await firstClient.nextMessage();

    const firstClose = new Promise<{ code: number; reason: string }>((resolve) => {
      firstClient.socket.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      );
    });

    const secondClient = await connectClient(server.wsUrl);
    await secondClient.nextMessage();

    const closed = await withTimeout(firstClose);
    expect(closed.code).toBe(4000);
    expect(closed.reason).toBe("replaced-by-new-client");

    const response = await sendRequest(
      secondClient.socket,
      secondClient.nextMessage,
      "todos-auth-replace-1",
      "todos.list",
    );
    expect(response.ok).toBe(true);

    secondClient.socket.close();
  });

  it("requires auth token when runtime is configured with one", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
      authToken: "secret-token",
    });
    servers.push(server);

    const authorizedUrl = new URL(server.wsUrl);
    expect(authorizedUrl.searchParams.get("token")).toBe("secret-token");
    const unauthorizedUrl = `${authorizedUrl.origin}${authorizedUrl.pathname}`;
    const unauthorizedClient = new WebSocket(unauthorizedUrl);
    let unauthorizedMessageCount = 0;
    unauthorizedClient.on("message", () => {
      unauthorizedMessageCount += 1;
    });
    const unauthorizedClose = await withTimeout(
      new Promise<{ code: number; reason: string }>((resolve, reject) => {
        unauthorizedClient.once("close", (code, reason) =>
          resolve({ code, reason: reason.toString() }),
        );
        unauthorizedClient.once("error", (error) => reject(error));
      }),
    );
    expect(unauthorizedClose.code).toBe(4001);
    expect(unauthorizedClose.reason).toBe("unauthorized");
    expect(unauthorizedMessageCount).toBe(0);

    const wrongTokenUrl = `${authorizedUrl.origin}${authorizedUrl.pathname}?token=wrong-token`;
    const wrongTokenClient = new WebSocket(wrongTokenUrl);
    let wrongTokenMessageCount = 0;
    wrongTokenClient.on("message", () => {
      wrongTokenMessageCount += 1;
    });
    const wrongTokenClose = await withTimeout(
      new Promise<{ code: number }>((resolve, reject) => {
        wrongTokenClient.once("close", (code) => resolve({ code }));
        wrongTokenClient.once("error", (error) => reject(error));
      }),
    );
    expect(wrongTokenClose.code).toBe(4001);
    expect(wrongTokenMessageCount).toBe(0);

    const emptyTokenUrl = `${authorizedUrl.origin}${authorizedUrl.pathname}?token=`;
    const emptyTokenClient = new WebSocket(emptyTokenUrl);
    let emptyTokenMessageCount = 0;
    emptyTokenClient.on("message", () => {
      emptyTokenMessageCount += 1;
    });
    const emptyTokenClose = await withTimeout(
      new Promise<{ code: number }>((resolve, reject) => {
        emptyTokenClient.once("close", (code) => resolve({ code }));
        emptyTokenClient.once("error", (error) => reject(error));
      }),
    );
    expect(emptyTokenClose.code).toBe(4001);
    expect(emptyTokenMessageCount).toBe(0);

    const whitespaceTokenUrl = `${authorizedUrl.origin}${authorizedUrl.pathname}?token=%20%20`;
    const whitespaceTokenClient = new WebSocket(whitespaceTokenUrl);
    let whitespaceTokenMessageCount = 0;
    whitespaceTokenClient.on("message", () => {
      whitespaceTokenMessageCount += 1;
    });
    const whitespaceTokenClose = await withTimeout(
      new Promise<{ code: number }>((resolve, reject) => {
        whitespaceTokenClient.once("close", (code) => resolve({ code }));
        whitespaceTokenClient.once("error", (error) => reject(error));
      }),
    );
    expect(whitespaceTokenClose.code).toBe(4001);
    expect(whitespaceTokenMessageCount).toBe(0);

    const duplicateTokenUrl = `${authorizedUrl.origin}${authorizedUrl.pathname}?token=secret-token&token=wrong-token`;
    const duplicateTokenClient = new WebSocket(duplicateTokenUrl);
    let duplicateTokenMessageCount = 0;
    duplicateTokenClient.on("message", () => {
      duplicateTokenMessageCount += 1;
    });
    const duplicateTokenClose = await withTimeout(
      new Promise<{ code: number }>((resolve, reject) => {
        duplicateTokenClient.once("close", (code) => resolve({ code }));
        duplicateTokenClient.once("error", (error) => reject(error));
      }),
    );
    expect(duplicateTokenClose.code).toBe(4001);
    expect(duplicateTokenMessageCount).toBe(0);

    const extraParamTokenUrl = `${authorizedUrl.origin}${authorizedUrl.pathname}?token=secret-token&debug=1`;
    const extraParamTokenClient = new WebSocket(extraParamTokenUrl);
    let extraParamTokenMessageCount = 0;
    extraParamTokenClient.on("message", () => {
      extraParamTokenMessageCount += 1;
    });
    const extraParamTokenClose = await withTimeout(
      new Promise<{ code: number }>((resolve, reject) => {
        extraParamTokenClient.once("close", (code) => resolve({ code }));
        extraParamTokenClient.once("error", (error) => reject(error));
      }),
    );
    expect(extraParamTokenClose.code).toBe(4001);
    expect(extraParamTokenMessageCount).toBe(0);

    const wrongPathTokenUrl = `${authorizedUrl.origin}/unexpected?token=secret-token`;
    const wrongPathTokenClient = new WebSocket(wrongPathTokenUrl);
    let wrongPathTokenMessageCount = 0;
    wrongPathTokenClient.on("message", () => {
      wrongPathTokenMessageCount += 1;
    });
    const wrongPathTokenClose = await withTimeout(
      new Promise<{ code: number }>((resolve, reject) => {
        wrongPathTokenClient.once("close", (code) => resolve({ code }));
        wrongPathTokenClient.once("error", (error) => reject(error));
      }),
    );
    expect(wrongPathTokenClose.code).toBe(4001);
    expect(wrongPathTokenMessageCount).toBe(0);

    const authorizedClient = await connectClient(server.wsUrl);
    const hello = await authorizedClient.nextMessage();
    expect(hello.type).toBe("hello");
    authorizedClient.socket.close();
  });

  it("rejects websocket connections on non-root paths without auth", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const wrongPathClient = new WebSocket(`${server.wsUrl}/unexpected`);
    let wrongPathMessageCount = 0;
    wrongPathClient.on("message", () => {
      wrongPathMessageCount += 1;
    });
    const wrongPathClose = await withTimeout(
      new Promise<{ code: number; reason: string }>((resolve, reject) => {
        wrongPathClient.once("close", (code, reason) =>
          resolve({ code, reason: reason.toString() }),
        );
        wrongPathClient.once("error", (error) => reject(error));
      }),
    );
    expect(wrongPathClose.code).toBe(4001);
    expect(wrongPathClose.reason).toBe("unauthorized");
    expect(wrongPathMessageCount).toBe(0);

    const unexpectedQueryClient = new WebSocket(`${server.wsUrl}?debug=1`);
    let unexpectedQueryMessageCount = 0;
    unexpectedQueryClient.on("message", () => {
      unexpectedQueryMessageCount += 1;
    });
    const unexpectedQueryClose = await withTimeout(
      new Promise<{ code: number; reason: string }>((resolve, reject) => {
        unexpectedQueryClient.once("close", (code, reason) =>
          resolve({ code, reason: reason.toString() }),
        );
        unexpectedQueryClient.once("error", (error) => reject(error));
      }),
    );
    expect(unexpectedQueryClose.code).toBe(4001);
    expect(unexpectedQueryClose.reason).toBe("unauthorized");
    expect(unexpectedQueryMessageCount).toBe(0);

    const unexpectedTokenClient = new WebSocket(`${server.wsUrl}?token=legacy-token`);
    let unexpectedTokenMessageCount = 0;
    unexpectedTokenClient.on("message", () => {
      unexpectedTokenMessageCount += 1;
    });
    const unexpectedTokenClose = await withTimeout(
      new Promise<{ code: number; reason: string }>((resolve, reject) => {
        unexpectedTokenClient.once("close", (code, reason) =>
          resolve({ code, reason: reason.toString() }),
        );
        unexpectedTokenClient.once("error", (error) => reject(error));
      }),
    );
    expect(unexpectedTokenClose.code).toBe(4001);
    expect(unexpectedTokenClose.reason).toBe("unauthorized");
    expect(unexpectedTokenMessageCount).toBe(0);

    const authorizedClient = await connectClient(server.wsUrl);
    const hello = await authorizedClient.nextMessage();
    expect(hello.type).toBe("hello");
    authorizedClient.socket.close();
  });

  it("does not evict active client when unexpected-query client connects without auth", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const activeClient = await connectClient(server.wsUrl);
    await activeClient.nextMessage();

    const activeClose = new Promise<{ code: number }>((resolve) => {
      activeClient.socket.once("close", (code) => resolve({ code }));
    });

    const unauthorizedUnexpectedQueryClient = new WebSocket(`${server.wsUrl}?debug=1`);
    const unauthorizedUnexpectedQueryClose = await withTimeout(
      new Promise<{ code: number }>((resolve, reject) => {
        unauthorizedUnexpectedQueryClient.once("close", (code) => resolve({ code }));
        unauthorizedUnexpectedQueryClient.once("error", (error) => reject(error));
      }),
    );
    expect(unauthorizedUnexpectedQueryClose.code).toBe(4001);

    const response = await sendRequest(
      activeClient.socket,
      activeClient.nextMessage,
      "todos-authless-unexpected-query-1",
      "todos.list",
    );
    expect(response.ok).toBe(true);

    activeClient.socket.close();
    const closed = await withTimeout(activeClose);
    expect([1000, 1005]).toContain(closed.code);
  });

  it("does not evict authorized client when unauthorized client connects", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
      authToken: "secret-token",
    });
    servers.push(server);

    const authorizedClient = await connectClient(server.wsUrl);
    await authorizedClient.nextMessage();

    const authorizedClose = new Promise<{ code: number }>((resolve) => {
      authorizedClient.socket.once("close", (code) => resolve({ code }));
    });

    const authorizedUrl = new URL(server.wsUrl);
    const unauthorizedUrl = `${authorizedUrl.origin}${authorizedUrl.pathname}`;
    const unauthorizedClient = new WebSocket(unauthorizedUrl);
    const unauthorizedClose = await withTimeout(
      new Promise<{ code: number }>((resolve, reject) => {
        unauthorizedClient.once("close", (code) => resolve({ code }));
        unauthorizedClient.once("error", (error) => reject(error));
      }),
    );
    expect(unauthorizedClose.code).toBe(4001);

    const response = await sendRequest(
      authorizedClient.socket,
      authorizedClient.nextMessage,
      "todos-auth-1",
      "todos.list",
    );
    expect(response.ok).toBe(true);

    authorizedClient.socket.close();
    const closed = await withTimeout(authorizedClose);
    expect([1000, 1005]).toContain(closed.code);
  });

  it("does not evict authorized client when duplicate-token client connects", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
      authToken: "secret-token",
    });
    servers.push(server);

    const authorizedClient = await connectClient(server.wsUrl);
    await authorizedClient.nextMessage();

    const authorizedClose = new Promise<{ code: number }>((resolve) => {
      authorizedClient.socket.once("close", (code) => resolve({ code }));
    });

    const authorizedUrl = new URL(server.wsUrl);
    const duplicateTokenClient = new WebSocket(
      `${authorizedUrl.origin}${authorizedUrl.pathname}?token=secret-token&token=wrong-token`,
    );
    const duplicateTokenClose = await withTimeout(
      new Promise<{ code: number }>((resolve, reject) => {
        duplicateTokenClient.once("close", (code) => resolve({ code }));
        duplicateTokenClient.once("error", (error) => reject(error));
      }),
    );
    expect(duplicateTokenClose.code).toBe(4001);

    const response = await sendRequest(
      authorizedClient.socket,
      authorizedClient.nextMessage,
      "todos-auth-duplicate-token-1",
      "todos.list",
    );
    expect(response.ok).toBe(true);

    authorizedClient.socket.close();
    const closed = await withTimeout(authorizedClose);
    expect([1000, 1005]).toContain(closed.code);
  });

  it("does not evict authorized client when extra-query client connects", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
      authToken: "secret-token",
    });
    servers.push(server);

    const authorizedClient = await connectClient(server.wsUrl);
    await authorizedClient.nextMessage();

    const authorizedClose = new Promise<{ code: number }>((resolve) => {
      authorizedClient.socket.once("close", (code) => resolve({ code }));
    });

    const authorizedUrl = new URL(server.wsUrl);
    const extraQueryClient = new WebSocket(
      `${authorizedUrl.origin}${authorizedUrl.pathname}?token=secret-token&debug=1`,
    );
    const extraQueryClose = await withTimeout(
      new Promise<{ code: number }>((resolve, reject) => {
        extraQueryClient.once("close", (code) => resolve({ code }));
        extraQueryClient.once("error", (error) => reject(error));
      }),
    );
    expect(extraQueryClose.code).toBe(4001);

    const response = await sendRequest(
      authorizedClient.socket,
      authorizedClient.nextMessage,
      "todos-auth-extra-query-1",
      "todos.list",
    );
    expect(response.ok).toBe(true);

    authorizedClient.socket.close();
    const closed = await withTimeout(authorizedClose);
    expect([1000, 1005]).toContain(closed.code);
  });

  it("returns a bootstrap payload even when codex cannot initialize", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const server = await startRuntimeApiServer({
        port: 0,
        launchCwd: process.cwd(),
        bootstrapSessionTimeoutMs: 100,
      });
      servers.push(server);

      const client = await connectClient(server.wsUrl);
      await client.nextMessage();

      const response = await sendRequest(
        client.socket,
        client.nextMessage,
        "bootstrap-1",
        "app.bootstrap",
      );
      expect(response.ok).toBe(true);
      if (!response.ok) {
        throw new Error("Expected successful bootstrap response payload.");
      }

      const payload = response.result as {
        launchCwd: string;
        projectName: string;
        session: { status: string };
        bootstrapError?: string;
      };
      expect(payload.launchCwd).toBe(process.cwd());
      expect(payload.projectName).toBe(path.basename(process.cwd()) || process.cwd());
      expect(payload.session.status).toBe("error");
      expect(typeof payload.bootstrapError).toBe("string");
      expect((payload.bootstrapError ?? "").length).toBeGreaterThan(0);

      client.socket.close();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("handles repeated bootstrap requests under failure conditions", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const server = await startRuntimeApiServer({
        port: 0,
        launchCwd: process.cwd(),
        bootstrapSessionTimeoutMs: 100,
      });
      servers.push(server);

      const client = await connectClient(server.wsUrl);
      await client.nextMessage();

      const first = await sendRequest(
        client.socket,
        client.nextMessage,
        "bootstrap-repeat-1",
        "app.bootstrap",
      );
      const second = await sendRequest(
        client.socket,
        client.nextMessage,
        "bootstrap-repeat-2",
        "app.bootstrap",
      );

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        throw new Error("Expected both bootstrap responses to succeed.");
      }

      const firstSession = first.result as {
        projectName: string;
        session: { sessionId: string; status: string };
      };
      const secondSession = second.result as {
        projectName: string;
        session: { sessionId: string; status: string };
      };
      expect(firstSession.projectName).toBe(path.basename(process.cwd()) || process.cwd());
      expect(secondSession.projectName).toBe(path.basename(process.cwd()) || process.cwd());
      expect(firstSession.session.status).toBe("error");
      expect(firstSession.session.sessionId.length).toBeGreaterThan(0);
      expect(secondSession.session.sessionId.length).toBeGreaterThan(0);
      expect(secondSession.session.status).not.toBe("closed");

      client.socket.close();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("returns structured errors for unknown methods", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "unknown-1",
      "unknown.method",
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected unknown method to fail.");
    }
    expect(response.error?.code).toBe("request_failed");
    expect(response.error?.message).toContain("Unknown API method");

    client.socket.close();
  });

  it("returns structured errors for invalid shell.openInEditor payloads", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "shell-invalid-1",
      "shell.openInEditor",
      {
        cwd: "/workspace",
        editor: "unknown-editor",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected invalid shell payload to fail.");
    }
    expect(response.error?.code).toBe("request_failed");

    client.socket.close();
  });

  it("returns structured errors when shell.openInEditor target is missing", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const missingPath = path.join(process.cwd(), `missing-editor-target-${Date.now()}`);
    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "shell-missing-path-1",
      "shell.openInEditor",
      {
        cwd: missingPath,
        editor: "file-manager",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected missing shell path request to fail.");
    }
    expect(response.error?.code).toBe("request_failed");
    expect(response.error?.message).toContain("Editor target does not exist");

    client.socket.close();
  });

  it("returns launch-cwd-relative errors for missing shell.openInEditor targets", async () => {
    const launchCwd = mkdtempSync(path.join(os.tmpdir(), "t3-shell-missing-relative-"));
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd,
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "shell-missing-relative-1",
      "shell.openInEditor",
      {
        cwd: "missing-dir",
        editor: "file-manager",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected relative missing shell target request to fail.");
    }
    expect(response.error?.code).toBe("request_failed");
    expect(response.error?.message).toContain(path.join(launchCwd, "missing-dir"));

    client.socket.close();
  });

  it("returns structured errors when shell.openInEditor target is not a directory", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-shell-target-file-"));
    const filePath = path.join(tempDir, "target.txt");
    writeFileSync(filePath, "not-a-dir", "utf8");
    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "shell-file-path-1",
      "shell.openInEditor",
      {
        cwd: filePath,
        editor: "cursor",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected file-path shell target request to fail.");
    }
    expect(response.error?.code).toBe("request_failed");
    expect(response.error?.message).toContain("Editor target is not a directory");

    client.socket.close();
  });

  it("returns structured errors when shell.openInEditor target is whitespace", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "shell-whitespace-path-1",
      "shell.openInEditor",
      {
        cwd: "   ",
        editor: "cursor",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected whitespace shell target request to fail.");
    }
    expect(response.error?.code).toBe("request_failed");
    expect(response.error?.message).toContain("Editor target must be a non-empty path");

    client.socket.close();
  });

  it("returns structured errors for invalid terminal.run payloads", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "terminal-invalid-1",
      "terminal.run",
      {
        command: "",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected invalid terminal payload to fail.");
    }
    expect(response.error?.code).toBe("request_failed");

    client.socket.close();
  });

  it("returns structured errors for invalid todos.toggle payloads", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "todo-invalid-1",
      "todos.toggle",
      "",
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected invalid todo id payload to fail.");
    }
    expect(response.error?.code).toBe("request_failed");

    client.socket.close();
  });

  it("returns structured errors for invalid agent.spawn payloads", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "agent-invalid-1",
      "agent.spawn",
      {
        command: "",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected invalid agent payload to fail.");
    }
    expect(response.error?.code).toBe("request_failed");

    client.socket.close();
  });

  it("returns structured errors for invalid providers.respondToRequest payloads", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "provider-respond-invalid-1",
      "providers.respondToRequest",
      {
        sessionId: "sess-1",
        requestId: "req-1",
        decision: "invalid-decision",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected invalid provider decision payload to fail.");
    }
    expect(response.error?.code).toBe("request_failed");

    client.socket.close();
  });

  it("returns structured errors for invalid providers.sendTurn payloads", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "provider-send-invalid-1",
      "providers.sendTurn",
      {
        sessionId: "sess-1",
        input: "",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected invalid provider sendTurn payload to fail.");
    }
    expect(response.error?.code).toBe("request_failed");

    client.socket.close();
  });

  it("returns structured errors for invalid providers.startSession payloads", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "provider-start-invalid-1",
      "providers.startSession",
      {
        provider: "unknown-provider",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected invalid provider start payload to fail.");
    }
    expect(response.error?.code).toBe("request_failed");

    client.socket.close();
  });

  it("returns structured errors for invalid providers.interruptTurn payloads", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "provider-interrupt-invalid-1",
      "providers.interruptTurn",
      {
        sessionId: "",
        turnId: "turn-1",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected invalid provider interrupt payload to fail.");
    }
    expect(response.error?.code).toBe("request_failed");

    client.socket.close();
  });

  it("returns structured errors for invalid providers.stopSession payloads", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "provider-stop-invalid-1",
      "providers.stopSession",
      {
        sessionId: "",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected invalid provider stop payload to fail.");
    }
    expect(response.error?.code).toBe("request_failed");

    client.socket.close();
  });

  it("runs terminal commands through terminal.run endpoint", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "terminal-run-1",
      "terminal.run",
      {
        command: "echo hello",
        cwd: process.cwd(),
        timeoutMs: 5_000,
      },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error("Expected terminal.run response to succeed.");
    }
    const payload = response.result as {
      stdout: string;
      stderr: string;
      code: number | null;
      timedOut: boolean;
    };
    expect(payload.stdout.toLowerCase()).toContain("hello");
    expect(payload.stderr).toBe("");
    expect(payload.code).toBe(0);
    expect(payload.timedOut).toBe(false);

    client.socket.close();
  });

  it("marks long-running terminal commands as timed out", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "terminal-timeout-1",
      "terminal.run",
      {
        command: "sleep 2",
        cwd: process.cwd(),
        timeoutMs: 100,
      },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error("Expected terminal.run timeout response to succeed.");
    }
    const payload = response.result as {
      timedOut: boolean;
      stdout: string;
      stderr: string;
      code: number | null;
    };
    expect(payload.timedOut).toBe(true);
    expect(payload.stdout).toBe("");
    expect(payload.stderr).toBe("");
    expect(payload.code === null || payload.code > 0).toBe(true);

    client.socket.close();
  });

  it("force-kills commands that ignore SIGTERM after timeout", async () => {
    if (process.platform === "win32") {
      return;
    }

    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const startedAt = Date.now();
    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "terminal-timeout-sigkill-1",
      "terminal.run",
      {
        command: "trap '' TERM; while true; do sleep 1; done",
        cwd: process.cwd(),
        timeoutMs: 100,
      },
    );
    const elapsedMs = Date.now() - startedAt;
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error("Expected SIGTERM-resistant command response to succeed.");
    }
    const payload = response.result as {
      timedOut: boolean;
    };
    expect(payload.timedOut).toBe(true);
    expect(elapsedMs).toBeLessThan(5_000);

    client.socket.close();
  });

  it("runs terminal commands in the requested cwd", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "terminal-cwd-1",
      "terminal.run",
      {
        command: "pwd",
        cwd: process.cwd(),
      },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error("Expected terminal cwd response to succeed.");
    }

    const payload = response.result as {
      stdout: string;
    };
    expect(payload.stdout.trim()).toBe(process.cwd());

    client.socket.close();
  });

  it("defaults terminal commands to launch cwd when cwd is omitted", async () => {
    const launchCwd = path.dirname(process.cwd());
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd,
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "terminal-default-cwd-1",
      "terminal.run",
      {
        command: "pwd",
      },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error("Expected terminal default cwd response to succeed.");
    }

    const payload = response.result as {
      stdout: string;
    };
    expect(payload.stdout.trim()).toBe(launchCwd);

    client.socket.close();
  });

  it("resolves relative terminal cwd paths against runtime working directory", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "terminal-cwd-relative-1",
      "terminal.run",
      {
        command: "pwd",
        cwd: ".",
      },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error("Expected relative terminal cwd response to succeed.");
    }

    const payload = response.result as {
      stdout: string;
    };
    expect(payload.stdout.trim()).toBe(process.cwd());

    client.socket.close();
  });

  it("resolves relative terminal cwd paths from launch cwd", async () => {
    const launchCwd = mkdtempSync(path.join(os.tmpdir(), "t3-terminal-launch-cwd-"));
    const nestedDir = path.join(launchCwd, "nested");
    mkdirSync(nestedDir, { recursive: true });

    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd,
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "terminal-cwd-relative-launch-1",
      "terminal.run",
      {
        command: "pwd",
        cwd: "nested",
      },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error("Expected relative launch cwd terminal response to succeed.");
    }

    const payload = response.result as {
      stdout: string;
    };
    expect(payload.stdout.trim()).toBe(nestedDir);

    client.socket.close();
  });

  it("returns structured errors when terminal cwd does not exist", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const missingCwd = path.join(process.cwd(), `missing-cwd-${Date.now()}`);
    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "terminal-missing-cwd-1",
      "terminal.run",
      {
        command: "pwd",
        cwd: missingCwd,
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected terminal missing cwd response to fail.");
    }
    expect(response.error?.code).toBe("request_failed");
    expect(response.error?.message).toContain("Working directory does not exist");

    client.socket.close();
  });

  it("returns launch-cwd-relative errors when terminal cwd is missing", async () => {
    const launchCwd = mkdtempSync(path.join(os.tmpdir(), "t3-terminal-missing-relative-"));
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd,
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "terminal-missing-relative-1",
      "terminal.run",
      {
        command: "pwd",
        cwd: "missing-subdir",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected relative missing terminal cwd response to fail.");
    }
    expect(response.error?.code).toBe("request_failed");
    expect(response.error?.message).toContain(path.join(launchCwd, "missing-subdir"));

    client.socket.close();
  });

  it("returns structured errors when terminal cwd is not a directory", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-terminal-file-cwd-"));
    const fileCwd = path.join(tempDir, "file.txt");
    writeFileSync(fileCwd, "not-a-dir", "utf8");

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "terminal-file-cwd-1",
      "terminal.run",
      {
        command: "pwd",
        cwd: fileCwd,
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected terminal file cwd response to fail.");
    }
    expect(response.error?.code).toBe("request_failed");
    expect(response.error?.message).toContain("Working directory is not a directory");

    client.socket.close();
  });

  it("returns structured errors when terminal cwd is whitespace", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "terminal-whitespace-cwd-1",
      "terminal.run",
      {
        command: "pwd",
        cwd: "   ",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected terminal whitespace cwd response to fail.");
    }
    expect(response.error?.code).toBe("request_failed");
    expect(response.error?.message).toContain("Working directory must be a non-empty path");

    client.socket.close();
  });

  it("returns non-zero terminal exit codes without request failure", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "terminal-exit-code-1",
      "terminal.run",
      {
        command: "exit 3",
        cwd: process.cwd(),
      },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error("Expected terminal non-zero exit response to succeed.");
    }

    const payload = response.result as {
      code: number | null;
      timedOut: boolean;
    };
    expect(payload.code).toBe(3);
    expect(payload.timedOut).toBe(false);

    client.socket.close();
  });

  it("supports todo mutation lifecycle over websocket RPC", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const addResponse = await sendRequest(
      client.socket,
      client.nextMessage,
      "todo-add-1",
      "todos.add",
      { title: "test todo" },
    );
    expect(addResponse.ok).toBe(true);
    if (!addResponse.ok) {
      throw new Error("Expected todos.add response to succeed.");
    }

    const afterAdd = addResponse.result as Array<{
      id: string;
      title: string;
      completed: boolean;
    }>;
    expect(afterAdd.length).toBeGreaterThan(0);
    const createdTodo = afterAdd[0];
    expect(createdTodo?.title).toBe("test todo");
    expect(createdTodo?.completed).toBe(false);
    if (!createdTodo?.id) {
      throw new Error("Expected created todo id.");
    }

    const toggleResponse = await sendRequest(
      client.socket,
      client.nextMessage,
      "todo-toggle-1",
      "todos.toggle",
      createdTodo.id,
    );
    expect(toggleResponse.ok).toBe(true);
    if (!toggleResponse.ok) {
      throw new Error("Expected todos.toggle response to succeed.");
    }
    const afterToggle = toggleResponse.result as Array<{
      id: string;
      completed: boolean;
    }>;
    const toggled = afterToggle.find((todo) => todo.id === createdTodo.id);
    expect(toggled?.completed).toBe(true);

    const removeResponse = await sendRequest(
      client.socket,
      client.nextMessage,
      "todo-remove-1",
      "todos.remove",
      createdTodo.id,
    );
    expect(removeResponse.ok).toBe(true);
    if (!removeResponse.ok) {
      throw new Error("Expected todos.remove response to succeed.");
    }
    const afterRemove = removeResponse.result as Array<{ id: string }>;
    expect(afterRemove.some((todo) => todo.id === createdTodo.id)).toBe(false);

    client.socket.close();
  });

  it("streams agent output and exit events for spawned commands", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const spawnResponse = await sendRequest(
      client.socket,
      client.nextMessage,
      "agent-spawn-1",
      "agent.spawn",
      {
        command: "bash",
        args: ["-lc", "printf runtime-agent-test"],
        cwd: process.cwd(),
      },
    );
    expect(spawnResponse.ok).toBe(true);
    if (!spawnResponse.ok) {
      throw new Error("Expected agent.spawn response to succeed.");
    }
    const sessionId = String(spawnResponse.result);

    const outputEvent = await waitForAgentEvent(
      client.nextMessage,
      WS_EVENT_CHANNELS.agentOutput,
      sessionId,
    );
    const outputPayload = outputEvent.payload as {
      stream: string;
      data: string;
    };
    expect(outputPayload.stream).toBe("stdout");
    expect(outputPayload.data).toContain("runtime-agent-test");

    const exitEvent = await waitForAgentEvent(
      client.nextMessage,
      WS_EVENT_CHANNELS.agentExit,
      sessionId,
    );
    const exitPayload = exitEvent.payload as {
      code: number | null;
    };
    expect(exitPayload.code).toBe(0);

    client.socket.close();
  });

  it("supports agent.write and agent.kill lifecycle", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const spawnResponse = await sendRequest(
      client.socket,
      client.nextMessage,
      "agent-spawn-2",
      "agent.spawn",
      {
        command: "bash",
        args: ["-lc", "cat"],
        cwd: process.cwd(),
      },
    );
    expect(spawnResponse.ok).toBe(true);
    if (!spawnResponse.ok) {
      throw new Error("Expected agent.spawn response to succeed.");
    }
    const sessionId = String(spawnResponse.result);

    const writeResponse = await sendRequest(
      client.socket,
      client.nextMessage,
      "agent-write-1",
      "agent.write",
      {
        sessionId,
        data: "runtime-write-test\n",
      },
    );
    expect(writeResponse.ok).toBe(true);

    const outputEvent = await waitForAgentEvent(
      client.nextMessage,
      WS_EVENT_CHANNELS.agentOutput,
      sessionId,
    );
    const outputPayload = outputEvent.payload as {
      data: string;
    };
    expect(outputPayload.data).toContain("runtime-write-test");

    const killResponse = await sendRequest(
      client.socket,
      client.nextMessage,
      "agent-kill-1",
      "agent.kill",
      sessionId,
    );
    expect(killResponse.ok).toBe(true);

    const exitEvent = await waitForAgentEvent(
      client.nextMessage,
      WS_EVENT_CHANNELS.agentExit,
      sessionId,
    );
    const exitPayload = exitEvent.payload as {
      code: number | null;
      signal: string | null;
    };
    expect(exitPayload.code === null || typeof exitPayload.code === "number").toBe(true);
    expect(exitPayload.signal === null || typeof exitPayload.signal === "string").toBe(true);

    client.socket.close();
  });

  it("returns structured errors when writing to unknown agent session", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "agent-write-unknown-1",
      "agent.write",
      {
        sessionId: "missing-session-id",
        data: "hello",
      },
    );
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected unknown agent.write session to fail.");
    }
    expect(response.error?.code).toBe("request_failed");

    client.socket.close();
  });

  it("treats agent.kill for unknown session as successful no-op", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "agent-kill-unknown-1",
      "agent.kill",
      "missing-session-id",
    );
    expect(response.ok).toBe(true);
    expect(response.result).toBeNull();

    client.socket.close();
  });

  it("reports runtime health metadata", async () => {
    const server = await startRuntimeApiServer({
      port: 0,
      launchCwd: process.cwd(),
    });
    servers.push(server);

    const client = await connectClient(server.wsUrl);
    await client.nextMessage();

    const response = await sendRequest(
      client.socket,
      client.nextMessage,
      "health-1",
      "app.health",
    );
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error("Expected health response to succeed.");
    }

    const payload = response.result as {
      status: string;
      launchCwd: string;
      sessionCount: number;
      activeClientConnected: boolean;
    };
    expect(payload.status).toBe("ok");
    expect(payload.launchCwd).toBe(process.cwd());
    expect(typeof payload.sessionCount).toBe("number");
    expect(payload.activeClientConnected).toBe(true);

    client.socket.close();
  });
});
