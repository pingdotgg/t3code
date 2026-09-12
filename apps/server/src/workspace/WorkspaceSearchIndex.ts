import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Schema from "effect/Schema";
import {
  ProjectListEntriesResult,
  ProjectSearchEntriesResult,
  ProjectSearchContentsResult,
} from "@t3tools/contracts";
import {
  WorkspaceSearchIndex,
  WORKSPACE_INDEX_PAGE_SIZE,
  WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndexRefreshFailed,
  WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndexSearchFailed,
  type WorkspaceSearchIndexVariant,
} from "./WorkspaceSearchIndexService.ts";
import { WorkspaceSearchHost } from "./WorkspaceSearchHost.ts";

export * from "./WorkspaceSearchIndexService.ts";
const WORKSPACE_INDEX_IDLE_TTL = "15 minutes";
const isCreateFailed = Schema.is(WorkspaceSearchIndexCreateFailed);
const isScanTimedOut = Schema.is(WorkspaceSearchIndexScanTimedOut);
const isSearchFailed = Schema.is(WorkspaceSearchIndexSearchFailed);
const isRefreshFailed = Schema.is(WorkspaceSearchIndexRefreshFailed);
const decodeList = Schema.decodeUnknownEffect(ProjectListEntriesResult);
const decodeSearch = Schema.decodeUnknownEffect(ProjectSearchEntriesResult);
const decodeContents = Schema.decodeUnknownEffect(ProjectSearchContentsResult);

export const make = Effect.fn("WorkspaceSearchIndex.make")(function* (
  cwd: string,
  variant: WorkspaceSearchIndexVariant = "paths",
) {
  const host = yield* WorkspaceSearchHost;
  const remote = yield* host.open(cwd, variant).pipe(
    Effect.mapError((cause) =>
      isCreateFailed(cause) || isScanTimedOut(cause)
        ? cause
        : new WorkspaceSearchIndexCreateFailed({
            cwd,
            reason: "Workspace search process could not initialize.",
            cause,
          }),
    ),
  );

  const searchFailure = (queryLength: number, pageSize: number) => (cause: unknown) =>
    isSearchFailed(cause)
      ? cause
      : new WorkspaceSearchIndexSearchFailed({
          cwd,
          queryLength,
          pageSize,
          reason: "Workspace search process failed.",
          cause,
        });

  return WorkspaceSearchIndex.of({
    list: () =>
      remote
        .request({ method: "list" })
        .pipe(
          Effect.flatMap(decodeList),
          Effect.mapError(searchFailure(0, WORKSPACE_INDEX_PAGE_SIZE)),
        ),
    search: (query, limit, kind, imageOnly) =>
      remote
        .request({ method: "search", query, limit, kind, imageOnly })
        .pipe(
          Effect.flatMap(decodeSearch),
          Effect.mapError(
            searchFailure(
              query.length,
              imageOnly ? WORKSPACE_INDEX_PAGE_SIZE : Math.max(1, limit + 1),
            ),
          ),
        ),
    searchContents: (input) =>
      remote
        .request({ method: "searchContents", input })
        .pipe(
          Effect.flatMap(decodeContents),
          Effect.mapError(searchFailure(input.query.length, input.limit)),
        ),
    refresh: () =>
      remote.request({ method: "refresh" }).pipe(
        Effect.asVoid,
        Effect.mapError((cause) =>
          isRefreshFailed(cause) || isScanTimedOut(cause)
            ? cause
            : new WorkspaceSearchIndexRefreshFailed({
                cwd,
                reason: "Workspace search process failed.",
                cause,
              }),
        ),
      ),
  });
});

/**
 * Composite LayerMap key so the lightweight path index and the on-demand
 * content-search index of the same workspace are separate resources with
 * independent lifecycles. "\n" cannot appear in a filesystem path.
 */
export const workspaceSearchIndexKey = (cwd: string, variant: WorkspaceSearchIndexVariant) =>
  `${variant}\n${cwd}`;

function parseWorkspaceSearchIndexKey(key: string): {
  readonly cwd: string;
  readonly variant: WorkspaceSearchIndexVariant;
} {
  const separatorIndex = key.indexOf("\n");
  return {
    variant: key.slice(0, separatorIndex) as WorkspaceSearchIndexVariant,
    cwd: key.slice(separatorIndex + 1),
  };
}

/**
 * A layer factory is required because every index is scoped to a concrete
 * workspace root and variant. WorkspaceSearchIndexMap owns memoization and
 * idle cleanup; using a default cwd here would mix resources from different
 * workspaces.
 *
 * @public Service construction is part of the canonical Effect module API.
 */
export const layer = (key: string) => {
  const { cwd, variant } = parseWorkspaceSearchIndexKey(key);
  return Layer.effect(WorkspaceSearchIndex, make(cwd, variant));
};

export class WorkspaceSearchIndexMap extends LayerMap.Service<WorkspaceSearchIndexMap>()(
  "t3/workspace/WorkspaceSearchIndexMap",
  {
    lookup: layer,
    dependencies: [WorkspaceSearchHost.layer],
    idleTimeToLive: WORKSPACE_INDEX_IDLE_TTL,
  },
) {}
