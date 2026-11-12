import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { expect, vi } from "vite-plus/test";

const session = vi.hoisted(() => ({
  languages: ["en-US"] as string[],
  availableSpellCheckerLanguages: ["en-US", "en-GB", "fr-FR", "de-DE"],
  getSpellCheckerLanguages: () => [...session.languages],
  setSpellCheckerLanguages: (languages: string[]) => {
    session.languages = [...languages];
  },
}));
vi.mock("electron", () => ({
  app: { getLocale: () => "en-GB" },
  session: { defaultSession: session },
}));

import * as DesktopClientSettings from "./DesktopClientSettings.ts";
import * as DesktopSpellcheck from "./DesktopSpellcheck.ts";

const withLanguages = (spellcheckLanguages: ReadonlyArray<string>) => ({
  ...DEFAULT_CLIENT_SETTINGS,
  spellcheckLanguages,
});

// `persisted` is the list Electron restored from its Preferences file at launch.
const run = (
  platform: NodeJS.Platform,
  stored: ReadonlyArray<string>,
  persisted: ReadonlyArray<string> = ["en-GB"],
) =>
  Effect.gen(function* () {
    session.languages = [...persisted];
    return yield* DesktopSpellcheck.DesktopSpellcheck;
  }).pipe(
    Effect.provide(
      DesktopSpellcheck.layer.pipe(
        Layer.provide(DesktopClientSettings.layerTest(Option.some(withLanguages(stored)))),
      ),
    ),
    Effect.provideService(HostProcess.Platform, platform),
  );

it.effect("applies stored languages, drops unknown codes, and restores the locale default", () =>
  Effect.gen(function* () {
    const spellcheck = yield* run("linux", ["fr-FR", "xx-XX", "en-US", "fr-FR"]);
    yield* spellcheck.initialize;
    expect(session.languages).toEqual(["fr-FR", "en-US"]);

    yield* spellcheck.configure(withLanguages(["de-DE"]));
    expect(session.languages).toEqual(["de-DE"]);

    yield* spellcheck.configure(withLanguages(["xx-XX"]));
    expect(session.languages).toEqual(["en-GB"]);

    yield* spellcheck.configure(withLanguages([]));
    expect(session.languages).toEqual(["en-GB"]);
    expect(yield* spellcheck.availableLanguages).toEqual(session.availableSpellCheckerLanguages);
  }),
);

it.effect("clearing an override after a restart restores the locale default", () =>
  Effect.gen(function* () {
    const spellcheck = yield* run("linux", ["fr-FR"], ["fr-FR"]);
    yield* spellcheck.initialize;
    yield* spellcheck.configure(withLanguages([]));
    expect(session.languages).toEqual(["en-GB"]);
  }),
);

it.effect("leaves a list it never overrode alone", () =>
  Effect.gen(function* () {
    const spellcheck = yield* run("linux", [], ["en-US", "fr-FR"]);
    yield* spellcheck.initialize;
    yield* spellcheck.configure(withLanguages([]));
    expect(session.languages).toEqual(["en-US", "fr-FR"]);
  }),
);

it.effect("leaves the native macOS spellchecker alone", () =>
  Effect.gen(function* () {
    const spellcheck = yield* run("darwin", ["fr-FR"]);
    yield* spellcheck.initialize;
    expect(session.languages).toEqual(["en-GB"]);
    expect(yield* spellcheck.availableLanguages).toEqual([]);
  }),
);
