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
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 100;

export type SinkExclusion = {
  /**
   * Client-assigned exclusion id. Limited to 100 characters (letters,
   * digits, underscores, hyphens, periods). First character must be
   * alphanumeric.
   */
  name: string;
  /**
   * Advanced logs filter matching entries to exclude from the export.
   */
  filter: string;
  /**
   * Human-readable description of this exclusion.
   */
  description?: string;
  /**
   * When true, the exclusion exists but does not exclude any entries.
   * @default false
   */
  disabled?: boolean;
};

export type SinkBigQueryOptions = {
  /**
   * Use BigQuery partitioned tables instead of dated tables
   * (`syslog_20170523`). Only applies when `destination` is a BigQuery
   * dataset.
   * @default false
   */
  usePartitionedTables?: boolean;
};

export type SinkProps = {
  /**
   * Sink id (the `{sink}` segment of `projects/{project}/sinks/{sink}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Limited to 100 characters: letters, digits, underscores,
   * hyphens, periods; first character must be alphanumeric. Immutable —
   * changing it replaces the sink.
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
  exclusions?: SinkExclusion[];
  /**
   * BigQuery-specific export options. Ignored unless `destination` is a
   * BigQuery dataset.
   */
  bigqueryOptions?: SinkBigQueryOptions;
  /**
   * When true, Cloud Logging assigns a unique writer service account as
   * `writerIdentity`. When false (GCP default for project sinks), the
   * shared `cloud-logs` identity is used and the destination must be in
   * the same project. Sinks whose destination is a log bucket in the
   * same project have no writer identity.
   */
  uniqueWriterIdentity?: boolean;
  /**
   * Caller-provided writer service account
   * (`serviceAccount:some@email`). Only valid when routing to a log
   * bucket in a different project.
   */
  customWriterIdentity?: string;
  /**
   * Organization/folder sinks only. When true, logs from child projects,
   * folders, and billing accounts are also eligible for export.
   * @default false
   */
  includeChildren?: boolean;
  /**
   * Organization/folder sinks only. When true (requires
   * `includeChildren`), matching logs are intercepted and omitted from
   * non-`_Required` child sinks.
   * @default false
   */
  interceptChildren?: boolean;
};

export type Sink = Resource<
  "GCP.Logging.Sink",
  SinkProps,
  {
    /** Full resource name `projects/{project}/sinks/{sink}`. */
    name: string;
    /** Sink id (last path segment). */
    sinkId: string;
    /** Project id. */
    project: string;
    /** Export destination. */
    destination: string;
    /** Advanced logs filter, if set. */
    filter: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Whether the sink is disabled. */
    disabled: boolean;
    /** Exclusion filters. */
    exclusions: SinkExclusion[];
    /** BigQuery export options, if set. */
    bigqueryOptions: SinkBigQueryOptions | undefined;
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
 * A Cloud Logging sink that routes log entries to a destination.
 *
 * Logging sinks have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. Name is identity — changing `sinkId`
 * replaces the sink. Filter, destination, description, disabled flag,
 * exclusions, and BigQuery options update in place.
 *
 * ### Creating a Sink
 * **Example:** Route errors to the `_Default` log bucket
 * ```typescript
 * const sink = yield* GCP.Logging.Sink("Errors", {
 *   destination:
 *     "logging.googleapis.com/projects/my-project/locations/global/buckets/_Default",
 *   filter: "severity>=ERROR",
 * });
 * ```
 *
 * **Example:** Named sink with a description
 * ```typescript
 * const sink = yield* GCP.Logging.Sink("Errors", {
 *   sinkId: "app-errors",
 *   destination:
 *     "logging.googleapis.com/projects/my-project/locations/global/buckets/_Default",
 *   filter: "severity>=ERROR",
 *   description: "application errors",
 * });
 * ```
 *
 * ### Updating a Sink
 * **Example:** Change the filter and add an exclusion
 * ```typescript
 * const sink = yield* GCP.Logging.Sink("Errors", {
 *   destination:
 *     "logging.googleapis.com/projects/my-project/locations/global/buckets/_Default",
 *   filter: "severity>=WARNING",
 *   description: "warnings and errors",
 *   exclusions: [
 *     {
 *       name: "drop-healthchecks",
 *       filter: 'httpRequest.requestUrl="/healthz"',
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const Sink = Resource<Sink>("GCP.Logging.Sink");

export class SinkNotResolved extends Data.TaggedError(
  "GCP.Logging.SinkNotResolved",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const resourceName = (project: string, sinkId: string) =>
  `projects/${project}/sinks/${sinkId}`;

const sinkIdOf = (sink: logging.LogSink) => {
  const raw = sink.name ?? sink.resourceName ?? "";
  return raw.includes("/") ? lastSegment(raw) : raw;
};

const toId = (id: string, sinkId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (sinkId !== undefined) return sinkId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `s${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const exclusionsOf = (
  list: readonly logging.LogExclusion[] | readonly SinkExclusion[] | undefined,
): SinkExclusion[] =>
  (list ?? [])
    .map((exclusion) => ({
      name: exclusion.name ?? "",
      filter: exclusion.filter ?? "",
      description: exclusion.description,
      disabled: exclusion.disabled === true,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

const sameExclusions = (
  left: readonly logging.LogExclusion[] | readonly SinkExclusion[] | undefined,
  right: readonly logging.LogExclusion[] | readonly SinkExclusion[] | undefined,
) => JSON.stringify(exclusionsOf(left)) === JSON.stringify(exclusionsOf(right));

const toExclusionsBody = (
  list: readonly SinkExclusion[] | undefined,
): logging.LogExclusion[] | undefined => {
  if (list === undefined) return undefined;
  return list.map((exclusion) => ({
    name: exclusion.name,
    filter: exclusion.filter,
    description: exclusion.description,
    disabled: exclusion.disabled === true ? true : undefined,
  }));
};

const toAttrs = (sink: logging.LogSink, project: string) => {
  const sinkId = sinkIdOf(sink);
  const parsed = parseDescription(sink.description);
  const bq = sink.bigqueryOptions;
  return {
    name: sink.resourceName ?? (sinkId ? resourceName(project, sinkId) : ""),
    sinkId,
    project,
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
    .getSinks({ sinkName: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toCreateBody = (
  sinkId: string,
  props: SinkProps,
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

export const SinkProvider = () =>
  Provider.succeed(Sink, {
    stables: ["name", "sinkId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.sinkId ?? output?.sinkId;
      if (
        previous !== undefined &&
        news.sinkId !== undefined &&
        news.sinkId !== previous
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const sinkId = yield* toId(id, olds?.sinkId, output?.sinkId);
      const name = output?.name ?? resourceName(env.project, sinkId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* logging.listSinks
          .pages({
            parent: `projects/${env.project}`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.sinks ?? [])),
            Stream.filter((sink) => hasOwnershipMarker(sink.description)),
            Stream.map((sink) => toAttrs(sink, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const sinkId = yield* toId(id, news.sinkId, output?.sinkId);
      const name = resourceName(env.project, sinkId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createSinks({
            parent: `projects/${env.project}`,
            uniqueWriterIdentity: news.uniqueWriterIdentity,
            customWriterIdentity: news.customWriterIdentity,
            body: toCreateBody(sinkId, news, desiredDescription),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SinkNotResolved({ name });
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
        current = yield* logging.updateSinks({
          sinkName: current.resourceName ?? name,
          uniqueWriterIdentity: news.uniqueWriterIdentity,
          customWriterIdentity: news.customWriterIdentity,
          updateMask: updateMask.join(","),
          body,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteSinks({ sinkName: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
