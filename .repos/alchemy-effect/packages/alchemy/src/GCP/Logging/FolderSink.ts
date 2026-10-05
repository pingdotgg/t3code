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
  createOwnership,
  encodeDescription,
  exclusionsOf,
  hasOwnershipMarker,
  lastSegment,
  ownedBy,
  parseDescription,
  parseLoggingName,
  sameExclusions,
  scopeParent,
  toExclusionsBody,
  toPhysicalId,
  type SinkExclusion,
} from "./internal.ts";

export type FolderSinkExclusion = SinkExclusion;

export type FolderSinkBigQueryOptions = {
  /**
   * Use BigQuery partitioned tables instead of dated tables
   * (`syslog_20170523`). Only applies when `destination` is a BigQuery
   * dataset.
   * @default false
   */
  usePartitionedTables?: boolean;
};

export type FolderSinkProps = {
  /**
   * Folder id (`folders/{folder}` or the numeric id). When omitted, the
   * stack project is used. Immutable — changing it replaces the sink.
   */
  folderId?: string;
  /**
   * Sink id (the `{sink}` segment of `{parent}/sinks/{sink}`). If omitted,
   * a unique name is generated from the stack, stage, and logical id.
   * Limited to 100 characters: letters, digits, underscores, hyphens,
   * periods; first character must be alphanumeric. Immutable — changing
   * it replaces the sink.
   */
  sinkId?: string;
  /**
   * Export destination. One of:
   * `storage.googleapis.com/[GCS_BUCKET]`,
   * `bigquery.googleapis.com/projects/[PROJECT_ID]/datasets/[DATASET]`,
   * `pubsub.googleapis.com/projects/[PROJECT_ID]/topics/[TOPIC_ID]`,
   * `logging.googleapis.com/projects/[PROJECT_ID]`,
   * `logging.googleapis.com/projects/[PROJECT_ID]/locations/[LOCATION_ID]/buckets/[BUCKET_ID]`.
   */
  destination: string;
  /**
   * Advanced logs filter. Only matching entries in the sink's parent are
   * exported. Empty or omitted exports every entry.
   */
  filter?: string;
  /**
   * Human-readable description (max 8000 characters). Logging sinks have
   * no labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes.
   */
  description?: string;
  /**
   * When true, the sink exists but does not export any log entries.
   * @default false
   */
  disabled?: boolean;
  /**
   * Exclusion filters. An entry matching `filter` and any exclusion is
   * not exported.
   */
  exclusions?: FolderSinkExclusion[];
  /**
   * BigQuery-specific export options. Ignored unless `destination` is a
   * BigQuery dataset.
   */
  bigqueryOptions?: FolderSinkBigQueryOptions;
  /**
   * When true, Cloud Logging assigns a unique writer service account as
   * `writerIdentity`. Folder sinks always receive a writer identity.
   */
  uniqueWriterIdentity?: boolean;
  /**
   * Caller-provided writer service account
   * (`serviceAccount:some@email`). Only valid when routing to a log
   * bucket in a different project.
   */
  customWriterIdentity?: string;
  /**
   * When true, logs from child projects, folders, and billing accounts
   * are also eligible for export. Folder/org sinks only.
   * @default false
   */
  includeChildren?: boolean;
  /**
   * When true (requires `includeChildren`), matching logs are intercepted
   * and omitted from non-`_Required` child sinks. Folder/org sinks only.
   * @default false
   */
  interceptChildren?: boolean;
};

export type FolderSink = Resource<
  "GCP.Logging.FolderSink",
  FolderSinkProps,
  {
    /** Full resource name `{parent}/sinks/{sink}`. */
    name: string;
    /** Sink id (last path segment). */
    sinkId: string;
    /** Parent resource (`folders/{folder}` or `projects/{project}`). */
    parent: string;
    /** Folder id when the parent is a folder. */
    folderId: string | undefined;
    /** Export destination. */
    destination: string;
    /** Advanced logs filter, if set. */
    filter: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Whether the sink is disabled. */
    disabled: boolean;
    /** Exclusion filters. */
    exclusions: FolderSinkExclusion[];
    /** BigQuery export options, if set. */
    bigqueryOptions: FolderSinkBigQueryOptions | undefined;
    /** Whether child resources are included (org/folder sinks). */
    includeChildren: boolean;
    /** Whether matching child logs are intercepted (org/folder sinks). */
    interceptChildren: boolean;
    /**
     * IAM identity Cloud Logging uses to write to `destination`. Empty
     * for same-project log-bucket destinations.
     */
    writerIdentity: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Logging sink owned by a folder (or the stack project).
 *
 * Logging sinks have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. `folderId` and `sinkId` are identity
 * — changing either replaces the sink. Filter, destination, description,
 * disabled flag, exclusions, and BigQuery options update in place.
 *
 * ### Creating a Folder Sink
 * **Example:** Route errors to the `_Default` log bucket
 * ```typescript
 * const sink = yield* GCP.Logging.FolderSink("Errors", {
 *   destination:
 *     "logging.googleapis.com/projects/my-project/locations/global/buckets/_Default",
 *   filter: "severity>=ERROR",
 * });
 * ```
 *
 * **Example:** Folder-owned sink including children
 * ```typescript
 * const sink = yield* GCP.Logging.FolderSink("Errors", {
 *   folderId: "123456789",
 *   destination:
 *     "logging.googleapis.com/projects/my-project/locations/global/buckets/_Default",
 *   filter: "severity>=ERROR",
 *   includeChildren: true,
 *   uniqueWriterIdentity: true,
 * });
 * ```
 *
 * ### Updating a Folder Sink
 * **Example:** Change the filter
 * ```typescript
 * const sink = yield* GCP.Logging.FolderSink("Errors", {
 *   destination:
 *     "logging.googleapis.com/projects/my-project/locations/global/buckets/_Default",
 *   filter: "severity>=WARNING",
 *   description: "warnings and errors",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const FolderSink = Resource<FolderSink>("GCP.Logging.FolderSink");

export class FolderSinkNotResolved extends Data.TaggedError(
  "GCP.Logging.FolderSinkNotResolved",
)<{
  name: string;
}> {}

const resourceName = (parent: string, sinkId: string) =>
  `${parent}/sinks/${sinkId}`;

const folderIdOf = (parent: string) =>
  parent.startsWith("folders/") ? lastSegment(parent) : undefined;

const sinkIdOf = (sink: logging.LogSink) => {
  const raw = sink.name ?? sink.resourceName ?? "";
  const parsed = parseLoggingName(raw);
  return parsed.sinkId ?? (raw.includes("/") ? lastSegment(raw) : raw);
};

const toAttrs = (sink: logging.LogSink, parent: string) => {
  const sinkId = sinkIdOf(sink);
  const parsed = parseDescription(sink.description);
  const name =
    sink.resourceName ?? (sinkId ? resourceName(parent, sinkId) : "");
  const resolvedParent = parseLoggingName(name).parent || parent;
  const bq = sink.bigqueryOptions;
  return {
    name,
    sinkId,
    parent: resolvedParent,
    folderId: folderIdOf(resolvedParent),
    destination: sink.destination ?? "",
    filter: sink.filter,
    description: parsed.description,
    disabled: sink.disabled === true,
    exclusions: exclusionsOf(sink.exclusions),
    bigqueryOptions:
      bq?.usePartitionedTables !== undefined
        ? { usePartitionedTables: bq.usePartitionedTables }
        : undefined,
    includeChildren: sink.includeChildren === true,
    interceptChildren: sink.interceptChildren === true,
    writerIdentity: sink.writerIdentity,
    createTime: sink.createTime,
    updateTime: sink.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getFoldersSinks({ sinkName: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toCreateBody = (
  sinkId: string,
  props: FolderSinkProps,
  description: string,
): logging.LogSink => ({
  name: sinkId,
  destination: props.destination,
  filter: props.filter,
  description,
  disabled: props.disabled === true ? true : undefined,
  exclusions: toExclusionsBody(props.exclusions),
  bigqueryOptions: props.bigqueryOptions,
  includeChildren: props.includeChildren === true ? true : undefined,
  interceptChildren: props.interceptChildren === true ? true : undefined,
});

export const FolderSinkProvider = () =>
  Provider.succeed(FolderSink, {
    stables: ["name", "sinkId", "parent", "folderId", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.sinkId ?? output?.sinkId;
      const idChanged =
        previous !== undefined &&
        news.sinkId !== undefined &&
        news.sinkId !== previous;
      const previousFolder = olds?.folderId ?? output?.folderId;
      const folderChanged =
        news.folderId !== undefined && news.folderId !== previousFolder;
      if (!idChanged && !folderChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = scopeParent(
        env.project,
        olds?.folderId ?? output?.folderId,
      );
      const sinkId = yield* toPhysicalId(id, olds?.sinkId, output?.sinkId, "s");
      const name = output?.name ?? resourceName(parent, sinkId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, parent);
      const { labels } = parseDescription(existing.description);
      return (yield* ownedBy(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* logging.listFoldersSinks
          .pages({
            parent: `projects/${env.project}`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.sinks ?? [])),
            Stream.filter((sink) => hasOwnershipMarker(sink.description)),
            Stream.map((sink) => toAttrs(sink, `projects/${env.project}`)),
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
      const sinkId = yield* toPhysicalId(id, news.sinkId, output?.sinkId, "s");
      const name = resourceName(parent, sinkId);
      const ownership = yield* createOwnership(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const uniqueWriterIdentity =
        news.uniqueWriterIdentity ??
        (news.folderId !== undefined ? true : undefined);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createFoldersSinks({
            parent,
            uniqueWriterIdentity,
            customWriterIdentity: news.customWriterIdentity,
            body: toCreateBody(sinkId, news, desiredDescription),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new FolderSinkNotResolved({ name });
      }

      const desiredDisabled = news.disabled === true;
      const desiredIncludeChildren = news.includeChildren === true;
      const desiredInterceptChildren = news.interceptChildren === true;
      const desiredBq = news.bigqueryOptions?.usePartitionedTables === true;
      const observedBq = current.bigqueryOptions?.usePartitionedTables === true;

      const destinationChanged =
        (current.destination ?? "") !== news.destination;
      const filterChanged = (current.filter ?? "") !== (news.filter ?? "");
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const disabledChanged = (current.disabled === true) !== desiredDisabled;
      const exclusionsChanged = !sameExclusions(
        current.exclusions,
        news.exclusions,
      );
      const bqChanged =
        news.bigqueryOptions !== undefined && desiredBq !== observedBq;
      const includeChildrenChanged =
        news.includeChildren !== undefined &&
        (current.includeChildren === true) !== desiredIncludeChildren;
      const interceptChildrenChanged =
        news.interceptChildren !== undefined &&
        (current.interceptChildren === true) !== desiredInterceptChildren;

      const updateMask = [
        destinationChanged ? "destination" : undefined,
        filterChanged ? "filter" : undefined,
        descriptionChanged ? "description" : undefined,
        disabledChanged ? "disabled" : undefined,
        exclusionsChanged ? "exclusions" : undefined,
        bqChanged ? "bigqueryOptions.usePartitionedTables" : undefined,
        includeChildrenChanged ? "includeChildren" : undefined,
        interceptChildrenChanged ? "interceptChildren" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        const body: logging.LogSink = {
          name: sinkId,
          destination: news.destination,
          filter: news.filter ?? "",
          description: desiredDescription,
          disabled: desiredDisabled,
        };
        if (exclusionsChanged) {
          body.exclusions = toExclusionsBody(news.exclusions) ?? [];
        }
        if (bqChanged) {
          body.bigqueryOptions = {
            usePartitionedTables: desiredBq,
          };
        }
        if (includeChildrenChanged) {
          body.includeChildren = desiredIncludeChildren;
        }
        if (interceptChildrenChanged) {
          body.interceptChildren = desiredInterceptChildren;
        }
        current = yield* logging.patchFoldersSinks({
          sinkName: current.resourceName ?? name,
          uniqueWriterIdentity,
          customWriterIdentity: news.customWriterIdentity,
          updateMask: updateMask.join(","),
          body,
        });
      }

      return toAttrs(current, parent);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteFoldersSinks({ sinkName: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
