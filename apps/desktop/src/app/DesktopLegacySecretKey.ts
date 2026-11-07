import { T3_LEARN_LEGACY } from "@t3tools/shared/t3LearnIdentity";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import { decryptChromiumValue } from "../preview/BrowserImport/ChromiumCookies.ts";
import { resolveChromiumKeys } from "../preview/BrowserImport/ChromiumKeys.ts";
import { LinuxBrowserSecretPath } from "../preview/BrowserImport/LinuxBrowserSecret.ts";
import * as LinuxBrowserSecret from "../preview/BrowserImport/LinuxBrowserSecret.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export class DesktopLegacySecretKey extends Context.Service<
  DesktopLegacySecretKey,
  {
    readonly decrypt: (encrypted: Uint8Array) => Effect.Effect<Option.Option<string>>;
  }
>()("@t3tools/desktop/app/DesktopLegacySecretKey") {}

/** Resolve the old Chromium key once so a macOS migration causes at most one Keychain prompt. */
const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const linuxSecretPath = yield* LinuxBrowserSecretPath;
  const resolveKeys = yield* Effect.cached(
    Effect.gen(function* () {
      if (environment.isDevelopment) return yield* Effect.succeedNone;
      if (environment.platform !== "darwin" && environment.platform !== "linux") {
        return yield* Effect.succeedNone;
      }
      const keys = yield* resolveChromiumKeys({
        platform: environment.platform,
        keychainService:
          environment.platform === "darwin"
            ? `${T3_LEARN_LEGACY.executableName} Safe Storage`
            : undefined,
        keychainAccount:
          environment.platform === "darwin" ? `${T3_LEARN_LEGACY.executableName} Key` : undefined,
        linuxSecretApplication:
          environment.platform === "linux" ? T3_LEARN_LEGACY.executableName : undefined,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(LinuxBrowserSecretPath, linuxSecretPath),
      );
      return yield* Effect.succeedSome(keys);
    }).pipe(Effect.catch(() => Effect.succeedNone)),
  );

  return DesktopLegacySecretKey.of({
    decrypt: Effect.fn("DesktopLegacySecretKey.decrypt")((encrypted) =>
      resolveKeys.pipe(
        Effect.map((keys) =>
          Option.isNone(keys)
            ? Option.none()
            : Option.fromNullishOr(
                decryptChromiumValue(encrypted, keys.value, "", 23, environment.platform),
              ),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(DesktopLegacySecretKey, make).pipe(
  Layer.provideMerge(LinuxBrowserSecret.layer),
);
