import { ExtensionOperationError } from "@t3tools/contracts";
import {
  WORKSPACE_SEARCH_API,
  type WorkspaceContentMatch,
  type WorkspaceSearchResultEntry,
} from "@t3tools/extension-sdk/catalogue";
import type { Json } from "@t3tools/extension-sdk/contracts";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { WorkspaceEntries } from "../workspace/WorkspaceEntries.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

const LINE_CONTENT_MAX_LENGTH = 8192;
const PATH_MAX_LENGTH = 512;
const failure = (detail: string) =>
  new ExtensionOperationError({ operation: "workspace.search", detail });
const searchInput = Schema.decodeUnknownSync(
  Schema.Struct({
    query: Schema.String.check(Schema.isMaxLength(256)),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
    kind: Schema.optional(Schema.Literals(["file", "directory"])),
    imageOnly: Schema.optional(Schema.Boolean),
  }),
  { onExcessProperty: "error" },
);
const searchContentsInput = Schema.decodeUnknownSync(
  Schema.Struct({
    query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
    caseSensitive: Schema.optional(Schema.Boolean),
    wholeWord: Schema.optional(Schema.Boolean),
    useRegex: Schema.optional(Schema.Boolean),
  }),
  { onExcessProperty: "error" },
);

/**
 * The contract bounds paths at 512 chars and lines at 8192 chars while the
 * native index is unbounded. Over-long results are dropped/clamped and the
 * result reports `truncated: true` so the wire state stays honest.
 */
function boundEntries(entries: ReadonlyArray<{ path: string; kind: "file" | "directory" }>): {
  readonly entries: WorkspaceSearchResultEntry[];
  readonly overflow: boolean;
} {
  const bounded = entries.filter((entry) => entry.path.length <= PATH_MAX_LENGTH);
  return { entries: bounded, overflow: bounded.length !== entries.length };
}
function boundMatch(match: {
  path: string;
  lineNumber: number;
  lineContent: string;
  matchRanges: ReadonlyArray<{ start: number; end: number }>;
}): WorkspaceContentMatch | null {
  if (match.path.length > PATH_MAX_LENGTH) return null;
  const lineContent = match.lineContent.slice(0, LINE_CONTENT_MAX_LENGTH);
  const matchRanges = match.matchRanges.flatMap((range) => {
    if (range.start >= lineContent.length) return [];
    return [{ start: range.start, end: Math.min(range.end, lineContent.length) }];
  });
  return { path: match.path, lineNumber: match.lineNumber, lineContent, matchRanges };
}

/** Caller supplies no cwd; the granted project root is resolved host-side. */
export function createWorkspaceSearchApiProvider(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0] & {
    readonly entries: Pick<WorkspaceEntries["Service"], "search" | "searchContents">;
  },
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  const invoke = Effect.fn("WorkspaceSearchApi.invoke")(function* (
    method: string,
    input: unknown,
    context: Parameters<typeof resolve>[0],
  ) {
    const scope = yield* resolve(context);
    let result: Json;
    if (method === "search") {
      const safe = yield* Effect.try({
        try: () => searchInput(input),
        catch: () => failure("Invalid workspace search request."),
      });
      const found = yield* dependencies.entries
        .search({
          cwd: scope.cwd,
          query: safe.query,
          limit: safe.limit ?? 100,
          ...(safe.kind === undefined ? {} : { kind: safe.kind }),
          ...(safe.imageOnly === undefined ? {} : { imageOnly: safe.imageOnly }),
        })
        .pipe(Effect.mapError(() => failure("Workspace search is unavailable for this project.")));
      const bounded = boundEntries(found.entries);
      result = { entries: bounded.entries, truncated: found.truncated || bounded.overflow };
    } else if (method === "searchContents") {
      const safe = yield* Effect.try({
        try: () => searchContentsInput(input),
        catch: () => failure("Invalid workspace content search request."),
      });
      const found = yield* dependencies.entries
        .searchContents({
          cwd: scope.cwd,
          query: safe.query,
          limit: safe.limit ?? 100,
          caseSensitive: safe.caseSensitive ?? false,
          wholeWord: safe.wholeWord ?? false,
          useRegex: safe.useRegex ?? false,
        })
        .pipe(Effect.mapError(() => failure("Workspace search is unavailable for this project.")));
      const matches = found.matches.flatMap((match) => {
        const bounded = boundMatch(match);
        return bounded === null ? [] : [bounded];
      });
      result = {
        matches,
        truncated: found.truncated || matches.length !== found.matches.length,
        ...(found.regexFallbackError === undefined
          ? {}
          : { regexFallbackError: found.regexFallbackError.slice(0, 512) }),
      };
    } else return yield* failure("Workspace search method is unavailable.");
    yield* resolve(scope.context);
    return result;
  });
  return {
    providerId: "host.workspace-search",
    definition: WORKSPACE_SEARCH_API,
    invoke: (method, input, context, signal) =>
      Effect.runPromise(invoke(method, input, context), { signal }),
  };
}

export const makeWorkspaceSearchApiProvider = Effect.fn("WorkspaceSearchApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  return createWorkspaceSearchApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    entries: yield* WorkspaceEntries,
  });
});
