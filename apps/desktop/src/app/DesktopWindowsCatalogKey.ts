// @effect-diagnostics nodeBuiltinImport:off - Windows safeStorage uses Chromium's AES-GCM wire format.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";
import * as Path from "effect/Path";

import { decryptChromiumValue } from "../preview/BrowserImport/ChromiumCookies.ts";
import { readWindowsKey } from "../preview/BrowserImport/ChromiumKeys.ts";

/** Keep a shared catalog on its original key without replacing either Electron profile's key. */
export const make = Effect.fn("desktop.windowsCatalogKey.make")(function* (
  appDataDirectory: string,
) {
  const path = yield* Path.Path;
  const context = yield* Effect.context<
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >();
  const keys = yield* Effect.cached(
    Effect.forEach(["t3code", "T3 Code (Alpha)"], (profile) =>
      readWindowsKey(path.join(appDataDirectory, profile, "Local State")).pipe(Effect.option),
    ).pipe(Effect.provide(context)),
  );
  return Effect.fn("desktop.windowsCatalogKey.recover")(function* (encrypted: Uint8Array) {
    if (encrypted.length < 31 || Buffer.from(encrypted.subarray(0, 3)).toString("ascii") !== "v10")
      return undefined;
    for (const key of yield* keys) {
      if (key._tag === "None") continue;
      // safeStorage and legacy Chromium cookies use the same Windows v10 format;
      // safeStorage plaintext has no cookie-domain binding (schemaVersion < 24).
      const catalog = decryptChromiumValue(encrypted, { gcmV10: key.value }, "", 23, "win32");
      if (catalog === null) continue;
      return {
        catalog,
        encrypt: (value: string) => {
          const nonce = NodeCrypto.randomBytes(12);
          const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key.value, nonce);
          return Buffer.concat([
            Buffer.from("v10"),
            nonce,
            cipher.update(value, "utf8"),
            cipher.final(),
            cipher.getAuthTag(),
          ]);
        },
      };
    }
    return undefined;
  });
});
