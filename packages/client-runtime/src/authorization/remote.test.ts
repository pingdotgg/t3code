import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import { hashTelemetryId } from "@t3tools/shared/telemetryId";
import {
  bootstrapRemoteBearerSession,
  exchangeRemoteDpopAccessToken,
  issueRemoteDpopWebSocketTicket,
  issueRemoteWebSocketTicket,
  resolveRemoteDpopWebSocketConnectionUrl,
  resolveRemoteWebSocketConnectionUrl,
} from "./remote.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RpcHttp from "../rpc/http.ts";

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

const provideRemoteHttp = (fetchFn: typeof fetch) =>
  Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn));

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

describe("remote environment authorization", () => {
  it.effect("exchanges managed credentials and admits websocket requests with DPoP", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json({
          access_token: "dpop-access-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "DPoP",
          expires_in: 3600,
          scope: "orchestration:read orchestration:operate terminal:operate review:write",
        }),
        Response.json({
          ticket: "ws-ticket",
          expiresAt: "2026-05-01T12:05:00.000Z",
        }),
      );

      const token = yield* exchangeRemoteDpopAccessToken({
        httpBaseUrl: "https://remote.example.com/",
        credential: "one-time-credential",
        dpopProof: "token-proof",
        clientMetadata: {
          label: "T3 Code Mobile",
          deviceType: "mobile",
          os: "iOS",
        },
      }).pipe(provideRemoteHttp(fetch.fetchFn));
      yield* issueRemoteDpopWebSocketTicket({
        httpBaseUrl: "https://remote.example.com/",
        accessToken: token.access_token,
        dpopProof: "resource-proof",
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expectFetchCall(fetch.calls, 1, {
        url: "https://remote.example.com/oauth/token",
        method: "POST",
        headers: { dpop: "token-proof", "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=one-time-credential&subject_token_type=urn%3At3%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token&client_label=T3+Code+Mobile&client_device_type=mobile&client_os=iOS",
      });
      expectFetchCall(fetch.calls, 2, {
        url: "https://remote.example.com/api/auth/websocket-ticket",
        method: "POST",
        headers: {
          authorization: "DPoP dpop-access-token",
          dpop: "resource-proof",
        },
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

  it.effect("mints a websocket url that targets the rpc route with a short-lived ticket", () =>
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
        clientMetadata: {
          surface: "mobile",
          appVersion: "1.2.3",
          deviceType: "mobile",
          os: "Android",
          osMajorVersion: 15,
          deviceModel: "Pixel 9",
        },
        connectionMethod: "relay",
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expect(url).toBe(
        "wss://remote.example.com/ws?wsTicket=ws-ticket&clientSurface=mobile&clientAppVersion=1.2.3&clientDeviceType=phone&clientOs=Android&clientOsMajorVersion=15&clientDeviceModel=Pixel+9&connectionMethod=relay",
      );
    }),
  );

  it.effect("binds a DPoP client's rpc ticket to its key and proves the upgrade", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json({ ticket: "ws-ticket", expiresAt: "2026-05-01T12:05:00.000Z" }),
      );
      const proofs: Array<{ method: string; url: string; accessToken: string }> = [];

      const url = yield* resolveRemoteDpopWebSocketConnectionUrl({
        wsBaseUrl: "wss://remote.example.com/",
        httpBaseUrl: "https://remote.example.com/",
        accessToken: "dpop-access-token",
        createProof: (input) => {
          proofs.push(input);
          return Effect.succeed(`proof-${proofs.length}`);
        },
        connectionMethod: "relay",
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expectFetchCall(fetch.calls, 1, {
        url: "https://remote.example.com/api/auth/websocket-ticket/rpc",
        method: "POST",
        headers: { authorization: "DPoP dpop-access-token", dpop: "proof-1" },
      });
      expect(proofs).toEqual([
        {
          method: "POST",
          url: "https://remote.example.com/api/auth/websocket-ticket/rpc",
          accessToken: "dpop-access-token",
        },
        { method: "GET", url: "https://remote.example.com/ws", accessToken: "ws-ticket" },
      ]);
      expect(url).toBe(
        "wss://remote.example.com/ws?wsTicket=ws-ticket&dpop=proof-2&connectionMethod=relay",
      );
    }),
  );

  it.effect("requests the audience route even without a fallback proof", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json({ ticket: "media-ticket", expiresAt: "2026-05-01T12:05:00.000Z" }),
      );
      yield* issueRemoteDpopWebSocketTicket({
        httpBaseUrl: "https://remote.example.com/",
        accessToken: "dpop-access-token",
        dpopProof: "media-proof",
        use: "media",
      }).pipe(provideRemoteHttp(fetch.fetchFn));
      expectFetchCall(fetch.calls, 1, {
        url: "https://remote.example.com/api/auth/websocket-ticket/media",
        method: "POST",
        headers: { dpop: "media-proof" },
      });
    }),
  );

  it.effect("falls back to the bare ticket path on a server without the audience route", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json({ message: "Not Found" }, { status: 404 }),
        Response.json({ ticket: "old-ticket", expiresAt: "2026-05-01T12:05:00.000Z" }),
      );
      const proofs: Array<{ method: string; url: string; accessToken: string }> = [];

      const url = yield* resolveRemoteDpopWebSocketConnectionUrl({
        wsBaseUrl: "wss://remote.example.com/",
        httpBaseUrl: "https://remote.example.com/",
        accessToken: "dpop-access-token",
        createProof: (input) => {
          proofs.push(input);
          return Effect.succeed(`proof-${proofs.length}`);
        },
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expect(fetch.calls.map(([target]) => String(target))).toEqual([
        "https://remote.example.com/api/auth/websocket-ticket/rpc",
        "https://remote.example.com/api/auth/websocket-ticket",
      ]);
      expect(proofs).toEqual([
        {
          method: "POST",
          url: "https://remote.example.com/api/auth/websocket-ticket/rpc",
          accessToken: "dpop-access-token",
        },
        {
          method: "POST",
          url: "https://remote.example.com/api/auth/websocket-ticket",
          accessToken: "dpop-access-token",
        },
        { method: "GET", url: "https://remote.example.com/ws", accessToken: "old-ticket" },
      ]);
      expectFetchCall(fetch.calls, 2, {
        url: "https://remote.example.com/api/auth/websocket-ticket",
        method: "POST",
        headers: { dpop: "proof-2" },
      });
      expect(new URL(url).searchParams.get("wsTicket")).toBe("old-ticket");
      expect(new URL(url).searchParams.get("dpop")).toBe("proof-3");
    }),
  );

  it.effect("names the signed-in Connect account and this device by hash only", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json({ ticket: "ws-ticket", expiresAt: "2026-05-01T12:05:00.000Z" }),
      );

      const url = new URL(
        yield* resolveRemoteWebSocketConnectionUrl({
          wsBaseUrl: "wss://remote.example.com/",
          httpBaseUrl: "https://remote.example.com/",
          bearerToken: "bearer-token",
        }).pipe(
          provideRemoteHttp(fetch.fetchFn),
          Effect.provideService(
            ClientCapabilities.CloudSession,
            ClientCapabilities.CloudSession.of({
              identity: Effect.succeedSome({ accountId: "user_connect" }),
              clerkToken: Effect.succeed("clerk-token"),
            }),
          ),
          Effect.provideService(ClientCapabilities.AnalyticsDevice, {
            id: Effect.succeedSome("device-1"),
          }),
        ),
      );

      expect(url.searchParams.get("clientOwner")).toBe(hashTelemetryId("user_connect"));
      expect(url.searchParams.get("clientDevice")).toBe(hashTelemetryId("device-1"));
      expect(url.toString()).not.toContain("user_connect");
      expect(url.toString()).not.toContain("device-1");
    }),
  );

  describe("hedged requests", () => {
    const descriptorJson = {
      environmentId: "environment-remote",
      label: "Remote environment",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    };

    const scriptedFetch = (
      ...behaviors: ReadonlyArray<"hang" | "descriptor" | "reject" | "reject-later">
    ) => {
      const signals: Array<AbortSignal | undefined> = [];
      const rejectLater: Array<() => void> = [];
      const fetchFn = ((_input, init) => {
        signals.push(init?.signal ?? undefined);
        const behavior = behaviors[signals.length - 1];
        if (behavior === "descriptor") return Promise.resolve(Response.json(descriptorJson));
        if (behavior === "reject") return Promise.reject(new TypeError("Network request failed"));
        if (behavior === "reject-later") {
          return new Promise<Response>((_, reject) => {
            rejectLater.push(() => reject(new TypeError("Network request failed")));
          });
        }
        if (behavior === "hang") return new Promise<Response>(() => undefined);
        return Promise.reject(new Error("Unexpected fetch call"));
      }) satisfies typeof fetch;
      return { fetchFn, signals, rejectLater };
    };

    const forkDescriptor = (fetchFn: typeof fetch) =>
      fetchRemoteEnvironmentDescriptor({ httpBaseUrl: "http://remote.example.com/" }).pipe(
        provideRemoteHttp(fetchFn),
        Effect.result,
        Effect.forkScoped,
      );

    it.effect("answers from a second attempt when the first hangs past the hedge delay", () =>
      Effect.gen(function* () {
        const fetch = scriptedFetch("hang", "descriptor");
        const fiber = yield* forkDescriptor(fetch.fetchFn);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(1_999));
        expect(fetch.signals).toHaveLength(1);
        expect(fiber.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust(Duration.millis(1));
        const result = yield* Fiber.join(fiber);

        expect(result).toMatchObject({ success: { environmentId: "environment-remote" } });
        expect(fetch.signals).toHaveLength(2);
        expect(fetch.signals[0]?.aborted).toBe(true);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("keeps the overall timeout when both attempts hang", () =>
      Effect.gen(function* () {
        const fetch = scriptedFetch("hang", "hang");
        const fiber = yield* forkDescriptor(fetch.fetchFn);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(10));
        const result = yield* Fiber.join(fiber);

        expect(result).toMatchObject({
          failure: {
            _tag: "RemoteEnvironmentAuthTimeoutError",
            message:
              "Remote environment endpoint http://remote.example.com/.well-known/t3/environment timed out after 10000ms.",
          },
        });
        expect(fetch.signals).toHaveLength(2);
        expect(fetch.signals.every((signal) => signal?.aborted)).toBe(true);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("fails with the first attempt's error once it settles after the delay", () =>
      Effect.gen(function* () {
        const fetch = scriptedFetch("reject-later", "hang");
        const fiber = yield* forkDescriptor(fetch.fetchFn);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(2_500));
        expect(fetch.signals).toHaveLength(2);
        fetch.rejectLater[0]?.();
        const result = yield* Fiber.join(fiber);

        expect(result).toMatchObject({ failure: { _tag: "RemoteEnvironmentAuthFetchError" } });
        expect(fetch.signals[1]?.aborted).toBe(true);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
});
