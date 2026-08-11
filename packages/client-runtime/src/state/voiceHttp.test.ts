import { describe, expect, it, vi } from "@effect/vitest";
import { EnvironmentId, EnvironmentVoiceRateLimitedError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError, remoteHttpClientLayer } from "../rpc/http.ts";
import {
  fetchVoiceCredentialStatus,
  mintVoiceClientSecret,
  updateVoiceCredential,
} from "./voiceHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-voice"),
  label: "Voice environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

const requestBody = (init: RequestInit): unknown => {
  const body =
    typeof init.body === "string"
      ? init.body
      : init.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : "";
  // This helper deliberately inspects the serialized HTTP test fixture.
  return JSON.parse(body);
};

describe("voice environment HTTP", () => {
  it.effect("uses the paired browser cookie path for credential status", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const fetchFn = ((request, init) => {
        calls.push([request, init ?? {}]);
        return Promise.resolve(Response.json({ configured: true, source: "stored" }));
      }) satisfies typeof fetch;

      const result = yield* fetchVoiceCredentialStatus({
        prepared: PREPARED,
        signer: Option.none(),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      expect(result).toEqual({ configured: true, source: "stored" });
      expect(calls).toHaveLength(1);
      expect(String(calls[0]?.[0])).toBe(
        "https://environment.example.test/api/voice/openai/credential",
      );
      expect(calls[0]?.[1].method).toBe("GET");
      expect(calls[0]?.[1].credentials).toBe("include");
    }),
  );

  it.effect("preserves bearer authorization while updating the server credential", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const fetchFn = ((request, init) => {
        calls.push([request, init ?? {}]);
        return Promise.resolve(Response.json({ configured: true, source: "stored" }));
      }) satisfies typeof fetch;
      const prepared: PreparedConnection = {
        ...PREPARED,
        httpAuthorization: { _tag: "Bearer", token: "environment-token" },
      };

      yield* updateVoiceCredential({
        prepared,
        mutation: { action: "set", apiKey: "sk-server" },
        signer: Option.none(),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1].method).toBe("POST");
      expect(new Headers(calls[0]?.[1].headers).get("authorization")).toBe(
        "Bearer environment-token",
      );
      expect(calls[0]?.[1].credentials).toBeUndefined();
      expect(requestBody(calls[0]?.[1] ?? {})).toEqual({
        action: "set",
        apiKey: "sk-server",
      });
    }),
  );

  it.effect("preserves DPoP request binding when minting a client secret", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const createProof = vi.fn(() => Effect.succeed("dpop-proof"));
      const signer = ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("thumbprint"),
        createProof,
      });
      const fetchFn = ((request, init) => {
        calls.push([request, init ?? {}]);
        return Promise.resolve(
          Response.json({
            clientSecret: "ek_client",
            expiresAt: 4_102_444_800,
            sessionId: "sess_client",
          }),
        );
      }) satisfies typeof fetch;
      const prepared: PreparedConnection = {
        ...PREPARED,
        httpAuthorization: { _tag: "Dpop", accessToken: "relay-token" },
      };

      yield* mintVoiceClientSecret({
        prepared,
        request: { voice: "cedar" },
        signer: Option.some(signer),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      const expectedUrl = "https://environment.example.test/api/voice/realtime/client-secret";
      expect(createProof).toHaveBeenCalledWith({
        method: "POST",
        url: expectedUrl,
        accessToken: "relay-token",
      });
      const headers = new Headers(calls[0]?.[1].headers);
      expect(headers.get("authorization")).toBe("DPoP relay-token");
      expect(headers.get("dpop")).toBe("dpop-proof");
      expect(requestBody(calls[0]?.[1] ?? {})).toEqual({ voice: "cedar" });
    }),
  );

  it.effect("preserves typed rate-limit failures from the environment", () =>
    Effect.gen(function* () {
      const fetchFn = (() =>
        Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentVoiceRateLimitedError",
              code: "rate_limited",
              reason: "local_concurrency",
              retryAfterSeconds: 2,
              traceId: "trace-voice",
            },
            { status: 429, headers: { "retry-after": "2" } },
          ),
        )) satisfies typeof fetch;

      const error = yield* Effect.flip(
        mintVoiceClientSecret({
          prepared: PREPARED,
          request: {},
          signer: Option.none(),
        }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn))),
      );

      expect(error).toBeInstanceOf(EnvironmentVoiceRateLimitedError);
      expect(error).toMatchObject({
        reason: "local_concurrency",
        retryAfterSeconds: 2,
        traceId: "trace-voice",
      });
    }),
  );

  it.effect("redacts transport causes that could retain the credential request body", () =>
    Effect.gen(function* () {
      const secret = "sk-client-secret-that-must-not-appear";
      const fetchFn = (() =>
        Promise.reject(new Error(`transport failed for ${secret}`))) satisfies typeof fetch;

      const error = yield* Effect.flip(
        updateVoiceCredential({
          prepared: PREPARED,
          mutation: { action: "set", apiKey: secret },
          signer: Option.none(),
        }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn))),
      );

      expect(error).toBeInstanceOf(RemoteEnvironmentAuthFetchError);
      expect(error).toMatchObject({
        message: "The voice environment request failed.",
        cause: "redacted",
      });
      expect(String(error)).not.toContain(secret);
    }),
  );
});
