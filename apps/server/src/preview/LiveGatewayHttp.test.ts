import { expect, it } from "@effect/vitest";
import { AuthSessionId, PreviewTabId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Cookies, Headers, HttpClientRequest, type HttpServerRequest } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import {
  LIVE_GATEWAY_COOKIE_NAME,
  LIVE_GATEWAY_HTTP_COOKIE_NAME,
  type LiveGatewayLease,
} from "./LiveGateway.ts";
import {
  LIVE_GATEWAY_WEBSOCKET_MAX_FRAME_BYTES,
  LIVE_GATEWAY_WEBSOCKET_MAX_PENDING_FRAMES,
  bridgeLiveGatewaySockets,
  interruptLiveGatewayStream,
  isLiveGatewayControlCookie,
  isForwardableWebSocketCloseCode,
  liveGatewayCookieName,
  liveGatewayResponseCookies,
  liveGatewayResponseHeaders,
  liveGatewayUpstreamHeaders,
  liveGatewayUpstreamUrl,
  liveGatewayWebSocketProtocols,
  retargetLiveGatewayRequest,
} from "./LiveGatewayHttp.ts";

const environmentSessionCookieName = "t3_session_3773_deadbeef";
const lease: LiveGatewayLease = {
  sessionId: AuthSessionId.make("session-http-gateway"),
  threadId: ThreadId.make("thread-http-gateway"),
  tabId: PreviewTabId.make("tab-http-gateway"),
  target: {
    origin: "http://127.0.0.1:5173",
    redirectPath: "/",
  },
  expiresAt: 1_785_369_600_000,
  invalidated: Effect.never,
};

function request(input: {
  readonly cookies?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
}): HttpServerRequest.HttpServerRequest {
  return {
    cookies: input.cookies ?? {},
    headers: Headers.fromInput(input.headers ?? {}),
  } as unknown as HttpServerRequest.HttpServerRequest;
}

function testSocket(input?: {
  readonly blockDataWrites?: boolean;
  readonly frames?: ReadonlyArray<string | Uint8Array>;
}) {
  const closes: Socket.CloseEvent[] = [];
  const socket = Socket.make({
    runRaw: ((handler: (frame: string | Uint8Array) => unknown) =>
      Effect.sync(() => {
        for (const frame of input?.frames ?? []) handler(frame);
      }).pipe(Effect.andThen(Effect.never))) as Socket.Socket["runRaw"],
    writer: Effect.succeed((frame) => {
      if (Socket.isCloseEvent(frame)) {
        return Effect.sync(() => {
          closes.push(frame);
        });
      }
      return input?.blockDataWrites === true ? Effect.never : Effect.void;
    }),
  });
  return { closes, socket };
}

it("keeps gateway paths pinned to the lease origin, including double-slash paths", () => {
  const upstream = liveGatewayUpstreamUrl(
    new URL("https://environment.example//attacker.example/pwn?q=1"),
    lease,
  );
  expect(upstream.origin).toBe(lease.target.origin);
  expect(upstream.pathname).toBe("//attacker.example/pwn");
  expect(upstream.search).toBe("?q=1");
});

it("preserves bare query flags when retargeting gateway requests", () => {
  const requestUrl = new URL("https://environment.example/src/styles.css?url");
  const upstreamUrl = liveGatewayUpstreamUrl(requestUrl, lease);
  const downstream = HttpClientRequest.get(requestUrl.toString());
  const upstream = retargetLiveGatewayRequest(downstream, upstreamUrl, Headers.empty);

  expect(Option.getOrThrow(HttpClientRequest.toUrl(upstream)).search).toBe("?url");
});

it("uses the downstream-selected websocket protocol and sanitizes close codes", () => {
  expect(liveGatewayWebSocketProtocols(" vite-hmr, fallback ")).toBe("vite-hmr");
  expect(liveGatewayWebSocketProtocols(undefined)).toBeUndefined();
  expect(isForwardableWebSocketCloseCode(1_000)).toBe(true);
  expect(isForwardableWebSocketCloseCode(1_006)).toBe(false);
  expect(isForwardableWebSocketCloseCode(3_001)).toBe(true);
  expect(isForwardableWebSocketCloseCode(5_000)).toBe(false);
});

it("uses a Secure host cookie over HTTPS and an HTTP-compatible host cookie over LAN", () => {
  expect(liveGatewayCookieName(new URL("https://environment.example/bootstrap"))).toBe(
    LIVE_GATEWAY_COOKIE_NAME,
  );
  expect(liveGatewayCookieName(new URL("http://192.168.1.53:13773/bootstrap"))).toBe(
    LIVE_GATEWAY_HTTP_COOKIE_NAME,
  );
});

it("strips environment credentials while preserving application cookies and request context", () => {
  const serverRequest = request({
    cookies: {
      [LIVE_GATEWAY_COOKIE_NAME]: "gateway-secret",
      [LIVE_GATEWAY_HTTP_COOKIE_NAME]: "lan-gateway-secret",
      [environmentSessionCookieName]: "environment-secret",
      t3_session: "legacy-secret",
      t3_session_other: "other-environment-secret",
      app_session: "application-value",
    },
    headers: {
      authorization: "Bearer environment-secret",
      "cf-ray": "cloudflare-metadata",
      cookie: "raw-cookie-header",
      dpop: "environment-proof",
      host: "environment.example",
      origin: "https://environment.example",
      referer: "https://environment.example/app/page?q=1",
      "sec-websocket-key": "downstream-key",
      "x-forwarded-host": "environment.example",
    },
  });
  const upstreamUrl = new URL("http://127.0.0.1:5173/asset");
  const headers = liveGatewayUpstreamHeaders({
    request: serverRequest,
    requestUrl: new URL("https://environment.example/asset"),
    upstreamUrl,
    environmentSessionCookieName,
  });

  expect(headers.authorization).toBeUndefined();
  expect(headers.dpop).toBeUndefined();
  expect(headers["cf-ray"]).toBeUndefined();
  expect(headers["x-forwarded-host"]).toBeUndefined();
  expect(headers["sec-websocket-key"]).toBeUndefined();
  expect(headers.cookie).toBe("app_session=application-value");
  expect(headers.host).toBe("127.0.0.1:5173");
  expect(headers.origin).toBe("http://127.0.0.1:5173");
  expect(headers.referer).toBe("http://127.0.0.1:5173/app/page?q=1");
  expect(headers["accept-encoding"]).toBe("identity");
});

it("rewrites loopback redirects and strips transport headers after fetch decompression", () => {
  const headers = liveGatewayResponseHeaders({
    headers: Headers.fromInput({
      "access-control-allow-origin": "http://127.0.0.1:5173",
      "content-encoding": "gzip",
      "content-length": "123",
      location: "http://localhost:5173/next?q=1#fragment",
      "set-cookie": "secret=value",
    }),
    requestUrl: new URL("https://environment.example/current"),
    upstreamOrigin: "http://127.0.0.1:5173",
  });

  expect(headers.location).toBe("/next?q=1#fragment");
  expect(headers["access-control-allow-origin"]).toBe("https://environment.example");
  expect(headers["content-encoding"]).toBeUndefined();
  expect(headers["content-length"]).toBeUndefined();
  expect(headers["set-cookie"]).toBeUndefined();
});

it("prevents upstream cookies from replacing gateway or environment credentials", () => {
  const upstream = Cookies.fromIterable([
    Cookies.makeCookieUnsafe("app_session", "value", {
      domain: "localhost",
      path: "/",
    }),
    Cookies.makeCookieUnsafe(environmentSessionCookieName, "attack"),
    Cookies.makeCookieUnsafe("t3_session", "legacy-attack"),
    Cookies.makeCookieUnsafe("t3_session_other", "other-attack"),
    Cookies.makeCookieUnsafe(LIVE_GATEWAY_COOKIE_NAME, "gateway-attack"),
    Cookies.makeCookieUnsafe(LIVE_GATEWAY_HTTP_COOKIE_NAME, "lan-gateway-attack"),
  ]);
  const filtered = liveGatewayResponseCookies(upstream, environmentSessionCookieName);

  expect(Object.keys(filtered.cookies)).toEqual(["app_session"]);
  expect(filtered.cookies.app_session?.options?.domain).toBeUndefined();
  expect(isLiveGatewayControlCookie("app_session", environmentSessionCookieName)).toBe(false);
  expect(isLiveGatewayControlCookie("t3_session_other", environmentSessionCookieName)).toBe(true);
});

it.effect("interrupts an active HTTP stream when its gateway lease is invalidated", () =>
  Effect.gen(function* () {
    const invalidated = yield* Deferred.make<void>();
    const firstChunk = yield* Deferred.make<void>();
    const activeLease: LiveGatewayLease = {
      ...lease,
      invalidated: Deferred.await(invalidated),
    };
    const stream = Stream.concat(Stream.make("first"), Stream.never).pipe(
      Stream.tap(() => Deferred.succeed(firstChunk, undefined)),
      (active) => interruptLiveGatewayStream(active, activeLease),
    );
    const fiber = yield* Stream.runCollect(stream).pipe(
      Effect.forkChild({ startImmediately: true }),
    );

    yield* Deferred.await(firstChunk);
    yield* Deferred.succeed(invalidated, undefined);

    expect(Array.from(yield* Fiber.join(fiber))).toEqual(["first"]);
  }),
);

it.effect("closes both websocket peers when one frame exceeds the payload cap", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = testSocket({
        frames: [new Uint8Array(LIVE_GATEWAY_WEBSOCKET_MAX_FRAME_BYTES + 1)],
      });
      const destination = testSocket({ blockDataWrites: true });

      yield* bridgeLiveGatewaySockets(source.socket, destination.socket);

      expect(source.closes).toMatchObject([{ code: 1_013 }]);
      expect(destination.closes).toMatchObject([{ code: 1_013 }]);
    }),
  ),
);

it.effect("bounds pending websocket frames while the destination is backpressured", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = testSocket({
        frames: Array.from({ length: LIVE_GATEWAY_WEBSOCKET_MAX_PENDING_FRAMES + 1 }, () => "x"),
      });
      const destination = testSocket({ blockDataWrites: true });

      yield* bridgeLiveGatewaySockets(source.socket, destination.socket);

      expect(source.closes).toMatchObject([{ code: 1_013 }]);
      expect(destination.closes).toMatchObject([{ code: 1_013 }]);
    }),
  ),
);

it.effect("bounds pending websocket bytes while the destination is backpressured", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const maximumFrame = new Uint8Array(LIVE_GATEWAY_WEBSOCKET_MAX_FRAME_BYTES);
      const source = testSocket({
        frames: [maximumFrame, maximumFrame, maximumFrame, maximumFrame, maximumFrame],
      });
      const destination = testSocket({ blockDataWrites: true });

      yield* bridgeLiveGatewaySockets(source.socket, destination.socket);

      expect(source.closes).toMatchObject([{ code: 1_013 }]);
      expect(destination.closes).toMatchObject([{ code: 1_013 }]);
    }),
  ),
);
