import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import type { RelayLinkProofRequest } from "@t3tools/contracts/relay";
import { RELAY_LINK_PROOF_TYP, signRelayJwt, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  isSupportedLinkProviderKind,
  linkProofIssuedAt,
  linkProofScopes,
  parseManagedEndpointLocalOrigin,
} from "./linkChecks.ts";

describe("parseManagedEndpointLocalOrigin", () => {
  it.each([
    {
      input: "http://127.0.0.1:80",
      httpBaseUrl: "http://127.0.0.1",
      wsBaseUrl: "ws://127.0.0.1",
      port: 80,
    },
    {
      input: "https://127.0.0.1:443",
      httpBaseUrl: "https://127.0.0.1",
      wsBaseUrl: "wss://127.0.0.1",
      port: 443,
    },
  ])("accepts an explicit default port in $input", ({ input, httpBaseUrl, wsBaseUrl, port }) => {
    expect(parseManagedEndpointLocalOrigin(input)).toEqual({
      httpBaseUrl,
      wsBaseUrl,
      origin: { localHttpHost: "127.0.0.1", localHttpPort: port },
    });
  });

  it.each([
    "ftp://127.0.0.1:3773",
    "http://user:password@127.0.0.1:3773",
    "http://127.0.0.1:3773/api",
    "http://127.0.0.1:3773?mode=test",
    "http://127.0.0.1:3773#fragment",
  ])("rejects non-origin URL %s", (input) => {
    expect(() => parseManagedEndpointLocalOrigin(input)).toThrow("Invalid local origin");
  });
});

describe("link proof provider kinds", () => {
  const proofRequest = (
    providerKind: RelayLinkProofRequest["endpoint"]["providerKind"],
  ): RelayLinkProofRequest => ({
    challenge: "challenge",
    relayIssuer: "https://relay.example.test",
    endpoint: {
      httpBaseUrl: "http://127.0.0.1:7331",
      wsBaseUrl: "ws://127.0.0.1:7331",
      providerKind,
    },
    origin: { localHttpHost: "127.0.0.1", localHttpPort: 7331 },
  });

  it("accepts managed and manual endpoints but not t3_relay", () => {
    expect(isSupportedLinkProviderKind(proofRequest("cloudflare_tunnel"))).toBe(true);
    expect(isSupportedLinkProviderKind(proofRequest("manual"))).toBe(true);
    expect(isSupportedLinkProviderKind(proofRequest("t3_relay"))).toBe(false);
  });

  it("only claims the managed-tunnel scope for tunnel links", () => {
    expect(linkProofScopes(proofRequest("cloudflare_tunnel"))).toEqual([
      "agent_activity_notifications",
      "managed_tunnels",
    ]);
    expect(linkProofScopes(proofRequest("manual"))).toEqual(["agent_activity_notifications"]);
  });
});

describe("linkProofIssuedAt", () => {
  const relayIssuer = "https://relay.example.test";
  const relayKeys = NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const environmentKeys = NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const relayNow = 1_800_000_000;
  const hostNow = relayNow + 10 * 60;

  const relayChallenge = signRelayJwt({
    privateKey: relayKeys.privateKey,
    typ: "t3-link-challenge+jwt",
    payload: { iss: relayIssuer, aud: relayIssuer, iat: relayNow, exp: relayNow + 300 },
  });

  const verifyAtRelay = (iat: number) =>
    signRelayJwt({
      privateKey: environmentKeys.privateKey,
      typ: RELAY_LINK_PROOF_TYP,
      payload: { iss: "t3-env:env-1", aud: relayIssuer, iat, exp: iat + 300 },
    }).pipe(
      Effect.flatMap((token) =>
        verifyRelayJwt({
          publicKey: environmentKeys.publicKey,
          token,
          typ: RELAY_LINK_PROOF_TYP,
          issuer: "t3-env:env-1",
          audience: relayIssuer,
          nowEpochSeconds: relayNow,
        }),
      ),
      Effect.result,
    );

  it.effect("dates the proof on the relay's clock when the host clock runs fast", () =>
    Effect.gen(function* () {
      const challenge = yield* relayChallenge;
      const iat = linkProofIssuedAt({ challenge, nowSeconds: hostNow });

      expect(iat).toBe(relayNow);
      expect(Result.isSuccess(yield* verifyAtRelay(iat))).toBe(true);
      // The host clock alone puts `iat` in the relay's future, which it rejects.
      expect(Result.isFailure(yield* verifyAtRelay(hostNow))).toBe(true);
    }),
  );

  it.effect("falls back to the host clock when the challenge has no usable iat", () =>
    Effect.gen(function* () {
      const withoutIat = yield* signRelayJwt({
        privateKey: relayKeys.privateKey,
        typ: "t3-link-challenge+jwt",
        payload: { iss: relayIssuer },
      });

      expect(linkProofIssuedAt({ challenge: "not-a-jwt", nowSeconds: hostNow })).toBe(hostNow);
      expect(linkProofIssuedAt({ challenge: withoutIat, nowSeconds: hostNow })).toBe(hostNow);
    }),
  );
});
