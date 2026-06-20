import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CliTokenManager from "./CliTokenManager.ts";

const unusedSecretStoreOperation = () => Effect.die("unused secret-store operation");

function makeSecretStore(
  overrides: Partial<ServerSecretStore.ServerSecretStore["Service"]>,
): ServerSecretStore.ServerSecretStore["Service"] {
  return {
    get: unusedSecretStoreOperation,
    set: unusedSecretStoreOperation,
    create: unusedSecretStoreOperation,
    getOrCreateRandom: unusedSecretStoreOperation,
    remove: unusedSecretStoreOperation,
    ...overrides,
  };
}

function makeTokenManager(secretStore: ServerSecretStore.ServerSecretStore["Service"]) {
  return CliTokenManager.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unused HTTP client")),
        ),
      ),
    ),
  );
}

describe("CloudCliTokenManager", () => {
  it.effect("retains secret context and cause when credential removal fails", () => {
    const failure = new ServerSecretStore.SecretStoreRemoveError({
      secretName: "cloud-cli-oauth-token",
      secretPath: "/tmp/secrets/cloud-cli-oauth-token.bin",
      cause: PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "remove",
        pathOrDescriptor: "/tmp/secrets/cloud-cli-oauth-token.bin",
      }),
    });

    return Effect.gen(function* () {
      const tokens = yield* makeTokenManager(
        makeSecretStore({ remove: () => Effect.fail(failure) }),
      );
      const error = yield* Effect.flip(tokens.clear);

      expect(error).toMatchObject({
        _tag: "CloudCliCredentialRemovalError",
        secretName: "cloud-cli-oauth-token",
        cause: failure,
      });
      expect(error.message).toBe(
        "Could not remove the stored T3 Connect CLI credential cloud-cli-oauth-token.",
      );
    });
  });

  it.effect("classifies credential read failures without replacing the cause", () => {
    const failure = new ServerSecretStore.SecretStoreReadError({
      secretName: "cloud-cli-oauth-token",
      secretPath: "/tmp/secrets/cloud-cli-oauth-token.bin",
      cause: PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFile",
        pathOrDescriptor: "/tmp/secrets/cloud-cli-oauth-token.bin",
      }),
    });

    return Effect.gen(function* () {
      const tokens = yield* makeTokenManager(makeSecretStore({ get: () => Effect.fail(failure) }));
      const error = yield* Effect.flip(tokens.hasCredential);

      expect(error).toMatchObject({
        _tag: "CloudCliCredentialReadError",
        stage: "read-credential",
        secretName: "cloud-cli-oauth-token",
        cause: failure,
      });
      expect(error.message).toBe(
        "Could not inspect the stored T3 Connect CLI credential cloud-cli-oauth-token during read-credential.",
      );
    });
  });

  it.effect("classifies malformed persisted credentials as refresh decode failures", () =>
    Effect.gen(function* () {
      const tokens = yield* makeTokenManager(
        makeSecretStore({
          get: () =>
            Effect.succeed(Option.some(new TextEncoder().encode("not valid credential JSON"))),
        }),
      );
      const error = yield* Effect.flip(tokens.getExisting);

      expect(error).toMatchObject({
        _tag: "CloudCliCredentialRefreshError",
        stage: "decode-credential",
        secretName: "cloud-cli-oauth-token",
        cause: { _tag: "SchemaError" },
      });
      expect(error.message).toBe(
        "Could not refresh the T3 Connect CLI credential cloud-cli-oauth-token during decode-credential.",
      );
    }),
  );
});
