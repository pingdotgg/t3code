// Exercise the raw Node HTTP boundary before Effect attaches serving handlers.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as HttpResponseErrorGuard from "./httpResponseErrorGuard.ts";

const { guardHttpResponseWriteErrors } = HttpResponseErrorGuard;

const servers: NodeHttp.Server[] = [];
const requests: NodeHttp.ClientRequest[] = [];
const sockets: NodeNet.Socket[] = [];

function listen(server: NodeHttp.Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket) => sockets.push(socket));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as NodeNet.AddressInfo).port);
    });
  });
}

function fetchResponse(
  port: number,
  path: string,
  upgrade = false,
): Promise<NodeHttp.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.get(
      {
        host: "127.0.0.1",
        port,
        path,
        agent: false,
        headers: upgrade
          ? {
              connection: "Upgrade",
              upgrade: "websocket",
              "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
              "sec-websocket-version": "13",
            }
          : {},
      },
      (response) => {
        response.on("error", reject);
        response.on("end", () => resolve(response));
        response.resume();
      },
    );
    requests.push(request);
    request.on("error", reject);
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response);
    });
  });
}

function fetchStatus(port: number, path: string): Promise<number> {
  return fetchResponse(port, path).then((response) => response.statusCode ?? 0);
}

afterEach(async () => {
  for (const request of requests.splice(0)) {
    request.destroy();
  }
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("guardHttpResponseWriteErrors", () => {
  it("contains an upgrade socket write failure instead of crashing the process", async () => {
    const writeErrors: unknown[] = [];
    const failureObserved = Promise.withResolvers<void>();
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) => {
      writeErrors.push(error);
      failureObserved.resolve();
    });

    server.on("upgrade", (_request, socket) => {
      // Simulate the client vanishing while the auth rejection response is
      // written to the upgrade socket: the write failure surfaces as an
      // "error" event on a socket Node's http server no longer listens to.
      socket.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    });

    const port = await listen(server);

    const client = NodeNet.connect(port, "127.0.0.1", () => {
      client.write(
        [
          "GET /rpc HTTP/1.1",
          "Host: 127.0.0.1",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    sockets.push(client);
    client.on("error", () => {});

    await failureObserved.promise;
    client.destroy();

    expect(writeErrors).toHaveLength(1);
    expect(writeErrors[0]).toBeInstanceOf(Error);
    expect((writeErrors[0] as NodeJS.ErrnoException).code).toBe("EPIPE");

    server.on("request", (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    await expect(fetchStatus(port, "/")).resolves.toBe(200);
  });

  it("arms every response with an error listener without disturbing normal traffic", async () => {
    const writeErrors: unknown[] = [];
    let responseErrorListeners = -1;
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) => {
      writeErrors.push(error);
    });

    server.on("request", (_request, response) => {
      responseErrorListeners = response.listenerCount("error");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });

    const port = await listen(server);

    await expect(fetchStatus(port, "/")).resolves.toBe(200);
    expect(responseErrorListeners).toBeGreaterThan(0);
    expect(writeErrors).toEqual([]);
  });
});

describe("rejectRequestsUntilServing", () => {
  it("rejects early HTTP and upgrades, then hands each off to its serving handler", async () => {
    const writeErrors: unknown[] = [];
    const server = HttpResponseErrorGuard.rejectRequestsUntilServing(
      guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) => writeErrors.push(error)),
    );
    const port = await listen(server);

    const earlyHttp = await fetchResponse(port, "/");
    expect(earlyHttp.statusCode).toBe(503);
    expect(earlyHttp.headers["retry-after"]).toBe("1");

    const earlyUpgrade = await fetchResponse(port, "/rpc", true);
    expect(earlyUpgrade.statusCode).toBe(503);
    expect(earlyUpgrade.headers["retry-after"]).toBe("1");

    server.on("request", (_request, response) => response.writeHead(204).end());

    const servingHttp = await fetchResponse(port, "/");
    expect(servingHttp.statusCode).toBe(204);
    expect(servingHttp.headers["retry-after"]).toBeUndefined();

    const pendingUpgrade = await fetchResponse(port, "/rpc", true);
    expect(pendingUpgrade.statusCode).toBe(503);
    expect(pendingUpgrade.headers["retry-after"]).toBe("1");

    server.on("upgrade", (_request, socket) => {
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });

    const servingUpgrade = await fetchResponse(port, "/rpc", true);
    expect(servingUpgrade.statusCode).toBe(101);
    expect(servingUpgrade.headers["retry-after"]).toBeUndefined();
    expect(writeErrors).toEqual([]);
  }, 5_000);
});
