import {
  EnvironmentId,
  OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadSearchMatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

export interface EnvironmentThreadSearchMatch extends OrchestrationThreadSearchMatch {
  readonly environmentId: EnvironmentId;
}

export interface ThreadSearchResultsState {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isLoading: boolean;
}

const ThreadSearchKey = Schema.fromJsonString(
  Schema.Tuple([
    Schema.Array(EnvironmentId),
    OrchestrationSearchThreadsInput.fields.query,
    Schema.optional(Schema.Boolean),
  ]),
);
const decodeThreadSearchKey = Schema.decodeUnknownOption(ThreadSearchKey);

export function makeThreadSearchKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
  archived = false,
): string {
  const sortedEnvironmentIds = [...environmentIds].sort((left, right) => left.localeCompare(right));
  const key = archived
    ? ([sortedEnvironmentIds, query, true] as const)
    : ([sortedEnvironmentIds, query] as const);
  return JSON.stringify(key);
}

function parseThreadSearchKey(key: string) {
  return decodeThreadSearchKey(key);
}

export function threadSearchMatchKey(
  match: Pick<EnvironmentThreadSearchMatch, "environmentId" | "threadId">,
): string {
  return JSON.stringify([match.environmentId, match.threadId]);
}

/**
 * Combines one search query atom per environment. Invalid search keys, failed
 * requests, and disconnected environments contribute no content matches,
 * preserving local title search as the compatibility fallback.
 */
export function createThreadSearchResultsAtomFamily<E>(options: {
  readonly getSearchAtom: (
    environmentId: EnvironmentId,
    query: string,
    archived?: boolean,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((key: string) =>
    Atom.make((get): ThreadSearchResultsState => {
      const parsedKey = parseThreadSearchKey(key);
      if (Option.isNone(parsedKey)) {
        return { matches: [], isLoading: false };
      }

      const [environmentIds, query, archived] = parsedKey.value;
      const matches: EnvironmentThreadSearchMatch[] = [];
      let isLoading = false;

      for (const environmentId of environmentIds) {
        const result = get(options.getSearchAtom(environmentId, query, archived));
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
