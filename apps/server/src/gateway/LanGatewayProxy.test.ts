import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpRouter, type HttpServerRequest } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as LanGateway from "./LanGateway.ts";
import * as LanGatewayProxy from "./LanGatewayProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const peerId = EnvironmentId.make("env_peer");
const upstreamOrigin = "http://192.168.1.20:13773";

const fixture = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  options?: {
    readonly upstream?: Option.Option<string>;
  },
) => {
  const requests: string[] = [];
  const authenticatedUrls: string[] = [];
  const headers: Array<Readonly<Record<string, string>>> = [];
  const client = HttpClient.make((request, _url, _signal) =>
    Effect.sync(() => {
      requests.push(request.url);
      headers.push(request.headers);
      return HttpClientResponse.fromWeb(request, new Response("ok"));
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    LanGatewayProxy.layer.pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateWebSocketUpgrade: (request: HttpServerRequest.HttpServerRequest) =>
            Effect.sync(() => {
              authenticatedUrls.push(request.url);
              return {
                sessionId: AuthSessionId.make("test"),
                subject: "test",
                method: "bearer-access-token",
                scopes,
              };
            }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(LanGateway.LanGateway, {
          list: Effect.die("unused"),
          add: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
          advertise: Effect.succeed([]),
          subscribeAdvertisementChanges: Effect.succeed(Stream.empty),
          resolveUpstream: (environmentId) =>
            Effect.succeed(
              environmentId === peerId
                ? (options?.upstream ?? Option.some(upstreamOrigin))
                : Option.none(),
            ),
        } as LanGateway.LanGateway["Service"]),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, requests, authenticatedUrls, headers };
};

describe("LAN gateway proxy", () => {
  it("rewrites the gateway path onto the peer origin and strips only gatewayTicket", () => {
    expect(
      LanGatewayProxy.rewriteUpstreamUrl(
        `/__t3_gateway/${peerId}/api/auth/session`,
        "?gatewayTicket=hop&wsTicket=peer&x=1",
        upstreamOrigin,
      ),
    ).toEqual(Option.some(`${upstreamOrigin}/api/auth/session?wsTicket=peer&x=1`));
    expect(
      LanGatewayProxy.rewriteUpstreamUrl(`/__t3_gateway/${peerId}`, "", upstreamOrigin),
    ).toEqual(Option.some(`${upstreamOrigin}/`));
  });

  it("forwards authenticated requests to the resolved peer", async () => {
    const { handler, requests, authenticatedUrls, headers } = fixture([AuthOrchestrationReadScope]);
    const response = await handler(
      new Request(
        `http://t3.test/__t3_gateway/${peerId}/api/auth/session?gatewayTicket=hop&wsTicket=peer`,
        {
          headers: { authorization: "Bearer peer-token", cookie: "session=1", dpop: "proof" },
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(requests).toEqual([`${upstreamOrigin}/api/auth/session?wsTicket=peer`]);
    expect(authenticatedUrls).toEqual([`/__t3_gateway/${peerId}/api/auth/session?wsTicket=hop`]);
    expect(headers[0]?.authorization).toBe("Bearer peer-token");
    expect(headers[0]?.cookie).toBeUndefined();
    expect(headers[0]?.dpop).toBe("proof");
  });

  it("authenticates a ticketless hop without the peer's wsTicket, which still reaches the peer", async () => {
    const { handler, requests, authenticatedUrls, headers } = fixture([AuthOrchestrationReadScope]);
    const response = await handler(
      new Request(`http://t3.test/__t3_gateway/${peerId}/ws?wsTicket=peer`, {
        headers: { cookie: "session=1" },
      }),
    );
    expect(response.status).toBe(200);
    expect(authenticatedUrls).toEqual([`/__t3_gateway/${peerId}/ws`]);
    expect(requests).toEqual([`${upstreamOrigin}/ws?wsTicket=peer`]);
    expect(headers[0]?.cookie).toBeUndefined();
  });

  it("returns 404 when the peer is unknown or the gateway is disabled", async () => {
    const missing = fixture([AuthOrchestrationReadScope], { upstream: Option.none() });
    expect(
      (await missing.handler(new Request(`http://t3.test/__t3_gateway/${peerId}/api/foo`))).status,
    ).toBe(404);
    expect(missing.requests).toEqual([]);
  });

  it("requires orchestration read scope", async () => {
    const { handler, requests } = fixture([]);
    expect(
      (await handler(new Request(`http://t3.test/__t3_gateway/${peerId}/api/foo`))).status,
    ).toBe(403);
    expect(requests).toEqual([]);
  });
});
