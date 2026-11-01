// @effect-diagnostics nodeBuiltinImport:off - Effect has no AES-GCM primitive for Windows safeStorage compatibility.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { readWindowsKey } from "../preview/BrowserImport/ChromiumKeys.ts";

const PREFIX = Buffer.from("v10");
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const CIPHERTEXT_OFFSET = PREFIX.length + NONCE_LENGTH;

export const make = Effect.fn("desktop.windowsCatalogKey.make")(function* (
  appDataDirectory: string,
) {
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const path = yield* Path.Path;
  const context = yield* Effect.context<
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >();
  // Failed lookups are cached too; restoring a profile key requires an app restart.
  const keys = yield* Effect.cached(
    Effect.forEach(["t3code", "T3 Code (Alpha)"], (profile) =>
      readWindowsKey(path.join(appDataDirectory, profile, "Local State")).pipe(
        Effect.timeout("10 seconds"),
        Effect.option,
      ),
    ).pipe(Effect.provide(context)),
  );
  return Effect.fn("desktop.windowsCatalogKey.decrypt")(function* (encrypted: Uint8Array) {
    const bytes = Buffer.from(encrypted);
    // Native Windows safeStorage can abort on truncated v10 payloads.
    if (
      bytes.length < CIPHERTEXT_OFFSET + TAG_LENGTH ||
      !bytes.subarray(0, PREFIX.length).equals(PREFIX)
    ) {
      return yield* new ElectronSafeStorage.ElectronSafeStorageDecryptError({
        cause: new Error("Invalid Windows catalog ciphertext framing."),
      });
    }
    return yield* safeStorage.decryptString(encrypted).pipe(
      Effect.map((catalog) => ({ catalog, encrypt: safeStorage.encryptString })),
      Effect.catch((error) =>
        Effect.gen(function* () {
          for (const key of yield* keys) {
            if (Option.isNone(key)) continue;
            const catalog = yield* Effect.try({
              try: () => {
                const decipher = NodeCrypto.createDecipheriv(
                  "aes-256-gcm",
                  key.value,
                  bytes.subarray(PREFIX.length, CIPHERTEXT_OFFSET),
                );
                decipher.setAuthTag(bytes.subarray(-TAG_LENGTH));
                return Buffer.concat([
                  decipher.update(bytes.subarray(CIPHERTEXT_OFFSET, -TAG_LENGTH)),
                  decipher.final(),
                ]).toString("utf8");
              },
              catch: () => error,
            }).pipe(Effect.option);
            if (Option.isNone(catalog)) continue;
            return {
              catalog: catalog.value,
              encrypt: (value: string) =>
                Effect.try({
                  try: () => {
                    const nonce = NodeCrypto.randomBytes(NONCE_LENGTH);
                    const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key.value, nonce);
                    return Buffer.concat([
                      PREFIX,
                      nonce,
                      cipher.update(value, "utf8"),
                      cipher.final(),
                      cipher.getAuthTag(),
                    ]);
                  },
                  catch: (cause) =>
                    new ElectronSafeStorage.ElectronSafeStorageEncryptError({ cause }),
                }),
            };
          }
          return yield* error;
        }),
      ),
    );
  });
});
