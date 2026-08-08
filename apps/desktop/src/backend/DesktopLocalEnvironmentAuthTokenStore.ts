import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import ElectronStore from "electron-store";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

interface TokenDocument {
  readonly encryptedToken?: string;
}

const TokenStoreOperation = Schema.Literals(["read", "write", "clear"]);

export class DesktopLocalEnvironmentAuthTokenStoreError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthTokenStoreError>()(
  "DesktopLocalEnvironmentAuthTokenStoreError",
  {
    operation: TokenStoreOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop local authorization token store failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopLocalEnvironmentAuthTokenStore extends Context.Service<
  DesktopLocalEnvironmentAuthTokenStore,
  {
    readonly get: Effect.Effect<Option.Option<string>, DesktopLocalEnvironmentAuthTokenStoreError>;
    readonly set: (
      token: string,
    ) => Effect.Effect<boolean, DesktopLocalEnvironmentAuthTokenStoreError>;
    readonly clear: Effect.Effect<void, DesktopLocalEnvironmentAuthTokenStoreError>;
  }
>()("@t3tools/desktop/backend/DesktopLocalEnvironmentAuthTokenStore") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const tokenPath = path.join(environment.stateDir, "desktop-local-auth.json");

  const openStore = Effect.try(
    () =>
      new ElectronStore<TokenDocument>({
        cwd: environment.stateDir,
        name: "desktop-local-auth",
        clearInvalidConfig: true,
        schema: {
          encryptedToken: { type: "string" },
        },
      }),
  );

  const secureStorageAvailable = Effect.gen(function* () {
    if (!(yield* safeStorage.isEncryptionAvailable)) {
      return false;
    }
    return !Option.contains(yield* safeStorage.selectedStorageBackend, "basic_text");
  });

  const get = Effect.fn("desktop.localEnvironmentAuthTokenStore.get")(function* () {
    if (!(yield* secureStorageAvailable)) {
      return Option.none<string>();
    }
    const store = yield* openStore;
    const encoded = yield* Effect.try(() => store.get("encryptedToken"));
    if (encoded === undefined) {
      return Option.none<string>();
    }
    const encryptedToken = yield* Effect.fromResult(Encoding.decodeBase64(encoded));
    return Option.some(yield* safeStorage.decryptString(encryptedToken));
  });

  const set = Effect.fn("desktop.localEnvironmentAuthTokenStore.set")(function* (token: string) {
    if (!(yield* secureStorageAvailable)) {
      return false;
    }
    const encryptedToken = Encoding.encodeBase64(yield* safeStorage.encryptString(token));
    const store = yield* openStore;
    yield* Effect.try(() => store.set("encryptedToken", encryptedToken));
    return true;
  });

  const clear = Effect.fn("desktop.localEnvironmentAuthTokenStore.clear")(function* () {
    const store = yield* openStore;
    yield* Effect.try(() => store.delete("encryptedToken"));
  });

  return DesktopLocalEnvironmentAuthTokenStore.of({
    get: get().pipe(
      Effect.mapError(
        (cause) =>
          new DesktopLocalEnvironmentAuthTokenStoreError({
            operation: "read",
            path: tokenPath,
            cause,
          }),
      ),
    ),
    set: (token) =>
      set(token).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopLocalEnvironmentAuthTokenStoreError({
              operation: "write",
              path: tokenPath,
              cause,
            }),
        ),
      ),
    clear: clear().pipe(
      Effect.mapError(
        (cause) =>
          new DesktopLocalEnvironmentAuthTokenStoreError({
            operation: "clear",
            path: tokenPath,
            cause,
          }),
      ),
    ),
  });
});

export const layer = Layer.effect(DesktopLocalEnvironmentAuthTokenStore, make);
