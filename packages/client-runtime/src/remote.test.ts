import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/unstable/http";

import {
  bootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState,
  issueRemoteWebSocketToken,
  remoteHttpClientLayer,
  RemoteEnvironmentAuthTimeoutError,
  resolveRemoteWebSocketConnectionUrl,
} from "./remote.ts";

type FetchCall = readonly [input: RequestInfo | URL, init: RequestInit];

const recordedFetch = (...responses: ReadonlyArray<Response>) => {
  const calls: Array<FetchCall> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    if (!response) {
      return Promise.reject(new Error("Unexpected fetch call"));
    }
    return Promise.resolve(response);
  }) satisfies typeof fetch;

  return { fetchFn, calls };
};

const hangingFetch = () => {
  const calls: Array<FetchCall> = [];
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    return new Promise<Response>(() => undefined);
  }) satisfies typeof fetch;

  return { fetchFn, calls };
};

const provideRemoteHttp =
  (fetchFn: typeof fetch) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | HttpClient.HttpClient>) =>
    effect.pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

const expectFetchCall = (
  calls: ReadonlyArray<FetchCall>,
  index: number,
  expected: {
    readonly url: string;
    readonly method: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
): void => {
  const call = calls[index - 1];
  expect(call).toBeDefined();
  if (!call) {
    return;
  }

  const [url, init] = call;
  expect(String(url)).toBe(expected.url);
  expect(init).toEqual(
    expect.objectContaining({
      method: expected.method,
    }),
  );
  expect(init.headers).toEqual(expect.objectContaining(expected.headers ?? {}));

  if ("body" in expected) {
    const body = init.body;
    if (typeof body === "string") {
      expect(body).toBe(expected.body);
    } else if (body instanceof Uint8Array) {
      expect(new TextDecoder().decode(body)).toBe(expected.body);
    } else {
      throw new Error("Expected fetch request body");
    }
  }
};

describe("remote", () => {
  it.effect("bootstraps bearer auth against a remote backend", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(
          {
            authenticated: true,
            role: "client",
            sessionMethod: "bearer-session-token",
            expiresAt: "2026-05-01T12:00:00.000Z",
            sessionToken: "bearer-token",
          },
          { status: 200 },
        ),
      );

      const result = yield* bootstrapRemoteBearerSession({
        httpBaseUrl: "https://remote.example.com/",
        credential: "pairing-token",
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expect(result).toMatchObject({
        sessionMethod: "bearer-session-token",
        sessionToken: "bearer-token",
      });
      expectFetchCall(fetch.calls, 1, {
        url: "https://remote.example.com/api/auth/bootstrap/bearer",
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: `{"credential":"pairing-token"}`,
      });
    }),
  );

  it.effect("loads remote session state and websocket tokens over bearer auth", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(
          {
            environmentId: "environment-remote",
            label: "Remote environment",
            platform: {
              os: "linux",
              arch: "x64",
            },
            serverVersion: "0.0.0-test",
            capabilities: {
              repositoryIdentity: true,
            },
          },
          { status: 200 },
        ),
        Response.json(
          {
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: ["one-time-token"],
              sessionMethods: ["browser-session-cookie", "bearer-session-token"],
              sessionCookieName: "t3_session",
            },
            role: "client",
            sessionMethod: "bearer-session-token",
            expiresAt: "2026-05-01T12:00:00.000Z",
          },
          { status: 200 },
        ),
        Response.json(
          {
            token: "ws-token",
            expiresAt: "2026-05-01T12:05:00.000Z",
          },
          { status: 200 },
        ),
      );

      const environment = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: "https://remote.example.com/",
      }).pipe(provideRemoteHttp(fetch.fetchFn));
      expect(environment).toMatchObject({
        environmentId: "environment-remote",
        label: "Remote environment",
      });

      const session = yield* fetchRemoteSessionState({
        httpBaseUrl: "https://remote.example.com/",
        bearerToken: "bearer-token",
      }).pipe(provideRemoteHttp(fetch.fetchFn));
      expect(session).toMatchObject({
        authenticated: true,
        role: "client",
      });

      const token = yield* issueRemoteWebSocketToken({
        httpBaseUrl: "https://remote.example.com/",
        bearerToken: "bearer-token",
      }).pipe(provideRemoteHttp(fetch.fetchFn));
      expect(token).toMatchObject({
        token: "ws-token",
      });

      expectFetchCall(fetch.calls, 1, {
        url: "https://remote.example.com/.well-known/t3/environment",
        method: "GET",
      });
      expectFetchCall(fetch.calls, 2, {
        url: "https://remote.example.com/api/auth/session",
        method: "GET",
        headers: {
          authorization: "Bearer bearer-token",
        },
      });
      expectFetchCall(fetch.calls, 3, {
        url: "https://remote.example.com/api/auth/ws-token",
        method: "POST",
        headers: {
          authorization: "Bearer bearer-token",
        },
      });
    }),
  );

  it.effect("fails hung fetch requests on the configured timeout", () =>
    Effect.gen(function* () {
      const fetch = hangingFetch();

      const errorFiber = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: "http://remote.example.com/",
        timeoutMs: 25,
      }).pipe(provideRemoteHttp(fetch.fetchFn), Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(25));
      const error = yield* Fiber.join(errorFiber);

      expect(error).toBeInstanceOf(RemoteEnvironmentAuthTimeoutError);
      expect(error.message).toBe(
        "Remote auth endpoint http://remote.example.com/.well-known/t3/environment timed out after 25ms.",
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("mints a websocket url that targets the rpc route with a short-lived ws token", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(
          {
            token: "ws-token",
            expiresAt: "2026-05-01T12:05:00.000Z",
          },
          { status: 200 },
        ),
      );

      const url = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: "wss://remote.example.com/",
        httpBaseUrl: "https://remote.example.com/",
        bearerToken: "bearer-token",
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expect(url).toBe("wss://remote.example.com/ws?wsToken=ws-token");
    }),
  );
});
