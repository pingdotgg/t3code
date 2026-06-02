import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState,
  issueRemoteWebSocketTicket,
  remoteHttpClientLayer,
  RemoteEnvironmentAuthInvalidJsonError,
  RemoteEnvironmentAuthTimeoutError,
  resolveRemoteWebSocketConnectionUrl,
} from "./remote.ts";

const isEnvironmentAuthInvalidError = Schema.is(EnvironmentAuthInvalidError);

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

const provideRemoteHttp = (fetchFn: typeof fetch) => Effect.provide(remoteHttpClientLayer(fetchFn));

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
            access_token: "bearer-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 3600,
            scope:
              "orchestration:read orchestration:operate terminal:operate review:write relay:read",
          },
          { status: 200 },
        ),
      );

      const result = yield* bootstrapRemoteBearerSession({
        httpBaseUrl: "https://remote.example.com/",
        credential: "pairing-token",
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expect(result).toMatchObject({
        token_type: "Bearer",
        access_token: "bearer-token",
        scope: "orchestration:read orchestration:operate terminal:operate review:write relay:read",
      });
      expectFetchCall(fetch.calls, 1, {
        url: "https://remote.example.com/oauth/token",
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=pairing-token&subject_token_type=urn%3At3%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token",
      });
    }),
  );

  it.effect("submits optional client display metadata during bearer token exchange", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(
          {
            access_token: "bearer-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 3600,
            scope:
              "orchestration:read orchestration:operate terminal:operate review:write relay:read",
          },
          { status: 200 },
        ),
      );

      yield* bootstrapRemoteBearerSession({
        httpBaseUrl: "https://remote.example.com/",
        credential: "pairing-token",
        clientMetadata: {
          label: "T3 Code Mobile",
          deviceType: "mobile",
          os: "iOS",
        },
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expectFetchCall(fetch.calls, 1, {
        url: "https://remote.example.com/oauth/token",
        method: "POST",
        body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=pairing-token&subject_token_type=urn%3At3%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token&client_label=T3+Code+Mobile&client_device_type=mobile&client_os=iOS",
      });
    }),
  );

  it.effect("allows a client to explicitly narrow a pairing grant", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(
          {
            access_token: "read-only-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "orchestration:read",
          },
          { status: 200 },
        ),
      );

      yield* bootstrapRemoteBearerSession({
        httpBaseUrl: "https://remote.example.com/",
        credential: "pairing-token",
        scopes: ["orchestration:read"],
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expectFetchCall(fetch.calls, 1, {
        url: "https://remote.example.com/oauth/token",
        method: "POST",
        body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=pairing-token&subject_token_type=urn%3At3%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token&scope=orchestration%3Aread",
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
              sessionMethods: ["browser-session-cookie", "bearer-access-token"],
              sessionCookieName: "t3_session",
            },
            scopes: [
              "orchestration:read",
              "orchestration:operate",
              "terminal:operate",
              "review:write",
              "relay:read",
            ],
            sessionMethod: "bearer-access-token",
            expiresAt: "2026-05-01T12:00:00.000Z",
          },
          { status: 200 },
        ),
        Response.json(
          {
            ticket: "ws-ticket",
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
        scopes: [
          "orchestration:read",
          "orchestration:operate",
          "terminal:operate",
          "review:write",
          "relay:read",
        ],
      });

      const token = yield* issueRemoteWebSocketTicket({
        httpBaseUrl: "https://remote.example.com/",
        bearerToken: "bearer-token",
      }).pipe(provideRemoteHttp(fetch.fetchFn));
      expect(token).toMatchObject({
        ticket: "ws-ticket",
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
        url: "https://remote.example.com/api/auth/websocket-ticket",
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

  it.effect("revives declared typed errors from remote auth failures", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "auth_invalid",
            reason: "missing_credential",
            traceId: "trace-auth-test",
          },
          { status: 401 },
        ),
      );

      const error = yield* issueRemoteWebSocketTicket({
        httpBaseUrl: "https://remote.example.com/",
        bearerToken: "expired-token",
      }).pipe(provideRemoteHttp(fetch.fetchFn), Effect.flip);

      expect(isEnvironmentAuthInvalidError(error)).toBe(true);
      if (isEnvironmentAuthInvalidError(error)) {
        expect(error.reason).toBe("missing_credential");
        expect(error.traceId).toBe("trace-auth-test");
      }
    }),
  );

  it.effect("classifies malformed successful remote auth responses as invalid responses", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(
          {
            access_token: "",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 3600,
            scope:
              "orchestration:read orchestration:operate terminal:operate review:write relay:read",
          },
          { status: 200 },
        ),
      );

      const error = yield* bootstrapRemoteBearerSession({
        httpBaseUrl: "https://remote.example.com/",
        credential: "pairing-token",
      }).pipe(provideRemoteHttp(fetch.fetchFn), Effect.flip);

      expect(error).toBeInstanceOf(RemoteEnvironmentAuthInvalidJsonError);
      expect(error.message).toBe(
        "Remote auth endpoint returned an invalid response from https://remote.example.com/oauth/token.",
      );
    }),
  );

  it.effect(
    "mints a websocket url that targets the rpc route with a short-lived websocket ticket",
    () =>
      Effect.gen(function* () {
        const fetch = recordedFetch(
          Response.json(
            {
              ticket: "ws-ticket",
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

        expect(url).toBe("wss://remote.example.com/ws?wsTicket=ws-ticket");
      }),
  );
});
