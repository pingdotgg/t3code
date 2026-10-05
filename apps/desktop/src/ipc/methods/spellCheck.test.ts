import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const native = vi.hoisted(() => {
  const available = ["en-US", "it"];
  const state = { languages: ["en-US"] };
  return {
    state,
    session: {
      availableSpellCheckerLanguages: available,
      getSpellCheckerLanguages: () => [...state.languages],
      // Mirrors Electron: unknown codes throw, an empty list is accepted.
      setSpellCheckerLanguages: vi.fn((languages: string[]) => {
        const unknown = languages.find((language) => !available.includes(language));
        if (unknown !== undefined) {
          throw new Error(`Invalid language code provided: "${unknown}"`);
        }
        state.languages = languages;
      }),
    },
  };
});
vi.mock("electron", () => ({ session: { defaultSession: native.session } }));

import { getSpellCheckState, setSpellCheckLanguages } from "./spellCheck.ts";

describe("spell check IPC", () => {
  beforeEach(() => {
    native.state.languages = ["en-US"];
    native.session.setSpellCheckerLanguages.mockClear();
  });

  it.effect("refuses an empty list instead of letting Electron fall back to en-US", () =>
    Effect.gen(function* () {
      const error = yield* setSpellCheckLanguages.handler([]).pipe(Effect.asVoid, Effect.flip);
      assert.strictEqual(error._tag, "SchemaError");
      assert.strictEqual(native.session.setSpellCheckerLanguages.mock.calls.length, 0);
    }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("reports a rejected language as a failure and keeps the current list", () =>
    Effect.gen(function* () {
      const error = yield* setSpellCheckLanguages
        .handler(["it", "xx"])
        .pipe(Effect.asVoid, Effect.flip);
      assert.strictEqual(error._tag, "SpellCheckLanguagesError");
      assert.deepEqual(yield* getSpellCheckState.handler(undefined), {
        availableLanguages: ["en-US", "it"],
        languages: ["en-US"],
      });
    }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
  );

  it.effect("passes each language to Electron once", () =>
    Effect.gen(function* () {
      yield* setSpellCheckLanguages.handler(["it", "en-US", "it"]);
      assert.deepEqual(native.state.languages, ["it", "en-US"]);
    }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("leaves macOS to the OS spell checker", () =>
    Effect.gen(function* () {
      assert.isNull(yield* getSpellCheckState.handler(undefined));
      assert.isNull(yield* setSpellCheckLanguages.handler(["it"]));
      assert.strictEqual(native.session.setSpellCheckerLanguages.mock.calls.length, 0);
    }).pipe(Effect.provideService(HostProcessPlatform, "darwin")),
  );
});
