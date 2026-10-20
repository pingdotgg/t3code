import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import { decryptChromiumValue } from "../preview/BrowserImport/ChromiumCookies.ts";
import { resolveChromiumKeys } from "../preview/BrowserImport/ChromiumKeys.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export class DesktopSafeStorageIdentity extends Context.Service<
  DesktopSafeStorageIdentity,
  {
    readonly decryptWithPreviousName: (
      encrypted: Uint8Array,
    ) => Effect.Effect<Option.Option<string>>;
  }
>()("@t3tools/desktop/app/DesktopSafeStorageIdentity") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();

  const decryptWithPreviousName = Effect.fn("desktop.safeStorageIdentity.decryptWithPreviousName")(
    function* (encrypted: Uint8Array) {
      if (environment.platform !== "darwin" && environment.platform !== "linux") {
        return Option.none<string>();
      }
      if (
        DesktopEnvironment.resolveDesktopSafeStorageName(environment.appVersion) !==
        "T3 Code (Alpha)"
      ) {
        return Option.none<string>();
      }
      // Cookie imports also accept plaintext; safeStorage requires an OSCrypt prefix.
      const prefix = Buffer.from(encrypted.subarray(0, 3)).toString("latin1");
      if (prefix !== (environment.platform === "darwin" ? "v10" : "v11")) {
        return Option.none<string>();
      }
      const keys = yield* resolveChromiumKeys({
        platform: environment.platform,
        keychainService: "T3 Code (Beta) Safe Storage",
        keychainAccount: "T3 Code (Beta)",
        linuxSecretApplication: "T3 Code (Beta)",
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Could not read the Beta safe storage key.", {
            reason: error.reason,
          }),
        ),
        Effect.option,
      );
      return Option.flatMapNullishOr(keys, (material) =>
        decryptChromiumValue(encrypted, material, "", undefined, environment.platform),
      );
    },
    Effect.provide(services),
  );

  return DesktopSafeStorageIdentity.of({ decryptWithPreviousName });
});

export const layer = Layer.effect(DesktopSafeStorageIdentity, make);
