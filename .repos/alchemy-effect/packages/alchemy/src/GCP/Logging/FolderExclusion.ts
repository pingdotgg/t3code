import * as logging from "@distilled.cloud/gcp/logging_v2";
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
  encodeDescription,
  folderParent,
  hasOwnershipMarker,
  lastSegment,
  lookupProjectFolderId,
  parseDescription,
  resolveFolderId,
  toPhysicalId,
} from "./internal.ts";

export type FolderExclusionProps = {
  /**
   * Exclusion id (the `{exclusion}` segment of
   * `folders/{folder}/exclusions/{exclusion}`). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Limited to 100
   * characters: letters, digits, underscores, hyphens, periods; first
   * character must be alphanumeric. Immutable — changing it replaces the
   * exclusion.
   */
  exclusionId?: string;
  /**
   * Folder id (`123456789` or `folders/{id}`). If omitted, Alchemy uses
   * the parent folder of the current project. Immutable — changing it
   * replaces the exclusion.
   */
  folderId?: string;
  /**
   * Advanced logs filter matching entries to exclude from the `_Default`
   * sink. Required.
   */
  filter: string;
  /**
   * Human-readable description. Logging exclusions have no labels field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * When true, the exclusion exists but does not exclude any entries.
   * @default false
   */
  disabled?: boolean;
};

export type FolderExclusion = Resource<
  "GCP.Logging.FolderExclusion",
  FolderExclusionProps,
  {
    /** Full resource name `folders/{folder}/exclusions/{exclusionId}`. */
    name: string;
    /** Exclusion id (last path segment). */
    exclusionId: string;
    /** Folder id. */
    folderId: string;
    /** Advanced logs filter. */
    filter: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Whether the exclusion is disabled. */
    disabled: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Logging exclusion on a folder `_Default` sink.
 *
 * Exclusions drop matching log entries before they are stored in the
 * `_Default` bucket (they do not apply to `_Required`). Folder exclusions
 * do not apply to child projects. Logging exclusions have no labels field,
 * so Alchemy stamps ownership into the description for `list` / nuke.
 * Name is identity — changing `exclusionId` or `folderId` replaces the
 * exclusion.
 *
 * ### Creating a Folder Exclusion
 * **Example:** Generated name, drop debug logs
 * ```typescript
 * const exclusion = yield* GCP.Logging.FolderExclusion("DropDebug", {
 *   filter: "severity=DEBUG",
 *   description: "drop debug entries",
 * });
 * ```
 *
 * **Example:** Named exclusion on an explicit folder
 * ```typescript
 * const exclusion = yield* GCP.Logging.FolderExclusion("DropDebug", {
 *   folderId: "123456789",
 *   exclusionId: "drop-debug",
 *   filter: "severity=DEBUG",
 * });
 * ```
 *
 * ### Updating a Folder Exclusion
 * **Example:** Change the filter and disable
 * ```typescript
 * const exclusion = yield* GCP.Logging.FolderExclusion("DropDebug", {
 *   filter: "severity<ERROR",
 *   description: "drop non-errors",
 *   disabled: true,
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const FolderExclusion = Resource<FolderExclusion>(
  "GCP.Logging.FolderExclusion",
);

export class FolderExclusionNotResolved extends Data.TaggedError(
  "GCP.Logging.FolderExclusionNotResolved",
)<{
  name: string;
}> {}

const resourceName = (folderId: string, exclusionId: string) =>
  `${folderParent(folderId)}/exclusions/${exclusionId}`;

const exclusionIdOf = (exclusion: logging.LogExclusion) => {
  const raw = exclusion.name ?? "";
  return raw.includes("/") ? lastSegment(raw) : raw;
};

const folderIdOfName = (name: string, fallback: string) => {
  const match = name.match(/^folders\/([^/]+)\//);
  return match?.[1] ?? fallback;
};

const toAttrs = (exclusion: logging.LogExclusion, folderId: string) => {
  const exclusionId = exclusionIdOf(exclusion);
  const parsed = parseDescription(exclusion.description);
  const folder = folderIdOfName(exclusion.name ?? "", folderId);
  return {
    name:
      exclusion.name?.includes("/") === true
        ? exclusion.name
        : resourceName(folder, exclusionId),
    exclusionId,
    folderId: folder,
    filter: exclusion.filter ?? "",
    description: parsed.description,
    disabled: exclusion.disabled === true,
    createTime: exclusion.createTime,
    updateTime: exclusion.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getFoldersExclusions({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const FolderExclusionProvider = () =>
  Provider.succeed(FolderExclusion, {
    stables: ["name", "exclusionId", "folderId", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.exclusionId ?? output?.exclusionId;
      const idChanged =
        previousId !== undefined &&
        news.exclusionId !== undefined &&
        news.exclusionId !== previousId;
      const previousFolder = olds?.folderId ?? output?.folderId;
      const folderChanged =
        previousFolder !== undefined &&
        news.folderId !== undefined &&
        lastSegment(news.folderId) !== lastSegment(previousFolder);
      if (!idChanged && !folderChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const folderId = yield* resolveFolderId(olds?.folderId, output?.folderId);
      const exclusionId = yield* toPhysicalId(
        id,
        olds?.exclusionId,
        output?.exclusionId,
        "e",
      );
      const name = output?.name ?? resourceName(folderId, exclusionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, folderId);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const folderId = yield* lookupProjectFolderId(env.project);
        if (folderId === undefined) return [];
        return yield* logging.listFoldersExclusions
          .pages({
            parent: folderParent(folderId),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.exclusions ?? []),
            ),
            Stream.filter((exclusion) =>
              hasOwnershipMarker(exclusion.description),
            ),
            Stream.map((exclusion) => toAttrs(exclusion, folderId)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as FolderExclusion["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const folderId = yield* resolveFolderId(news.folderId, output?.folderId);
      const exclusionId = yield* toPhysicalId(
        id,
        news.exclusionId,
        output?.exclusionId,
        "e",
      );
      const name = resourceName(folderId, exclusionId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createFoldersExclusions({
            parent: folderParent(folderId),
            body: {
              name: exclusionId,
              filter: news.filter,
              description: desiredDescription,
              disabled: news.disabled === true ? true : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new FolderExclusionNotResolved({ name });
      }

      const desiredDisabled = news.disabled === true;
      const filterChanged = (current.filter ?? "") !== news.filter;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const disabledChanged = (current.disabled === true) !== desiredDisabled;

      const updateMask = [
        filterChanged ? "filter" : undefined,
        descriptionChanged ? "description" : undefined,
        disabledChanged ? "disabled" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* logging.patchFoldersExclusions({
          name: current.name?.includes("/") ? current.name : name,
          updateMask: updateMask.join(","),
          body: {
            filter: news.filter,
            description: desiredDescription,
            disabled: desiredDisabled,
          },
        });
      }

      return toAttrs(current, folderId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteFoldersExclusions({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
