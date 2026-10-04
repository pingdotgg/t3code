import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { decodeCredential, encodeCredential, pair } from "./credential.ts";

function pairingFetch(tokenRequests: Array<URLSearchParams>, protocolVersion?: number) {
  return ((input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/.well-known/t3/environment")) {
      return Promise.resolve(
        Response.json({
          environmentId: "environment-paired",
          label: "Paired environment",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: protocolVersion ?? ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: { repositoryIdentity: true },
        }),
      );
    }
    if (url.endsWith("/oauth/token")) {
      const body = init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : "";
      const request = new URLSearchParams(body);
      tokenRequests.push(request);
      return Promise.resolve(
        Response.json({
          access_token: "secret-bearer-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: request.get("scope") ?? "orchestration:read",
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;
}

describe("pair", () => {
  it.effect("asks for read and operate scopes only and keeps the token redacted", () =>
    Effect.gen(function* () {
      const tokenRequests: Array<URLSearchParams> = [];
      const credential = yield* pair({
        host: "remote.example.test",
        pairingCode: "pairing-token",
        label: "Nightly triage",
      }).pipe(Effect.provide(remoteHttpClientLayer(pairingFetch(tokenRequests))));

      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0]?.get("scope")).toBe("orchestration:read orchestration:operate");
      expect(tokenRequests[0]?.get("client_label")).toBe("Nightly triage");
      expect(credential.environmentId).toBe("environment-paired");
      expect(credential.httpBaseUrl).toBe("https://remote.example.test/");
      expect(credential.wsBaseUrl).toBe("wss://remote.example.test/");
      expect(Redacted.value(credential.token)).toBe("secret-bearer-token");
      expect(String(credential)).not.toContain("secret-bearer-token");

      const stored = yield* encodeCredential(credential);
      const restored = yield* decodeCredential(stored);
      expect(Redacted.value(restored.token)).toBe("secret-bearer-token");
      expect(restored.environmentId).toBe(credential.environmentId);
    }),
  );

  it.effect("requests exactly the scopes the caller names", () =>
    Effect.gen(function* () {
      const tokenRequests: Array<URLSearchParams> = [];
      yield* pair({
        host: "remote.example.test",
        pairingCode: "pairing-token",
        scopes: ["orchestration:read"],
      }).pipe(Effect.provide(remoteHttpClientLayer(pairingFetch(tokenRequests))));

      expect(tokenRequests[0]?.get("scope")).toBe("orchestration:read");
    }),
  );

  it.effect("refuses a server that is newer than this client", () =>
    Effect.gen(function* () {
      const tokenRequests: Array<URLSearchParams> = [];
      const error = yield* pair({ host: "remote.example.test", pairingCode: "pairing-token" }).pipe(
        Effect.provide(
          remoteHttpClientLayer(pairingFetch(tokenRequests, ORCHESTRATION_PROTOCOL_VERSION + 1)),
        ),
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "unsupported" });
      expect(tokenRequests).toHaveLength(0);
    }),
  );
});
