import * as observability from "@distilled.cloud/gcp/observability_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_TRACE_LOCATION,
  encodeDescription,
  expandResourceNames,
  hasOwnershipMarker,
  parseDescription,
  parseScopeName,
  sameStringList,
  scopeResourceName,
  toScopeId,
} from "./internal.ts";

export type TraceScopeProps = {
  /**
   * Trace scope id (the `{traceScope}` segment of
   * `projects/{project}/locations/{location}/traceScopes/{traceScope}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Limited to 100 characters: letters, digits, underscores,
   * hyphens, periods; first character must be alphanumeric. Immutable —
   * changing it replaces the scope. The system-managed `_Default` scope
   * cannot be deleted.
   */
  traceScopeId?: string;
  /**
   * Location. Trace scopes are only available in `global`. Immutable —
   * changing it replaces the scope.
   * @default "global"
   */
  location?: string;
  /**
   * Projects whose traces this scope queries together. Each entry is
   * `projects/{project}`. At most 20 projects. Bare project ids are
   * expanded. If omitted, the current project is used.
   */
  resourceNames?: string[];
  /**
   * Human-readable description (max 8000 characters). Trace scopes have
   * no labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes.
   */
  description?: string;
};

export type TraceScope = Resource<
  "GCP.Observability.TraceScope",
  TraceScopeProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/traceScopes/{traceScopeId}`. */
    name: string;
    /** Trace scope id (last path segment). */
    traceScopeId: string;
    /** Project id. */
    project: string;
    /** Location (`global`). */
    location: string;
    /** Covered projects (`projects/{project}`). */
    resourceNames: string[];
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Observability trace scope — a named collection of projects
 * whose traces are queried together in Trace Explorer.
 *
 * Trace scopes exist only in the `global` location. They have no labels
 * field, so Alchemy stamps ownership into the description for `list` /
 * nuke. `traceScopeId` and `location` are identity — changing either
 * replaces the scope. `resourceNames` and description update in place.
 * The system-managed `_Default` scope cannot be deleted.
 *
 * ### Creating a Trace Scope
 * **Example:** Generated name covering this project
 * ```typescript
 * const scope = yield* GCP.Observability.TraceScope("App", {
 *   resourceNames: ["projects/my-project"],
 *   description: "application traces",
 * });
 * ```
 *
 * **Example:** Named scope
 * ```typescript
 * const scope = yield* GCP.Observability.TraceScope("App", {
 *   traceScopeId: "app-traces",
 *   resourceNames: ["projects/my-project"],
 * });
 * ```
 *
 * ### Updating a Trace Scope
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Change the description
 * ```typescript
 * const scope = yield* GCP.Observability.TraceScope("App", {
 *   resourceNames: ["projects/my-project"],
 *   description: "all application traces",
 * });
 * ```
 *
 * @resource
 * @category Observability
 */
export const TraceScope = Resource<TraceScope>("GCP.Observability.TraceScope");

export class TraceScopeNotResolved extends Data.TaggedError(
  "GCP.Observability.TraceScopeNotResolved",
)<{
  name: string;
}> {}

const traceScopeIdOf = (scope: observability.TraceScope, fallback?: string) => {
  const parsed = parseScopeName(scope.name ?? "");
  return (
    parsed?.traceScopeId ??
    fallback ??
    (scope.name ?? "").split("/").pop() ??
    ""
  );
};

const toAttrs = (
  scope: observability.TraceScope,
  project: string,
  location: string,
) => {
  const traceScopeId = traceScopeIdOf(scope);
  const parsed = parseDescription(scope.description);
  const parsedName = parseScopeName(scope.name ?? "");
  const resolvedLocation = parsedName?.location ?? location;
  const resolvedProject = parsedName?.project ?? project;
  return {
    name:
      scope.name ??
      (traceScopeId
        ? scopeResourceName(resolvedProject, resolvedLocation, traceScopeId)
        : ""),
    traceScopeId,
    project: resolvedProject,
    location: resolvedLocation,
    resourceNames: [...(scope.resourceNames ?? [])],
    description: parsed.description,
    createTime: scope.createTime,
    updateTime: scope.updateTime,
  };
};

const getByName = (name: string) =>
  observability
    .getProjectsLocationsTraceScopes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const TraceScopeProvider = () =>
  Provider.succeed(TraceScope, {
    stables: ["name", "traceScopeId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.traceScopeId ?? output?.traceScopeId;
      const idChanged =
        previousId !== undefined &&
        news.traceScopeId !== undefined &&
        news.traceScopeId !== previousId;
      const previousLocation = olds?.location ?? output?.location;
      const locationChanged =
        previousLocation !== undefined &&
        news.location !== undefined &&
        news.location !== previousLocation;
      if (!idChanged && !locationChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location =
        olds?.location ?? output?.location ?? DEFAULT_TRACE_LOCATION;
      const traceScopeId = yield* toScopeId(
        id,
        olds?.traceScopeId,
        output?.traceScopeId,
      );
      const name =
        output?.name ?? scopeResourceName(env.project, location, traceScopeId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, location);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* observability.listProjectsLocationsTraceScopes
          .pages({
            parent: `projects/${env.project}/locations/${DEFAULT_TRACE_LOCATION}`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.traceScopes ?? []),
            ),
            Stream.filter((scope) => hasOwnershipMarker(scope.description)),
            Stream.map((scope) =>
              toAttrs(scope, env.project, DEFAULT_TRACE_LOCATION),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as ReturnType<typeof toAttrs>[]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location =
        news.location ?? output?.location ?? DEFAULT_TRACE_LOCATION;
      const traceScopeId = yield* toScopeId(
        id,
        news.traceScopeId,
        output?.traceScopeId,
      );
      const name = scopeResourceName(env.project, location, traceScopeId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredResources = expandResourceNames(
        news.resourceNames,
        env.project,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* observability
          .createProjectsLocationsTraceScopes({
            parent: `projects/${env.project}/locations/${location}`,
            traceScopeId,
            body: {
              resourceNames: desiredResources,
              description: desiredDescription,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TraceScopeNotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const resourcesChanged = !sameStringList(
        current.resourceNames,
        desiredResources,
      );
      const updateMask = [
        descriptionChanged ? "description" : undefined,
        resourcesChanged ? "resourceNames" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* observability.patchProjectsLocationsTraceScopes({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            resourceNames: desiredResources,
            description: desiredDescription,
          },
        });
      }

      return toAttrs(current, env.project, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.traceScopeId === "_Default") return;
      yield* observability
        .deleteProjectsLocationsTraceScopes({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
