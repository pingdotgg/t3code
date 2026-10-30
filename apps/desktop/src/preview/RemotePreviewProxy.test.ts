// @effect-diagnostics nodeBuiltinImport:off globalDate:off - drives real proxy, TLS and WebSocket sockets.
import { assert, expect, it } from "@effect/vitest";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { EnvironmentId, type DesktopRemotePreviewProxyStatus } from "@t3tools/contracts";
import {
  REMOTE_PREVIEW_PROXY_GRANT_HEADER,
  REMOTE_PREVIEW_PROXY_RENEW_PATH,
  REMOTE_PREVIEW_PROXY_REVOKE_PATH,
  REMOTE_PREVIEW_PROXY_TUNNEL_PATH,
  isRemotePreviewProxyDialHost,
} from "@t3tools/shared/remotePreviewProxy";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import * as NodeTls from "node:tls";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as RemotePreviewProxy from "./RemotePreviewProxy.ts";

// Non-secret, self-signed 127.0.0.1 certificate shared with apps/server/src/outboundHttp.test.ts.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3EwCztQysKTvzdcR
g0LWq+axzUd4tHi9PyMdqh7PlGShRANCAARfQpoLgv/tOsHWCLriDza7Ruaey2b7
mR/nS6mLu6W7+agkEqDm0mE3F/ngpPjL4Jj0IGadeMcKNKFRSBgiLdfn
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVagAwIBAgIUWbn2Wt5kTxii1UU57NJMt/wTaUgwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZdDNjb2RlIG91dGJvdW5kIGh0dHAgdGVzdDAgFw0yNjEwMTEy
MjQyMzZaGA8yMTI2MDkxNzIyNDIzNlowJDEiMCAGA1UEAwwZdDNjb2RlIG91dGJv
dW5kIGh0dHAgdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABF9CmguC/+06
wdYIuuIPNrtG5p7LZvuZH+dLqYu7pbv5qCQSoObSYTcX+eCk+MvgmPQgZp14xwo0
oVFIGCIt1+ejZDBiMB0GA1UdDgQWBBSsekAc30Q/zdIE/tvVDQKJL5oiCDAfBgNV
HSMEGDAWgBSsekAc30Q/zdIE/tvVDQKJL5oiCDAPBgNVHRMBAf8EBTADAQH/MA8G
A1UdEQQIMAaHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgebUrkyP56242EJB7nCV7
A+Ke/q0rNPya3fjQa9O5B+kCIQC1SfmdNaFcNJ4JINlus4FfrRnfKiADS2MIJR9f
99BN0A==
-----END CERTIFICATE-----
`;

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");
const TEN_MINUTES = 10 * 60_000;

const listen = <S extends NodeNet.Server>(server: S) => {
  // Upgraded and tunneled sockets outlive closeAllConnections, so track every one.
  const sockets = new Set<NodeNet.Socket>();
  server.on("connection", (socket: NodeNet.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("secureConnection", (socket: NodeNet.Socket) => sockets.add(socket));
  return Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<S>((resolve) => {
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    ),
    (listening) =>
      Effect.promise(() => {
        for (const socket of sockets) socket.destroy();
        return new Promise<void>((resolve) => listening.close(() => resolve()));
      }),
  ).pipe(Effect.map((listening) => (listening.address() as NodeNet.AddressInfo).port));
};

/** A server standing in for a loopback service; `label` shows which machine answered. */
const appServer = (label: string) => {
  const stream = { release: Promise.withResolvers<void>() };
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://placeholder");
    switch (url.pathname) {
      case "/redirect":
        response.writeHead(302, { location: "/landing" });
        response.end();
        return;
      case "/cookie":
        response.writeHead(200, { "set-cookie": "session=abc; Path=/; HttpOnly" });
        response.end(`${label}:cookie-set`);
        return;
      case "/upload": {
        const hash = NodeCrypto.createHash("sha256");
        let bytes = 0;
        request.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          hash.update(chunk);
        });
        request.on("end", () => response.end(`${bytes}:${hash.digest("hex")}`));
        return;
      }
      case "/download":
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.alloc(3 * 1024 * 1024, 7));
        return;
      case "/stream":
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("first;");
        void stream.release.promise.then(() => response.end("last"));
        return;
      case "/truncated":
        response.writeHead(200, { "content-length": "1000" });
        response.write("partial", () => response.socket?.destroy());
        return;
      default:
        response.end(
          `${label} host=${request.headers.host} cookie=${request.headers.cookie ?? ""} proxyauth=${request.headers["proxy-authorization"] ?? ""}`,
        );
    }
  });
  const sockets = new NodeWS.WebSocketServer({ server });
  sockets.on("connection", (socket) =>
    socket.on("message", (data) => socket.send(`${label}:${String(data)}`)),
  );
  return { server, stream };
};

interface FakeEnvironment {
  readonly origin: string;
  /** Live grants and the ports each approves. */
  readonly grants: Map<string, ReadonlySet<number>>;
  /** Browser-visible port to the port that actually answers on this "environment". */
  readonly loopback: Map<number, number>;
  readonly renewals: Queue.Queue<string>;
  renew: "ok" | "reject" | "offline";
  renewCount: number;
  readonly revoked: string[];
  beforeUpgrade?: () => Promise<void>;
  disconnectTunnels?: () => Promise<void>;
}

/** Speaks the environment's tunnel/renew/revoke protocol against local stand-in services. */
const fakeEnvironment = Effect.gen(function* () {
  const renewals = yield* Queue.unbounded<string>();
  const environment: FakeEnvironment = {
    origin: "",
    grants: new Map(),
    loopback: new Map(),
    renewals,
    renew: "ok",
    renewCount: 0,
    revoked: [],
  };
  const sockets = new NodeWS.WebSocketServer({ noServer: true });
  environment.disconnectTunnels = () =>
    Promise.all(
      [...sockets.clients].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
            socket.close();
          }),
      ),
    ).then(() => undefined);
  const server = NodeHttp.createServer((request, response) => {
    const grant = request.headers[REMOTE_PREVIEW_PROXY_GRANT_HEADER];
    const grantString = typeof grant === "string" ? grant : "";
    if (request.url === REMOTE_PREVIEW_PROXY_RENEW_PATH) {
      const ports = environment.grants.get(grantString);
      if (environment.renew === "offline") {
        response.writeHead(503).end();
      } else if (environment.renew === "reject" || ports === undefined) {
        response.writeHead(401).end();
      } else {
        environment.renewCount += 1;
        const renewed = `renewed-${environment.renewCount}`;
        environment.grants.set(renewed, ports);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            grant: renewed,
            expiresAt: new Date(TEN_MINUTES * (environment.renewCount + 1)).toISOString(),
            ports: [...ports],
          }),
        );
      }
      Queue.offerUnsafe(renewals, environment.renew);
      return;
    }
    if (request.url === REMOTE_PREVIEW_PROXY_REVOKE_PATH) {
      environment.revoked.push(grantString);
      environment.grants.delete(grantString);
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://placeholder");
    const reject = (status: number) => {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    const grant = request.headers[REMOTE_PREVIEW_PROXY_GRANT_HEADER];
    const ports = typeof grant === "string" ? environment.grants.get(grant) : undefined;
    const host = url.searchParams.get("host") ?? "";
    const port = Number(url.searchParams.get("port"));
    if (url.pathname !== REMOTE_PREVIEW_PROXY_TUNNEL_PATH || ports === undefined)
      return reject(401);
    if (!isRemotePreviewProxyDialHost(host)) return reject(400);
    if (!ports.has(port)) return reject(403);
    const target = environment.loopback.get(port);
    if (target === undefined) return reject(502);
    const upstream = NodeNet.connect(target, "127.0.0.1");
    upstream.once("error", () => reject(502));
    upstream.once("connect", () => {
      upstream.removeAllListeners("error");
      void (environment.beforeUpgrade?.() ?? Promise.resolve()).then(() => {
        if (socket.destroyed) {
          upstream.destroy();
          return;
        }
        sockets.handleUpgrade(request, socket, head, (client) => {
          const stream = NodeWS.createWebSocketStream(client);
          NodeStream.pipeline(stream, upstream, () => stream.destroy());
          NodeStream.pipeline(upstream, stream, () => upstream.destroy());
        });
      });
    });
  });
  const port = yield* listen(server);
  return Object.assign(environment, { origin: `http://127.0.0.1:${port}` });
});

const makeProxy = Effect.gen(function* () {
  const context = yield* Layer.build(
    RemotePreviewProxy.layer.pipe(
      Layer.provide(NodeHttpClient.layerUndici),
      Layer.provide(NodeServices.layer),
    ),
  );
  const proxy = Context.get(context, RemotePreviewProxy.RemotePreviewProxy);
  const statuses = yield* Queue.unbounded<DesktopRemotePreviewProxyStatus>();
  yield* proxy.subscribe((status) => Queue.offerUnsafe(statuses, status));
  return { proxy, statuses };
});

const awaitStatus = (
  statuses: Queue.Queue<DesktopRemotePreviewProxyStatus>,
  matches: (status: DesktopRemotePreviewProxyStatus) => boolean,
): Effect.Effect<DesktopRemotePreviewProxyStatus> =>
  Queue.take(statuses).pipe(Effect.filterOrElse(matches, () => awaitStatus(statuses, matches)));

/** Configures an environment and returns the embedded consumer's proxy endpoint. */
const configure = (
  proxy: RemotePreviewProxy.RemotePreviewProxy["Service"],
  environment: FakeEnvironment,
  environmentId: EnvironmentId,
  grant: string,
  ports: ReadonlyArray<number>,
) =>
  Effect.gen(function* () {
    environment.grants.set(grant, new Set(ports));
    yield* proxy.configure({
      environmentId,
      label: `environment ${environmentId}`,
      httpBaseUrl: environment.origin,
      grant,
      expiresAt: (yield* Clock.currentTimeMillis) + TEN_MINUTES,
      ports,
    });
    const access = yield* proxy.issueExternalAccess(environmentId);
    return {
      port: Number(new URL(access.proxyServer).port),
      authorization: `Basic ${Buffer.from(`${access.username}:${access.password}`).toString("base64")}`,
    };
  });

interface Endpoint {
  readonly port: number;
  readonly authorization: string;
}

interface ProxiedResponse {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: Buffer;
}

const proxiedRequest = (
  endpoint: Endpoint,
  url: string,
  options: { readonly method?: string; readonly body?: Buffer; readonly cookie?: string } = {},
) =>
  Effect.promise(
    () =>
      new Promise<ProxiedResponse>((resolve, reject) => {
        const target = new URL(url);
        const request = NodeHttp.request({
          host: "127.0.0.1",
          port: endpoint.port,
          method: options.method ?? "GET",
          path: url,
          agent: false,
          headers: {
            host: target.host,
            "proxy-authorization": endpoint.authorization,
            ...(options.cookie ? { cookie: options.cookie } : {}),
          },
        });
        request.on("response", (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
          response.on("error", reject);
        });
        request.on("error", reject);
        request.end(options.body);
      }),
  );

const connect = (endpoint: Endpoint, authority: string) =>
  Effect.promise(
    () =>
      new Promise<{ readonly status: number; readonly socket: NodeNet.Socket }>(
        (resolve, reject) => {
          const request = NodeHttp.request({
            host: "127.0.0.1",
            port: endpoint.port,
            method: "CONNECT",
            path: authority,
            agent: false,
            headers: { "proxy-authorization": endpoint.authorization },
          });
          request.on("connect", (response, socket) =>
            resolve({ status: response.statusCode ?? 0, socket }),
          );
          request.on("response", (response) => {
            response.resume();
            resolve({ status: response.statusCode ?? 0, socket: response.socket });
          });
          request.on("error", reject);
          request.end();
        },
      ),
  );

const webSocketMessage = (socket: NodeNet.Socket, url: string, message: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        const client = new NodeWS.WebSocket(url, { createConnection: () => socket });
        client.once("open", () => client.send(message));
        client.once("message", (data) => {
          resolve(String(data));
          client.close();
        });
        client.once("error", reject);
      }),
  );

it.effect(
  "serves HTTP, redirects, cookies, uploads, downloads and streams from the environment",
  () =>
    Effect.gen(function* () {
      const { proxy } = yield* makeProxy;
      const environment = yield* fakeEnvironment;
      const app = appServer("remote-app");
      const appPort = yield* listen(app.server);
      environment.loopback.set(appPort, appPort);
      const endpoint = yield* configure(proxy, environment, ENV_A, "grant-a", [appPort]);
      const origin = `http://localhost:${appPort}`;

      const page = yield* proxiedRequest(endpoint, `${origin}/`, { cookie: "theme=dark" });
      expect(page.status).toBe(200);
      // The page keeps its localhost origin, and the proxy credential never reaches the app.
      expect(page.body.toString()).toBe(
        `remote-app host=localhost:${appPort} cookie=theme=dark proxyauth=`,
      );

      const redirect = yield* proxiedRequest(endpoint, `${origin}/redirect`);
      expect(redirect.status).toBe(302);
      expect(redirect.headers.location).toBe("/landing");

      const cookie = yield* proxiedRequest(endpoint, `${origin}/cookie`);
      expect(cookie.headers["set-cookie"]).toEqual(["session=abc; Path=/; HttpOnly"]);

      const upload = Buffer.alloc(2 * 1024 * 1024, 3);
      const uploaded = yield* proxiedRequest(endpoint, `${origin}/upload`, {
        method: "POST",
        body: upload,
      });
      expect(uploaded.body.toString()).toBe(
        `${upload.byteLength}:${NodeCrypto.createHash("sha256").update(upload).digest("hex")}`,
      );

      const download = yield* proxiedRequest(endpoint, `${origin}/download`);
      expect(download.body.equals(Buffer.alloc(3 * 1024 * 1024, 7))).toBe(true);

      const firstChunk = yield* Effect.promise(
        () =>
          new Promise<{ chunk: string; rest: Promise<string> }>((resolve, reject) => {
            const request = NodeHttp.request({
              host: "127.0.0.1",
              port: endpoint.port,
              path: `${origin}/stream`,
              agent: false,
              headers: { "proxy-authorization": endpoint.authorization },
            });
            request.on("response", (response) => {
              response.once("data", (chunk: Buffer) => {
                const rest = new Promise<string>((done) => {
                  let text = "";
                  response.on("data", (more: Buffer) => (text += more.toString()));
                  response.on("end", () => done(text));
                });
                resolve({ chunk: chunk.toString(), rest });
              });
            });
            request.on("error", reject);
            request.end();
          }),
      );
      // The first chunk arrives before the server finishes the response.
      expect(firstChunk.chunk).toBe("first;");
      app.stream.release.resolve();
      expect(yield* Effect.promise(() => firstChunk.rest)).toBe("last");
    }),
);

it.effect("does not reuse a pooled HTTP tunnel after the environment closes it", () =>
  Effect.gen(function* () {
    const { proxy } = yield* makeProxy;
    const environment = yield* fakeEnvironment;
    const appPort = yield* listen(appServer("remote-app").server);
    environment.loopback.set(appPort, appPort);
    const endpoint = yield* configure(proxy, environment, ENV_A, "grant-a", [appPort]);
    const url = `http://localhost:${appPort}/`;
    expect((yield* proxiedRequest(endpoint, url)).status).toBe(200);
    yield* Effect.promise(() => environment.disconnectTunnels!());
    expect((yield* proxiedRequest(endpoint, url)).status).toBe(200);
  }),
);

it.effect("fails a truncated upstream response instead of hanging", () =>
  Effect.gen(function* () {
    const { proxy } = yield* makeProxy;
    const environment = yield* fakeEnvironment;
    const appPort = yield* listen(appServer("remote-app").server);
    environment.loopback.set(appPort, appPort);
    const endpoint = yield* configure(proxy, environment, ENV_A, "grant-a", [appPort]);

    const outcome = yield* Effect.exit(
      proxiedRequest(endpoint, `http://localhost:${appPort}/truncated`),
    );
    expect(Exit.isFailure(outcome)).toBe(true);
  }),
);

it.effect("tunnels WebSockets on a separate approved port through CONNECT", () =>
  Effect.gen(function* () {
    const { proxy } = yield* makeProxy;
    const environment = yield* fakeEnvironment;
    const appPort = yield* listen(appServer("remote-app").server);
    const hmrPort = yield* listen(appServer("remote-hmr").server);
    environment.loopback.set(appPort, appPort);
    environment.loopback.set(hmrPort, hmrPort);
    const endpoint = yield* configure(proxy, environment, ENV_A, "grant-a", [appPort, hmrPort]);

    const tunnel = yield* connect(endpoint, `localhost:${hmrPort}`);
    expect(tunnel.status).toBe(200);
    expect(yield* webSocketMessage(tunnel.socket, `ws://localhost:${hmrPort}/hmr`, "update")).toBe(
      "remote-hmr:update",
    );
  }),
);

it.effect("tunnels HTTPS end to end so the client's own certificate checks apply", () =>
  Effect.gen(function* () {
    const { proxy } = yield* makeProxy;
    const environment = yield* fakeEnvironment;
    const secureServer = NodeHttps.createServer(
      { key: TEST_KEY, cert: TEST_CERT },
      (_request, response) => response.end("secure-remote"),
    );
    const secureSockets = new NodeWS.WebSocketServer({ server: secureServer });
    secureSockets.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
    const tlsPort = yield* listen(secureServer);
    environment.loopback.set(tlsPort, tlsPort);
    const endpoint = yield* configure(proxy, environment, ENV_A, "grant-a", [tlsPort]);

    const handshake = (options: NodeTls.ConnectionOptions) =>
      Effect.flatMap(connect(endpoint, `127.0.0.1:${tlsPort}`), ({ socket }) =>
        Effect.promise(
          () =>
            new Promise<string>((resolve) => {
              const secure = NodeTls.connect({ socket, ...options });
              secure.once("secureConnect", () => {
                secure.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
                let text = "";
                secure.on("data", (chunk: Buffer) => (text += chunk.toString()));
                secure.on("end", () => resolve(text.endsWith("secure-remote") ? "ok" : text));
              });
              secure.once("error", (error: NodeJS.ErrnoException) =>
                resolve(error.code ?? error.message),
              );
            }),
        ),
      );

    expect(yield* handshake({ host: "127.0.0.1", ca: TEST_CERT })).toBe("ok");
    expect(yield* handshake({ host: "127.0.0.1" })).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    const tunnel = yield* connect(endpoint, `127.0.0.1:${tlsPort}`);
    const secureMessage = yield* Effect.promise(
      () =>
        new Promise<string>((resolve, reject) => {
          const client = new NodeWS.WebSocket(`wss://127.0.0.1:${tlsPort}/hmr`, {
            createConnection: () =>
              NodeTls.connect({ socket: tunnel.socket, host: "127.0.0.1", ca: TEST_CERT }),
          });
          client.once("open", () => client.send("secure HMR"));
          client.once("message", (data) => {
            resolve(String(data));
            client.close();
          });
          client.once("error", reject);
        }),
    );
    expect(secureMessage).toBe("secure HMR");
    expect(yield* handshake({ host: "localhost", servername: "localhost", ca: TEST_CERT })).toBe(
      "ERR_TLS_CERT_ALTNAME_INVALID",
    );
  }),
);

it.effect("keeps environments with the same port apart and never answers from this machine", () =>
  Effect.gen(function* () {
    const { proxy } = yield* makeProxy;
    // A service on this computer holds the port both environments use.
    const localPort = yield* listen(appServer("this-computer").server);
    const environmentA = yield* fakeEnvironment;
    const environmentB = yield* fakeEnvironment;
    environmentA.loopback.set(localPort, yield* listen(appServer("environment-a").server));
    environmentB.loopback.set(localPort, yield* listen(appServer("environment-b").server));
    const endpointA = yield* configure(proxy, environmentA, ENV_A, "grant-a", [localPort]);
    const endpointB = yield* configure(proxy, environmentB, ENV_B, "grant-b", [localPort]);
    const url = `http://localhost:${localPort}/`;

    expect((yield* proxiedRequest(endpointA, url)).body.toString()).toMatch(/^environment-a /);
    expect((yield* proxiedRequest(endpointB, url)).body.toString()).toMatch(/^environment-b /);
    for (const alias of ["127.0.0.1", "[::ffff:127.0.0.1]", "0.0.0.0", "app.localhost"]) {
      expect(
        (yield* proxiedRequest(endpointA, `http://${alias}:${localPort}/`)).body.toString(),
      ).toMatch(/^environment-a /);
    }
    const mapped = yield* connect(endpointA, `[::ffff:7f00:1]:${localPort}`);
    expect(mapped.status).toBe(200);
    expect(yield* webSocketMessage(mapped.socket, `ws://localhost:${localPort}/`, "hi")).toBe(
      "environment-a:hi",
    );

    yield* proxy.revoke(ENV_A);
    const revoked = yield* proxiedRequest(endpointA, url);
    expect(revoked.status).toBe(407);
    expect(environmentA.revoked).toEqual(["grant-a"]);
    expect((yield* proxiedRequest(endpointB, url)).body.toString()).toMatch(/^environment-b /);
  }),
);

it.effect("denies unapproved ports and reports them, without dialing this machine", () =>
  Effect.gen(function* () {
    const { proxy, statuses } = yield* makeProxy;
    const environment = yield* fakeEnvironment;
    const appPort = yield* listen(appServer("remote-app").server);
    const localOnlyPort = yield* listen(appServer("this-computer").server);
    environment.loopback.set(appPort, appPort);
    const endpoint = yield* configure(proxy, environment, ENV_A, "grant-a", [appPort]);

    const page = yield* proxiedRequest(endpoint, `http://localhost:${localOnlyPort}/`);
    expect(page.status).toBe(403);
    expect(page.body.toString()).toContain(`Port ${localOnlyPort}`);
    expect((yield* connect(endpoint, `localhost:${localOnlyPort}`)).status).toBe(403);
    const status = yield* awaitStatus(statuses, (next) => next.deniedPorts.length > 0);
    expect(status.deniedPorts).toEqual([localOnlyPort]);

    // An approved port with nothing listening on the environment is a 502, not a local dial.
    const widened = yield* configure(proxy, environment, ENV_A, "grant-a2", [
      appPort,
      localOnlyPort,
    ]);
    const unreachable = yield* proxiedRequest(widened, `http://localhost:${localOnlyPort}/`);
    expect(unreachable.status).toBe(502);
    expect(unreachable.body.toString()).not.toContain("this-computer");
  }),
);

it.effect("requires the proxy credential, and revoking external access ends it", () =>
  Effect.gen(function* () {
    const { proxy } = yield* makeProxy;
    const environment = yield* fakeEnvironment;
    const appPort = yield* listen(appServer("remote-app").server);
    environment.loopback.set(appPort, appPort);
    const endpoint = yield* configure(proxy, environment, ENV_A, "grant-a", [appPort]);
    const url = `http://localhost:${appPort}/`;

    expect((yield* proxiedRequest({ ...endpoint, authorization: "" }, url)).status).toBe(407);
    expect(
      (yield* connect({ ...endpoint, authorization: "" }, `localhost:${appPort}`)).status,
    ).toBe(407);
    expect((yield* proxiedRequest(endpoint, url)).status).toBe(200);
    const embedded = proxy.embeddedCredentialForPort(endpoint.port);
    assert(embedded !== null);
    const embeddedEndpoint = {
      port: endpoint.port,
      authorization: `Basic ${Buffer.from(embedded).toString("base64")}`,
    };
    const externalTunnel = yield* connect(endpoint, `localhost:${appPort}`);
    const embeddedTunnel = yield* connect(embeddedEndpoint, `localhost:${appPort}`);
    const externalClosed = new Promise<void>((resolve) =>
      externalTunnel.socket.once("close", () => resolve()),
    );

    yield* proxy.revokeExternalAccess(ENV_A);
    yield* Effect.promise(() => externalClosed);
    expect((yield* proxiedRequest(endpoint, url)).status).toBe(407);
    // The embedded consumer keeps its credential and its open tunnels.
    expect(
      yield* webSocketMessage(embeddedTunnel.socket, `ws://localhost:${appPort}/hmr`, "alive"),
    ).toBe("remote-app:alive");
    expect((yield* proxiedRequest(embeddedEndpoint, url)).status).toBe(200);
  }),
);

it.effect("revoking external access stops HTTP streams and pending CONNECT requests", () =>
  Effect.gen(function* () {
    const { proxy } = yield* makeProxy;
    const environment = yield* fakeEnvironment;
    const app = appServer("remote-app");
    const appPort = yield* listen(app.server);
    environment.loopback.set(appPort, appPort);
    const endpoint = yield* configure(proxy, environment, ENV_A, "grant-a", [appPort]);
    const streamed = Promise.withResolvers<void>();
    const outcome = new Promise<string>((resolve, reject) => {
      const request = NodeHttp.get(
        {
          host: "127.0.0.1",
          port: endpoint.port,
          path: `http://localhost:${appPort}/stream`,
          headers: { "proxy-authorization": endpoint.authorization },
        },
        (response) => {
          response.once("data", () => streamed.resolve());
          response.once("end", () => resolve("completed"));
          response.once("error", () => resolve("aborted"));
        },
      );
      request.on("error", reject);
    });
    yield* Effect.promise(() => streamed.promise);
    yield* proxy.revokeExternalAccess(ENV_A);
    app.stream.release.resolve();
    expect(yield* Effect.promise(() => outcome)).toBe("aborted");

    const access = yield* proxy.issueExternalAccess(ENV_A);
    const fresh = {
      port: endpoint.port,
      authorization: `Basic ${Buffer.from(`${access.username}:${access.password}`).toString("base64")}`,
    };
    const attempted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    environment.beforeUpgrade = () => {
      attempted.resolve();
      return release.promise;
    };
    const pending = yield* connect(fresh, `localhost:${appPort}`).pipe(Effect.forkChild);
    yield* Effect.promise(() => attempted.promise);
    yield* proxy.revokeExternalAccess(ENV_A);
    release.resolve();
    const result = yield* Fiber.await(pending);
    if (Exit.isSuccess(result)) result.value.socket.destroy();
    expect(Exit.isFailure(result)).toBe(true);
  }),
);

it.effect("external access expires after its lifetime", () =>
  Effect.gen(function* () {
    const { proxy } = yield* makeProxy;
    const environment = yield* fakeEnvironment;
    const appPort = yield* listen(appServer("remote-app").server);
    environment.loopback.set(appPort, appPort);
    const endpoint = yield* configure(proxy, environment, ENV_A, "grant-a", [appPort]);
    const url = `http://localhost:${appPort}/`;
    const tunnel = yield* connect(endpoint, `localhost:${appPort}`);
    const closed = new Promise<void>((resolve) => tunnel.socket.once("close", () => resolve()));
    yield* TestClock.adjust(RemotePreviewProxy.EXTERNAL_ACCESS_TTL);
    expect((yield* proxy.status(ENV_A))?.externalAccess).toBeNull();
    yield* Effect.promise(() => closed);
    expect((yield* proxiedRequest(endpoint, url)).status).toBe(407);
  }),
);

it.effect("renews the grant before it expires and keeps serving past the first TTL", () =>
  Effect.gen(function* () {
    const { proxy, statuses } = yield* makeProxy;
    const environment = yield* fakeEnvironment;
    const appPort = yield* listen(appServer("remote-app").server);
    environment.loopback.set(appPort, appPort);
    const endpoint = yield* configure(proxy, environment, ENV_A, "grant-a", [appPort]);

    for (const round of [1, 2, 3]) {
      yield* TestClock.adjust("10 minutes");
      expect(yield* Queue.take(environment.renewals)).toBe("ok");
      yield* awaitStatus(statuses, (status) => status.expiresAt === TEN_MINUTES * (round + 1));
      // Only the newest grant opens tunnels in this environment.
      for (const grant of environment.grants.keys()) {
        if (grant !== `renewed-${round}`) environment.grants.delete(grant);
      }
    }
    const page = yield* proxiedRequest(endpoint, `http://localhost:${appPort}/`);
    expect(page.status).toBe(200);
    expect((yield* proxy.status(ENV_A))?.state).toBe("ready");
  }),
);

it.effect("a failed renewal keeps open connections and fails new requests until reconfigured", () =>
  Effect.gen(function* () {
    const { proxy, statuses } = yield* makeProxy;
    const environment = yield* fakeEnvironment;
    const appPort = yield* listen(appServer("remote-app").server);
    const hmrPort = yield* listen(appServer("remote-hmr").server);
    environment.loopback.set(appPort, appPort);
    environment.loopback.set(hmrPort, hmrPort);
    const endpoint = yield* configure(proxy, environment, ENV_A, "grant-a", [appPort, hmrPort]);
    const hmr = yield* connect(endpoint, `localhost:${hmrPort}`);
    const client = new NodeWS.WebSocket(`ws://localhost:${hmrPort}/hmr`, {
      createConnection: () => hmr.socket,
    });
    yield* Effect.promise(() => new Promise((resolve) => client.once("open", resolve)));
    const echo = (message: string) =>
      Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            client.once("message", (data) => resolve(String(data)));
            client.send(message);
          }),
      );

    // The environment is unreachable for renewal until the grant runs out.
    environment.renew = "offline";
    yield* TestClock.adjust("7 minutes");
    expect(yield* Queue.take(environment.renewals)).toBe("offline");
    yield* TestClock.adjust("3 minutes");
    yield* awaitStatus(statuses, (status) => status.state === "expired");

    // The loaded page's socket survives; new requests fail closed with an explanation.
    expect(yield* echo("still-here")).toBe("remote-hmr:still-here");
    const expired = yield* proxiedRequest(endpoint, `http://localhost:${appPort}/`);
    expect(expired.status).toBe(503);
    expect(expired.body.toString()).toContain("expired");

    // Reconnecting issues a fresh grant; the same proxy listener works again.
    const reconnected = yield* configure(proxy, environment, ENV_A, "grant-a2", [appPort, hmrPort]);
    expect(reconnected.port).toBe(endpoint.port);
    expect((yield* proxiedRequest(reconnected, `http://localhost:${appPort}/`)).status).toBe(200);
    client.close();
  }),
);

it.effect("an environment that rejects the grant marks the proxy expired", () =>
  Effect.gen(function* () {
    const { proxy, statuses } = yield* makeProxy;
    const environment = yield* fakeEnvironment;
    const appPort = yield* listen(appServer("remote-app").server);
    environment.loopback.set(appPort, appPort);
    yield* configure(proxy, environment, ENV_A, "grant-a", [appPort]);
    environment.renew = "reject";
    yield* TestClock.adjust("7 minutes");
    expect(yield* Queue.take(environment.renewals)).toBe("reject");
    const status = yield* awaitStatus(statuses, (next) => next.state === "expired");
    expect(status.state).toBe("expired");
  }),
);

it.effect("an unconfigured environment fails closed", () =>
  Effect.gen(function* () {
    const { proxy } = yield* makeProxy;
    const environment = yield* fakeEnvironment;
    const localPort = yield* listen(appServer("this-computer").server);
    const endpoint = yield* configure(proxy, environment, ENV_A, "grant-a", [localPort]);
    yield* proxy.revoke(ENV_A);
    const embedded = proxy.embeddedCredentialForPort(endpoint.port);
    assert(embedded !== null);
    const page = yield* proxiedRequest(
      { port: endpoint.port, authorization: `Basic ${Buffer.from(embedded).toString("base64")}` },
      `http://localhost:${localPort}/`,
    );
    expect(page.status).toBe(503);
    expect(page.body.toString()).not.toContain("this-computer");
  }),
);
