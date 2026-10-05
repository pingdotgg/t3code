import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  parseDescription,
  sortedStrings,
} from "./ownership.ts";

const MAX_NAME_LENGTH = 100;
const DEFAULT_LOCATION = "global";

export type LogScopeProps = {
  /**
   * Log scope id (the `{logScope}` segment of
   * `projects/{project}/locations/{location}/logScopes/{logScope}`). If
   * omitted, a unique name is generated from the stack, stage, and
   * logical id. Limited to 100 characters: letters, digits, underscores,
   * hyphens, periods; first character must be alphanumeric. Immutable —
   * changing it replaces the log scope.
   */
  logScopeId?: string;
  /**
   * Location. Log scopes are only available in `global`. Immutable —
   * changing it replaces the log scope.
   * @default "global"
   */
  location?: string;
  /**
   * Parent resources whose logs this scope covers. Each entry is
   * `projects/{project}` or a log view
   * `projects/{project}/locations/{location}/buckets/{bucket}/views/{view}`.
   * At most 5 projects and 100 resources total. Organizations and folders
   * are not supported.
   */
  resourceNames: string[];
  /**
   * Human-readable description (max 8000 characters). Log scopes have no
   * labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes.
   */
  description?: string;
};

export type LogScope = Resource<
  "GCP.Logging.LogScope",
  LogScopeProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/logScopes/{logScopeId}`. */
    name: string;
    /** Log scope id (last path segment). */
    logScopeId: string;
    /** Project id. */
    project: string;
    /** Location (`global`). */
    location: string;
    /** Covered parent resources. */
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
 * A Cloud Logging log scope — a named collection of projects and log
 * views to query together.
 *
 * Log scopes exist only in the `global` location. They have no labels
 * field, so Alchemy stamps ownership into the description for `list` /
 * nuke. `logScopeId` and `location` are identity — changing either
 * replaces the scope. `resourceNames` and description update in place.
 *
 * ### Creating a Log Scope
 * **Example:** Generated name covering this project
 * ```typescript
 * const scope = yield* GCP.Logging.LogScope("App", {
 *   resourceNames: ["projects/my-project"],
 *   description: "application logs",
 * });
 * ```
 *
 * **Example:** Named scope
 * ```typescript
 * const scope = yield* GCP.Logging.LogScope("App", {
 *   logScopeId: "app-logs",
 *   resourceNames: ["projects/my-project"],
 * });
 * ```
 *
 * ### Updating a Log Scope
 * **Example:** Change the description
 * ```typescript
 * const scope = yield* GCP.Logging.LogScope("App", {
 *   resourceNames: ["projects/my-project"],
 *   description: "all application logs",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const LogScope = Resource<LogScope>("GCP.Logging.LogScope");

export class LogScopeNotResolved extends Data.TaggedError(
  "GCP.Logging.LogScopeNotResolved",
)<{
  name: string;
}> {}

const parseScopeName = (name: string) => {
  const match = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/logScopes\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    project: match[1]!,
    location: match[2]!,
    logScopeId: match[3]!,
  };
};

const resourceName = (project: string, location: string, logScopeId: string) =>
  `projects/${project}/locations/${location}/logScopes/${logScopeId}`;

const logScopeIdOf = (scope: logging.LogScope, fallback?: string) => {
  const parsed = parseScopeName(scope.name ?? "");
  return parsed?.logScopeId ?? fallback ?? lastSegment(scope.name ?? "");
};

const toId = (id: string, logScopeId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (logScopeId !== undefined) return logScopeId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z0-9]/.test(generated)
      ? generated
      : `s${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const toAttrs = (
  scope: logging.LogScope,
  project: string,
  location: string,
) => {
  const logScopeId = logScopeIdOf(scope);
  const parsed = parseDescription(scope.description);
  const parsedName = parseScopeName(scope.name ?? "");
  const resolvedLocation = parsedName?.location ?? location;
  const resolvedProject = parsedName?.project ?? project;
  return {
    name:
      scope.name ??
      (logScopeId
        ? resourceName(resolvedProject, resolvedLocation, logScopeId)
        : ""),
    logScopeId,
    project: resolvedProject,
    location: resolvedLocation,
    resourceNames: [...(scope.resourceNames ?? [])],
    description: parsed.description,
    createTime: scope.createTime,
    updateTime: scope.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getProjectsLocationsLogScopes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const LogScopeProvider = () =>
  Provider.succeed(LogScope, {
    stables: ["name", "logScopeId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.logScopeId ?? output?.logScopeId;
      const idChanged =
        previousId !== undefined &&
        news.logScopeId !== undefined &&
        news.logScopeId !== previousId;
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
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const logScopeId = yield* toId(id, olds?.logScopeId, output?.logScopeId);
      const name =
        output?.name ?? resourceName(env.project, location, logScopeId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, location);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* logging.listProjectsLocationsLogScopes
          .pages({
            parent: `projects/${env.project}/locations/${DEFAULT_LOCATION}`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.logScopes ?? [])),
            Stream.filter((scope) => hasOwnershipMarker(scope.description)),
            Stream.map((scope) =>
              toAttrs(scope, env.project, DEFAULT_LOCATION),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? DEFAULT_LOCATION;
      const logScopeId = yield* toId(id, news.logScopeId, output?.logScopeId);
      const name = resourceName(env.project, location, logScopeId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredResources = [...news.resourceNames];

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createProjectsLocationsLogScopes({
            parent: `projects/${env.project}/locations/${location}`,
            logScopeId,
            body: {
              resourceNames: desiredResources,
              description: desiredDescription,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new LogScopeNotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const resourcesChanged =
        JSON.stringify(sortedStrings(current.resourceNames)) !==
        JSON.stringify(sortedStrings(desiredResources));
      const updateMask = [
        descriptionChanged ? "description" : undefined,
        resourcesChanged ? "resourceNames" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* logging.patchProjectsLocationsLogScopes({
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
      yield* logging
        .deleteProjectsLocationsLogScopes({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
