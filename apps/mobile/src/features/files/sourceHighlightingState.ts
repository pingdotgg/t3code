import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import {
  highlightSourceFile,
  type ReviewDiffTheme,
  type ReviewHighlightedToken,
} from "../review/shikiReviewHighlighter";

const SOURCE_HIGHLIGHT_IDLE_TTL_MS = 5 * 60_000;

export interface SourceHighlightInput {
  readonly path: string;
  readonly contents: string;
  readonly theme: ReviewDiffTheme;
}

export type SourceHighlightTokens = ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>;

type SourceHighlighter = (input: SourceHighlightInput) => Promise<SourceHighlightTokens>;

class SourceHighlightCacheKey extends Data.Class<SourceHighlightInput> {}

class SourceHighlightError extends Data.TaggedError("SourceHighlightError")<{
  readonly cause: unknown;
}> {}

export function createSourceHighlightAtomFamily(options?: {
  readonly highlight?: SourceHighlighter;
  readonly idleTtlMs?: number;
}) {
  const highlight = options?.highlight ?? highlightSourceFile;
  const idleTtlMs = options?.idleTtlMs ?? SOURCE_HIGHLIGHT_IDLE_TTL_MS;
  const family = Atom.family((request: SourceHighlightCacheKey) =>
    Atom.make(
      Effect.tryPromise({
        try: () => highlight(request),
        catch: (cause) => new SourceHighlightError({ cause }),
      }),
    ).pipe(
      Atom.setIdleTTL(idleTtlMs),
      Atom.withLabel(`mobile:source-highlight:${request.theme}:${request.path}`),
    ),
  );

  return (input: SourceHighlightInput) => family(new SourceHighlightCacheKey(input));
}

export const sourceHighlightAtom = createSourceHighlightAtomFamily();
