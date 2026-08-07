import {
  EnvironmentId,
  OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadSearchMatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

export interface EnvironmentThreadSearchMatch extends OrchestrationThreadSearchMatch {
  readonly environmentId: EnvironmentId;
}

export interface ThreadSearchResultsState {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isLoading: boolean;
}

export interface ThreadSearchTextPart {
  readonly text: string;
  readonly highlighted: boolean;
  readonly start: number;
}

function foldThreadSearchCase(text: string): string {
  const lowered = text.toLowerCase();
  if (lowered.length === text.length) return lowered;

  let folded = "";
  for (const character of text) {
    const loweredCharacter = character.toLowerCase();
    folded += loweredCharacter.length === character.length ? loweredCharacter : character;
  }
  return folded;
}

export function findThreadSearchOccurrences(text: string, query: string): number[] {
  if (text.length === 0 || query.length === 0) return [];

  const foldedText = foldThreadSearchCase(text);
  const foldedQuery = foldThreadSearchCase(query);
  const offsets: number[] = [];
  let cursor = 0;

  while (cursor <= foldedText.length - foldedQuery.length) {
    const offset = foldedText.indexOf(foldedQuery, cursor);
    if (offset === -1) break;
    offsets.push(offset);
    cursor = offset + foldedQuery.length;
  }
  return offsets;
}

export function splitThreadSearchText(text: string, query: string): ThreadSearchTextPart[] {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return [{ text, highlighted: false, start: 0 }];
  }

  const parts: ThreadSearchTextPart[] = [];
  let cursor = 0;
  for (const offset of findThreadSearchOccurrences(text, normalizedQuery)) {
    if (offset > cursor) {
      parts.push({ text: text.slice(cursor, offset), highlighted: false, start: cursor });
    }
    parts.push({
      text: text.slice(offset, offset + normalizedQuery.length),
      highlighted: true,
      start: offset,
    });
    cursor = offset + normalizedQuery.length;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), highlighted: false, start: cursor });
  }
  return parts;
}

const ThreadSearchKey = Schema.Tuple([
  Schema.Array(EnvironmentId),
  OrchestrationSearchThreadsInput.fields.query,
]);
const decodeThreadSearchKey = Schema.decodeUnknownSync(ThreadSearchKey);

export function makeThreadSearchKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
): string {
  return JSON.stringify([
    [...environmentIds].sort((left, right) => left.localeCompare(right)),
    query,
  ]);
}

function parseThreadSearchKey(key: string) {
  return decodeThreadSearchKey(JSON.parse(key));
}

export function threadSearchMatchKey(
  match: Pick<EnvironmentThreadSearchMatch, "environmentId" | "threadId">,
): string {
  return JSON.stringify([match.environmentId, match.threadId]);
}

/**
 * Combines one search query atom per environment. Failed and disconnected
 * environments contribute no content matches, preserving local title search
 * as the compatibility fallback.
 */
export function createThreadSearchResultsAtomFamily<E>(options: {
  readonly getSearchAtom: (
    environmentId: EnvironmentId,
    query: string,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((key: string) =>
    Atom.make((get): ThreadSearchResultsState => {
      const [environmentIds, query] = parseThreadSearchKey(key);
      const matches: EnvironmentThreadSearchMatch[] = [];
      let isLoading = false;

      for (const environmentId of environmentIds) {
        const result = get(options.getSearchAtom(environmentId, query));
        isLoading ||= result.waiting;
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) {
          matches.push(
            ...value.matches.map((match) => ({
              ...match,
              environmentId,
            })),
          );
        }
      }

      return { matches, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${key}`)),
  );
}
