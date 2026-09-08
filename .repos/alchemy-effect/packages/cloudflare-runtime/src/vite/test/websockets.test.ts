import { handleWebSocket } from "../websockets.ts";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeNet from "node:net";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

const DEBUG = !!process.env.WS_PROXY_DEBUG;
const dbg = (...args: Array<unknown>) => {
  if (DEBUG) {
    console.error(`[ws-dbg ${Date.now() % 100000}]`, ...args);
  }
};

interface UpstreamCall {
  url: string;
  method: string | undefined;
  headers: NodeHttp.IncomingHttpHeaders;
}

interface Harness {
  clientServer: NodeHttp.Server;
  clientPort: number;
  upstreamServer: NodeHttp.Server;
  upstreamWss: WebSocketServer;
  upstreamPort: number;
  upstreamCalls: Array<UpstreamCall>;
  upstreamConnections: Array<WebSocket>;
  cleanup: () => void;
}

const listen = (server: NodeHttp.Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

const close = (server: NodeHttp.Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });

const setup = async (): Promise<Harness> => {
  const upstreamCalls: Array<UpstreamCall> = [];
  const upstreamConnections: Array<WebSocket> = [];

  const upstreamServer = NodeHttp.createServer((_req, res) => {
    res.statusCode = 200;
    res.end("upstream-http");
  });
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstreamServer.on("upgrade", (req, socket, head) => {
    dbg("upstream received upgrade", req.method, req.url);
    upstreamCalls.push({
      url: req.url ?? "",
      method: req.method,
      headers: { ...req.headers },
    });
    upstreamWss.handleUpgrade(req, socket, head, (ws) => {
      dbg("upstream handshake completed, emitting connection");
      upstreamConnections.push(ws);
      upstreamWss.emit("connection", ws, req);
    });
  });

  const clientServer = NodeHttp.createServer((_req, res) => res.end("OK"));
  const upstreamPort = await listen(upstreamServer);
  const removeListener = handleWebSocket(
    clientServer,
    `http://127.0.0.1:${upstreamPort}`,
  );
  const clientPort = await listen(clientServer);

  return {
    clientServer,
    clientPort,
    upstreamServer,
    upstreamWss,
    upstreamPort,
    upstreamCalls,
    upstreamConnections,
    cleanup: () => {
      removeListener();
      for (const client of upstreamWss.clients) {
        client.terminate();
      }
      upstreamWss.close();
    },
  };
};

const makeFakeRequest = (overrides: {
  host: string;
  url?: string;
  protocol?: string;
}): NodeHttp.IncomingMessage => {
  const readable = Readable.from([]);
  return Object.assign(readable, {
    url: overrides.url ?? "/",
    method: "GET",
    headers: {
      host: overrides.host,
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      ...(overrides.protocol
        ? { "sec-websocket-protocol": overrides.protocol }
        : {}),
    },
  }) as unknown as NodeHttp.IncomingMessage;
};

const teardown = async (harness: Harness) => {
  harness.cleanup();
  for (const ws of harness.upstreamConnections) {
    ws.terminate();
  }
  harness.clientServer.closeAllConnections();
  harness.upstreamServer.closeAllConnections();
  await close(harness.clientServer);
  await close(harness.upstreamServer);
};

describe("handleWebSocket", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setup();
  });

  afterEach(async () => {
    await teardown(harness);
  });

  test("proxies messages bidirectionally", async () => {
    harness.upstreamWss.on("connection", (ws) => {
      ws.on("message", (data) => {
        ws.send(`echo:${data.toString()}`);
      });
      ws.send("hello");
    });

    const client = new WebSocket(
      `ws://127.0.0.1:${harness.clientPort}/path?x=1`,
    );
    const received: Array<string> = [];
    client.on("upgrade", (res) =>
      dbg("client received upgrade response", res.statusCode),
    );
    client.on("unexpected-response", (_req, res) =>
      dbg("client unexpected-response", res.statusCode),
    );
    client.on("close", (code, reason) =>
      dbg("client close", code, reason.toString()),
    );
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        dbg("client open, sending ping");
        client.send("ping");
      });
      client.on("message", (data) => {
        dbg("client message", data.toString());
        received.push(data.toString());
        if (received.length === 2) {
          client.close();
          resolve();
        }
      });
      client.on("error", (err) => {
        dbg("client error", err.message);
        reject(err);
      });
    });

    expect(received).toEqual(["hello", "echo:ping"]);
    expect(harness.upstreamCalls).toHaveLength(1);
    const call = harness.upstreamCalls[0]!;
    expect(call.url).toBe("/path?x=1");
    expect(call.method).toBe("GET");
    expect(call.headers.host).toBe(`127.0.0.1:${harness.clientPort}`);
    expect(call.headers.upgrade).toBe("websocket");
  });

  test("ignores vite HMR upgrades", async () => {
    // Emit a synthetic upgrade event directly to avoid leaving an orphaned
    // upgraded socket on the test HTTP server.
    const fakeReq = makeFakeRequest({
      host: `127.0.0.1:${harness.clientPort}`,
      protocol: "vite-hmr",
    });
    const fakeSocket = new NodeNet.Socket();
    const destroySpy = vi.spyOn(fakeSocket, "destroy");
    const writeSpy = vi.spyOn(fakeSocket, "write");

    harness.clientServer.emit("upgrade", fakeReq, fakeSocket, Buffer.alloc(0));

    await new Promise((r) => setTimeout(r, 50));

    expect(harness.upstreamCalls).toHaveLength(0);
    expect(destroySpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("forwards sandbox-preview-URL upgrades even with vite protocol", async () => {
    harness.upstreamWss.on("connection", (ws) => {
      ws.send("ack");
    });

    const sandboxHost = `4567-my-sandbox-sup3rs3cr3t.localhost:${harness.clientPort}`;
    const client = new WebSocket(
      `ws://127.0.0.1:${harness.clientPort}/`,
      "vite-hmr",
      {
        headers: { host: sandboxHost },
      },
    );
    client.on("open", () => dbg("sandbox client open"));
    client.on("upgrade", (res) =>
      dbg("sandbox client received upgrade response", res.statusCode),
    );
    client.on("unexpected-response", (_req, res) =>
      dbg("sandbox client unexpected-response", res.statusCode),
    );
    client.on("close", (code, reason) =>
      dbg("sandbox client close", code, reason.toString()),
    );
    const message = await new Promise<string>((resolve, reject) => {
      client.on("message", (data) => {
        dbg("sandbox client message", data.toString());
        resolve(data.toString());
        client.close();
      });
      client.on("error", (err) => {
        dbg("sandbox client error", err.message);
        reject(err);
      });
    });

    expect(message).toBe("ack");
    expect(harness.upstreamCalls).toHaveLength(1);
    expect(harness.upstreamCalls[0]!.headers.host).toBe(sandboxHost);
    expect(harness.upstreamCalls[0]!.headers["sec-websocket-protocol"]).toBe(
      "vite-hmr",
    );
  });

  test("prefers X-Forwarded-Host over Host when set by a tunnel", async () => {
    harness.upstreamWss.on("connection", (ws) => {
      ws.send("ack");
    });

    const client = new WebSocket(`ws://127.0.0.1:${harness.clientPort}/`, {
      headers: { "x-forwarded-host": "example.ngrok.app" },
    });
    const message = await new Promise<string>((resolve, reject) => {
      client.on("message", (data) => {
        resolve(data.toString());
        client.close();
      });
      client.on("error", reject);
    });

    expect(message).toBe("ack");
    expect(harness.upstreamCalls).toHaveLength(1);
    expect(harness.upstreamCalls[0]!.headers.host).toBe("example.ngrok.app");
  });

  // https://github.com/cloudflare/workers-sdk/issues/12047
  test("survives client disconnect during upgrade", async () => {
    // Upstream upgrade handler that never responds — the proxy is stuck waiting
    // when the client resets the connection.
    harness.upstreamServer.removeAllListeners("upgrade");
    harness.upstreamServer.on("upgrade", () => {});

    const fakeReq = makeFakeRequest({ host: "localhost" });
    const fakeSocket = new NodeNet.Socket();
    harness.clientServer.emit("upgrade", fakeReq, fakeSocket, Buffer.alloc(0));

    fakeSocket.destroy(new Error("ECONNRESET"));

    // The proxy and Vite server should still be responsive.
    const response = await fetch(`http://127.0.0.1:${harness.clientPort}/`);
    expect(response.ok).toBe(true);
  });

  test("destroys client socket when worker does not upgrade", async () => {
    // Upstream responds with a normal HTTP 200 instead of upgrading.
    harness.upstreamServer.removeAllListeners("upgrade");

    const fakeReq = makeFakeRequest({ host: "localhost" });
    const fakeSocket = new NodeNet.Socket();
    harness.clientServer.emit("upgrade", fakeReq, fakeSocket, Buffer.alloc(0));

    await new Promise<void>((resolve) => fakeSocket.once("close", resolve));
    expect(fakeSocket.destroyed).toBe(true);
  });

  test("returns a cleanup function that removes the upgrade listener", async () => {
    const server = NodeHttp.createServer();
    await listen(server);
    const remove = handleWebSocket(
      server,
      `http://127.0.0.1:${harness.upstreamPort}`,
    );
    expect(server.listenerCount("upgrade")).toBe(1);
    remove();
    expect(server.listenerCount("upgrade")).toBe(0);
    await close(server);
  });
});
