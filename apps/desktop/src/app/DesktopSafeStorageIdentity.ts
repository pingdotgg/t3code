import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import { decryptChromiumValue } from "../preview/BrowserImport/ChromiumCookies.ts";
import { resolveChromiumKeys } from "../preview/BrowserImport/ChromiumKeys.ts";
import { resolveDefaultDesktopUpdateChannel } from "../updates/updateChannels.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export interface SafeStorageIdentity {
  readonly name: string;
  readonly previousNames: ReadonlyArray<string>;
}

/**
 * Electron names the macOS Keychain item and the Linux keyring entry that hold
 * the safeStorage key after the app name Chromium starts with. Data encrypted
 * under one name does not decrypt under another, so this name stays fixed when
 * the product branding changes. Windows keeps its key in the userData profile.
 *
 * These are the packaged product names each channel shipped with before the
 * name was fixed here; 0.1.0 stable started as "T3 Code (Beta)".
 */
export function resolveSafeStorageIdentity(appVersion: string): SafeStorageIdentity {
  return resolveDefaultDesktopUpdateChannel(appVersion) === "nightly"
    ? { name: "T3 Code (Nightly)", previousNames: [] }
    : { name: "T3 Code (Alpha)", previousNames: ["T3 Code (Beta)"] };
}

export class DesktopSafeStorageIdentity extends Context.Service<
  DesktopSafeStorageIdentity,
  {
    /** Decrypts safeStorage output written while the app ran under a previous name. */
    readonly decryptWithPreviousName: (
      encrypted: Uint8Array,
    ) => Effect.Effect<Option.Option<string>>;
  }
>()("@t3tools/desktop/app/DesktopSafeStorageIdentity") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const previousNames =
    environment.platform === "darwin" || environment.platform === "linux"
      ? resolveSafeStorageIdentity(environment.appVersion).previousNames
      : [];

  const decryptWithPreviousName = Effect.fn("desktop.safeStorageIdentity.decryptWithPreviousName")(
    function* (encrypted: Uint8Array) {
      for (const name of previousNames) {
        const keys = yield* resolveChromiumKeys({
          platform: environment.platform,
          keychainService: `${name} Safe Storage`,
          keychainAccount: name,
          linuxSecretApplication: name,
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Could not read a previous safe storage key.", {
              name,
              reason: error.reason,
            }),
          ),
          Effect.option,
        );
        const plaintext = Option.flatMapNullishOr(keys, (material) =>
          decryptChromiumValue(encrypted, material, "", undefined, environment.platform),
        );
        if (Option.isSome(plaintext)) {
          return plaintext;
        }
      }
      return Option.none<string>();
    },
    Effect.provide(services),
  );

  return DesktopSafeStorageIdentity.of({ decryptWithPreviousName });
});

export const layer = Layer.effect(DesktopSafeStorageIdentity, make);
