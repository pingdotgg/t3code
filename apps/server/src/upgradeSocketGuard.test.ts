import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { expect, it } from "@effect/vitest";

import { guardUpgradeSockets } from "./upgradeSocketGuard.ts";

const UPGRADE_REQUEST =
  "GET /ws HTTP/1.1\r\n" +
  "Host: 127.0.0.1\r\n" +
  "Upgrade: websocket\r\n" +
  "Connection: Upgrade\r\n" +
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
  "Sec-WebSocket-Version: 13\r\n" +
  "\r\n";

const listen = (server: NodeHttp.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as NodeNet.AddressInfo).port));
  });

const close = (server: NodeHttp.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

const resetUpgradeConnection = (port: number): Promise<void> =>
  new Promise((resolve) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.on("error", () => resolve());
    socket.on("connect", () => {
      socket.write(UPGRADE_REQUEST);
      setTimeout(() => {
        socket.resetAndDestroy();
        resolve();
      }, 50);
    });
  });

const makeUpgradeServer = () => {
  const server = NodeHttp.createServer((_request, response) => {
    response.writeHead(200);
    response.end("ok");
  });
  server.on("upgrade", (_request, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
  });
  return server;
};

const httpGet = (port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    NodeHttp.get({ host: "127.0.0.1", port, path: "/" }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on("error", reject);
  });

it("attaches an error listener to every upgrade socket", async () => {
  const server = guardUpgradeSockets(makeUpgradeServer());
  // Registered after the guard, so it runs second and observes the guard's listener.
  const observed = new Promise<number>((resolve) => {
    server.on("upgrade", (_request, socket) => resolve(socket.listenerCount("error")));
  });
  const port = await listen(server);
  try {
    const client = NodeNet.connect(port, "127.0.0.1");
    client.on("error", () => {});
    client.on("connect", () => client.write(UPGRADE_REQUEST));
    expect(await observed).toBe(1);
    client.destroy();
  } finally {
    await close(server);
  }
});

it("keeps the server alive when a client RSTs a /ws upgrade connection", async () => {
  const uncaught: Array<unknown> = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);

  const server = guardUpgradeSockets(makeUpgradeServer());
  const port = await listen(server);
  try {
    for (let i = 0; i < 10; i++) {
      await resetUpgradeConnection(port);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(uncaught).toEqual([]);
    expect(await httpGet(port)).toBe(200);
  } finally {
    process.off("uncaughtException", onUncaught);
    await close(server);
  }
});
