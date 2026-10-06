import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import type { RelayLinkProofRequest } from "@t3tools/contracts/relay";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  consumeCloudReplayGuards,
  isSupportedLinkProviderKind,
  linkProofScopes,
  parseManagedEndpointLocalOrigin,
} from "./linkChecks.ts";

const storeFailure = (tag: "AlreadyExists" | "PermissionDenied") =>
  new ServerSecretStore.SecretStorePersistError({
    resource: "cloud replay guard",
    cause: PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: "cloud-replay-guard.bin",
    }),
  });

const unusedSecretStoreOperation = () => Effect.die("unused secret-store operation");

function makeSecretStore(
  create: ServerSecretStore.ServerSecretStore["Service"]["create"],
): ServerSecretStore.ServerSecretStore["Service"] {
  return {
    get: unusedSecretStoreOperation,
    set: unusedSecretStoreOperation,
    create,
    getOrCreateRandom: unusedSecretStoreOperation,
    remove: unusedSecretStoreOperation,
  };
}

describe("consumeCloudReplayGuards", () => {
  it.effect("reports already-created guards as replay conflicts", () =>
    Effect.gen(function* () {
      const consumed = yield* consumeCloudReplayGuards({
        secrets: makeSecretStore(() => Effect.fail(storeFailure("AlreadyExists"))),
        names: ["cloud-jti", "cloud-nonce"],
        value: new Uint8Array(),
      });

      expect(consumed).toBe(false);
    }),
  );

  it.effect("preserves replay-store availability failures", () =>
    Effect.gen(function* () {
      const failure = storeFailure("PermissionDenied");
      const error = yield* Effect.flip(
        consumeCloudReplayGuards({
          secrets: makeSecretStore(() => Effect.fail(failure)),
          names: ["cloud-jti", "cloud-nonce"],
          value: new Uint8Array(),
        }),
      );

      expect(error).toBe(failure);
    }),
  );
});

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
