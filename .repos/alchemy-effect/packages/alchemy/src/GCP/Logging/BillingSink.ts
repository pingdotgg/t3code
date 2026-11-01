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
  billingAccountIdOf,
  billingAccountParent,
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  lookupProjectBillingAccountId,
  parseDescription,
  resolveBillingAccountId,
  toPhysicalId,
} from "./internal.ts";

export type BillingSinkExclusion = SinkExclusion;
export type BillingSinkBigQueryOptions = SinkBigQueryOptions;

export type BillingSinkProps = {
  /**
   * Sink id (the `{sink}` segment of
   * `billingAccounts/{billingAccount}/sinks/{sink}`). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Limited to
   * 100 characters: letters, digits, underscores, hyphens, periods; first
   * character must be alphanumeric. Immutable — changing it replaces the
   * sink.
   */
  sinkId?: string;
  /**
   * Billing account id (`XXXXXX-XXXXXX-XXXXXX` or
   * `billingAccounts/{id}`). If omitted, Alchemy uses the billing
   * account linked to the current project. Immutable — changing it
   * replaces the sink.
   */
  billingAccountId?: string;
  /**
   * Export destination. One of:
   * `storage.googleapis.com/[GCS_BUCKET]`,
   * `bigquery.googleapis.com/projects/[PROJECT_ID]/datasets/[DATASET]`,
   * `pubsub.googleapis.com/projects/[PROJECT_ID]/topics/[TOPIC_ID]`,
   * `logging.googleapis.com/projects/[PROJECT_ID]`,
   * `logging.googleapis.com/billingAccounts/[BILLING_ACCOUNT_ID]/locations/[LOCATION_ID]/buckets/[BUCKET_ID]`.
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
  exclusions?: BillingSinkExclusion[];
  /**
   * BigQuery-specific export options. Ignored unless `destination` is a
   * BigQuery dataset.
   */
  bigqueryOptions?: BillingSinkBigQueryOptions;
  /**
   * When true, Cloud Logging assigns a unique writer service account as
   * `writerIdentity`. Billing-account sinks typically use a service
   * agent.
   */
  uniqueWriterIdentity?: boolean;
  /**
   * Caller-provided writer service account
   * (`serviceAccount:some@email`). Only valid when routing to a log
   * bucket in a different project.
   */
  customWriterIdentity?: string;
};

export type BillingSink = Resource<
  "GCP.Logging.BillingSink",
  BillingSinkProps,
  {
    /** Full resource name `billingAccounts/{billingAccount}/sinks/{sink}`. */
    name: string;
    /** Sink id (last path segment). */
    sinkId: string;
    /** Billing account id. */
    billingAccountId: string;
    /** Export destination. */
    destination: string;
    /** Advanced logs filter, if set. */
    filter: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Whether the sink is disabled. */
    disabled: boolean;
    /** Exclusion filters. */
    exclusions: BillingSinkExclusion[];
    /** BigQuery export options, if set. */
    bigqueryOptions: BillingSinkBigQueryOptions | undefined;
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
 * A Cloud Logging sink that routes billing-account log entries to a
 * destination.
 *
 * Logging sinks have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. Name is identity — changing `sinkId`
 * or `billingAccountId` replaces the sink. Filter, destination,
 * description, disabled flag, exclusions, and BigQuery options update in
 * place.
 *
 * ### Creating a Billing Sink
 * **Example:** Route errors to the `_Default` log bucket
 * ```typescript
 * const sink = yield* GCP.Logging.BillingSink("Errors", {
 *   destination:
 *     "logging.googleapis.com/billingAccounts/AAAAAA-BBBBBB-CCCCCC/locations/global/buckets/_Default",
 *   filter: "severity>=ERROR",
 * });
 * ```
 *
 * **Example:** Named sink with a description
 * ```typescript
 * const sink = yield* GCP.Logging.BillingSink("Errors", {
 *   sinkId: "app-errors",
 *   billingAccountId: "AAAAAA-BBBBBB-CCCCCC",
 *   destination:
 *     "logging.googleapis.com/billingAccounts/AAAAAA-BBBBBB-CCCCCC/locations/global/buckets/_Default",
 *   filter: "severity>=ERROR",
 *   description: "application errors",
 * });
 * ```
 *
 * ### Updating a Billing Sink
 * **Example:** Change the filter and add an exclusion
 * ```typescript
 * const sink = yield* GCP.Logging.BillingSink("Errors", {
 *   destination:
 *     "logging.googleapis.com/billingAccounts/AAAAAA-BBBBBB-CCCCCC/locations/global/buckets/_Default",
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
export const BillingSink = Resource<BillingSink>("GCP.Logging.BillingSink");

export class BillingSinkNotResolved extends Data.TaggedError(
  "GCP.Logging.BillingSinkNotResolved",
)<{
  name: string;
}> {}

const resourceName = (billingAccountId: string, sinkId: string) =>
  `${billingAccountParent(billingAccountId)}/sinks/${sinkId}`;

const sinkIdOf = (sink: logging.LogSink) => {
  const raw = sink.name ?? sink.resourceName ?? "";
  return raw.includes("/") ? lastSegment(raw) : raw;
};

const billingAccountOfName = (name: string, fallback: string) => {
  const match = name.match(/^billingAccounts\/([^/]+)\//);
  return match?.[1] ?? fallback;
};

const exclusionsOf = (
  list:
    | readonly logging.LogExclusion[]
    | readonly BillingSinkExclusion[]
    | undefined,
): BillingSinkExclusion[] =>
  (list ?? [])
    .map((exclusion) => ({
      name: exclusion.name ?? "",
      filter: exclusion.filter ?? "",
      description: exclusion.description,
      disabled: exclusion.disabled === true,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

const sameExclusions = (
  left:
    | readonly logging.LogExclusion[]
    | readonly BillingSinkExclusion[]
    | undefined,
  right:
    | readonly logging.LogExclusion[]
    | readonly BillingSinkExclusion[]
    | undefined,
) => JSON.stringify(exclusionsOf(left)) === JSON.stringify(exclusionsOf(right));

const toExclusionsBody = (
  list: readonly BillingSinkExclusion[] | undefined,
): logging.LogExclusion[] | undefined => {
  if (list === undefined) return undefined;
  return list.map((exclusion) => ({
    name: exclusion.name,
    filter: exclusion.filter,
    description: exclusion.description,
    disabled: exclusion.disabled === true ? true : undefined,
  }));
};

const toAttrs = (sink: logging.LogSink, billingAccountId: string) => {
  const sinkId = sinkIdOf(sink);
  const parsed = parseDescription(sink.description);
  const bq = sink.bigqueryOptions;
  const account = billingAccountOfName(
    sink.resourceName ?? sink.name ?? "",
    billingAccountId,
  );
  return {
    name: sink.resourceName ?? (sinkId ? resourceName(account, sinkId) : ""),
    sinkId,
    billingAccountId: account,
    destination: sink.destination ?? "",
    filter: sink.filter,
    description: parsed.description,
    disabled: sink.disabled === true,
    exclusions: exclusionsOf(sink.exclusions),
    bigqueryOptions:
      bq?.usePartitionedTables !== undefined
        ? { usePartitionedTables: bq.usePartitionedTables }
        : undefined,
    writerIdentity: sink.writerIdentity,
    createTime: sink.createTime,
    updateTime: sink.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getBillingAccountsSinks({ sinkName: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toCreateBody = (
  sinkId: string,
  props: BillingSinkProps,
  description: string,
): logging.LogSink => ({
  name: sinkId,
  destination: props.destination,
  filter: props.filter,
  description,
  disabled: props.disabled === true ? true : undefined,
  exclusions: toExclusionsBody(props.exclusions),
  bigqueryOptions: props.bigqueryOptions,
});

export const BillingSinkProvider = () =>
  Provider.succeed(BillingSink, {
    stables: ["name", "sinkId", "billingAccountId", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.sinkId ?? output?.sinkId;
      const idChanged =
        previous !== undefined &&
        news.sinkId !== undefined &&
        news.sinkId !== previous;
      const previousAccount =
        olds?.billingAccountId ?? output?.billingAccountId;
      const accountChanged =
        previousAccount !== undefined &&
        news.billingAccountId !== undefined &&
        billingAccountIdOf(news.billingAccountId) !==
          billingAccountIdOf(previousAccount);
      if (!idChanged && !accountChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const billingAccountId = yield* resolveBillingAccountId(
        olds?.billingAccountId,
        output?.billingAccountId,
      );
      const sinkId = yield* toPhysicalId(id, olds?.sinkId, output?.sinkId, "s");
      const name = output?.name ?? resourceName(billingAccountId, sinkId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, billingAccountId);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const billingAccountId = yield* lookupProjectBillingAccountId(
          env.project,
        );
        if (billingAccountId === undefined) return [];
        return yield* logging.listBillingAccountsSinks
          .pages({
            parent: billingAccountParent(billingAccountId),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.sinks ?? [])),
            Stream.filter((sink) => hasOwnershipMarker(sink.description)),
            Stream.map((sink) => toAttrs(sink, billingAccountId)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as BillingSink["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const billingAccountId = yield* resolveBillingAccountId(
        news.billingAccountId,
        output?.billingAccountId,
      );
      const sinkId = yield* toPhysicalId(id, news.sinkId, output?.sinkId, "s");
      const name = resourceName(billingAccountId, sinkId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createBillingAccountsSinks({
            parent: billingAccountParent(billingAccountId),
            uniqueWriterIdentity: news.uniqueWriterIdentity,
            customWriterIdentity: news.customWriterIdentity,
            body: toCreateBody(sinkId, news, desiredDescription),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new BillingSinkNotResolved({ name });
      }

      const desiredDisabled = news.disabled === true;
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

      const updateMask = [
        destinationChanged ? "destination" : undefined,
        filterChanged ? "filter" : undefined,
        descriptionChanged ? "description" : undefined,
        disabledChanged ? "disabled" : undefined,
        exclusionsChanged ? "exclusions" : undefined,
        bqChanged ? "bigqueryOptions.usePartitionedTables" : undefined,
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
        current = yield* logging.patchBillingAccountsSinks({
          sinkName: current.resourceName ?? name,
          uniqueWriterIdentity: news.uniqueWriterIdentity,
          customWriterIdentity: news.customWriterIdentity,
          updateMask: updateMask.join(","),
          body,
        });
      }

      return toAttrs(current, billingAccountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteBillingAccountsSinks({ sinkName: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
