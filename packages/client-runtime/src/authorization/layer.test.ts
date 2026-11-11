import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as RpcHttp from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "./service.ts";
import { BearerConnectionCredential, BearerConnectionProfile } from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import * as ConnectionProfileStore from "../connection/profileStore.ts";
import * as ConnectionResolver from "../connection/resolver.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
};
const DESCRIPTOR = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote environment",
  platform: {
    os: "linux",
    arch: "x64",
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};

type RecordedResponse = Response | ((init: RequestInit) => Response);

function recordedFetch(responses: ReadonlyArray<RecordedResponse>) {
  const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    return response === undefined
      ? Promise.reject(new Error(`Unexpected fetch call to ${String(input)}`))
      : Promise.resolve(typeof response === "function" ? response(init ?? {}) : response);
  }) satisfies typeof fetch;
  return { calls, fetchFn };
}

const websocketTicket = (ticket: string) =>
  Response.json({
    ticket,
    expiresAt: "2026-06-06T01:00:00.000Z",
  });

const makeHarness = (input: { readonly responses: ReadonlyArray<RecordedResponse> }) =>
  Effect.sync(() => {
    const fetch = recordedFetch(input.responses);
    const layer = RemoteEnvironmentAuthorization.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          RpcHttp.layerRemoteHttpClient(fetch.fetchFn),
          Layer.succeed(
            ClientCapabilities.ClientPresentation,
            ClientCapabilities.ClientPresentation.of({
              metadata: {
                label: "T3 Code Test",
                deviceType: "mobile",
                os: "test",
              },
            }),
          ),
        ),
      ),
    );
    return { layer, fetch };
  });

const prepareDirectBearer = Effect.fn("TestRemoteAuthorization.prepareDirectBearer")(function* (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  times: number,
) {
  const target = new BearerConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: DESCRIPTOR.label,
    connectionId: "direct-1",
  });
  const entry = {
    target,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: target.connectionId,
        environmentId: ENVIRONMENT_ID,
        label: target.label,
        httpBaseUrl: ENDPOINT.httpBaseUrl,
        wsBaseUrl: ENDPOINT.wsBaseUrl,
      }),
    ),
    enabled: true,
  };
  const unused = () => Effect.die("unused");
  const layer = ConnectionResolver.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness.layer,
        Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, {
          get: unused,
          put: unused,
          remove: unused,
        }),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, {
          get: () => Effect.succeedSome(new BearerConnectionCredential({ token: "bearer-token" })),
          put: unused,
          remove: unused,
        }),
        Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, {
          bearerToken: Effect.succeedNone,
        }),
        Layer.succeed(ClientCapabilities.SshEnvironmentGateway, {
          provision: unused,
          prepare: unused,
          disconnect: unused,
        }),
      ),
    ),
  );
  const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layer));
  return yield* Effect.forEach(Array.from({ length: times }), () =>
    resolver.prepare(entry).pipe(Effect.result),
  );
});

describe("RemoteEnvironmentAuthorization", () => {
  it.effect("prepares a cold direct bearer connection with one descriptor request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json({
            ...DESCRIPTOR,
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          }),
          websocketTicket("cold-ticket"),
        ],
      });

      const [prepared] = yield* prepareDirectBearer(harness, 1);

      expect(prepared).toMatchObject({
        _tag: "Success",
        success: { socketUrl: expect.stringContaining("wsTicket=cold-ticket") },
      });
      expect(harness.fetch.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        "/.well-known/t3/environment",
        "/api/auth/websocket-ticket/rpc",
      ]);
      // The server prefers a session cookie over Authorization, and iOS fetch sends the
      // shared cookie jar unless told not to, so a stale cookie would override the token.
      expect(harness.fetch.calls[1]?.[1]).toMatchObject({
        credentials: "omit",
        headers: expect.objectContaining({ authorization: "Bearer bearer-token" }),
      });
    }),
  );

  it.effect("reuses a matching descriptor a check just read, once, while fresh, over HTTPS", () =>
    Effect.gen(function* () {
      const descriptor = {
        ...DESCRIPTOR,
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      } as ExecutionEnvironmentDescriptor;
      const harness = yield* makeHarness({
        responses: [
          websocketTicket("reused"),
          ...Array.from({ length: 5 }, () => [
            Response.json(descriptor),
            websocketTicket("fresh"),
          ]).flat(),
        ],
      });

      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorizeAt = (httpBaseUrl: string) =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl,
            wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
            bearerToken: "bearer-token",
            connectionMethod: "direct",
          });
        const authorize = authorizeAt(ENDPOINT.httpBaseUrl);
        const remember = (value: Option.Option<ExecutionEnvironmentDescriptor>) =>
          remote.rememberCheckedDescriptor(ENDPOINT.httpBaseUrl, value);

        yield* remember(Option.some(descriptor));
        yield* authorize;
        // Used once.
        yield* authorize;
        // Stale.
        yield* remember(Option.some(descriptor));
        yield* TestClock.adjust("6 seconds");
        yield* authorize;
        // A mismatch reads again, so a host back on the right environment is not blocked.
        yield* remember(Option.some({ ...descriptor, environmentId: "other" as never }));
        yield* authorize;
        // A failed check drops an older match.
        yield* remember(Option.some(descriptor));
        yield* remember(Option.none());
        yield* authorize;
        // After a network change, a plain LAN address can belong to another machine.
        yield* remote.rememberCheckedDescriptor("http://192.168.1.2:3773", Option.some(descriptor));
        yield* authorizeAt("http://192.168.1.2:3773");
      }).pipe(Effect.provide(harness.layer));

      expect(harness.fetch.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        "/api/auth/websocket-ticket/rpc",
        ...Array.from({ length: 5 }, () => [
          "/.well-known/t3/environment",
          "/api/auth/websocket-ticket/rpc",
        ]).flat(),
      ]);
    }),
  );

  it.effect("blocks a warm direct bearer prepare when the environment changes identity", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json({
            ...DESCRIPTOR,
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          }),
          websocketTicket("first-ticket"),
          Response.json({
            ...DESCRIPTOR,
            environmentId: "another-environment",
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          }),
        ],
      });

      const [first, second] = yield* prepareDirectBearer(harness, 2);

      expect(first?._tag).toBe("Success");
      expect(second).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionBlockedError", reason: "configuration" },
      });
      expect(
        harness.fetch.calls.filter(([url]) =>
          String(url).endsWith("/api/auth/websocket-ticket/rpc"),
        ),
      ).toHaveLength(1);
    }),
  );
  it.effect("validates a fresh bearer descriptor while issuing fresh websocket tickets", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          websocketTicket("first-ticket"),
          Response.json(DESCRIPTOR),
          websocketTicket("second-ticket"),
        ],
      });

      const [first, second] = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = () =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            wsBaseUrl: ENDPOINT.wsBaseUrl,
            bearerToken: "bearer-token",
            connectionMethod: "direct",
          });
        return [yield* authorize(), yield* authorize()] as const;
      }).pipe(Effect.provide(harness.layer));

      expect(first.socketUrl).toContain("wsTicket=first-ticket");
      expect(second.socketUrl).toContain("wsTicket=second-ticket");
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/.well-known/t3/environment")),
      ).toHaveLength(2);
      expect(
        harness.fetch.calls.filter(([url]) =>
          String(url).endsWith("/api/auth/websocket-ticket/rpc"),
        ),
      ).toHaveLength(2);
    }),
  );
});
