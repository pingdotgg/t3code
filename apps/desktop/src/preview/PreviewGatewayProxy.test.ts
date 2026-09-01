// @effect-diagnostics nodeBuiltinImport:off globalDate:off - These tests exercise the native HTTP proxy boundary.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { startPreviewGatewayProxy, type PreviewGatewayProxy } from "./PreviewGatewayProxy.ts";

const servers: Array<NodeHttp.Server> = [];
const proxies: Array<PreviewGatewayProxy> = [];

const listen = async (server: NodeHttp.Server): Promise<number> => {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server port");
  return address.port;
};

const startProxy = async (
  httpBaseUrl: string,
  ticket: string,
  port = 3000,
  expiresAtEpochMilliseconds = Date.now() + 60_000,
): Promise<PreviewGatewayProxy> => {
  const proxy = await startPreviewGatewayProxy({
    httpBaseUrl,
    ticket,
    port,
    expiresAtEpochMilliseconds,
  });
  proxies.push(proxy);
  return proxy;
};

const request = async (
  proxyPort: number,
  targetUrl: string,
  options: {
    readonly method?: string;
    readonly headers?: NodeHttp.OutgoingHttpHeaders;
    readonly body?: string;
  } = {},
): Promise<{
  readonly statusCode: number | undefined;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}> =>
  await new Promise((resolve, reject) => {
    const proxyRequest = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: options.method,
        path: targetUrl,
        headers: options.headers,
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    proxyRequest.once("error", reject);
    if (options.body !== undefined) proxyRequest.write(options.body);
    proxyRequest.end();
  });

afterEach(async () => {
  await Promise.allSettled(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("PreviewGatewayProxy", () => {
  it("routes selected loopback HTTP traffic without changing browser semantics", async () => {
    type ReceivedRequest = {
      readonly url: string | undefined;
      readonly method: string | undefined;
      readonly headers: NodeHttp.IncomingHttpHeaders;
      readonly body: string;
    };
    let resolveReceived!: (request: ReceivedRequest) => void;
    const received = new Promise<ReceivedRequest>((resolve) => {
      resolveReceived = resolve;
    });
    const gateway = NodeHttp.createServer((gatewayRequest, gatewayResponse) => {
      const chunks: Array<Buffer> = [];
      gatewayRequest.on("data", (chunk: Buffer) => chunks.push(chunk));
      gatewayRequest.on("end", () => {
        resolveReceived({
          url: gatewayRequest.url,
          method: gatewayRequest.method,
          headers: gatewayRequest.headers,
          body: Buffer.concat(chunks).toString(),
        });
        gatewayResponse.writeHead(307, {
          location: "/redirected",
          "set-cookie": ["first=one; Path=/", "second=two; Path=/"],
          "x-gateway-response": "preserved",
        });
        gatewayResponse.end("redirect body");
      });
    });
    const gatewayPort = await listen(gateway);
    const proxy = await startProxy(`http://127.0.0.1:${gatewayPort}/ignored`, "ticket-one");
    const response = await request(
      proxy.port,
      "http://localhost:3000/nested/path?query=one%20two&repeat=1&repeat=2",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-original-header": "preserved",
        },
        body: '{"works":true}',
      },
    );
    expect(response.statusCode).toBe(307);
    expect(response.headers.location).toBe("/redirected");
    expect(response.headers["set-cookie"]).toEqual(["first=one; Path=/", "second=two; Path=/"]);
    expect(response.headers["x-gateway-response"]).toBe("preserved");
    expect(response.body).toBe("redirect body");

    const gatewayRequest = await received;
    expect(gatewayRequest.url).toBe("/api/preview-gateway/http");
    expect(gatewayRequest.method).toBe("POST");
    expect(gatewayRequest.headers["x-t3-preview-gateway-ticket"]).toBe("ticket-one");
    expect(gatewayRequest.headers["x-t3-preview-gateway-target"]).toBe(
      "http://localhost:3000/nested/path?query=one%20two&repeat=1&repeat=2",
    );
    expect(gatewayRequest.headers["x-original-header"]).toBe("preserved");
    expect(gatewayRequest.headers["content-type"]).toBe("application/json");
    expect(gatewayRequest.body).toBe('{"works":true}');

    const unselected = await request(proxy.port, "http://localhost:5173/");
    expect(unselected.statusCode).toBe(502);
    expect(unselected.body).toContain("this loopback port has not been authorized");

    proxy.configure({
      httpBaseUrl: `http://127.0.0.1:${gatewayPort}`,
      ticket: "expired-ticket",
      port: 8080,
      expiresAtEpochMilliseconds: Date.now() - 1,
    });
    const expired = await request(proxy.port, "http://localhost:8080/");
    expect(expired.statusCode).toBe(502);
    expect(expired.body).toContain('content="authentication-expired" data-port="8080"');
  });

  it("bridges Vite HMR websocket upgrades, handshake heads, and frames", async () => {
    let gatewayHeaders: NodeHttp.IncomingHttpHeaders | undefined;
    let browserHeadAtGateway = "";
    let resolveGatewayClosed!: () => void;
    const gatewayClosed = new Promise<void>((resolve) => {
      resolveGatewayClosed = resolve;
    });
    const gateway = NodeHttp.createServer();
    gateway.on("upgrade", (gatewayRequest, gatewaySocket) => {
      gatewayHeaders = gatewayRequest.headers;
      gatewaySocket.on("error", () => undefined);
      gatewaySocket.once("close", resolveGatewayClosed);
      gatewaySocket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Protocol: vite-hmr\r\n\r\n" +
          "gateway-head",
      );
      gatewaySocket.once("data", (data) => {
        browserHeadAtGateway = data.toString();
        gatewaySocket.write(`echo:${data.toString()}`);
      });
    });
    const gatewayPort = await listen(gateway);
    const proxy = await startProxy(`http://127.0.0.1:${gatewayPort}`, "ws-ticket", 4173);

    const browserResponse = await new Promise<string>((resolve, reject) => {
      const socket = NodeNet.connect(proxy.port, "127.0.0.1");
      let received = "";
      let tunnelEstablished = false;
      socket.once("connect", () => {
        socket.write("CONNECT localhost:4173 HTTP/1.1\r\nHost: localhost:4173\r\n\r\n");
      });
      socket.on("data", (data) => {
        received += data.toString();
        if (!tunnelEstablished && received.includes("HTTP/1.1 200 Connection Established")) {
          tunnelEstablished = true;
          socket.write(
            "GET /socket?channel=one HTTP/1.1\r\n" +
              "Host: localhost:4173\r\n" +
              "Connection: Upgrade\r\n" +
              "Upgrade: websocket\r\n" +
              "Sec-WebSocket-Key: dGVzdC1wcmV2aWV3LWtleQ==\r\n" +
              "Sec-WebSocket-Version: 13\r\n" +
              "Sec-WebSocket-Protocol: vite-hmr\r\n\r\n" +
              "browser-head",
          );
        }
        if (received.includes("echo:browser-head")) {
          socket.destroy();
          resolve(received);
        }
      });
      socket.once("error", reject);
    });
    await proxy.close();
    await gatewayClosed;

    expect(gatewayHeaders?.["x-t3-preview-gateway-ticket"]).toBe("ws-ticket");
    expect(gatewayHeaders?.["x-t3-preview-gateway-target"]).toBe(
      "ws://localhost:4173/socket?channel=one",
    );
    expect(gatewayHeaders?.["sec-websocket-protocol"]).toBe("vite-hmr");
    expect(browserHeadAtGateway).toBe("browser-head");
    expect(browserResponse).toContain("HTTP/1.1 101 Switching Protocols");
    expect(browserResponse).toContain("Sec-WebSocket-Protocol: vite-hmr");
    expect(browserResponse).toContain("gateway-head");
    expect(browserResponse).toContain("echo:browser-head");
  });
});
