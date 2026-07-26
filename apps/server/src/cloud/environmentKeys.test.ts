// @ts-nocheck
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "./environmentKeys.ts";

const makeServerSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-environment-keys-test-" })),
  );

const unusedSecretStoreOperation = () => Effect.die("unused secret-store operation");

it.layer(NodeServices.layer)("getOrCreateEnvironmentKeyPairFromSecretStore", (it) => {
  it.effect("persists one atomic keypair secret and reuses it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secretStore);
      const second = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secretStore);

      assert.deepEqual(second, first);
      assert.isTrue(Option.isSome(yield* secretStore.get("cloud-link-ed25519-key-pair")));
      assert.isTrue(Option.isNone(yield* secretStore.get("cloud-link-ed25519-private-key")));
      assert.isTrue(Option.isNone(yield* secretStore.get("cloud-link-ed25519-public-key")));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("migrates a legacy keypair into the atomic secret", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      yield* secretStore.set("cloud-link-ed25519-private-key", new TextEncoder().encode("private"));
      yield* secretStore.set("cloud-link-ed25519-public-key", new TextEncoder().encode("public"));

      assert.deepEqual(yield* getOrCreateEnvironmentKeyPairFromSecretStore(secretStore), {
        privateKey: "private",
        publicKey: "public",
      });
      assert.isTrue(Option.isSome(yield* secretStore.get("cloud-link-ed25519-key-pair")));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("reads independent legacy key secrets concurrently during startup migration", () =>
    Effect.gen(function* () {
      const privateReadStarted = yield* Deferred.make<void>();
      const publicReadStarted = yield* Deferred.make<void>();
      const privateKey = new TextEncoder().encode("private");
      const publicKey = new TextEncoder().encode("public");
      let persisted: Uint8Array | undefined;
      const secretStore = {
        get: (name) => {
          switch (name) {
            case "cloud-link-ed25519-key-pair":
              return Effect.succeed(Option.none());
            case "cloud-link-ed25519-private-key":
              return Deferred.succeed(privateReadStarted, void 0).pipe(
                Effect.andThen(Deferred.await(publicReadStarted)),
                Effect.as(Option.some(privateKey)),
              );
            case "cloud-link-ed25519-public-key":
              return Deferred.succeed(publicReadStarted, void 0).pipe(
                Effect.andThen(Deferred.await(privateReadStarted)),
                Effect.as(Option.some(publicKey)),
              );
            default:
              return Effect.die(`unexpected secret read: ${name}`);
          }
        },
        set: unusedSecretStoreOperation,
        create: (_name, value) =>
          Effect.sync(() => {
            persisted = value;
          }),
        getOrCreateRandom: unusedSecretStoreOperation,
        remove: unusedSecretStoreOperation,
        list: () => Effect.succeed([]),
      } satisfies ServerSecretStore.ServerSecretStore["Service"];

      assert.deepEqual(yield* getOrCreateEnvironmentKeyPairFromSecretStore(secretStore), {
        privateKey: "private",
        publicKey: "public",
      });
      assert.isTrue(persisted instanceof Uint8Array);
    }),
  );

  it.effect("propagates legacy secret read failures without persisting a replacement keypair", () =>
    Effect.gen(function* () {
      const readError = new ServerSecretStore.SecretStoreReadError({
        resource: "cloud-link-ed25519-public-key",
      });
      let createAttempted = false;
      const secretStore = {
        get: (name) => {
          switch (name) {
            case "cloud-link-ed25519-key-pair":
              return Effect.succeed(Option.none());
            case "cloud-link-ed25519-private-key":
              return Effect.succeed(Option.some(new TextEncoder().encode("private")));
            case "cloud-link-ed25519-public-key":
              return Effect.fail(readError);
            default:
              return Effect.die(`unexpected secret read: ${name}`);
          }
        },
        set: unusedSecretStoreOperation,
        create: () =>
          Effect.sync(() => {
            createAttempted = true;
          }),
        getOrCreateRandom: unusedSecretStoreOperation,
        remove: unusedSecretStoreOperation,
        list: () => Effect.succeed([]),
      } satisfies ServerSecretStore.ServerSecretStore["Service"];

      assert.equal(
        yield* Effect.flip(getOrCreateEnvironmentKeyPairFromSecretStore(secretStore)),
        readError,
      );
      assert.isFalse(createAttempted);
    }),
  );

  it.effect("uses the persisted keypair when a concurrent creator wins", () =>
    Effect.gen(function* () {
      const winner = new TextEncoder().encode(
        '{"privateKey":"winner-private","publicKey":"winner-public"}',
      );
      let createAttempted = false;
      const secretStore = {
        get: (name) =>
          Effect.sync(() =>
            name === "cloud-link-ed25519-key-pair" && createAttempted
              ? Option.some(winner)
              : Option.none(),
          ),
        set: unusedSecretStoreOperation,
        create: () =>
          Effect.sync(() => {
            createAttempted = true;
          }).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: "environment signing key pair",
                  cause: PlatformError.systemError({
                    _tag: "AlreadyExists",
                    module: "FileSystem",
                    method: "open",
                    pathOrDescriptor: "cloud-link-ed25519-key-pair.bin",
                  }),
                }),
              ),
            ),
          ),
        getOrCreateRandom: unusedSecretStoreOperation,
        remove: unusedSecretStoreOperation,
        list: () => Effect.succeed([]),
      } satisfies ServerSecretStore.ServerSecretStore["Service"];

      assert.deepEqual(yield* getOrCreateEnvironmentKeyPairFromSecretStore(secretStore), {
        privateKey: "winner-private",
        publicKey: "winner-public",
      });
    }),
  );
});
