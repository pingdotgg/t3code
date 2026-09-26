// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Route-layer tests drive real loopback HTTP against a stub upstream.
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import type * as NodeNet from "node:net";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";

import {
  type BrowserFrameAuthority,
  layer as BrowserFrameLeasesLayer,
  BrowserFrameLeases,
} from "./BrowserFrameLeases.ts";
import { browserFrameProxyRouteLayer } from "./BrowserFrameProxy.ts";
import { EnvironmentExtensions } from "../extensions/EnvironmentExtensions.ts";
import { ExtensionCatalogueChanges } from "../extensions/catalogueChanges.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import * as EnvAuth from "../auth/EnvironmentAuth.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import { AuthSessionId, EnvironmentId, PreviewTabId, ThreadId } from "@t3tools/contracts";

const tuple = {
  environmentId: EnvironmentId.make("env-a"),
  threadId: ThreadId.make("thread-a"),
  serverEpoch: "epoch-1",
  tabId: PreviewTabId.make("tab-1"),
};

const extensionAuthority: BrowserFrameAuthority = {
  kind: "extension",
  principalKind: "host",
  principalId: "p",
  subject: "u",
  rootCallerId: "ext",
  callerId: "ext",
  callerGenerations: [{ pluginId: "ext", contentHash: "h", installationGeneration: 1 }],
  context: { resource: { projectId: "p" } },
  grants: ["t3.browser/frames"],
};

const extensionRows = [
  {
    id: "ext",
    enabled: true,
    contentHash: "h",
    grants: { capabilities: ["t3.browser/frames"], projectIds: ["p"] },
  },
];

const sessionStoreStub = {
  watchChanges: () => Effect.succeed(Stream.never),
  revalidate: () => Effect.succeed({ subject: "u", scopes: ["orchestration:read"] }),
};

const routeDeps = (
  leases: BrowserFrameLeases["Service"],
  hub: Broker.BrowserFrameHubEndpoint,
  extensions: Pick<EnvironmentExtensions["Service"], "list">,
  auth?: Partial<EnvAuth.EnvironmentAuth["Service"]>,
) =>
  Layer.mergeAll(
    Layer.succeed(BrowserFrameLeases, leases),
    Layer.succeed(Broker.PreviewAutomationBroker, {
      frameHubs: Effect.succeed([hub]),
      frameHubEvents: Stream.never,
      watchFrameHubEvents: () => Effect.succeed(Stream.never),
    } as unknown as Broker.PreviewAutomationBroker["Service"]),
    Layer.succeed(EnvironmentExtensions, extensions as EnvironmentExtensions["Service"]),
    Layer.succeed(ExtensionCatalogueChanges, {
      changes: Stream.never,
      publish: Effect.void,
    } as unknown as ExtensionCatalogueChanges["Service"]),
    Layer.succeed(SessionStore, sessionStoreStub as unknown as SessionStore["Service"]),
    Layer.succeed(EnvAuth.EnvironmentAuth, (auth ?? {}) as EnvAuth.EnvironmentAuth["Service"]),
    FetchHttpClient.layer,
    NodeServices.layer,
  );

const routes = (
  leases: BrowserFrameLeases["Service"],
  hub: Broker.BrowserFrameHubEndpoint,
  extensions: Pick<EnvironmentExtensions["Service"], "list">,
  auth?: Partial<EnvAuth.EnvironmentAuth["Service"]>,
) => browserFrameProxyRouteLayer.pipe(Layer.provideMerge(routeDeps(leases, hub, extensions, auth)));

/** Loopback GET against a real Node server — kept out of Effect code. */
const httpGet = (url: string): Promise<Response> => fetch(url);

const listen = async (server: NodeHttp.Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
};

const LeasesLive = BrowserFrameLeasesLayer.pipe(Layer.provide(NodeServices.layer));

interface Fixture {
  readonly hub: Broker.BrowserFrameHubEndpoint;
  readonly web: {
    readonly handler: (request: Request) => Promise<Response>;
    readonly dispose: () => Promise<void>;
  };
  readonly leases: BrowserFrameLeases["Service"];
}

const withProxy = <A, E>(
  upstream: NodeHttp.RequestListener,
  extensions: Pick<EnvironmentExtensions["Service"], "list">,
  auth: Partial<EnvAuth.EnvironmentAuth["Service"]> | undefined,
  run: (fixture: Fixture) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const leases = yield* BrowserFrameLeases;
    const server = NodeHttp.createServer(upstream);
    const origin = yield* Effect.promise(() => listen(server));
    const hub = {
      origin,
      secret: "hub-secret",
      clientId: "h",
      connectionId: "hc",
      environmentId: "env-a",
    } as Broker.BrowserFrameHubEndpoint;
    const web = HttpRouter.toWebHandler(routes(leases, hub, extensions, auth), {
      disableLogger: true,
    });
    try {
      return yield* run({ hub, web, leases });
    } finally {
      yield* Effect.promise(() => web.dispose());
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      );
    }
  }).pipe(Effect.scoped, Effect.provide(LeasesLive));

const ticketMint = (hub: Broker.BrowserFrameHubEndpoint) => ({
  authority: extensionAuthority,
  session: tuple,
  hostClientId: hub.clientId,
  hostConnectionId: hub.connectionId,
  engineGeneration: "gen-1",
});

const okExtensions = { list: Effect.succeed(extensionRows as never) };

describe("BrowserFrameProxy", () => {
  it.live("a revocation landing during redemption is never missed", () =>
    Effect.gen(function* () {
      // Gate the authority re-check so the revocation lands mid-redeem: `list`
      // resolves `listHold` only after the test has revoked every record.
      let listHoldRelease: (() => void) | undefined;
      const listHold = new Promise<void>((resolve) => {
        listHoldRelease = resolve;
      });
      let listCalled: (() => void) | undefined;
      const listStarted = new Promise<void>((resolve) => {
        listCalled = resolve;
      });
      yield* withProxy(
        (_req, res) => {
          res.writeHead(200, {
            "Content-Type": "multipart/x-mixed-replace; boundary=t3frame",
          });
          res.write("frame1");
        },
        {
          list: Effect.promise(async () => {
            listCalled!();
            await listHold;
            return extensionRows as never;
          }),
        },
        undefined,
        ({ hub, web, leases }) =>
          Effect.gen(function* () {
            const minted = Option.getOrThrow(yield* leases.issueStreamTicket(ticketMint(hub)));
            const pending = web.handler(
              new Request(
                `http://fixture/api/browser-frames/sessions/tab-1/stream.mjpeg?frameTicket=${minted.ticket}`,
              ),
            );
            yield* Effect.promise(() => listStarted);
            yield* leases.revokeWhere(() => true);
            listHoldRelease!();
            const response = yield* Effect.promise(() => pending);
            expect(response.status).toBe(401);
          }),
      );
    }),
  );

  it.live("an upstream redirect is never followed and leaks no hub secret", () => {
    const redirectHits: Array<Record<string, unknown>> = [];
    const redirectTarget = NodeHttp.createServer((req, res) => {
      redirectHits.push(req.headers as Record<string, unknown>);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    return Effect.gen(function* () {
      const targetOrigin = yield* Effect.promise(() => listen(redirectTarget));
      try {
        yield* withProxy(
          (req, res) => {
            if (req.url?.startsWith("/sessions/tab-1/stream.mjpeg")) {
              res.writeHead(302, { location: `${targetOrigin}/private` });
              res.end();
              return;
            }
            res.writeHead(404);
            res.end();
          },
          okExtensions,
          undefined,
          ({ hub, web, leases }) =>
            Effect.gen(function* () {
              const minted = Option.getOrThrow(yield* leases.issueStreamTicket(ticketMint(hub)));
              const response = yield* Effect.promise(() =>
                web.handler(
                  new Request(
                    `http://fixture/api/browser-frames/sessions/tab-1/stream.mjpeg?frameTicket=${minted.ticket}`,
                  ),
                ),
              );
              expect(response.status).toBe(502);
              expect(redirectHits).toHaveLength(0);
            }),
        );
      } finally {
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              redirectTarget.closeAllConnections();
              redirectTarget.close(() => resolve());
            }),
        );
      }
    });
  });

  it.live("refuses a ticket whose bound host connection is gone", () =>
    withProxy(
      (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
      okExtensions,
      undefined,
      ({ hub, web, leases }) =>
        Effect.gen(function* () {
          // Mint bound to connectionId 'hc-stale'; the broker now reports 'hc'.
          const minted = Option.getOrThrow(
            yield* leases.issueStreamTicket({
              ...ticketMint(hub),
              hostConnectionId: "hc-stale",
            }),
          );
          const response = yield* Effect.promise(() =>
            web.handler(
              new Request(
                `http://fixture/api/browser-frames/sessions/tab-1/config?frameTicket=${minted.ticket}`,
              ),
            ),
          );
          expect(response.status).toBe(503);
        }),
    ),
  );

  it.live("propagates the credential deadline to the upstream stream", () => {
    const upstreamRequests: Array<{ url: string; headers: Record<string, unknown> }> = [];
    // Fixed far-future instant — the deadline only needs to outlive the test.
    const deadline = DateTime.makeUnsafe(4_102_444_800_000);
    const auth: Partial<EnvAuth.EnvironmentAuth["Service"]> = {
      authenticateWebSocketUpgrade: () =>
        Effect.succeed({
          sessionId: AuthSessionId.make("sess-1"),
          subject: "u",
          method: "browser-session-cookie",
          scopes: ["orchestration:read"],
          credentialExpiresAt: deadline,
        } as EnvAuth.AuthenticatedSession),
    };
    return withProxy(
      (req, res) => {
        upstreamRequests.push({
          url: req.url ?? "",
          headers: req.headers as Record<string, unknown>,
        });
        res.writeHead(200, {
          "Content-Type": "multipart/x-mixed-replace; boundary=t3frame",
        });
        res.write("--t3frame\r\nContent-Length: 1\r\n\r\nx\r\n");
      },
      okExtensions,
      auth,
      ({ web }) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            web.handler(
              new Request(
                "http://fixture/api/browser-frames/sessions/tab-1/stream.mjpeg?" +
                  new URLSearchParams({
                    wsTicket: "ws.t",
                    environmentId: tuple.environmentId,
                    threadId: tuple.threadId,
                    serverEpoch: tuple.serverEpoch,
                  }),
              ),
            ),
          );
          expect(response.status).toBe(200);
          yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
          const upstream = upstreamRequests[0];
          const query = new URLSearchParams(upstream?.url.split("?")[1] ?? "");
          expect(query.get("x-t3-lease-expires")).toBe(String(deadline.epochMilliseconds));
          expect(upstream?.headers["x-t3-hub-auth"]).toBe("hub-secret");
        }),
    );
  });

  it.live("root disconnect terminates already-open extension stream and input channels", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      // Upstream engine hub: a held-open MJPEG response and an input WS
      // that accepts and idles — both must die when the viewer's root
      // connection goes away.
      const upstreamSockets = new Set<NodeNet.Socket>();
      const upstream = NodeHttp.createServer((req, res) => {
        if (req.url?.startsWith("/sessions/tab-1/stream.mjpeg")) {
          res.writeHead(200, {
            "content-type": "multipart/x-mixed-replace; boundary=t3frame",
          });
          res.write("--t3frame\r\nContent-Length: 1\r\n\r\nx\r\n");
          return;
        }
        res.writeHead(404);
        res.end();
      });
      // Minimal 101 handshake upstream — accepts the input upgrade and idles
      // so the test observes the proxy closing the hop, not WS semantics.
      upstream.on("upgrade", (req, socket: NodeNet.Socket) => {
        if (req.url?.startsWith("/sessions/tab-1/input")) {
          const key = req.headers["sec-websocket-key"];
          const accept = NodeCrypto.createHash("sha1")
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\n" +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          upstreamSockets.add(socket);
          socket.on("close", () => upstreamSockets.delete(socket));
          socket.on("error", () => {});
          // Answer the peer's close frame with FIN — without it the proxy's
          // close handshake never completes and the TCP connection lingers.
          socket.on("data", (data) => {
            if ((data[0]! & 0x0f) === 0x8) socket.end();
          });
          return;
        }
        socket.destroy();
      });
      const upstreamOrigin = yield* Effect.promise(() => listen(upstream));
      const hub = {
        origin: upstreamOrigin,
        secret: "hub-secret",
        clientId: "h",
        connectionId: "hc",
        environmentId: "env-a",
      } as Broker.BrowserFrameHubEndpoint;
      // A real Node server so the input path exercises an actual upgrade.
      const nodeServer = NodeHttp.createServer();
      yield* Layer.build(
        HttpRouter.serve(routes(leases, hub, okExtensions, undefined), {
          disableLogger: true,
        }).pipe(
          // Route handlers read these as ambient request-time services —
          // same provision shape `server.ts` gives the real routes layer.
          Layer.provideMerge(routeDeps(leases, hub, okExtensions, undefined)),
          Layer.provide(
            NodeHttpServer.layer(() => nodeServer, {
              port: 0,
              host: "127.0.0.1",
              websocket: {},
            }),
          ),
        ),
      );
      const origin = `http://127.0.0.1:${(nodeServer.address() as NodeNet.AddressInfo).port}`;
      let inputSocket: WebSocket | undefined;
      try {
        const connOne: BrowserFrameAuthority = {
          ...extensionAuthority,
          rootConnectionId: "conn-1",
        };
        const streamTicket = Option.getOrThrow(
          yield* leases.issueStreamTicket({
            ...ticketMint(hub),
            authority: connOne,
          }),
        );
        const inputLease = yield* leases.issueInputLease({
          ...ticketMint(hub),
          authority: connOne,
        });
        expect(Option.isSome(inputLease)).toBe(true);
        // A second connection sharing the session: its records must outlive
        // conn-1's disconnect.
        const connTwo: BrowserFrameAuthority = {
          ...extensionAuthority,
          rootConnectionId: "conn-2",
        };
        const controlTicket = Option.getOrThrow(
          yield* leases.issueStreamTicket({
            ...ticketMint(hub),
            authority: connTwo,
          }),
        );
        // Held presentation claims ride the same connection identity:
        // conn-1's claim is released by the disconnect, conn-2's survives.
        const claimExpiry = (yield* Clock.currentTimeMillis) + 60_000;
        yield* leases.recordHeldSurfaceClaim({
          token: "tok-conn-1",
          authority: { ...connOne, heldSlot: "tok-conn-1" },
          session: tuple,
          allowedCommands: ["attach", "present", "release"],
          expiresAt: claimExpiry,
        });
        yield* leases.recordHeldSurfaceClaim({
          token: "tok-conn-2",
          authority: { ...connTwo, heldSlot: "tok-conn-2" },
          session: tuple,
          allowedCommands: ["attach", "present", "release"],
          expiresAt: claimExpiry,
        });

        const streamResponse = yield* Effect.promise(() =>
          httpGet(
            `${origin}/api/browser-frames/sessions/tab-1/stream.mjpeg?frameTicket=${streamTicket.ticket}`,
          ),
        );
        expect(streamResponse.status).toBe(200);
        const reader = streamResponse.body!.getReader();
        expect((yield* Effect.promise(() => reader.read())).done).toBe(false);

        inputSocket = yield* Effect.promise(
          () =>
            new Promise<WebSocket>((resolve, reject) => {
              const ws = new WebSocket(
                `${origin}/api/browser-frames/sessions/tab-1/input?inputTicket=${Option.getOrThrow(inputLease).inputTicket}`,
              );
              ws.addEventListener("open", () => resolve(ws), { once: true });
              ws.addEventListener("error", () => reject(new Error("input upgrade rejected")), {
                once: true,
              });
            }),
        );
        yield* Effect.promise(() => vi.waitFor(() => expect(upstreamSockets.size).toBe(1)));

        // The ws layer's disconnect path: every record riding conn-1 dies.
        yield* leases.revokeConnection("conn-1");

        const streamEnd = yield* Effect.promise(() => reader.read());
        expect(streamEnd.done).toBe(true);
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(inputSocket?.readyState).toBe(WebSocket.CLOSED)),
        );
        yield* Effect.promise(() => vi.waitFor(() => expect(upstreamSockets.size).toBe(0)));
        expect(Option.isSome(yield* leases.verify(controlTicket.ticket))).toBe(true);
        expect(Option.isNone(yield* leases.heldSurfaceClaim("tok-conn-1"))).toBe(true);
        expect(Option.isSome(yield* leases.heldSurfaceClaim("tok-conn-2"))).toBe(true);
      } finally {
        inputSocket?.close();
        for (const socket of upstreamSockets) socket.destroy();
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              upstream.closeAllConnections();
              upstream.close(() => resolve());
            }),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(LeasesLive)),
  );

  it.live("scopes a ticket-bound /sessions listing to the bound tuple", () =>
    withProxy(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            { ...tuple },
            {
              environmentId: "env-a",
              threadId: "thread-b",
              serverEpoch: "epoch-1",
              tabId: "tab-9",
            },
          ]),
        );
      },
      okExtensions,
      undefined,
      ({ hub, web, leases }) =>
        Effect.gen(function* () {
          const minted = Option.getOrThrow(yield* leases.issueStreamTicket(ticketMint(hub)));
          const response = yield* Effect.promise(() =>
            web.handler(
              new Request(
                `http://fixture/api/browser-frames/sessions?frameTicket=${minted.ticket}`,
              ),
            ),
          );
          expect(response.status).toBe(200);
          const rows = (yield* Effect.promise(() => response.json())) as Array<{
            tabId: string;
          }>;
          expect(rows).toEqual([tuple]);
        }),
    ),
  );
});
