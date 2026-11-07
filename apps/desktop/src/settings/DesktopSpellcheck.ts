import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Electron from "electron";

import * as DesktopClientSettings from "./DesktopClientSettings.ts";

export class DesktopSpellcheck extends Context.Service<
  DesktopSpellcheck,
  {
    readonly initialize: Effect.Effect<void>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    /** Empty where the OS spellchecker picks languages itself (macOS). */
    readonly availableLanguages: Effect.Effect<ReadonlyArray<string>>;
  }
>()("@t3tools/desktop/settings/DesktopSpellcheck") {}

/** Unknown codes are dropped so a stale setting can never leave spellcheck with no language. */
function resolveSpellCheckerLanguages(
  requested: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
  systemDefault: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const supported = new Set(available);
  const languages = [...new Set(requested)].filter((language) => supported.has(language));
  return languages.length > 0 ? languages : systemDefault;
}

/** @public */
export const make = Effect.gen(function* () {
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const platform = yield* HostProcess.Platform;
  // Electron's own locale-derived choice, captured before the first override so clearing the setting restores it.
  const systemDefaultRef = yield* Ref.make(Option.none<ReadonlyArray<string>>());

  const configure = Effect.fn("desktop.spellcheck.configure")(function* (settings: ClientSettings) {
    // macOS always uses the native spellchecker, which ignores Electron's language list.
    if (platform === "darwin") return;
    const session = Electron.session.defaultSession;
    const systemDefault = yield* Ref.modify(systemDefaultRef, (stored) => {
      const value = Option.getOrElse(stored, () => session.getSpellCheckerLanguages());
      return [value, Option.some(value)] as const;
    });
    const languages = resolveSpellCheckerLanguages(
      settings.spellcheckLanguages,
      session.availableSpellCheckerLanguages,
      systemDefault,
    );
    yield* Effect.annotateCurrentSpan({ languages: languages.join(",") });
    // Only throws for codes outside availableSpellCheckerLanguages, which resolve has dropped.
    yield* Effect.sync(() => session.setSpellCheckerLanguages([...languages]));
  });

  return DesktopSpellcheck.of({
    initialize: clientSettings.get.pipe(
      Effect.flatMap((stored) =>
        configure(Option.getOrElse(stored, () => DEFAULT_CLIENT_SETTINGS)),
      ),
      Effect.ignore,
    ),
    configure,
    availableLanguages: Effect.sync(() =>
      platform === "darwin" ? [] : Electron.session.defaultSession.availableSpellCheckerLanguages,
    ),
  });
});

export const layer = Layer.effect(DesktopSpellcheck, make);
