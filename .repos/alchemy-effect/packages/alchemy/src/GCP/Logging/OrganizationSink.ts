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
import type { SinkBigQueryOptions, SinkExclusion } from "./Sink.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  organizationIdOf,
  parseDescription,
  resolveOrganization,
  toPhysicalId,
  tryResolveOrganization,
} from "./internal.ts";

export type OrganizationSinkProps = {
  /**
   * Sink id (the `{sink}` segment of
   * `organizations/{organization}/sinks/{sink}`). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Limited to
   * 100 characters: letters, digits, underscores, hyphens, periods;
   * first character must be alphanumeric. Immutable — changing it
   * replaces the sink.
   */
  sinkId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to the project ancestor organization. Immutable —
   * changing it replaces the sink.
   */
  organization?: string;
  /**
   * Export destination. One of:
   * `storage.googleapis.com/[GCS_BUCKET]`,
   * `bigquery.googleapis.com/projects/[PROJECT_ID]/datasets/[DATASET]`,
   * `pubsub.googleapis.com/projects/[PROJECT_ID]/topics/[TOPIC_ID]`,
   * `logging.googleapis.com/projects/[PROJECT_ID]`,
   * `logging.googleapis.com/organizations/[ORGANIZATION_ID]/locations/[LOCATION_ID]/buckets/[BUCKET_ID]`.
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
   * `writerIdentity`. Organization sinks always receive a service agent.
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
   * are also eligible for export.
   * @default false
   */
  includeChildren?: boolean;
  /**
   * When true (requires `includeChildren`), matching logs are
   * intercepted and omitted from non-`_Required` child sinks.
   * @default false
   */
  interceptChildren?: boolean;
};

export type OrganizationSink = Resource<
  "GCP.Logging.OrganizationSink",
  OrganizationSinkProps,
  {
    /** Full resource name `organizations/{organization}/sinks/{sink}`. */
    name: string;
    /** Sink id (last path segment). */
    sinkId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Project id of the deploying stack. */
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
    /** Whether child resources are included. */
    includeChildren: boolean;
    /** Whether matching child logs are intercepted. */
    interceptChildren: boolean;
    /**
     * IAM identity Cloud Logging uses to write to `destination`.
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
 * A Cloud Logging sink that routes organization log entries to a
 * destination.
 *
 * Logging sinks have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. Name and organization are identity
 * — changing `sinkId` or `organization` replaces the sink. Filter,
 * destination, description, disabled flag, exclusions, and BigQuery
 * options update in place.
 *
 * ### Creating an Organization Sink
 * **Example:** Route errors to the organization `_Default` log bucket
 * ```typescript
 * const sink = yield* GCP.Logging.OrganizationSink("Errors", {
 *   destination:
 *     "logging.googleapis.com/organizations/123456789/locations/global/buckets/_Default",
 *   filter: "severity>=ERROR",
 * });
 * ```
 *
 * **Example:** Named sink that includes child projects
 * ```typescript
 * const sink = yield* GCP.Logging.OrganizationSink("Errors", {
 *   sinkId: "app-errors",
 *   destination:
 *     "logging.googleapis.com/organizations/123456789/locations/global/buckets/_Default",
 *   filter: "severity>=ERROR",
 *   includeChildren: true,
 *   description: "application errors",
 * });
 * ```
 *
 * ### Updating an Organization Sink
 * **Example:** Change the filter and add an exclusion
 * ```typescript
 * const sink = yield* GCP.Logging.OrganizationSink("Errors", {
 *   destination:
 *     "logging.googleapis.com/organizations/123456789/locations/global/buckets/_Default",
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
export const OrganizationSink = Resource<OrganizationSink>(
  "GCP.Logging.OrganizationSink",
);

export class OrganizationSinkNotResolved extends Data.TaggedError(
  "GCP.Logging.OrganizationSinkNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organization: string, sinkId: string) =>
  `${organization}/sinks/${sinkId}`;

const sinkIdOf = (sink: logging.LogSink) => {
  const raw = sink.name ?? sink.resourceName ?? "";
  return raw.includes("/") ? lastSegment(raw) : raw;
};

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

const toAttrs = (
  sink: logging.LogSink,
  organization: string,
  project: string,
) => {
  const sinkId = sinkIdOf(sink);
  const parsed = parseDescription(sink.description);
  const bq = sink.bigqueryOptions;
  return {
    name:
      sink.resourceName ?? (sinkId ? resourceName(organization, sinkId) : ""),
    sinkId,
    organization,
    organizationId: organizationIdOf(organization),
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
    .getOrganizationsSinks({ sinkName: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toCreateBody = (
  sinkId: string,
  props: OrganizationSinkProps,
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

export const OrganizationSinkProvider = () =>
  Provider.succeed(OrganizationSink, {
    stables: [
      "name",
      "sinkId",
      "organization",
      "organizationId",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.sinkId ?? output?.sinkId;
      const idChanged =
        previous !== undefined &&
        news.sinkId !== undefined &&
        news.sinkId !== previous;
      const previousOrg = olds?.organization ?? output?.organization;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        news.organization !== previousOrg;
      if (!idChanged && !orgChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const sinkId = yield* toPhysicalId(id, olds?.sinkId, output?.sinkId, "s");
      const name = output?.name ?? resourceName(organization, sinkId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        return yield* logging.listOrganizationsSinks
          .pages({
            parent: organization,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.sinks ?? [])),
            Stream.filter((sink) => hasOwnershipMarker(sink.description)),
            Stream.map((sink) => toAttrs(sink, organization, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const sinkId = yield* toPhysicalId(id, news.sinkId, output?.sinkId, "s");
      const name = resourceName(organization, sinkId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createOrganizationsSinks({
            parent: organization,
            uniqueWriterIdentity: news.uniqueWriterIdentity,
            customWriterIdentity: news.customWriterIdentity,
            body: toCreateBody(sinkId, news, desiredDescription),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new OrganizationSinkNotResolved({ name });
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
        current = yield* logging.updateOrganizationsSinks({
          sinkName: current.resourceName ?? name,
          uniqueWriterIdentity: news.uniqueWriterIdentity,
          customWriterIdentity: news.customWriterIdentity,
          updateMask: updateMask.join(","),
          body,
        });
      }

      return toAttrs(current, organization, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteOrganizationsSinks({ sinkName: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
