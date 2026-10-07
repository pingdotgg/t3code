import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  createOwnership,
  encodeDescription,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  locationParent,
  ownedBy,
  parseDescription,
  parseLoggingName,
  scopeParent,
  toPhysicalId,
} from "./internal.ts";

export type FolderLogScopeProps = {
  /**
   * Folder id (`folders/{folder}` or the numeric id). When omitted, the
   * stack project is used. Immutable — changing it replaces the log
   * scope.
   */
  folderId?: string;
  /**
   * Location of the log scope. Log scopes are only available in `global`.
   * Immutable — changing it replaces the log scope.
   * @default "global"
   */
  location?: string;
  /**
   * Log scope id (the `{logScope}` segment of
   * `{parent}/locations/{location}/logScopes/{logScope}`). If omitted, a
   * unique name is generated. Limited to 100 characters: letters, digits,
   * underscores, hyphens, periods; first character must be alphanumeric.
   * Immutable — changing it replaces the log scope.
   */
  logScopeId?: string;
  /**
   * Parent resources to read log entries from. Project names
   * (`projects/{project}`) and/or log views
   * (`projects/{project}/locations/{location}/buckets/{bucket}/views/{view}`).
   * Organizations and folders are not supported. Max 5 projects and 100
   * resources total.
   */
  resourceNames: string[];
  /**
   * Human-readable description (max 8000 characters). Log scopes have no
   * labels field, so Alchemy ownership is stored in a `[alchemy …]` prefix
   * and stripped from attributes.
   */
  description?: string;
};

export type FolderLogScope = Resource<
  "GCP.Logging.FolderLogScope",
  FolderLogScopeProps,
  {
    /** Full resource name `{parent}/locations/{location}/logScopes/{logScopeId}`. */
    name: string;
    /** Log scope id (last path segment). */
    logScopeId: string;
    /** Parent resource (`folders/{folder}` or `projects/{project}`). */
    parent: string;
    /** Folder id when the parent is a folder. */
    folderId: string | undefined;
    /** Location (`global`). */
    location: string;
    /** Resource names included in the scope. */
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
 * A Cloud Logging log scope grouping projects and views to read together.
 *
 * Log scopes exist only in `global`. They have no labels field, so Alchemy
 * stamps ownership into the description for `list` / nuke. `folderId`,
 * `logScopeId`, and `location` are identity — changing any of them
 * replaces the log scope. `resourceNames` and `description` update in
 * place. The `_Default` log scope cannot be modified or deleted.
 *
 * ### Creating a Folder Log Scope
 * **Example:** Scope the stack project
 * ```typescript
 * const scope = yield* GCP.Logging.FolderLogScope("App", {
 *   resourceNames: ["projects/my-project"],
 *   description: "application logs",
 * });
 * ```
 *
 * ### Updating a Folder Log Scope
 * **Example:** Change the description
 * ```typescript
 * const scope = yield* GCP.Logging.FolderLogScope("App", {
 *   resourceNames: ["projects/my-project"],
 *   description: "updated application logs",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const FolderLogScope = Resource<FolderLogScope>(
  "GCP.Logging.FolderLogScope",
);

export class FolderLogScopeNotResolved extends Data.TaggedError(
  "GCP.Logging.FolderLogScopeNotResolved",
)<{
  name: string;
}> {}

const resourceName = (parent: string, location: string, logScopeId: string) =>
  `${locationParent(parent, location)}/logScopes/${logScopeId}`;

const folderIdOf = (parent: string) =>
  parent.startsWith("folders/") ? lastSegment(parent) : undefined;

const sortedNames = (names: readonly string[] | undefined) =>
  [...(names ?? [])].slice().sort();

const toAttrs = (scope: logging.LogScope, parent: string, location: string) => {
  const parsed = parseLoggingName(scope.name ?? "");
  const logScopeId = parsed.logScopeId ?? lastSegment(scope.name ?? "");
  const resolvedParent = parsed.parent || parent;
  const resolvedLocation = parsed.location ?? location;
  const description = parseDescription(scope.description);
  return {
    name:
      scope.name ??
      (logScopeId
        ? resourceName(resolvedParent, resolvedLocation, logScopeId)
        : ""),
    logScopeId,
    parent: resolvedParent,
    folderId: folderIdOf(resolvedParent),
    location: resolvedLocation,
    resourceNames: [...(scope.resourceNames ?? [])],
    description: description.description,
    createTime: scope.createTime,
    updateTime: scope.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getFoldersLocationsLogScopes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const FolderLogScopeProvider = () =>
  Provider.succeed(FolderLogScope, {
    stables: [
      "name",
      "logScopeId",
      "parent",
      "folderId",
      "location",
      "createTime",
    ],

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
      const previousFolder = olds?.folderId ?? output?.folderId;
      const folderChanged =
        news.folderId !== undefined && news.folderId !== previousFolder;
      if (!idChanged && !locationChanged && !folderChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = scopeParent(
        env.project,
        olds?.folderId ?? output?.folderId,
      );
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const logScopeId = yield* toPhysicalId(
        id,
        olds?.logScopeId,
        output?.logScopeId,
        "s",
      );
      const name = output?.name ?? resourceName(parent, location, logScopeId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, parent, location);
      const { labels } = parseDescription(existing.description);
      return (yield* ownedBy(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* logging.listFoldersLocationsLogScopes
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.logScopes ?? [])),
            Stream.filter((scope) => hasOwnershipMarker(scope.description)),
            Stream.map((scope) =>
              toAttrs(
                scope,
                parseLoggingName(scope.name ?? "").parent ||
                  `projects/${env.project}`,
                parseLoggingName(scope.name ?? "").location ?? DEFAULT_LOCATION,
              ),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = scopeParent(
        env.project,
        news.folderId ?? output?.folderId,
      );
      const location = news.location ?? output?.location ?? DEFAULT_LOCATION;
      const logScopeId = yield* toPhysicalId(
        id,
        news.logScopeId,
        output?.logScopeId,
        "s",
      );
      const name = resourceName(parent, location, logScopeId);
      const ownership = yield* createOwnership(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createFoldersLocationsLogScopes({
            parent: locationParent(parent, location),
            logScopeId,
            body: {
              resourceNames: [...news.resourceNames],
              description: desiredDescription,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new FolderLogScopeNotResolved({ name });
      }

      const namesChanged = !jsonEqual(
        sortedNames(current.resourceNames),
        sortedNames(news.resourceNames),
      );
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const updateMask = [
        namesChanged ? "resourceNames" : undefined,
        descriptionChanged ? "description" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* logging.patchFoldersLocationsLogScopes({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            resourceNames: [...news.resourceNames],
            description: desiredDescription,
          },
        });
      }

      return toAttrs(current, parent, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteFoldersLocationsLogScopes({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
