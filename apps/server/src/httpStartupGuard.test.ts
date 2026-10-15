// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";
import { rejectRequestsUntilServing } from "./httpStartupGuard.ts";

const servers: NodeHttp.Server[] = [];

function listen(server: NodeHttp.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as NodeNet.AddressInfo).port);
    });
  });
}

function get(port: number): Promise<NodeHttp.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.get({ host: "127.0.0.1", port, path: "/" }, (response) => {
      response.resume();
      resolve(response);
    });
    request.on("error", reject);
    request.setTimeout(5_000, () => reject(new Error("request timed out")));
  });
}

function upgrade(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
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
    client.on("data", (chunk) => chunks.push(chunk));
    client.on("end", () => resolve(Buffer.concat(chunks).toString()));
    client.on("error", reject);
    client.setTimeout(5_000, () => reject(new Error("upgrade timed out")));
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

describe("rejectRequestsUntilServing", () => {
  it("answers 503 until the app handler attaches, then gets out of the way", async () => {
    const server = rejectRequestsUntilServing(
      guardHttpResponseWriteErrors(NodeHttp.createServer()),
    );
    const port = await listen(server);

    const early = await get(port);
    expect(early.statusCode).toBe(503);
    expect(early.headers["retry-after"]).toBe("1");
    expect(await upgrade(port)).toMatch(/^HTTP\/1\.1 503 /);

    // Mirrors NodeHttpServer.serve() attaching the Effect handlers.
    server.on("request", (_request, response) => {
      response.writeHead(200).end("ok");
    });
    server.on("upgrade", (_request, socket) => {
      socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
    });

    const late = await get(port);
    expect(late.statusCode).toBe(200);
    expect(late.headers["retry-after"]).toBeUndefined();
    expect(await upgrade(port)).toMatch(/^HTTP\/1\.1 101 /);
    expect(server.listenerCount("newListener")).toBe(0);
  });
});
