// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  PREVIEW_GATEWAY_HTTP_PATH,
  PREVIEW_GATEWAY_TARGET_HEADER,
  PREVIEW_GATEWAY_TICKET_HEADER,
  PREVIEW_GATEWAY_WEBSOCKET_PATH,
} from "@t3tools/shared/previewGateway";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import {
  Cookies,
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServer,
  HttpRouter,
} from "effect/unstable/http";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  previewGatewayRouteLayer,
  resolvePreviewGatewayTarget,
  sanitizePreviewGatewayHeaders,
} from "./Gateway.ts";
import { issuePreviewGatewayTicket } from "./GatewayTicket.ts";

const secretStoreLayer = Layer.mock(ServerSecretStore.ServerSecretStore)({
  getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
});
const otherEnvironmentSecretStoreLayer = Layer.mock(ServerSecretStore.ServerSecretStore)({
  getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(9)),
});
const issueTicket = (port: number) =>
  issuePreviewGatewayTicket(port).pipe(Effect.provide(secretStoreLayer));

const gatewayAppLayer = HttpRouter.serve(previewGatewayRouteLayer).pipe(
  Layer.provide(secretStoreLayer),
);

const buildGateway = Layer.build(gatewayAppLayer);

const listen = (server: NodeHttp.Server) =>
  Effect.acquireRelease(
    Effect.callback<number, Error>((resume) => {
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(0, "127.0.0.1", () => {
        server.removeAllListeners("error");
        resume(Effect.succeed((server.address() as NodeNet.AddressInfo).port));
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        server.closeAllConnections();
      }),
  );

const requestGateway = (input: {
  readonly path: string;
  readonly target: string;
  readonly ticket?: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}) => {
  let request = HttpClientRequest.make(input.method ?? "GET")(input.path, {
    headers: {
      [PREVIEW_GATEWAY_TARGET_HEADER]: input.target,
      ...(input.ticket === undefined ? {} : { [PREVIEW_GATEWAY_TICKET_HEADER]: input.ticket }),
      ...input.headers,
    },
  });
  if (input.body !== undefined) request = HttpClientRequest.bodyText(request, input.body);
  return HttpClient.execute(request);
};

const readGatewayError = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.map((html) => ({
      status: response.status,
      code: /name="t3-preview-gateway-error" content="([^"]+)"/u.exec(html)?.[1],
      port: /data-port="([^"]+)"/u.exec(html)?.[1],
    })),
  );

describe("preview gateway target validation", () => {
  it("accepts only loopback targets and strips proxy credentials", () => {
    expect(resolvePreviewGatewayTarget("http://127.7.8.9:5173/a?b=c", "http")).toMatchObject({
      hostHeader: "localhost:5173",
      port: "5173",
      url: new URL("http://127.7.8.9:5173/a?b=c"),
    });
    expect(
      resolvePreviewGatewayTarget("http://dev.localhost:4173/a?b=c", "http")?.url.toString(),
    ).toBe("http://localhost:4173/a?b=c");
    expect(resolvePreviewGatewayTarget("http://0.0.0.0:3000/", "http")?.url.hostname).toBe(
      "localhost",
    );
    expect(resolvePreviewGatewayTarget("http://[::]:3000/", "http")?.url.hostname).toBe(
      "localhost",
    );
    expect(
      resolvePreviewGatewayTarget("ws://[::1]:24678/hmr?token=one", "websocket")?.url.toString(),
    ).toBe("ws://[::1]:24678/hmr?token=one");

    expect(resolvePreviewGatewayTarget("https://localhost:5173/", "http")).toBeNull();
    expect(resolvePreviewGatewayTarget("wss://localhost:5173/", "websocket")).toBeNull();
    expect(resolvePreviewGatewayTarget("http://example.com:5173/", "http")).toBeNull();
    expect(resolvePreviewGatewayTarget("http://localhost:0/", "http")).toBeNull();
    expect(resolvePreviewGatewayTarget("http://localhost:65536/", "http")).toBeNull();
    expect(resolvePreviewGatewayTarget("http://localhost:not-a-port/", "http")).toBeNull();
    expect(resolvePreviewGatewayTarget("http://user:pass@localhost:5173/", "http")).toBeNull();
    expect(resolvePreviewGatewayTarget("http://localhost:5173/#secret", "http")).toBeNull();
    expect(
      sanitizePreviewGatewayHeaders(
        {
          connection: "keep-alive, x-remove-me",
          "keep-alive": "timeout=5",
          "x-remove-me": "secret",
          [PREVIEW_GATEWAY_TICKET_HEADER]: "ticket",
          [PREVIEW_GATEWAY_TARGET_HEADER]: "http://localhost:5173/",
          host: "relay.example.test",
          cookie: "t3_session=app-value; theme=dark",
          "x-app": "preserved",
          "sec-websocket-key": "generated-by-client",
        },
        { hostHeader: "localhost:5173", websocket: true },
      ),
    ).toEqual({
      host: "localhost:5173",
      cookie: "t3_session=app-value; theme=dark",
      "x-app": "preserved",
    });
  });
});

describe("preview gateway route authentication", () => {
  it.effect("rejects missing, expired, cross-environment, and wrong-port tickets", () =>
    Effect.gen(function* () {
      yield* buildGateway;
      const target = "http://localhost:5173/";
      const expired = yield* issueTicket(5173);
      yield* TestClock.adjust(Duration.minutes(6));
      const crossEnvironment = yield* issuePreviewGatewayTicket(5173).pipe(
        Effect.provide(otherEnvironmentSecretStoreLayer),
      );
      const cases = [
        { ticket: undefined, status: 401, code: "authentication-expired" },
        { ticket: expired.ticket, status: 401, code: "authentication-expired" },
        { ticket: crossEnvironment.ticket, status: 401, code: "authentication-expired" },
      ] as const;

      for (const testCase of cases) {
        const response = yield* requestGateway({
          path: PREVIEW_GATEWAY_HTTP_PATH,
          target,
          ...(testCase.ticket === undefined ? {} : { ticket: testCase.ticket }),
        });
        expect(yield* readGatewayError(response)).toEqual({
          status: testCase.status,
          code: testCase.code,
          port: undefined,
        });
      }

      const valid = yield* issueTicket(5173);
      const invalidTarget = yield* requestGateway({
        path: PREVIEW_GATEWAY_HTTP_PATH,
        target: "http://example.test:5173/",
        ticket: valid.ticket,
      });
      expect(yield* readGatewayError(invalidTarget)).toEqual({
        status: 400,
        code: "configuration-failed",
        port: undefined,
      });

      const wrongPort = yield* requestGateway({
        path: PREVIEW_GATEWAY_HTTP_PATH,
        target: "http://localhost:5174/",
        ticket: valid.ticket,
      });
      expect(yield* readGatewayError(wrongPort)).toEqual({
        status: 403,
        code: "configuration-failed",
        port: "5174",
      });

      const portOne = yield* issueTicket(1);
      const unavailable = yield* requestGateway({
        path: PREVIEW_GATEWAY_HTTP_PATH,
        target: "http://localhost:1/",
        ticket: portOne.ticket,
      });
      expect(yield* readGatewayError(unavailable)).toEqual({
        status: 502,
        code: "upstream-unreachable",
        port: "1",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );
});

describe("preview gateway HTTP transport", () => {
  it.effect("preserves requests, responses, streaming, redirects, and cookies", () => {
    const finishStream = Promise.withResolvers<void>();
    const upstream = NodeHttp.createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/final" });
        response.end();
        return;
      }
      if (request.url === "/stream") {
        response.writeHead(206, { "content-type": "text/plain", "x-stream": "yes" });
        response.write("first-");
        void finishStream.promise.then(() => response.end("second"));
        return;
      }

      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        response.writeHead(201, {
          "content-type": "application/json",
          "set-cookie": ["preview_session=abc; Path=/", "preview_theme=dark; Path=/; SameSite=Lax"],
          "x-upstream": "preserved",
        });
        response.end(
          JSON.stringify({
            method: request.method,
            url: request.url,
            host: request.headers.host,
            cookie: request.headers.cookie,
            appHeader: request.headers["x-app"],
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
    });

    return Effect.gen(function* () {
      const port = yield* listen(upstream);
      yield* buildGateway;
      const { ticket } = yield* issueTicket(port);

      const echoed = yield* requestGateway({
        path: PREVIEW_GATEWAY_HTTP_PATH,
        target: `http://0.0.0.0:${port}/echo?value=one`,
        ticket,
        method: "POST",
        headers: {
          cookie: "preview_session=request-value; t3_session=app-value",
          "x-app": "request-header",
        },
        body: "request-body",
      });
      expect(echoed.status).toBe(201);
      expect(echoed.headers["x-upstream"]).toBe("preserved");
      expect(Cookies.toSetCookieHeaders(echoed.cookies)).toEqual([
        "preview_session=abc; Path=/",
        "preview_theme=dark; Path=/; SameSite=Lax",
      ]);
      expect(yield* echoed.json).toEqual({
        method: "POST",
        url: "/echo?value=one",
        host: `localhost:${port}`,
        cookie: "preview_session=request-value; t3_session=app-value",
        appHeader: "request-header",
        body: "request-body",
      });

      const redirected = yield* requestGateway({
        path: PREVIEW_GATEWAY_HTTP_PATH,
        target: `http://localhost:${port}/redirect`,
        ticket,
      }).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      expect(redirected.status).toBe(302);
      expect(redirected.headers.location).toBe("/final");

      const streamed = yield* requestGateway({
        path: PREVIEW_GATEWAY_HTTP_PATH,
        target: `http://localhost:${port}/stream`,
        ticket,
      });
      expect(streamed.status).toBe(206);
      expect(streamed.headers["x-stream"]).toBe("yes");
      finishStream.resolve();
      expect(yield* streamed.text).toBe("first-second");
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
  });
});

describe("preview gateway WebSocket transport", () => {
  it.effect("preserves path, query, subprotocol, bidirectional frames, and cleanup", () => {
    const upstreamHttp = NodeHttp.createServer();
    const upstreamWs = new NodeSocket.NodeWS.WebSocketServer({
      server: upstreamHttp,
      handleProtocols: (protocols) => (protocols.has("vite-hmr") ? "vite-hmr" : false),
    });
    const upstreamConnected = Promise.withResolvers<{
      readonly socket: NodeSocket.NodeWS.WebSocket;
      readonly url: string;
      readonly host: string | undefined;
    }>();
    const upstreamReceived = Promise.withResolvers<string>();
    const upstreamClosed = Promise.withResolvers<void>();
    let upstreamConnectionCount = 0;
    upstreamWs.on("connection", (socket, request) => {
      upstreamConnectionCount += 1;
      upstreamConnected.resolve({
        socket,
        url: request.url ?? "",
        host: request.headers.host,
      });
      socket.on("message", (data) => upstreamReceived.resolve(data.toString()));
      socket.on("close", () => upstreamClosed.resolve());
      socket.send("from-upstream");
    });

    return Effect.gen(function* () {
      const upstreamPort = yield* listen(upstreamHttp);
      yield* buildGateway;
      const gatewayServer = yield* HttpServer.HttpServer;
      const gatewayPort = (gatewayServer.address as HttpServer.TcpAddress).port;
      const wrongPortTicket = yield* issueTicket(upstreamPort + 1);
      const rejected = yield* Effect.callback<
        { readonly status: number | undefined; readonly body: string },
        Error
      >((resume) => {
        const socket = new NodeSocket.NodeWS.WebSocket(
          `ws://127.0.0.1:${gatewayPort}${PREVIEW_GATEWAY_WEBSOCKET_PATH}`,
          ["vite-hmr"],
          {
            headers: {
              [PREVIEW_GATEWAY_TICKET_HEADER]: wrongPortTicket.ticket,
              [PREVIEW_GATEWAY_TARGET_HEADER]: `ws://localhost:${upstreamPort}/hmr`,
            },
          },
        );
        let settled = false;
        socket.once("unexpected-response", (_request, response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => {
            settled = true;
            socket.terminate();
            resume(
              Effect.succeed({
                status: response.statusCode,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          });
        });
        socket.once("open", () => {
          if (!settled) resume(Effect.die(new Error("wrong-port gateway request opened")));
        });
        socket.once("error", (error) => {
          if (!settled) resume(Effect.fail(error));
        });
      });
      expect(rejected.status).toBe(403);
      expect(rejected.body).toContain(
        'name="t3-preview-gateway-error" content="configuration-failed"',
      );
      expect(upstreamConnectionCount).toBe(0);

      const { ticket } = yield* issueTicket(upstreamPort);
      const client = yield* Effect.acquireRelease(
        Effect.callback<NodeSocket.NodeWS.WebSocket, Error>((resume) => {
          const socket = new NodeSocket.NodeWS.WebSocket(
            `ws://127.0.0.1:${gatewayPort}${PREVIEW_GATEWAY_WEBSOCKET_PATH}`,
            ["vite-hmr", "fallback"],
            {
              headers: {
                [PREVIEW_GATEWAY_TICKET_HEADER]: ticket,
                [PREVIEW_GATEWAY_TARGET_HEADER]: `ws://dev.localhost:${upstreamPort}/hmr?token=one`,
              },
            },
          );
          socket.once("open", () => resume(Effect.succeed(socket)));
          socket.once("error", (error) => resume(Effect.fail(error)));
        }),
        (socket) => Effect.sync(() => socket.close()),
      );

      const firstFrame = yield* Effect.callback<string, Error>((resume) => {
        client.once("message", (data) => resume(Effect.succeed(data.toString())));
        client.once("error", (error) => resume(Effect.fail(error)));
      });
      expect(firstFrame).toBe("from-upstream");
      expect(client.protocol).toBe("vite-hmr");
      const connected = yield* Effect.promise(() => upstreamConnected.promise);
      expect(upstreamConnectionCount).toBe(1);
      expect(connected.url).toBe("/hmr?token=one");
      expect(connected.host).toBe(`localhost:${upstreamPort}`);
      expect(connected.socket.protocol).toBe("vite-hmr");

      client.send("from-client");
      expect(yield* Effect.promise(() => upstreamReceived.promise)).toBe("from-client");
      client.close(1000);
      yield* Effect.promise(() => upstreamClosed.promise);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          upstreamWs.close();
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeHttpServer.layerTest),
    );
  });
});
