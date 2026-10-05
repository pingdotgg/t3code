import { DesktopSpellCheckLanguagesSchema, DesktopSpellCheckStateSchema } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export class SpellCheckLanguagesError extends Schema.TaggedError<SpellCheckLanguagesError>()(
  "SpellCheckLanguagesError",
  {
    languages: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to set spell check languages to ${this.languages.join(", ")}.`;
  }
}

// The app window renders in the default session. Its languages default to
// Chromium's UI locale, which the packaged app pins to `en-US` by shipping
// only that locale pak; Chromium persists any list set here. macOS uses the
// OS checker instead, which detects the language as you type and ignores
// this list.
const readSpellCheckState = Effect.gen(function* () {
  if ((yield* HostProcessPlatform) === "darwin") return null;
  const session = Electron.session.defaultSession;
  return {
    availableLanguages: session.availableSpellCheckerLanguages,
    languages: session.getSpellCheckerLanguages(),
  };
});

const StateResult = Schema.NullOr(DesktopSpellCheckStateSchema);

export const getSpellCheckState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_SPELL_CHECK_STATE_CHANNEL,
  payload: Schema.Void,
  result: StateResult,
  handler: Effect.fn("desktop.ipc.spellCheck.getState")(function* () {
    return yield* readSpellCheckState;
  }),
});

export const setSpellCheckLanguages = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_SPELL_CHECK_LANGUAGES_CHANNEL,
  payload: DesktopSpellCheckLanguagesSchema,
  result: StateResult,
  handler: Effect.fn("desktop.ipc.spellCheck.setLanguages")(function* (requested) {
    if ((yield* HostProcessPlatform) === "darwin") return null;
    const languages = [...new Set(requested)];
    // Electron rejects codes outside `availableSpellCheckerLanguages`.
    yield* Effect.try({
      try: () => Electron.session.defaultSession.setSpellCheckerLanguages(languages),
      catch: (cause) => new SpellCheckLanguagesError({ languages, cause }),
    });
    return yield* readSpellCheckState;
  }),
});
