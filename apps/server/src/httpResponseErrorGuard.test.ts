// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  guardHttpResponseWriteErrors,
  holdRequestsUntilServing,
} from "./httpResponseErrorGuard.ts";

const servers: NodeHttp.Server[] = [];

function listen(server: NodeHttp.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as NodeNet.AddressInfo).port);
    });
  });
}

function fetchStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.get({ host: "127.0.0.1", port, path }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.setTimeout(5_000, () => reject(new Error("request timed out")));
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
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
    client.on("error", () => {});

    await failureObserved.promise;
    client.destroy();

    expect(writeErrors).toHaveLength(1);
    expect(writeErrors[0]).toBeInstanceOf(Error);
    expect((writeErrors[0] as NodeJS.ErrnoException).code).toBe("EPIPE");

    // The process survived the failed write and the server keeps serving.
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

describe("holdRequestsUntilServing", () => {
  it("answers requests and upgrades accepted before the handlers attach", async () => {
    const server = holdRequestsUntilServing(guardHttpResponseWriteErrors(NodeHttp.createServer()));
    const port = await listen(server);
    const requestsParked = Promise.withResolvers<void>();
    let parsedRequests = 0;
    server.on("connection", (socket) =>
      socket.once("data", () => {
        if (++parsedRequests === 2) requestsParked.resolve();
      }),
    );

    const response = fetchStatus(port, "/early");
    const upgradeResponse = new Promise<string>((resolve, reject) => {
      const client = NodeNet.connect(port, "127.0.0.1", () => {
        client.write(
          [
            "GET /ws HTTP/1.1",
            "Host: 127.0.0.1",
            "Connection: Upgrade",
            "Upgrade: websocket",
            "",
            "",
          ].join("\r\n"),
        );
      });
      client.once("data", (data) => {
        resolve(data.toString().split("\r\n")[0] ?? "");
        client.destroy();
      });
      client.on("error", reject);
    });
    // Node's HTTP parser handles data before this observer.
    await requestsParked.promise;

    server.on("request", (_request, response) => {
      response.writeHead(204);
      response.end();
    });
    server.on("upgrade", (_request, socket) => {
      socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
    });

    await expect(response).resolves.toBe(204);
    await expect(upgradeResponse).resolves.toBe("HTTP/1.1 101 Switching Protocols");
  });

  it("hands parked requests to the handler before later ones", async () => {
    const server = holdRequestsUntilServing(NodeHttp.createServer());
    const received: Array<unknown> = [];
    server.emit("request", "parked");
    // A request whose I/O callback is already queued when the handler attaches.
    const laterEmitted = new Promise<void>((resolve) =>
      setImmediate(() => {
        server.emit("request", "later");
        resolve();
      }),
    );
    server.on("request", (request) => received.push(request));
    await laterEmitted;

    expect(received).toEqual(["parked", "later"]);
  });
});
