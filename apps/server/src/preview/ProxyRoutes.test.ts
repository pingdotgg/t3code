import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Http from "node:http";
import type * as Net from "node:net";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PortScanner from "./PortScanner.ts";
import {
  issueProxyTicket,
  PREVIEW_PROXY_COOKIE_NAME,
  PREVIEW_PROXY_EXIT_PATH,
} from "./ProxyAccess.ts";
import {
  filterForwardedCookieHeader,
  filterForwardedRequestHeaders,
  isForwardableSetCookie,
  previewProxyEntryRouteLayer,
  previewProxyExitRouteLayer,
  previewProxyMiddlewareLayer,
  shouldBypassPreviewProxy,
} from "./ProxyRoutes.ts";

describe("shouldBypassPreviewProxy", () => {
  it("bypasses requests presenting T3 credentials", () => {
    expect(
      shouldBypassPreviewProxy({
        path: "/",
        hasAuthorizationHeader: true,
        hasWsTicketParam: false,
      }),
    ).toBe(true);
    expect(
      shouldBypassPreviewProxy({
        path: "/ws",
        hasAuthorizationHeader: false,
        hasWsTicketParam: true,
      }),
    ).toBe(true);
  });

  it("bypasses reserved T3 paths and proxies everything else", () => {
    for (const path of [
      "/api/preview",
      "/api/preview/enter/token",
      "/api/preview/exit",
      "/api/assets/token/file.png",
      "/.well-known/t3/environment",
    ]) {
      expect(
        shouldBypassPreviewProxy({
          path,
          hasAuthorizationHeader: false,
          hasWsTicketParam: false,
        }),
      ).toBe(true);
    }
    for (const path of ["/", "/src/main.tsx", "/@vite/client", "/api/data", "/ws", "/index.html"]) {
      expect(
        shouldBypassPreviewProxy({
          path,
          hasAuthorizationHeader: false,
          hasWsTicketParam: false,
        }),
      ).toBe(false);
    }
  });
});

describe("header hygiene", () => {
  it("strips T3 cookies but forwards the dev server's own", () => {
    expect(
      filterForwardedCookieHeader(
        `${PREVIEW_PROXY_COOKIE_NAME}=abc; t3_session_1234_ff=def; myapp=1`,
      ),
    ).toBe("myapp=1");
    expect(filterForwardedCookieHeader(`${PREVIEW_PROXY_COOKIE_NAME}=abc`)).toBeNull();
  });

  it("keeps upstream Set-Cookie values away from T3 cookie names", () => {
    expect(isForwardableSetCookie("myapp=1; Path=/")).toBe(true);
    expect(isForwardableSetCookie("t3_session=stolen; Path=/")).toBe(false);
    expect(isForwardableSetCookie(`${PREVIEW_PROXY_COOKIE_NAME}=forged`)).toBe(false);
  });

  it("never forwards credential or hop-by-hop request headers", () => {
    const forwarded = filterForwardedRequestHeaders({
      authorization: "Bearer secret",
      dpop: "proof",
      host: "t3.example",
      connection: "keep-alive",
      "accept-encoding": "gzip",
      "content-type": "application/json",
      "x-custom": "yes",
      cookie: `${PREVIEW_PROXY_COOKIE_NAME}=abc; theirs=1`,
    });
    expect(forwarded).toEqual({
      "content-type": "application/json",
      "x-custom": "yes",
      cookie: "theirs=1",
    });
  });
});

const environmentLayer = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-proxy-routes-test")),
    getDescriptor: Effect.die("unused"),
  }),
);

// The upstream port is only known once the echo server binds; the discovery
// mock reads it through this box.
let upstreamPort = 0;

const portDiscoveryLayer = Layer.succeed(
  PortScanner.PortDiscovery,
  PortScanner.PortDiscovery.of({
    scan: () =>
      Effect.sync(() => [
        {
          host: "127.0.0.1",
          port: upstreamPort,
          url: `http://127.0.0.1:${upstreamPort}/`,
          processName: null,
          pid: null,
          terminal: null,
        },
      ]),
    subscribe: () => Effect.void,
    retain: Effect.void,
    registerTerminalProcesses: () => Effect.void,
    unregisterTerminal: () => Effect.void,
  }),
);

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-preview-proxy-routes-test-",
});

const depsLayer = Layer.mergeAll(
  environmentLayer,
  portDiscoveryLayer,
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

const makeUpstreamEchoServer = Effect.acquireRelease(
  Effect.callback<Http.Server>((resume) => {
    const server = Http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json", "x-upstream": "echo" });
      response.end(JSON.stringify({ url: request.url, headers: request.headers }));
    });
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
);

// deps (secret store, environment, discovery) are deliberately NOT provided
// here: they resolve from the test context so the router and the in-test
// ticket mint share one signing key.
const routerLayer = Layer.mergeAll(
  previewProxyEntryRouteLayer,
  previewProxyExitRouteLayer,
  HttpRouter.add("GET", "*", Effect.succeed(HttpServerResponse.text("t3-app"))),
).pipe(Layer.provide(previewProxyMiddlewareLayer));

const fetchManual = (url: string, init?: RequestInit) =>
  Effect.tryPromise(() => globalThis.fetch(url, { redirect: "manual", ...init }));

describe("preview proxy routes", () => {
  it.effect("routes the whole origin through the proxy for cookie-holding requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const upstream = yield* makeUpstreamEchoServer;
        upstreamPort = (upstream.address() as Net.AddressInfo).port;

        yield* HttpRouter.serve(routerLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);
        const address = (yield* HttpServer.HttpServer).address;
        if (address._tag !== "TcpAddress") throw new Error("expected tcp address");
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const ticket = yield* issueProxyTicket({
          url: `http://127.0.0.1:${upstreamPort}/`,
        });

        // Entering redeems the ticket, sets the cookie, and redirects into the origin.
        const entry = yield* fetchManual(`${baseUrl}${ticket.entryPath}?to=/dashboard`);
        expect(entry.status).toBe(302);
        expect(entry.headers.get("location")).toBe("/dashboard");
        const setCookie = entry.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain(`${PREVIEW_PROXY_COOKIE_NAME}=`);
        expect(setCookie.toLowerCase()).toContain("httponly");
        const cookiePair = setCookie.split(";")[0]!;

        // A reused entry ticket fails.
        const reused = yield* fetchManual(`${baseUrl}${ticket.entryPath}`);
        expect(reused.status).toBe(403);

        // Root-relative documents, assets, and API calls proxy through, with
        // T3 credentials stripped before they reach the dev server.
        const proxied = yield* fetchManual(`${baseUrl}/api/data?x=1`, {
          headers: {
            cookie: `${cookiePair}; t3_session=topsecret`,
            "x-custom": "yes",
          },
        });
        expect(proxied.status).toBe(200);
        expect(proxied.headers.get("x-upstream")).toBe("echo");
        const echoed = (yield* Effect.tryPromise(() => proxied.json())) as {
          url: string;
          headers: Record<string, string>;
        };
        expect(echoed.url).toBe("/api/data?x=1");
        expect(echoed.headers["x-custom"]).toBe("yes");
        expect(echoed.headers["authorization"]).toBeUndefined();
        expect(echoed.headers["cookie"]).toBeUndefined();
        expect(echoed.headers["host"]).toBe(`127.0.0.1:${upstreamPort}`);

        // Requests presenting T3 credentials bypass the proxy entirely.
        const bypassed = yield* fetchManual(`${baseUrl}/anything`, {
          headers: { cookie: cookiePair, authorization: "Bearer whatever" },
        });
        expect(yield* Effect.tryPromise(() => bypassed.text())).toBe("t3-app");

        // A tampered cookie fails closed with a clear error, not the T3 app.
        const tampered = yield* fetchManual(`${baseUrl}/`, {
          headers: { cookie: `${PREVIEW_PROXY_COOKIE_NAME}=forged` },
        });
        expect(tampered.status).toBe(403);

        // Exit clears the cookie.
        const exit = yield* fetchManual(`${baseUrl}${PREVIEW_PROXY_EXIT_PATH}`, {
          headers: { cookie: cookiePair },
        });
        expect(exit.status).toBe(204);
        expect(exit.headers.get("set-cookie") ?? "").toContain(`${PREVIEW_PROXY_COOKIE_NAME}=;`);

        // Without the cookie the origin serves T3 as usual.
        const plain = yield* fetchManual(`${baseUrl}/anything`);
        expect(yield* Effect.tryPromise(() => plain.text())).toBe("t3-app");
      }),
    ).pipe(
      // A plain server layer (not layerTest): the middleware resolves the
      // ambient HttpClient for upstream requests, which must be a real fetch
      // client, not layerTest's server-relative client.
      Effect.provide(
        Layer.mergeAll(
          NodeHttpServer.layer(() => Http.createServer(), { port: 0 }),
          FetchHttpClient.layer,
          depsLayer,
        ),
      ),
    ),
  );
});
