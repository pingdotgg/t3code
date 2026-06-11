import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

interface CloudAuthTokenDocument {
  readonly version: number;
  readonly encryptedClientJwt: string;
}

const CloudAuthTokenDocumentSchema = Schema.Struct({
  version: Schema.Number,
  encryptedClientJwt: Schema.String,
});

const CloudAuthTokenDocumentJson = fromLenientJson(CloudAuthTokenDocumentSchema);
const decodeCloudAuthTokenDocumentJson = Schema.decodeEffect(CloudAuthTokenDocumentJson);
const encodeCloudAuthTokenDocumentJson = Schema.encodeEffect(CloudAuthTokenDocumentJson);

export class DesktopCloudAuthTokenStoreWriteError extends Data.TaggedError(
  "DesktopCloudAuthTokenStoreWriteError",
)<{
  readonly cause: PlatformError.PlatformError | Schema.SchemaError;
}> {
  override get message() {
    return `Failed to write desktop cloud auth token: ${this.cause.message}`;
  }
}

export class DesktopCloudAuthTokenStoreDecodeError extends Data.TaggedError(
  "DesktopCloudAuthTokenStoreDecodeError",
)<{
  readonly cause: Encoding.EncodingError;
}> {
  override get message() {
    return "Failed to decode desktop cloud auth token.";
  }
}

export interface DesktopCloudAuthTokenStoreShape {
  readonly get: Effect.Effect<
    Option.Option<string>,
    | DesktopCloudAuthTokenStoreDecodeError
    | ElectronSafeStorage.ElectronSafeStorageAvailabilityError
    | ElectronSafeStorage.ElectronSafeStorageDecryptError
  >;
  readonly set: (
    token: string,
  ) => Effect.Effect<
    boolean,
    | DesktopCloudAuthTokenStoreWriteError
    | ElectronSafeStorage.ElectronSafeStorageAvailabilityError
    | ElectronSafeStorage.ElectronSafeStorageEncryptError
  >;
  readonly clear: Effect.Effect<void>;
}

export class DesktopCloudAuthTokenStore extends Context.Service<
  DesktopCloudAuthTokenStore,
  DesktopCloudAuthTokenStoreShape
>()("@t3tools/desktop/app/DesktopCloudAuthTokenStore") {}

function decodeSecretBytes(
  encoded: string,
): Effect.Effect<Uint8Array, DesktopCloudAuthTokenStoreDecodeError> {
  return Effect.fromResult(Encoding.decodeBase64(encoded)).pipe(
    Effect.mapError((cause) => new DesktopCloudAuthTokenStoreDecodeError({ cause })),
  );
}

const readDocument = (
  fileSystem: FileSystem.FileSystem,
  tokenPath: string,
): Effect.Effect<Option.Option<CloudAuthTokenDocument>> =>
  fileSystem.readFileString(tokenPath).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<CloudAuthTokenDocument>()),
        onSome: (raw) => decodeCloudAuthTokenDocumentJson(raw).pipe(Effect.option),
      }),
    ),
  );

const writeDocument = Effect.fn("desktop.cloudAuthTokenStore.writeDocument")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly tokenPath: string;
  readonly document: CloudAuthTokenDocument;
  readonly suffix: string;
}): Effect.fn.Return<void, PlatformError.PlatformError | Schema.SchemaError> {
  const directory = input.path.dirname(input.tokenPath);
  const tempPath = `${input.tokenPath}.${process.pid}.${input.suffix}.tmp`;
  const encoded = yield* encodeCloudAuthTokenDocumentJson(input.document);
  yield* input.fileSystem.makeDirectory(directory, { recursive: true });
  yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`);
  yield* input.fileSystem.rename(tempPath, input.tokenPath);
});

export const layer = Layer.effect(
  DesktopCloudAuthTokenStore,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const crypto = yield* Crypto.Crypto;
    const tokenPath = path.join(environment.stateDir, "cloud-auth-token.json");

    return DesktopCloudAuthTokenStore.of({
      get: Effect.gen(function* () {
        const document = yield* readDocument(fileSystem, tokenPath);
        if (Option.isNone(document) || !(yield* safeStorage.isEncryptionAvailable)) {
          return Option.none<string>();
        }

        const secretBytes = yield* decodeSecretBytes(document.value.encryptedClientJwt);
        return Option.some(yield* safeStorage.decryptString(secretBytes));
      }).pipe(Effect.withSpan("desktop.cloudAuthTokenStore.get")),
      set: Effect.fn("desktop.cloudAuthTokenStore.set")(function* (token) {
        if (!(yield* safeStorage.isEncryptionAvailable)) {
          return false;
        }

        const encryptedClientJwt = Encoding.encodeBase64(yield* safeStorage.encryptString(token));
        const suffix = (yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => new DesktopCloudAuthTokenStoreWriteError({ cause })),
        )).replace(/-/g, "");
        yield* writeDocument({
          fileSystem,
          path,
          tokenPath,
          document: { version: 1, encryptedClientJwt },
          suffix,
        }).pipe(Effect.mapError((cause) => new DesktopCloudAuthTokenStoreWriteError({ cause })));
        return true;
      }),
      clear: fileSystem.remove(tokenPath, { force: true }).pipe(
        Effect.catch(() => Effect.void),
        Effect.withSpan("desktop.cloudAuthTokenStore.clear"),
      ),
    });
  }),
);
