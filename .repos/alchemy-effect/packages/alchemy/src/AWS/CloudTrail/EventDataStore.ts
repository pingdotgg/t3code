import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

/**
 * A field selector inside an advanced event selector. Mirrors the
 * CloudTrail `AdvancedFieldSelector` wire shape.
 */
export interface EventDataStoreFieldSelector {
  /**
   * The event record field to select on (e.g. `eventCategory`,
   * `resources.type`).
   */
  field: string;
  /** Exact-match values. */
  equals?: string[];
  /** Prefix-match values. */
  startsWith?: string[];
  /** Suffix-match values. */
  endsWith?: string[];
  /** Exact-mismatch values. */
  notEquals?: string[];
  /** Prefix-mismatch values. */
  notStartsWith?: string[];
  /** Suffix-mismatch values. */
  notEndsWith?: string[];
}

/**
 * An advanced event selector controlling which events the event data
 * store collects.
 */
export interface EventDataStoreEventSelector {
  /** Descriptive name for the selector. */
  name?: string;
  /** Field selectors that events must match to be collected. */
  fieldSelectors: EventDataStoreFieldSelector[];
}

export interface EventDataStoreProps {
  /**
   * Name of the event data store. Must be 3-128 characters, contain only
   * letters, numbers, periods, underscores, and dashes, and start and end
   * with a letter or number. Renaming updates the store in place (the ARN
   * is the stable identity).
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Advanced event selectors controlling which events are collected.
   * @default management events
   */
  advancedEventSelectors?: EventDataStoreEventSelector[];
  /**
   * Whether the event data store collects events from all Regions or
   * only the current Region.
   * @default true
   */
  multiRegionEnabled?: boolean;
  /**
   * Whether the event data store collects events for all accounts in an
   * organization.
   * @default false
   */
  organizationEnabled?: boolean;
  /**
   * Retention period, e.g. `"30 days"` or `Duration.days(30)` (minimum
   * 7 days; maximum 2557 days under `EXTENDABLE_RETENTION_PRICING`,
   * 3653 days under `FIXED_RETENTION_PRICING`). Rounded to whole days
   * on the wire.
   * @default 366 days
   */
  retentionPeriod?: Duration.Input;
  /**
   * Whether termination protection is enabled. A protected store cannot
   * be deleted until protection is disabled.
   * @default true (AWS default)
   */
  terminationProtectionEnabled?: boolean;
  /**
   * The billing mode for the event data store.
   * @default "EXTENDABLE_RETENTION_PRICING"
   */
  billingMode?: "EXTENDABLE_RETENTION_PRICING" | "FIXED_RETENTION_PRICING";
  /**
   * KMS key ID (ID, alias, or ARN) used to encrypt the events delivered
   * to the event data store.
   */
  kmsKeyId?: string;
  /**
   * Whether the event data store ingests live events. Synced via
   * `StartEventDataStoreIngestion` / `StopEventDataStoreIngestion`; a
   * stopped store keeps its collected events queryable.
   * @default true (AWS default)
   */
  ingestionEnabled?: boolean;
  /**
   * Tags to apply to the event data store. Merged with internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

export interface EventDataStore extends Resource<
  "AWS.CloudTrail.EventDataStore",
  EventDataStoreProps,
  {
    /** ARN of the event data store (its stable identity). */
    eventDataStoreArn: string;
    /** Name of the event data store. */
    name: string;
    /** Current status (e.g. `ENABLED`, `STARTING_INGESTION`). */
    status: string;
  },
  never,
  Providers
> {}

/**
 * A CloudTrail Lake event data store — an immutable collection of events
 * that can be queried with SQL via CloudTrail Lake.
 *
 * Deleting an event data store schedules it for deletion
 * (`PENDING_DELETION`); AWS purges it after a seven-day wait period during
 * which it incurs no cost. If a store with the same name is still pending
 * deletion, the reconciler restores it instead of creating a duplicate.
 * @resource
 * @section Creating Event Data Stores
 * @example Basic Event Data Store
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const store = yield* AWS.CloudTrail.EventDataStore("Lake", {
 *   retentionPeriod: "7 days",
 *   terminationProtectionEnabled: false,
 * });
 * ```
 *
 * @example Single-Region Store with Custom Selectors
 * ```typescript
 * const store = yield* AWS.CloudTrail.EventDataStore("S3DataEvents", {
 *   multiRegionEnabled: false,
 *   retentionPeriod: "30 days",
 *   terminationProtectionEnabled: false,
 *   advancedEventSelectors: [
 *     {
 *       name: "S3 data events",
 *       fieldSelectors: [
 *         { field: "eventCategory", equals: ["Data"] },
 *         { field: "resources.type", equals: ["AWS::S3::Object"] },
 *       ],
 *     },
 *   ],
 * });
 * ```
 */
export const EventDataStore = Resource<EventDataStore>(
  "AWS.CloudTrail.EventDataStore",
);

/**
 * A just-created or just-restored event data store transitions through
 * `CREATED`/`STARTING_INGESTION` before mutations are accepted; concurrent
 * mutations surface as transient `ConflictException` /
 * `InvalidEventDataStoreStatusException`.
 *
 * Expressed as an explicitly-typed helper: inlining `Effect.retry` in a
 * lifecycle op leaks `Retry.Return`'s conditional into declaration emit
 * and widens the provider layer to an `unknown` R for every consumer of
 * `AWS.providers()`.
 */
const retryWhileSettling = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "ConflictException" ||
      e._tag === "InvalidEventDataStoreStatusException" ||
      e._tag === "InactiveEventDataStoreException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

/**
 * Deletion right after another mutation can raise a transient
 * `ConflictException`; already-inactive stores are handled by the caller
 * as success and must NOT be retried.
 */
const retryWhileDeleteConflict = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

const toWireSelectors = (
  selectors: EventDataStoreEventSelector[] | undefined,
): cloudtrail.AdvancedEventSelector[] | undefined =>
  selectors?.map((s) => ({
    Name: s.name,
    FieldSelectors: s.fieldSelectors.map((f) => ({
      Field: f.field,
      Equals: f.equals,
      StartsWith: f.startsWith,
      EndsWith: f.endsWith,
      NotEquals: f.notEquals,
      NotStartsWith: f.notStartsWith,
      NotEndsWith: f.notEndsWith,
    })),
  }));

export const EventDataStoreProvider = () =>
  Provider.effect(
    EventDataStore,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        if (props.name) {
          return props.name;
        }
        return yield* createPhysicalName({ id, maxLength: 128 });
      });

      const fetchObservedTags = (arn: string) =>
        cloudtrail.listTags({ ResourceIdList: [arn] }).pipe(
          Effect.map((r) => {
            const tags: Record<string, string> = {};
            for (const t of r.ResourceTagList?.[0]?.TagsList ?? []) {
              tags[t.Key] = t.Value ?? "";
            }
            return tags;
          }),
          Effect.catch(() => Effect.succeed({} as Record<string, string>)),
        );

      // Look up a store by ARN, tolerating the typed not-found.
      const getByArn = (arn: string) =>
        cloudtrail
          .getEventDataStore({ EventDataStore: arn })
          .pipe(
            Effect.catchTag(
              [
                "EventDataStoreNotFoundException",
                "EventDataStoreARNInvalidException",
              ],
              () => Effect.succeed(undefined),
            ),
          );

      // Find a store by name, INCLUDING pending-deletion ones — the caller
      // decides whether a `PENDING_DELETION` match should be restored.
      const findByName = (name: string) =>
        cloudtrail.listEventDataStores.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .flatMap((page) => page.EventDataStores ?? [])
              .find((s) => s.Name === name),
          ),
        );

      return EventDataStore.Provider.of({
        stables: ["eventDataStoreArn", "name"],
        list: () =>
          Effect.gen(function* () {
            const stores = yield* cloudtrail.listEventDataStores.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.EventDataStores ?? []),
              ),
            );
            return stores
              .filter(
                (s) =>
                  s.EventDataStoreArn !== undefined &&
                  s.Name !== undefined &&
                  s.Status !== "PENDING_DELETION",
              )
              .map((s) => ({
                eventDataStoreArn: s.EventDataStoreArn!,
                name: s.Name!,
                status: s.Status ?? "ENABLED",
              }));
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const store = output?.eventDataStoreArn
            ? yield* getByArn(output.eventDataStoreArn)
            : yield* findByName(yield* createName(id, olds ?? {}));
          if (store === undefined || store.Status === "PENDING_DELETION") {
            return undefined;
          }
          const attrs = {
            eventDataStoreArn: store.EventDataStoreArn!,
            name: store.Name!,
            status: store.Status ?? "ENABLED",
          };
          const tags = yield* fetchObservedTags(attrs.eventDataStoreArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ news }) {
          if (!isResolved(news)) return undefined;
          // Every prop (including the name) is mutable via
          // UpdateEventDataStore — the ARN is the stable identity, so no
          // prop change forces a replacement.
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredSelectors = toWireSelectors(news.advancedEventSelectors);
          // The CloudTrail wire unit for RetentionPeriod is whole days.
          const retentionDays = toWireDays(news.retentionPeriod);

          // 1. OBSERVE — prefer the cached ARN, fall back to name lookup.
          let store = output?.eventDataStoreArn
            ? yield* getByArn(output.eventDataStoreArn)
            : yield* findByName(name).pipe(
                Effect.flatMap((s) =>
                  s?.EventDataStoreArn
                    ? getByArn(s.EventDataStoreArn)
                    : Effect.succeed(undefined),
                ),
              );

          // A pending-deletion store still holds the name — restore it and
          // let the sync step converge it to the desired state.
          if (store !== undefined && store.Status === "PENDING_DELETION") {
            yield* session.note(
              `Restoring pending-deletion event data store ${store.Name}`,
            );
            yield* retryWhileSettling(
              cloudtrail.restoreEventDataStore({
                EventDataStore: store.EventDataStoreArn!,
              }),
            );
            store = yield* getByArn(store.EventDataStoreArn!);
          }

          // 2. ENSURE — create if missing; on the AlreadyExists race (or a
          // same-name store pending deletion), converge via name lookup +
          // restore.
          if (store === undefined) {
            yield* session.note(`Creating event data store ${name}`);
            const created = yield* cloudtrail
              .createEventDataStore({
                Name: name,
                AdvancedEventSelectors: desiredSelectors,
                MultiRegionEnabled: news.multiRegionEnabled,
                OrganizationEnabled: news.organizationEnabled,
                RetentionPeriod: retentionDays,
                TerminationProtectionEnabled: news.terminationProtectionEnabled,
                BillingMode: news.billingMode,
                KmsKeyId: news.kmsKeyId,
                StartIngestion: news.ingestionEnabled,
                TagsList: Object.entries({
                  ...news.tags,
                  ...internalTags,
                }).map(([Key, Value]) => ({ Key, Value })),
              })
              .pipe(
                Effect.catchTag("EventDataStoreAlreadyExistsException", () =>
                  Effect.succeed(undefined),
                ),
              );
            if (created?.EventDataStoreArn) {
              store = yield* getByArn(created.EventDataStoreArn);
            } else {
              // AlreadyExists race — the holder may be active (peer created
              // it) or pending deletion (a prior stack run deleted it).
              const existing = yield* findByName(name);
              if (existing?.Status === "PENDING_DELETION") {
                yield* session.note(
                  `Name ${name} is held by a pending-deletion store — restoring it`,
                );
                yield* retryWhileSettling(
                  cloudtrail.restoreEventDataStore({
                    EventDataStore: existing.EventDataStoreArn!,
                  }),
                );
              }
              store = existing?.EventDataStoreArn
                ? yield* getByArn(existing.EventDataStoreArn)
                : undefined;
            }
          }
          if (store === undefined) {
            // Surface the typed not-found from a direct name-keyed get.
            store = yield* cloudtrail.getEventDataStore({
              EventDataStore: name,
            });
          }

          const arn = store.EventDataStoreArn!;

          // 3. SYNC — diff observed against desired, push only the delta.
          const updateDelta: Partial<
            Omit<cloudtrail.UpdateEventDataStoreRequest, "EventDataStore">
          > = {};
          if (store.Name !== name) {
            updateDelta.Name = name;
          }
          if (
            retentionDays !== undefined &&
            store.RetentionPeriod !== retentionDays
          ) {
            updateDelta.RetentionPeriod = retentionDays;
          }
          if (
            news.multiRegionEnabled !== undefined &&
            store.MultiRegionEnabled !== news.multiRegionEnabled
          ) {
            updateDelta.MultiRegionEnabled = news.multiRegionEnabled;
          }
          if (
            news.organizationEnabled !== undefined &&
            store.OrganizationEnabled !== news.organizationEnabled
          ) {
            updateDelta.OrganizationEnabled = news.organizationEnabled;
          }
          if (
            news.terminationProtectionEnabled !== undefined &&
            store.TerminationProtectionEnabled !==
              news.terminationProtectionEnabled
          ) {
            updateDelta.TerminationProtectionEnabled =
              news.terminationProtectionEnabled;
          }
          if (
            news.billingMode !== undefined &&
            store.BillingMode !== news.billingMode
          ) {
            updateDelta.BillingMode = news.billingMode;
          }
          if (news.kmsKeyId !== undefined && store.KmsKeyId !== news.kmsKeyId) {
            updateDelta.KmsKeyId = news.kmsKeyId;
          }
          if (
            desiredSelectors !== undefined &&
            JSON.stringify(store.AdvancedEventSelectors ?? []) !==
              JSON.stringify(desiredSelectors)
          ) {
            updateDelta.AdvancedEventSelectors = desiredSelectors;
          }
          if (Object.keys(updateDelta).length > 0) {
            yield* session.note(
              `Updating event data store: ${Object.keys(updateDelta).join(", ")}`,
            );
            store = yield* retryWhileSettling(
              cloudtrail.updateEventDataStore({
                EventDataStore: arn,
                ...updateDelta,
              }),
            );
          }

          // 3b. SYNC ingestion state — only when declared. The store's
          // Status is the observed ingestion state: ENABLED ingests,
          // STOPPED_INGESTION does not. retryWhileSettling rides out the
          // CREATED/STARTING_INGESTION window after create/restore.
          if (news.ingestionEnabled !== undefined) {
            const status = store.Status ?? "ENABLED";
            if (news.ingestionEnabled && status === "STOPPED_INGESTION") {
              yield* session.note(`Starting ingestion for ${name}`);
              yield* retryWhileSettling(
                cloudtrail.startEventDataStoreIngestion({
                  EventDataStore: arn,
                }),
              );
              store = (yield* getByArn(arn)) ?? store;
            } else if (
              !news.ingestionEnabled &&
              status !== "STOPPED_INGESTION"
            ) {
              yield* session.note(`Stopping ingestion for ${name}`);
              yield* retryWhileSettling(
                cloudtrail.stopEventDataStoreIngestion({
                  EventDataStore: arn,
                }),
              );
              store = (yield* getByArn(arn)) ?? store;
            }
          }

          // 3c. SYNC tags against OBSERVED cloud tags (adoption-safe).
          const observedTags = yield* fetchObservedTags(arn);
          const { upsert, removed } = diffTags(observedTags, {
            ...news.tags,
            ...internalTags,
          });
          if (upsert.length > 0) {
            yield* cloudtrail.addTags({
              ResourceId: arn,
              TagsList: upsert.map((t) => ({ Key: t.Key, Value: t.Value })),
            });
          }
          if (removed.length > 0) {
            yield* cloudtrail.removeTags({
              ResourceId: arn,
              TagsList: removed.map((Key) => ({ Key })),
            });
          }

          yield* session.note(arn);
          return {
            eventDataStoreArn: arn,
            name: store.Name ?? name,
            status: store.Status ?? "ENABLED",
          };
        }),
        // DeleteEventDataStore schedules PENDING_DELETION (7-day window, no
        // cost). Idempotent: already-deleted (NotFound/ARNInvalid) and
        // already-pending (Inactive) stores are both success. A protected
        // store fails with the typed
        // `EventDataStoreTerminationProtectedException` — disable
        // `terminationProtectionEnabled` first.
        delete: Effect.fn(function* ({ output }) {
          yield* retryWhileDeleteConflict(
            cloudtrail.deleteEventDataStore({
              EventDataStore: output.eventDataStoreArn,
            }),
          ).pipe(
            Effect.catchTag(
              [
                "EventDataStoreNotFoundException",
                "EventDataStoreARNInvalidException",
                "InactiveEventDataStoreException",
              ],
              () => Effect.void,
            ),
          );
        }),
      });
    }),
  );
