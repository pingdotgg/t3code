import { createServer, request } from "node:http";
import { connect as connectTcp, createServer as createTcpServer } from "node:net";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const pnpmDirectory = join(repositoryRoot, "node_modules/.pnpm");
const wsPackageDirectory = readdirSync(pnpmDirectory)
  .filter((name) => name.startsWith("ws@8."))
  .sort()
  .at(-1);
if (!wsPackageDirectory) throw new Error("The locked ws 8 package is not installed");
const requireWs = createRequire(join(pnpmDirectory, wsPackageDirectory, "node_modules/ws/package.json"));
const { WebSocket, WebSocketServer } = requireWs("ws");

function listen(server) {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePort(address.port);
    });
  });
}

function listenTcp(server) {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePort(server.address().port));
  });
}

function close(server) {
  return new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return {
    count: sorted.length,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1),
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

const upstreamWebSockets = new WebSocketServer({ noServer: true });
upstreamWebSockets.on("connection", (socket) => {
  socket.on("message", (message) => socket.send(`upstream:${message}`));
});
const upstream = createServer((incoming, response) => {
  response.writeHead(200, {
    "content-type": incoming.url === "/app" ? "text/html" : "application/json",
    "x-upstream-host": incoming.headers.host ?? "",
  });
  response.end(
    incoming.url === "/app"
      ? "<!doctype html><title>Remote Preview</title><h1>remote-loopback-ok</h1>"
      : JSON.stringify({ ok: true, url: incoming.url }),
  );
});
upstream.on("upgrade", (incoming, socket, head) => {
  upstreamWebSockets.handleUpgrade(incoming, socket, head, (webSocket) => {
    upstreamWebSockets.emit("connection", webSocket, incoming);
  });
});
const upstreamPort = await listen(upstream);

const gatewayWebSockets = new WebSocketServer({ noServer: true });
gatewayWebSockets.on("connection", (clientSocket, incoming) => {
  const upstreamSocket = new WebSocket(`ws://127.0.0.1:${upstreamPort}${incoming.url}`);
  const pending = [];
  clientSocket.on("message", (message) => {
    if (upstreamSocket.readyState === WebSocket.OPEN) upstreamSocket.send(message);
    else pending.push(message);
  });
  upstreamSocket.on("open", () => pending.splice(0).forEach((message) => upstreamSocket.send(message)));
  upstreamSocket.on("message", (message) => clientSocket.send(message));
  const closeBoth = () => {
    if (clientSocket.readyState < WebSocket.CLOSING) clientSocket.close();
    if (upstreamSocket.readyState < WebSocket.CLOSING) upstreamSocket.close();
  };
  clientSocket.on("close", closeBoth);
  upstreamSocket.on("close", closeBoth);
  upstreamSocket.on("error", closeBoth);
});

const gateway = createServer((incoming, response) => {
  const upstreamRequest = request(
    {
      hostname: "127.0.0.1",
      port: upstreamPort,
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, host: `127.0.0.1:${upstreamPort}` },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstreamRequest.on("error", (error) => response.destroy(error));
  incoming.pipe(upstreamRequest);
});
gateway.on("upgrade", (incoming, socket, head) => {
  gatewayWebSockets.handleUpgrade(incoming, socket, head, (webSocket) => {
    gatewayWebSockets.emit("connection", webSocket, incoming);
  });
});
const gatewayPort = await listen(gateway);

const tunnelWebSockets = new WebSocketServer({ noServer: true });
tunnelWebSockets.on("connection", (tunnelSocket) => {
  const upstreamSocket = connectTcp({ host: "127.0.0.1", port: upstreamPort });
  const pending = [];
  tunnelSocket.on("message", (message) => {
    const bytes = Buffer.from(message);
    if (upstreamSocket.readyState === "open") upstreamSocket.write(bytes);
    else pending.push(bytes);
  });
  upstreamSocket.on("connect", () => pending.splice(0).forEach((bytes) => upstreamSocket.write(bytes)));
  upstreamSocket.on("data", (bytes) => {
    if (tunnelSocket.readyState === WebSocket.OPEN) tunnelSocket.send(bytes, { binary: true });
  });
  const closeBoth = () => {
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    if (tunnelSocket.readyState < WebSocket.CLOSING) tunnelSocket.close();
  };
  upstreamSocket.on("close", closeBoth);
  upstreamSocket.on("error", closeBoth);
  tunnelSocket.on("close", closeBoth);
});
const tunnelServer = createServer();
tunnelServer.on("upgrade", (incoming, socket, head) => {
  tunnelWebSockets.handleUpgrade(incoming, socket, head, (webSocket) => {
    tunnelWebSockets.emit("connection", webSocket, incoming);
  });
});
const tunnelPort = await listen(tunnelServer);

const desktopLoopback = createTcpServer((browserSocket) => {
  const tunnelSocket = new WebSocket(`ws://127.0.0.1:${tunnelPort}/tcp`);
  const pending = [];
  browserSocket.on("data", (bytes) => {
    if (tunnelSocket.readyState === WebSocket.OPEN) tunnelSocket.send(bytes, { binary: true });
    else pending.push(bytes);
  });
  tunnelSocket.on("open", () => pending.splice(0).forEach((bytes) => tunnelSocket.send(bytes, { binary: true })));
  tunnelSocket.on("message", (message) => browserSocket.write(Buffer.from(message)));
  const closeBoth = () => {
    if (!browserSocket.destroyed) browserSocket.destroy();
    if (tunnelSocket.readyState < WebSocket.CLOSING) tunnelSocket.close();
  };
  browserSocket.on("close", closeBoth);
  browserSocket.on("error", closeBoth);
  tunnelSocket.on("close", closeBoth);
  tunnelSocket.on("error", closeBoth);
});
const desktopLoopbackPort = await listenTcp(desktopLoopback);

async function measureFetch(url, count) {
  const durations = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    const response = await fetch(url);
    await response.arrayBuffer();
    durations.push(performance.now() - startedAt);
  }
  return summarize(durations);
}

function websocketRoundTrips(url, count) {
  return new Promise((resolveResult, reject) => {
    const socket = new WebSocket(url);
    const durations = [];
    let startedAt = 0;
    let completed = 0;
    socket.on("open", () => {
      startedAt = performance.now();
      socket.send(String(completed));
    });
    socket.on("message", (message) => {
      durations.push(performance.now() - startedAt);
      if (String(message) !== `upstream:${completed}`) {
        reject(new Error(`Unexpected WebSocket response: ${message}`));
        return;
      }
      completed += 1;
      if (completed === count) {
        socket.close();
        resolveResult(summarize(durations));
        return;
      }
      startedAt = performance.now();
      socket.send(String(completed));
    });
    socket.on("error", reject);
  });
}

try {
  const appResponse = await fetch(`http://127.0.0.1:${gatewayPort}/app`);
  const appBody = await appResponse.text();
  const directHttp = await measureFetch(`http://127.0.0.1:${upstreamPort}/bench`, 100);
  const gatewayHttp = await measureFetch(`http://127.0.0.1:${gatewayPort}/bench`, 100);
  const gatewayWebSocket = await websocketRoundTrips(`ws://127.0.0.1:${gatewayPort}/hmr`, 100);
  const tunnelAppResponse = await fetch(`http://127.0.0.1:${desktopLoopbackPort}/app`);
  const tunnelAppBody = await tunnelAppResponse.text();
  const rawTunnelHttp = await measureFetch(`http://127.0.0.1:${desktopLoopbackPort}/bench`, 100);
  const rawTunnelWebSocket = await websocketRoundTrips(
    `ws://127.0.0.1:${desktopLoopbackPort}/hmr`,
    100,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        success: appBody.includes("remote-loopback-ok"),
        upstreamPort,
        gatewayPort,
        responseHeaders: Object.fromEntries(appResponse.headers),
        directHttp,
        gatewayHttp,
        addedHttpMedianMs: gatewayHttp.medianMs - directHttp.medianMs,
        gatewayWebSocket,
        rawTcpTunnel: {
          success: tunnelAppBody.includes("remote-loopback-ok"),
          environmentTunnelPort: tunnelPort,
          desktopLoopbackPort,
          http: rawTunnelHttp,
          addedHttpMedianMs: rawTunnelHttp.medianMs - directHttp.medianMs,
          webSocket: rawTunnelWebSocket,
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await Promise.all([close(desktopLoopback), close(tunnelServer), close(gateway), close(upstream)]);
}
