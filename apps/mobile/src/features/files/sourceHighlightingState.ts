import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { resolveHighlightLanguage } from "../../lib/highlightLanguage";
import { highlightCode, type HighlightedLines, type HighlightScheme } from "../../lib/highlights";

const SOURCE_HIGHLIGHT_IDLE_TTL_MS = 5 * 60_000;

export interface SourceHighlightInput {
  readonly path: string;
  readonly contents: string;
  readonly theme: HighlightScheme;
}

class SourceHighlightCacheKey extends Data.Class<SourceHighlightInput> {}

class SourceHighlightError extends Data.TaggedError("SourceHighlightError")<{
  readonly cause: unknown;
}> {}

// Highlighting is synchronous, so a cold atom resolves on its first read. The
// family keeps results for files the user moves between.
const sourceHighlightFamily = Atom.family((request: SourceHighlightCacheKey) =>
  Atom.make(
    Effect.try({
      try: (): HighlightedLines =>
        highlightCode(
          request.contents,
          resolveHighlightLanguage({ path: request.path }),
          request.theme,
        ),
      catch: (cause) => new SourceHighlightError({ cause }),
    }),
  ).pipe(
    Atom.setIdleTTL(SOURCE_HIGHLIGHT_IDLE_TTL_MS),
    Atom.withLabel(`mobile:source-highlight:${request.theme}:${request.path}`),
  ),
);

export const sourceHighlightAtom = (input: SourceHighlightInput) =>
  sourceHighlightFamily(new SourceHighlightCacheKey(input));
