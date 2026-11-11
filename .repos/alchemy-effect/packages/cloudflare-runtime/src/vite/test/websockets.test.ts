import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeNet from "node:net";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { handleWebSocket } from "../websockets.ts";

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
    "websocket-secret",
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
    socket: {},
    headers: {
      host: overrides.host,
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      ...(overrides.protocol ? { "sec-websocket-protocol": overrides.protocol } : {}),
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

    const client = new WebSocket(`ws://127.0.0.1:${harness.clientPort}/path?x=1`);
    const received: Array<string> = [];
    client.on("upgrade", (res) => dbg("client received upgrade response", res.statusCode));
    client.on("unexpected-response", (_req, res) =>
      dbg("client unexpected-response", res.statusCode),
    );
    client.on("close", (code, reason) => dbg("client close", code, reason.toString()));
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
    const client = new WebSocket(`ws://127.0.0.1:${harness.clientPort}/`, "vite-hmr", {
      headers: { host: sandboxHost },
    });
    client.on("open", () => dbg("sandbox client open"));
    client.on("upgrade", (res) => dbg("sandbox client received upgrade response", res.statusCode));
    client.on("unexpected-response", (_req, res) =>
      dbg("sandbox client unexpected-response", res.statusCode),
    );
    client.on("close", (code, reason) => dbg("sandbox client close", code, reason.toString()));
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
    expect(harness.upstreamCalls[0]!.headers["sec-websocket-protocol"]).toBe("vite-hmr");
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

  test("relays the worker's response and closes when it refuses the upgrade", async () => {
    // The worker rejects the handshake with a plain HTTP response instead of
    // upgrading — the client must see that response, not a connection reset,
    // and the socket closes once it is relayed (the promise resolves on close).
    harness.upstreamServer.removeAllListeners("upgrade");
    harness.upstreamServer.on("upgrade", (_request, socket) => {
      socket.end(
        [
          "HTTP/1.1 403 Forbidden",
          "content-type: text/plain",
          "content-length: 9",
          "connection: close",
          "",
          "Forbidden",
        ].join("\r\n"),
      );
    });

    const received = await new Promise<string>((resolve, reject) => {
      const socket = NodeNet.connect(harness.clientPort, "127.0.0.1", () => {
        socket.write(
          [
            "GET /ws HTTP/1.1",
            `Host: 127.0.0.1:${harness.clientPort}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      });
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
      });
      socket.on("close", () => resolve(buffer));
      socket.on("error", reject);
    });

    expect(received).toContain("HTTP/1.1 403 Forbidden");
    expect(received).toContain("content-type: text/plain");
    expect(received.endsWith("Forbidden")).toBe(true);
  });

  test("forwards an upgrade an async listener declines", async () => {
    harness.upstreamWss.on("connection", (ws) => ws.send("ack"));
    // Like Vite's `server.proxy`, which awaits a `bypass` before it decides.
    harness.clientServer.on("upgrade", async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    const client = new WebSocket(`ws://127.0.0.1:${harness.clientPort}/ws`);
    const message = await new Promise<string>((resolve, reject) => {
      client.on("message", (data) => {
        resolve(data.toString());
        client.close();
      });
      client.on("error", reject);
    });
    expect(message).toBe("ack");
  });

  test("forwards an upgrade another listener only guards with a no-op error handler", async () => {
    harness.upstreamWss.on("connection", (ws) => ws.send("ack"));
    // Vite 8.3.5's HMR listener does this for every upgrade it doesn't handle.
    harness.clientServer.on("upgrade", (_request, socket) => {
      socket.on("error", function noop() {});
      socket.on("error", () => {});
    });

    const client = new WebSocket(`ws://127.0.0.1:${harness.clientPort}/ws`);
    const message = await new Promise<string>((resolve, reject) => {
      client.on("message", (data) => {
        resolve(data.toString());
        client.close();
      });
      client.on("error", reject);
    });
    expect(message).toBe("ack");
  });

  // https://github.com/alchemy-run/alchemy/issues/2191
  describe("leaves an upgrade another plugin accepts to that plugin", () => {
    const refuseUpgrades = () => {
      // workerd answers an upgrade on a path the Worker doesn't route with
      // plain HTTP.
      harness.upstreamServer.removeAllListeners("upgrade");
      harness.upstreamServer.on("upgrade", (_request, socket) => {
        socket.end(
          [
            "HTTP/1.1 404 Not Found",
            "content-length: 9",
            "connection: close",
            "",
            "Not Found",
          ].join("\r\n"),
        );
      });
    };

    // A plugin's own dev WebSocket, like `@foldkit/vite-plugin`'s relay.
    const echoPlugin = (
      server: NodeHttp.Server,
      options: { verifyDelay?: number; listenerDelay?: number } = {},
    ) => {
      const wss = new WebSocketServer({
        noServer: true,
        ...(options.verifyDelay !== undefined
          ? {
              verifyClient: (_info: unknown, done: (result: boolean) => void) =>
                setTimeout(() => done(true), options.verifyDelay),
            }
          : {}),
      });
      server.on("upgrade", async (request, socket, head) => {
        if (request.url !== "/__echo") return;
        if (options.listenerDelay !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.listenerDelay));
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.on("message", (data) => ws.send(`echo ${data}`));
        });
      });
      return wss;
    };

    const echo = (port: number) =>
      new Promise<Array<string>>((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${port}/__echo`);
        const events: Array<string> = [];
        client.on("open", () => {
          events.push("open");
          client.send("hi");
        });
        client.on("message", (data) => {
          events.push(data.toString());
          // Stay open long enough for a late close to show up.
          setTimeout(() => {
            resolve([...events]);
            client.close();
          }, 200);
        });
        client.on("close", (code) => {
          events.push(`close ${code}`);
          resolve(events);
        });
        client.on("error", reject);
      });

    test("a plugin registered after the proxy", async () => {
      refuseUpgrades();
      const wss = echoPlugin(harness.clientServer);
      expect(await echo(harness.clientPort)).toEqual(["open", "echo hi"]);
      wss.close();
    });

    test("a plugin registered before the proxy", async () => {
      refuseUpgrades();
      const server = NodeHttp.createServer();
      const wss = echoPlugin(server);
      const remove = handleWebSocket(
        server,
        `http://127.0.0.1:${harness.upstreamPort}`,
        "websocket-secret",
      );
      const port = await listen(server);
      expect(await echo(port)).toEqual(["open", "echo hi"]);
      remove();
      wss.close();
      await close(server);
    });

    test("a plugin that accepts after the Worker has answered", async () => {
      refuseUpgrades();
      const wss = echoPlugin(harness.clientServer, { verifyDelay: 200 });
      expect(await echo(harness.clientPort)).toEqual(["open", "echo hi"]);
      wss.close();
    });

    test("a plugin that awaits before it touches the socket", async () => {
      refuseUpgrades();
      const wss = echoPlugin(harness.clientServer, { listenerDelay: 200 });
      expect(await echo(harness.clientPort)).toEqual(["open", "echo hi"]);
      wss.close();
    });
  });

  test("returns a cleanup function that removes the upgrade listener", async () => {
    const server = NodeHttp.createServer();
    await listen(server);
    const remove = handleWebSocket(
      server,
      `http://127.0.0.1:${harness.upstreamPort}`,
      "websocket-secret",
    );
    expect(server.listenerCount("upgrade")).toBe(1);
    remove();
    expect(server.listenerCount("upgrade")).toBe(0);
    await close(server);
  });
});
