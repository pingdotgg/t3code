import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadSearchMatch,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { EnvironmentPresentation } from "../connection/presentation.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

export const THREAD_SEARCH_LIMIT = 50;

export interface EnvironmentThreadSearchMatch extends OrchestrationThreadSearchMatch {
  readonly environmentId: EnvironmentId;
}

export interface ThreadSearchSource {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: "complete" | "pending" | "failed" | "disconnected" | "unsupported" | "limited";
  readonly isStale: boolean;
}

export interface ThreadSearchResultsState {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isLoading: boolean;
  readonly sources: ReadonlyArray<ThreadSearchSource>;
}

const ThreadSearchKey = Schema.fromJsonString(
  Schema.Tuple([Schema.Array(EnvironmentId), OrchestrationSearchThreadsInput.fields.query]),
);
const decodeThreadSearchKey = Schema.decodeUnknownOption(ThreadSearchKey);

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
  return decodeThreadSearchKey(key);
}

export function threadSearchMatchKey(
  match: Pick<EnvironmentThreadSearchMatch, "environmentId" | "threadId">,
): string {
  return JSON.stringify([match.environmentId, match.threadId]);
}

/** Keeps cached matches and completeness independent during revalidation. */
export function createThreadSearchResultsAtomFamily<E>(options: {
  readonly getSearchAtom: (
    environmentId: EnvironmentId,
    query: string,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, E>>;
  readonly getEnvironmentAtom?: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<EnvironmentPresentation | null>;
  readonly labelPrefix: string;
}) {
  return Atom.family((key: string) =>
    Atom.make((get): ThreadSearchResultsState => {
      const parsedKey = parseThreadSearchKey(key);
      if (Option.isNone(parsedKey)) {
        return { matches: [], isLoading: false, sources: [] };
      }

      const [environmentIds, query] = parsedKey.value;
      const matches: EnvironmentThreadSearchMatch[] = [];
      let isLoading = false;
      const sources: ThreadSearchSource[] = [];

      for (const environmentId of environmentIds) {
        const result = get(options.getSearchAtom(environmentId, query));
        const environment =
          options.getEnvironmentAtom === undefined
            ? undefined
            : get(options.getEnvironmentAtom(environmentId));
        const phase = environment?.connection.phase;
        const unavailable = environment === null || (phase !== undefined && phase !== "connected");
        const unsupported =
          phase === "unsupported" ||
          (result._tag === "Failure" &&
            Cause.pretty(result.cause).includes(
              `Unknown request tag: ${ORCHESTRATION_WS_METHODS.searchThreads}`,
            ));
        const value = Option.getOrNull(AsyncResult.value(result));
        const status: ThreadSearchSource["status"] = unsupported
          ? "unsupported"
          : unavailable
            ? "disconnected"
            : result.waiting || result._tag === "Initial"
              ? "pending"
              : result._tag === "Failure"
                ? "failed"
                : value !== null && value.matches.length >= THREAD_SEARCH_LIMIT
                  ? "limited"
                  : "complete";
        isLoading ||= status === "pending";
        sources.push({
          environmentId,
          label: environment?.entry.target.label ?? environmentId,
          status,
          isStale: value !== null && status !== "complete" && status !== "limited",
        });
        if (value !== null) {
          matches.push(
            ...value.matches.map((match) => ({
              ...match,
              environmentId,
            })),
          );
        }
      }

      return { matches, isLoading, sources };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${key}`)),
  );
}

/** Shared wording for web and native search; limits are possible, not proven omissions. */
export function threadSearchSourceMessage(source: ThreadSearchSource): string | null {
  const cached = source.isStale ? " Showing cached matches." : "";
  switch (source.status) {
    case "complete":
      return null;
    case "pending":
      return `${source.label}: searching messages…${cached}`;
    case "failed":
      return `${source.label}: message search failed.${cached}`;
    case "disconnected":
      return `${source.label}: not connected; message search unavailable.${cached}`;
    case "unsupported":
      return `${source.label}: message search unavailable with this server version. Local titles still searched.${cached}`;
    case "limited":
      return `${source.label}: showing up to ${THREAD_SEARCH_LIMIT} message matches; more may exist. Refine your search.`;
  }
}
