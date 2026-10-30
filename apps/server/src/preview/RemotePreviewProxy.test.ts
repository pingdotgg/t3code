import { assert, expect, it } from "@effect/vitest";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@t3tools/contracts";
import {
  REMOTE_PREVIEW_PROXY_GRANT_HEADER,
  REMOTE_PREVIEW_PROXY_RENEW_PATH,
  REMOTE_PREVIEW_PROXY_REVOKE_PATH,
  REMOTE_PREVIEW_PROXY_TUNNEL_PATH,
} from "@t3tools/shared/remotePreviewProxy";
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as RemotePreviewProxy from "./RemotePreviewProxy.ts";

const SESSION = AuthSessionId.make("session-1");
const SERVER_PORT = 3773;

const setup = Effect.gen(function* () {
  const invalidated = yield* Deferred.make<void>();
  let active = true;
  const services = yield* Layer.build(
    HttpRouter.serve(RemotePreviewProxy.routeLayer, { disableListenLog: true }).pipe(
      Layer.provideMerge(RemotePreviewProxy.layer),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(
        Layer.mock(SessionStore.SessionStore)({
          cookieName: "t3_session",
          legacyCookieName: undefined,
          isActive: () => Effect.sync(() => active),
          awaitInvalidation: () => Deferred.await(invalidated),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
        }),
      ),
      Layer.provide(
        Layer.succeed(ServerConfig.ServerConfig, {
          port: SERVER_PORT,
        } as unknown as ServerConfig.ServerConfig["Service"]),
      ),
      Layer.provide(NodeServices.layer),
    ),
  );
  const proxy = Context.get(services, RemotePreviewProxy.RemotePreviewProxy);
  const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
  const invalidateSession = Effect.gen(function* () {
    active = false;
    yield* Deferred.succeed(invalidated, undefined);
  });
  // NodeHttpServer.layerTest's client resolves paths against the test server.
  const httpClient = Context.get(services, HttpClient.HttpClient);
  const post = (path: string, grant: string) =>
    httpClient
      .execute(
        HttpClientRequest.post(path).pipe(
          HttpClientRequest.setHeader(REMOTE_PREVIEW_PROXY_GRANT_HEADER, grant),
        ),
      )
      .pipe(Effect.orDie);
  return { proxy, origin, invalidateSession, post };
});

/** A loopback TCP server that answers each chunk with `echo:<chunk>`. */
const echoServer = Effect.gen(function* () {
  const sockets = new Set<NodeNet.Socket>();
  const server = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeNet.Server>((resolve) => {
          const created = NodeNet.createServer((socket) => {
            sockets.add(socket);
            socket.on("data", (chunk) => socket.write(`echo:${chunk.toString()}`));
          });
          created.listen(0, "127.0.0.1", () => resolve(created));
        }),
    ),
    (server) =>
      Effect.promise(() => {
        for (const socket of sockets) socket.destroy();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
  );
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("Missing echo port");
  return address.port;
});

interface TunnelResult {
  readonly status?: number;
  readonly socket?: InstanceType<typeof NodeWS.WebSocket>;
}

const openTunnel = (origin: string, grant: string, host: string, port: number) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<TunnelResult>((resolve) => {
          const url = new URL(REMOTE_PREVIEW_PROXY_TUNNEL_PATH, origin.replace(/^http/, "ws"));
          url.searchParams.set("host", host);
          url.searchParams.set("port", String(port));
          const socket = new NodeWS.WebSocket(url, {
            headers: { [REMOTE_PREVIEW_PROXY_GRANT_HEADER]: grant },
          });
          socket.once("open", () => resolve({ socket }));
          socket.once("unexpected-response", (_request, response) => {
            resolve({ status: response.statusCode ?? 0 });
            response.resume();
          });
          socket.once("error", () => resolve({ status: -1 }));
        }),
    ),
    (result) => Effect.sync(() => result.socket?.terminate()),
  );

const roundTrip = (socket: InstanceType<typeof NodeWS.WebSocket>, message: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve) => {
        socket.once("message", (data) => resolve(String(data)));
        socket.send(Buffer.from(message));
      }),
  );

const closed = (socket: InstanceType<typeof NodeWS.WebSocket>) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === socket.CLOSED) resolve();
        else socket.once("close", () => resolve());
      }),
  );

it.effect("tunnels bytes only to approved loopback ports of the granted session", () =>
  Effect.gen(function* () {
    const { proxy, origin } = yield* setup;
    const approved = yield* echoServer;
    const other = yield* echoServer;
    const { grant } = yield* proxy.issueGrant(SESSION, [approved]);

    const tunnel = yield* openTunnel(origin, grant, "127.0.0.1", approved);
    assert(tunnel.socket);
    expect(yield* roundTrip(tunnel.socket, "GET / HTTP/1.1\r\n\r\n")).toBe(
      "echo:GET / HTTP/1.1\r\n\r\n",
    );

    expect((yield* openTunnel(origin, grant, "127.0.0.1", other)).status).toBe(403);
    expect((yield* openTunnel(origin, grant, "192.168.1.10", approved)).status).toBe(400);
    expect((yield* openTunnel(origin, grant, "example.com", approved)).status).toBe(400);
    expect((yield* openTunnel(origin, `${grant}x`, "127.0.0.1", approved)).status).toBe(401);
  }),
);

it.effect("reports an unreachable approved port before upgrading", () =>
  Effect.gen(function* () {
    const { proxy, origin } = yield* setup;
    const port = yield* echoServer.pipe(Effect.scoped);
    const { grant } = yield* proxy.issueGrant(SESSION, [port]);
    expect((yield* openTunnel(origin, grant, "127.0.0.1", port)).status).toBe(502);
  }),
);

it.effect("refuses to grant the environment's own server port", () =>
  Effect.gen(function* () {
    const { proxy } = yield* setup;
    const error = yield* Effect.flip(proxy.issueGrant(SESSION, [5173, SERVER_PORT]));
    expect(error.reason).toBe("port-reserved");
  }),
);

it.effect("renews within the TTL, and an expired grant stops opening tunnels", () =>
  Effect.gen(function* () {
    const { proxy, origin, post } = yield* setup;
    const port = yield* echoServer;
    const issued = yield* proxy.issueGrant(SESSION, [port]);

    yield* TestClock.adjust("9 minutes");
    const renewal = yield* post(REMOTE_PREVIEW_PROXY_RENEW_PATH, issued.grant);
    expect(renewal.status).toBe(200);
    const renewed = (yield* renewal.json.pipe(Effect.orDie)) as {
      readonly grant: string;
      readonly ports: ReadonlyArray<number>;
    };
    expect(renewed.ports).toEqual([port]);

    yield* TestClock.adjust("2 minutes");
    expect((yield* openTunnel(origin, issued.grant, "127.0.0.1", port)).status).toBe(401);
    expect((yield* post(REMOTE_PREVIEW_PROXY_RENEW_PATH, issued.grant)).status).toBe(401);
    const tunnel = yield* openTunnel(origin, renewed.grant, "localhost", port);
    assert(tunnel.socket);
    expect(yield* roundTrip(tunnel.socket, "ping")).toBe("echo:ping");
  }),
);

it.effect("revoking a grant closes its open tunnels and blocks renewal", () =>
  Effect.gen(function* () {
    const { proxy, origin, post } = yield* setup;
    const port = yield* echoServer;
    const { grant } = yield* proxy.issueGrant(SESSION, [port]);
    const tunnel = yield* openTunnel(origin, grant, "127.0.0.1", port);
    assert(tunnel.socket);
    expect(yield* roundTrip(tunnel.socket, "a")).toBe("echo:a");

    expect((yield* post(REMOTE_PREVIEW_PROXY_REVOKE_PATH, grant)).status).toBe(204);
    yield* closed(tunnel.socket);
    expect((yield* post(REMOTE_PREVIEW_PROXY_RENEW_PATH, grant)).status).toBe(401);
    expect((yield* openTunnel(origin, grant, "127.0.0.1", port)).status).toBe(401);
  }),
);

it.effect("signing out the issuing session closes tunnels and invalidates its grants", () =>
  Effect.gen(function* () {
    const { proxy, origin, invalidateSession } = yield* setup;
    const port = yield* echoServer;
    const { grant } = yield* proxy.issueGrant(SESSION, [port]);
    const tunnel = yield* openTunnel(origin, grant, "127.0.0.1", port);
    assert(tunnel.socket);

    yield* invalidateSession;
    yield* closed(tunnel.socket);
    expect((yield* openTunnel(origin, grant, "127.0.0.1", port)).status).toBe(401);
  }),
);
