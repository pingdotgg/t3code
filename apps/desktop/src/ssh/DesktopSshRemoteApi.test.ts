import { assert, describe, it } from "@effect/vitest";
import { AuthBearerBootstrapResult } from "@t3tools/contracts";
import { SshHttpBridgeError } from "@t3tools/ssh/errors";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as DesktopSshRemoteApi from "./DesktopSshRemoteApi.ts";

const encodeAuthBearerBootstrapResult = Schema.encodeUnknownEffect(AuthBearerBootstrapResult);
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

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

  it.effect("decodes bearer bootstrap JSON dates from SSH HTTP responses", () => {
    const layer = makeLayer((request) =>
      Effect.sync(() =>
        jsonResponse(request, {
          authenticated: true,
          role: "owner",
          sessionMethod: "bearer-session-token",
          expiresAt: "2026-06-07T19:31:50.534Z",
          sessionToken: "bearer-token",
        }),
      ),
    );

    return Effect.gen(function* () {
      const remoteApi = yield* DesktopSshRemoteApi.DesktopSshRemoteApi;
      const session = yield* remoteApi.bootstrapBearerSession({
        httpBaseUrl: "http://127.0.0.1:41773/",
        credential: "pairing-token",
      });

      assert.equal(session.sessionToken, "bearer-token");
      assert.isTrue(DateTime.isDateTime(session.expiresAt));
      assert.equal(DateTime.formatIso(session.expiresAt), "2026-06-07T19:31:50.534Z");
    }).pipe(Effect.provide(layer));
  });

  it.effect("decodes session state JSON dates from SSH HTTP responses", () => {
    const layer = makeLayer((request) =>
      Effect.sync(() =>
        jsonResponse(request, {
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["bearer-session-token"],
            sessionCookieName: "t3_session",
          },
          role: "client",
          sessionMethod: "bearer-session-token",
          expiresAt: "2026-06-07T19:31:50.534Z",
        }),
      ),
    );

    return Effect.gen(function* () {
      const remoteApi = yield* DesktopSshRemoteApi.DesktopSshRemoteApi;
      const session = yield* remoteApi.fetchSessionState({
        httpBaseUrl: "http://127.0.0.1:41773/",
        bearerToken: "bearer-token",
      });

      assert.equal(session.role, "client");
      assert.isTrue(session.expiresAt ? DateTime.isDateTime(session.expiresAt) : false);
      assert.equal(
        session.expiresAt ? DateTime.formatIso(session.expiresAt) : null,
        "2026-06-07T19:31:50.534Z",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("decodes websocket token JSON dates from SSH HTTP responses", () => {
    const layer = makeLayer((request) =>
      Effect.sync(() =>
        jsonResponse(request, {
          token: "websocket-token",
          expiresAt: "2026-06-07T19:31:50.534Z",
        }),
      ),
    );

    return Effect.gen(function* () {
      const remoteApi = yield* DesktopSshRemoteApi.DesktopSshRemoteApi;
      const token = yield* remoteApi.issueWebSocketToken({
        httpBaseUrl: "http://127.0.0.1:41773/",
        bearerToken: "bearer-token",
      });

      assert.equal(token.token, "websocket-token");
      assert.isTrue(DateTime.isDateTime(token.expiresAt));
      assert.equal(DateTime.formatIso(token.expiresAt), "2026-06-07T19:31:50.534Z");
    }).pipe(Effect.provide(layer));
  });

  it.effect("encodes bearer bootstrap dates as JSON-safe strings for IPC", () =>
    Effect.gen(function* () {
      const encoded = yield* encodeAuthBearerBootstrapResult({
        authenticated: true,
        role: "owner",
        sessionMethod: "bearer-session-token",
        expiresAt: DateTime.makeUnsafe("2026-06-07T19:31:50.534Z"),
        sessionToken: "bearer-token",
      });

      assert.deepEqual(encoded, {
        authenticated: true,
        role: "owner",
        sessionMethod: "bearer-session-token",
        expiresAt: "2026-06-07T19:31:50.534Z",
        sessionToken: "bearer-token",
      });
      const json = yield* encodeUnknownJsonString(encoded);
      assert.equal(json.includes('"expiresAt":"2026-06-07T19:31:50.534Z"'), true);
    }),
  );

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
