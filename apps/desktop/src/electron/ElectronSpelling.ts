import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const SUGGESTION_TIMEOUT = Duration.millis(250);
const PROCESS_TERMINATE_GRACE = Duration.seconds(1);
const MAX_WORD_LENGTH = 100;
const MAX_SUGGESTIONS = 10;

// Chromium can flag a word using the macOS spellchecker while still providing
// no dictionary suggestions to Electron's context-menu event. Ask the same OS
// checker for its guesses out of process so no native module is required.
// Passing `$()` (nil) keeps automatic language selection, and the word travels
// through argv rather than script interpolation.
const SPELLING_GUESSES_JXA = [
  "function run(argv) {",
  '  ObjC.import("AppKit");',
  "  const word = String(argv[0]);",
  "  const checker = $.NSSpellChecker.sharedSpellChecker;",
  "  const guesses = checker.guessesForWordRangeInStringLanguageInSpellDocumentWithTag(",
  "    $.NSMakeRange(0, word.length), word, $(), 0);",
  "  return JSON.stringify(ObjC.deepUnwrap(guesses) || []);",
  "}",
].join("\n");

export class ElectronSpelling extends Context.Service<
  ElectronSpelling,
  {
    readonly platformSuggestionsFor: (word: string) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("@t3tools/desktop/electron/ElectronSpelling") {}

export const parsePlatformSuggestions = (output: string): ReadonlyArray<string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  const suggestions: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") {
      continue;
    }
    const suggestion = entry.trim();
    if (suggestion.length === 0 || suggestions.includes(suggestion)) {
      continue;
    }
    suggestions.push(suggestion);
    if (suggestions.length >= MAX_SUGGESTIONS) {
      break;
    }
  }
  return suggestions;
};

export const layer = Layer.effect(
  ElectronSpelling,
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return ElectronSpelling.of({
      platformSuggestionsFor: Effect.fn("desktop.spelling.platformSuggestionsFor")(function* (
        word: string,
      ): Effect.fn.Return<ReadonlyArray<string>> {
        if (platform !== "darwin") {
          return [];
        }
        const trimmedWord = word.trim();
        if (trimmedWord.length === 0 || trimmedWord.length > MAX_WORD_LENGTH) {
          return [];
        }

        const output = yield* spawner
          .string(
            ChildProcess.make(
              "/usr/bin/osascript",
              ["-l", "JavaScript", "-e", SPELLING_GUESSES_JXA, trimmedWord],
              {
                stdin: "ignore",
                stdout: "pipe",
                stderr: "ignore",
                killSignal: "SIGTERM",
                forceKillAfter: PROCESS_TERMINATE_GRACE,
              },
            ),
          )
          .pipe(
            Effect.timeoutOption(SUGGESTION_TIMEOUT),
            Effect.map(Option.getOrElse(() => "")),
            Effect.orElseSucceed(() => ""),
          );

        return parsePlatformSuggestions(output);
      }),
    });
  }),
);
