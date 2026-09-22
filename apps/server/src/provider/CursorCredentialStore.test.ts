import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { makeCursorCredentialStore } from "./CursorCredentialStore.ts";

const makeSecrets = () => {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    secrets: ServerSecretStore.of({
      get: (key) => Effect.sync(() => Option.fromUndefinedOr(data.get(key))),
      set: (key, bytes) =>
        Effect.sync(() => {
          data.set(key, bytes);
        }),
      remove: (key) =>
        Effect.sync(() => {
          data.delete(key);
        }),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
    }),
  };
};

const legacyCredentials = {
  version: 1 as const,
  backendUrl: "https://api.cursor.com",
  apiKey: "test-only-legacy-key",
  createdAtMs: 100,
};
// The SDK's FileCredentialStore writes pretty-printed JSON.
const legacyFileText = `{
  "version": 1,
  "backendUrl": "https://api.cursor.com",
  "apiKey": "test-only-legacy-key",
  "createdAtMs": 100
}`;

it.effect.each([
  {
    name: "imports a legacy sign-in",
    legacy: legacyFileText,
    stored: undefined,
    expected: "test-only-legacy-key",
  },
  {
    name: "keeps a newer stored sign-in",
    legacy: legacyFileText,
    stored: "test-only-current-key",
    expected: "test-only-current-key",
  },
  {
    name: "discards a damaged legacy file",
    legacy: "damaged",
    stored: undefined,
    expected: undefined,
  },
])("$name and deletes the legacy file", ({ legacy, stored, expected }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const legacyFile = path.join(yield* fileSystem.makeTempDirectoryScoped(), "cursor.json");
    yield* fileSystem.writeFileString(legacyFile, legacy);
    const { secrets } = makeSecrets();
    const open = makeCursorCredentialStore(ProviderInstanceId.make("personal"), legacyFile).pipe(
      Effect.provideService(ServerSecretStore, secrets),
    );
    if (stored !== undefined) {
      const current = yield* makeCursorCredentialStore(ProviderInstanceId.make("personal")).pipe(
        Effect.provideService(ServerSecretStore, secrets),
      );
      yield* Effect.tryPromise(() => current.store.save({ ...legacyCredentials, apiKey: stored }));
    }
    const migrated = yield* open;
    assert.strictEqual((yield* Effect.tryPromise(() => migrated.store.load()))?.apiKey, expected);
    assert.isFalse(yield* fileSystem.exists(legacyFile));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "restores SDK credentials in a new controller and keeps another account when signing out",
  () =>
    Effect.gen(function* () {
      const data = new Map<string, Uint8Array>();
      const secrets = ServerSecretStore.of({
        get: (key) => Effect.sync(() => Option.fromUndefinedOr(data.get(key))),
        set: (key, bytes) =>
          Effect.sync(() => {
            data.set(key, bytes);
          }),
        remove: (key) =>
          Effect.sync(() => {
            data.delete(key);
          }),
        create: () => Effect.die("unused"),
        getOrCreateRandom: () => Effect.die("unused"),
      });
      const makeStore = (id: string) =>
        makeCursorCredentialStore(ProviderInstanceId.make(id)).pipe(
          Effect.provideService(ServerSecretStore, secrets),
        );
      const personal = yield* makeStore("personal");
      const work = yield* makeStore("work");
      const credentials = {
        version: 1 as const,
        backendUrl: "https://api.cursor.com",
        apiKey: "test-only-key",
        createdAtMs: 100,
        apiKeyExpiresAtMs: 1000,
        email: "test@example.com",
      };
      yield* Effect.tryPromise(() => personal.store.save(credentials));
      yield* Effect.tryPromise(() =>
        work.store.save({ ...credentials, apiKey: "test-only-work-key" }),
      );
      const restored = yield* makeStore("personal");
      assert.deepEqual(yield* Effect.tryPromise(() => restored.store.load()), credentials);
      data.set(personal.binding.key, new TextEncoder().encode("damaged credential"));
      assert.isUndefined(yield* Effect.tryPromise(() => restored.store.load()));
      yield* Effect.tryPromise(() => restored.store.save(credentials));
      yield* Effect.tryPromise(() => restored.store.clear());
      assert.isUndefined(yield* Effect.tryPromise(() => personal.store.load()));
      assert.strictEqual(
        (yield* Effect.tryPromise(() => work.store.load()))?.apiKey,
        "test-only-work-key",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
