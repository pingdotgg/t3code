import { assert, describe, it } from "@effect/vitest";
import { SshHttpBridgeError } from "@t3tools/ssh/errors";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as DesktopSshRemoteApi from "./DesktopSshRemoteApi.ts";

function jsonResponse(request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function makeLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) {
  return DesktopSshRemoteApi.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => handler(request)),
      ),
    ),
  );
}

const authDescriptor = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-session-token"],
  sessionCookieName: "t3_session",
} as const;

describe("DesktopSshRemoteApi", () => {
  it.effect("fetches and decodes the remote environment descriptor", () => {
    const requestUrls: string[] = [];
    const layer = makeLayer((request) =>
      Effect.sync(() => {
        requestUrls.push(request.url);
        return jsonResponse(request, {
          environmentId: "remote-env",
          label: "Remote Devbox",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "1.2.3",
          capabilities: { repositoryIdentity: true },
        });
      }),
    );

    return Effect.gen(function* () {
      const remoteApi = yield* DesktopSshRemoteApi.DesktopSshRemoteApi;
      const descriptor = yield* remoteApi.fetchEnvironmentDescriptor({
        httpBaseUrl: "http://127.0.0.1:41773/",
      });

      assert.equal(descriptor.label, "Remote Devbox");
      assert.deepEqual(requestUrls, ["http://127.0.0.1:41773/.well-known/t3/environment"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("decodes auth timestamp strings returned by remote JSON endpoints", () => {
    const expiresAt = "2026-06-26T13:15:36.023Z";
    const requestUrls: string[] = [];
    const layer = makeLayer((request) =>
      Effect.sync(() => {
        requestUrls.push(request.url);

        switch (new URL(request.url).pathname) {
          case "/api/auth/bootstrap/bearer":
            return jsonResponse(request, {
              authenticated: true,
              role: "client",
              sessionMethod: "bearer-session-token",
              expiresAt,
              sessionToken: "session-token",
            });
          case "/api/auth/session":
            return jsonResponse(request, {
              authenticated: true,
              auth: authDescriptor,
              role: "client",
              sessionMethod: "bearer-session-token",
              expiresAt,
            });
          case "/api/auth/ws-token":
            return jsonResponse(request, {
              token: "websocket-token",
              expiresAt,
            });
          default:
            return jsonResponse(request, { error: "unexpected request" }, 404);
        }
      }),
    );

    return Effect.gen(function* () {
      const remoteApi = yield* DesktopSshRemoteApi.DesktopSshRemoteApi;

      const bootstrap = yield* remoteApi.bootstrapBearerSession({
        httpBaseUrl: "http://127.0.0.1:41773/",
        credential: "pairing-token",
      });
      assert.equal(bootstrap.sessionToken, "session-token");
      assert.equal(DateTime.formatIso(bootstrap.expiresAt), expiresAt);

      const session = yield* remoteApi.fetchSessionState({
        httpBaseUrl: "http://127.0.0.1:41773/",
        bearerToken: bootstrap.sessionToken,
      });
      if (!session.expiresAt) {
        throw new Error("expected authenticated session expiry");
      }
      assert.equal(DateTime.formatIso(session.expiresAt), expiresAt);

      const websocket = yield* remoteApi.issueWebSocketToken({
        httpBaseUrl: "http://127.0.0.1:41773/",
        bearerToken: bootstrap.sessionToken,
      });
      assert.equal(websocket.token, "websocket-token");
      assert.equal(DateTime.formatIso(websocket.expiresAt), expiresAt);

      assert.deepEqual(requestUrls, [
        "http://127.0.0.1:41773/api/auth/bootstrap/bearer",
        "http://127.0.0.1:41773/api/auth/session",
        "http://127.0.0.1:41773/api/auth/ws-token",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("wraps schema decode failures in a typed remote api error", () => {
    const layer = makeLayer((request) =>
      Effect.succeed(jsonResponse(request, { environmentId: "remote-env" })),
    );

    return Effect.gen(function* () {
      const remoteApi = yield* DesktopSshRemoteApi.DesktopSshRemoteApi;
      const error = yield* remoteApi
        .fetchEnvironmentDescriptor({
          httpBaseUrl: "http://127.0.0.1:41773/",
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, DesktopSshRemoteApi.DesktopSshRemoteApiError);
      assert.equal(error.operation, "fetch-environment-descriptor");
      assert.equal(error.cause instanceof SshHttpBridgeError, false);
    }).pipe(Effect.provide(layer));
  });
});
