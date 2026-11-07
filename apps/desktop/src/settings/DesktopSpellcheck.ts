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

/** Electron seeds its list from the app locale; Chromium falls back to the base language. */
function localeDefaultLanguages(
  locale: string,
  available: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const base = locale.split("-")[0] ?? locale;
  const match =
    available.find((language) => language === locale) ??
    available.find((language) => language === base) ??
    available.find((language) => language.startsWith(`${base}-`));
  return [match ?? "en-US"];
}

/** @public */
export const make = Effect.gen(function* () {
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const platform = yield* HostProcess.Platform;
  // Electron persists the list across restarts, so only undo an override this app applied;
  // a list the user set in Chromium's Preferences by hand is left alone.
  const overriddenRef = yield* Ref.make(false);

  const configure = Effect.fn("desktop.spellcheck.configure")(function* (settings: ClientSettings) {
    // macOS always uses the native spellchecker, which ignores Electron's language list.
    if (platform === "darwin") return;
    const session = Electron.session.defaultSession;
    const available = session.availableSpellCheckerLanguages;
    const supported = new Set(available);
    const requested = [...new Set(settings.spellcheckLanguages)].filter((language) =>
      supported.has(language),
    );
    const overridden = yield* Ref.getAndSet(overriddenRef, requested.length > 0);
    if (requested.length === 0 && !overridden) return;
    const languages =
      requested.length > 0
        ? requested
        : localeDefaultLanguages(Electron.app.getLocale(), available);
    yield* Effect.annotateCurrentSpan({ languages: languages.join(",") });
    // Only throws for codes outside availableSpellCheckerLanguages, which are filtered out above.
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
