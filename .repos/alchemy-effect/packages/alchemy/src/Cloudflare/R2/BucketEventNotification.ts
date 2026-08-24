import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import type { Bucket } from "./Bucket.ts";

const TypeId = "Cloudflare.R2.BucketEventNotification" as const;
type TypeId = typeof TypeId;

/**
 * An R2 object action that can trigger an event notification.
 *
 * - `PutObject` — an object is uploaded via a single PUT
 * - `CopyObject` — an object is copied into the bucket
 * - `DeleteObject` — an object is deleted
 * - `CompleteMultipartUpload` — a multipart upload completes
 * - `LifecycleDeletion` — an object is deleted by a lifecycle rule
 */
export type BucketEventNotificationAction =
  | "PutObject"
  | "CopyObject"
  | "DeleteObject"
  | "CompleteMultipartUpload"
  | "LifecycleDeletion";

/**
 * A single notification rule. An event message is delivered to the queue
 * when an object matching the rule's `prefix`/`suffix` undergoes one of
 * the rule's `actions`.
 */
export interface BucketEventNotificationRule {
  /**
   * Object actions that trigger a notification for this rule.
   */
  actions: BucketEventNotificationAction[];
  /**
   * Only notify for objects whose key starts with this prefix.
   * @default "" (match all objects)
   */
  prefix?: string;
  /**
   * Only notify for objects whose key ends with this suffix.
   * @default "" (match all objects)
   */
  suffix?: string;
  /**
   * Human-readable description of the rule. Cloudflare auto-generates one
   * when omitted.
   */
  description?: string;
}

export interface BucketEventNotificationProps {
  /**
   * Name of the R2 bucket that produces the events. Pass
   * `bucket.bucketName` from a `Cloudflare.R2.Bucket`.
   *
   * Immutable — changing the bucket triggers a replacement.
   */
  bucketName: string;
  /**
   * ID of the Queue that receives the event messages. Pass
   * `queue.queueId` from a `Cloudflare.Queues.Queue`.
   *
   * Immutable — changing the queue triggers a replacement.
   */
  queueId: string;
  /**
   * Jurisdiction of the bucket (must match the bucket's own jurisdiction).
   *
   * Immutable — changing the jurisdiction triggers a replacement.
   * @default "default"
   */
  jurisdiction?: Bucket.Jurisdiction;
  /**
   * Rules that decide which object events are delivered to the queue.
   * The full set is replaced on every update (the provider clears the
   * pair's configuration and re-creates the desired rules when they
   * drift).
   *
   * Note: Cloudflare rejects rule sets whose `prefix`/`suffix` key ranges
   * overlap ("invalid overlap"), even when their actions are disjoint —
   * scope each rule to a distinct key range.
   */
  rules: BucketEventNotificationRule[];
}

export interface BucketEventNotificationAttributes {
  /** Name of the bucket that produces the events. */
  bucketName: string;
  /** ID of the queue that receives the event messages. */
  queueId: string;
  /** Name of the queue that receives the event messages, if reported. */
  queueName: string | undefined;
  /** Account the configuration lives in. */
  accountId: string;
  /** Jurisdiction of the bucket. */
  jurisdiction: Bucket.Jurisdiction;
  /** The active notification rules, including server-assigned rule IDs. */
  rules: BucketEventNotification.Rule[];
}

export type BucketEventNotification = Resource<
  TypeId,
  BucketEventNotificationProps,
  BucketEventNotificationAttributes,
  never,
  Providers
>;

/**
 * Event notifications for a Cloudflare R2 bucket, delivered to a Queue.
 *
 * When objects in the bucket are created, deleted, or copied, R2 publishes
 * an event message to the configured Queue. One configuration exists per
 * (bucket, queue) pair and holds a list of rules; consume the messages with
 * a Queue consumer Worker.
 *
 * The configuration's identity is the (bucket, queue) pair — changing
 * either triggers a replacement, while rule changes are applied in place
 * (the provider converges the pair's configuration to exactly the
 * declared rule set).
 * @resource
 * @product R2
 * @category Storage & Databases
 * @section Notifying a Queue
 * @example Notify on every upload and delete
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("Uploads");
 * const queue = yield* Cloudflare.Queues.Queue("UploadEvents");
 *
 * yield* Cloudflare.R2.BucketEventNotification("UploadNotifications", {
 *   bucketName: bucket.bucketName,
 *   queueId: queue.queueId,
 *   rules: [
 *     {
 *       actions: ["PutObject", "CompleteMultipartUpload", "DeleteObject"],
 *     },
 *   ],
 * });
 * ```
 *
 * @example Scope notifications to a key prefix and suffix
 * ```typescript
 * yield* Cloudflare.R2.BucketEventNotification("ImageNotifications", {
 *   bucketName: bucket.bucketName,
 *   queueId: queue.queueId,
 *   rules: [
 *     {
 *       actions: ["PutObject"],
 *       prefix: "images/",
 *       suffix: ".png",
 *       description: "new PNG images",
 *     },
 *   ],
 * });
 * ```
 *
 * @section Multiple rules
 * @example Separate rules per key range
 * ```typescript
 * // Rules must cover non-overlapping key ranges — Cloudflare rejects
 * // overlapping prefixes/suffixes even when the actions are disjoint.
 * yield* Cloudflare.R2.BucketEventNotification("Notifications", {
 *   bucketName: bucket.bucketName,
 *   queueId: queue.queueId,
 *   rules: [
 *     { actions: ["PutObject"], prefix: "incoming/" },
 *     { actions: ["DeleteObject", "LifecycleDeletion"], prefix: "logs/" },
 *   ],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/r2/buckets/event-notifications/
 */
export const BucketEventNotification =
  Resource<BucketEventNotification>(TypeId);

export declare namespace BucketEventNotification {
  export type Rule = {
    actions: BucketEventNotificationAction[];
    prefix: string;
    suffix: string;
    description: string | undefined;
    ruleId: string | undefined;
    createdAt: string | undefined;
  };
}

/**
 * Returns true if the given value is an BucketEventNotification resource.
 */
export const isBucketEventNotification = (
  value: unknown,
): value is BucketEventNotification =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const BucketEventNotificationProvider = () =>
  Provider.succeed(BucketEventNotification, {
    stables: ["bucketName", "queueId", "accountId", "jurisdiction"],

    diff: Effect.fn(function* ({ olds = {}, news }) {
      const o = olds as Partial<BucketEventNotificationProps>;
      const n = news as BucketEventNotificationProps;
      // No prior props to compare against — let the engine decide.
      if (o.bucketName === undefined) return undefined;
      // bucketName/queueId are Input<string>; compare only once both
      // sides are concrete strings.
      if (
        typeof o.bucketName === "string" &&
        typeof n.bucketName === "string" &&
        o.bucketName !== n.bucketName
      ) {
        return { action: "replace" } as const;
      }
      if (
        typeof o.queueId === "string" &&
        typeof n.queueId === "string" &&
        o.queueId !== n.queueId
      ) {
        return { action: "replace" } as const;
      }
      if ((o.jurisdiction ?? "default") !== (n.jurisdiction ?? "default")) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      // The (bucket, queue) pair is the configuration's identity; cold
      // reads derive it from the last-persisted props.
      const bucketName =
        output?.bucketName ??
        (typeof olds?.bucketName === "string" ? olds.bucketName : undefined);
      const queueId =
        output?.queueId ??
        (typeof olds?.queueId === "string" ? olds.queueId : undefined);
      if (bucketName === undefined || queueId === undefined) return undefined;
      const jurisdiction =
        output?.jurisdiction ?? olds?.jurisdiction ?? "default";

      const observed = yield* getConfiguration(
        acct,
        bucketName,
        queueId,
        jurisdiction,
      );
      if (!observed) return undefined;

      const attrs = toAttributes(
        observed,
        acct,
        bucketName,
        queueId,
        jurisdiction,
      );
      // Event notification configs carry no ownership markers. With no
      // prior output we cannot prove we created this configuration —
      // brand it `Unowned` so takeover is gated behind the adopt policy.
      return output ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      // Inputs have been resolved to concrete strings by Plan.
      const bucketName = news.bucketName as string;
      const queueId = news.queueId as string;
      const jurisdiction = news.jurisdiction ?? "default";

      // 1. Observe — the configuration may or may not exist; `output` is
      //    only a cache of the identity, never proof of existence.
      const observed = yield* getConfiguration(
        acct,
        bucketName,
        queueId,
        jurisdiction,
      );

      // 2/3. Ensure + sync — skip the API entirely when the observed rules
      //    already match the desired set.
      if (!observed || !sameRules(observed.rules ?? [], news.rules)) {
        // The PUT *appends* rules to the queue's configuration (it is not
        // a full replace — verified against the live API), so on drift
        // the existing configuration must be cleared first. The brief gap
        // is unavoidable; each step is independently idempotent.
        if (observed) {
          yield* r2
            .deleteBucketEventNotification({
              accountId: acct,
              bucketName,
              queueId,
              jurisdiction,
            })
            .pipe(
              Effect.catchTag(
                [
                  "EventNotificationConfigNotFound",
                  "BucketNotFound",
                  "QueueNotFound",
                ],
                () => Effect.void,
              ),
            );
        }
        yield* r2
          .putBucketEventNotification({
            accountId: acct,
            bucketName,
            queueId,
            jurisdiction,
            rules: news.rules.map((rule) => ({
              actions: [...rule.actions],
              prefix: rule.prefix,
              suffix: rule.suffix,
              description: rule.description,
            })),
          })
          .pipe(
            // A freshly-created bucket or queue can briefly 404 on the
            // event-notification endpoint — ride out the consistency lag.
            Effect.retry({
              while: (e) =>
                e._tag === "BucketNotFound" || e._tag === "QueueNotFound",
              schedule: r2EventNotificationConsistencySchedule,
            }),
          );
      }

      // 4. Return — re-read so the attributes carry the server-assigned
      //    per-rule IDs. The read can lag the PUT briefly.
      if (news.rules.length === 0) {
        // An empty rule set reads back as "no configuration".
        return toAttributes(
          { queueId, queueName: undefined, rules: [] },
          acct,
          bucketName,
          queueId,
          jurisdiction,
        );
      }
      const final = yield* r2
        .getBucketEventNotification({
          accountId: acct,
          bucketName,
          queueId,
          jurisdiction,
        })
        .pipe(
          Effect.retry({
            while: (e) =>
              e._tag === "NoEventNotificationConfig" ||
              e._tag === "EventNotificationConfigNotFound" ||
              e._tag === "BucketNotFound" ||
              e._tag === "QueueNotFound",
            schedule: r2EventNotificationConsistencySchedule,
          }),
        );
      return toAttributes(final, acct, bucketName, queueId, jurisdiction);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent — the configuration, bucket, or queue may already be
      // gone (all typed not-found variants in the operation's union).
      yield* r2
        .deleteBucketEventNotification({
          accountId: output.accountId,
          bucketName: output.bucketName,
          queueId: output.queueId,
          jurisdiction: output.jurisdiction,
        })
        .pipe(
          Effect.catchTag(
            [
              "EventNotificationConfigNotFound",
              "BucketNotFound",
              "QueueNotFound",
            ],
            () => Effect.void,
          ),
        );
    }),

    // Parent fan-out: a notification configuration is keyed by (bucket,
    // queue) and there is no account-wide enumeration. Enumerate every R2
    // bucket (account-scoped), then list each bucket's event-notification
    // queues — one (bucket, queue) pair is one BucketEventNotification.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const buckets = yield* listAllBuckets(accountId);
      const perBucket = yield* Effect.forEach(
        buckets,
        (bucket) => {
          const bucketName = bucket.name;
          if (bucketName == null) {
            return Effect.succeed([] as BucketEventNotificationAttributes[]);
          }
          const jurisdiction = (bucket.jurisdiction ??
            "default") as Bucket.Jurisdiction;
          return r2
            .listBucketEventNotifications({
              accountId,
              bucketName,
              jurisdiction,
            })
            .pipe(
              Effect.map((res) =>
                (res.queues ?? [])
                  .filter(
                    (q): q is typeof q & { queueId: string } =>
                      q.queueId != null,
                  )
                  .map(
                    (q): BucketEventNotificationAttributes => ({
                      bucketName,
                      // The endpoint echoes the queue ID in dashed-UUID
                      // form; normalise to the undashed form
                      // `Queue.queueId` uses so list items match `read`.
                      queueId: q.queueId.replace(/-/g, ""),
                      queueName: q.queueName ?? undefined,
                      accountId,
                      jurisdiction,
                      rules: (q.rules ?? []).map(toRuleAttributes),
                    }),
                  ),
              ),
              // A bucket with no event-notification config (or a bucket
              // that vanished mid-enumeration) is not an error — skip it.
              Effect.catchTag(
                [
                  "NoEventNotificationConfig",
                  "BucketNotFound",
                  "NoSuchBucket",
                  // Plan-gated / partial buckets reject the route.
                  "InvalidRoute",
                ],
                () => Effect.succeed([] as BucketEventNotificationAttributes[]),
              ),
            );
        },
        { concurrency: 10 },
      );
      return perBucket.flat();
    }),
  });

// R2 can make a freshly-created bucket/queue visible to its own endpoints
// before the event-notification endpoints accept it. Retry only that narrow
// not-found lag with a bounded budget.
const r2EventNotificationConsistencySchedule = Schedule.max([
  Schedule.exponential(250),
  Schedule.recurs(6),
]);

type ObservedBucket = NonNullable<r2.ListBucketsResponse["buckets"]>[number];

// `listBuckets` is a non-paginated distilled op that returns at most one
// page (default ordering by name). Page through it exhaustively with the
// `startAfter` cursor so `list()` enumerates *every* bucket in the account.
const listAllBuckets = (accountId: string) =>
  Effect.gen(function* () {
    const pageSize = 1000;
    const all: ObservedBucket[] = [];
    let startAfter: string | undefined;
    while (true) {
      const { buckets } = yield* r2.listBuckets({
        accountId,
        perPage: pageSize,
        startAfter,
      });
      const page = buckets ?? [];
      all.push(...page);
      const last = page.at(-1)?.name;
      if (page.length < pageSize || last == null) break;
      startAfter = last;
    }
    return all;
  });

const getConfiguration = (
  accountId: string,
  bucketName: string,
  queueId: string,
  jurisdiction: Bucket.Jurisdiction,
) =>
  r2
    .getBucketEventNotification({
      accountId,
      bucketName,
      queueId,
      jurisdiction,
    })
    .pipe(
      Effect.map(
        (config): r2.GetBucketEventNotificationResponse | undefined => config,
      ),
      // "Gone" comes in several typed flavors: the bucket has no event
      // notification config at all (`NoEventNotificationConfig`, code
      // 11015), no config for this queue (`EventNotificationConfigNotFound`,
      // code 11011), or the bucket/queue themselves are gone.
      Effect.catchTag(
        [
          "NoEventNotificationConfig",
          "EventNotificationConfigNotFound",
          "BucketNotFound",
          "QueueNotFound",
        ],
        () => Effect.succeed(undefined),
      ),
    );

type ObservedRule = NonNullable<
  r2.GetBucketEventNotificationResponse["rules"]
>[number];

const toRuleAttributes = (
  rule: ObservedRule,
): BucketEventNotification.Rule => ({
  // Distilled widens generated string enums to open unions; the API only
  // returns the known action variants.
  actions: [...rule.actions] as BucketEventNotificationAction[],
  prefix: rule.prefix ?? "",
  suffix: rule.suffix ?? "",
  description: rule.description ?? undefined,
  ruleId: rule.ruleId ?? undefined,
  createdAt: rule.createdAt ?? undefined,
});

const toAttributes = (
  config: r2.GetBucketEventNotificationResponse,
  accountId: string,
  bucketName: string,
  queueId: string,
  jurisdiction: Bucket.Jurisdiction,
): BucketEventNotificationAttributes => ({
  bucketName,
  // The endpoint echoes the queue ID in dashed-UUID form while the Queues
  // API uses the undashed form — keep the canonical input ID so attributes
  // compare cleanly against `Queue.queueId`.
  queueId,
  queueName: config.queueName ?? undefined,
  accountId,
  jurisdiction,
  rules: (config.rules ?? []).map(toRuleAttributes),
});

/**
 * A rule's identity within the configuration: its matched actions (order-
 * insensitive) plus prefix/suffix. The server-assigned `ruleId` and
 * auto-generated description are deliberately excluded.
 */
const ruleIdentity = (rule: {
  actions: readonly string[];
  prefix?: string | null;
  suffix?: string | null;
}) =>
  JSON.stringify({
    actions: [...rule.actions].sort(),
    prefix: rule.prefix ?? "",
    suffix: rule.suffix ?? "",
  });

/**
 * Compares the observed rules against the desired rules as an unordered
 * set. Descriptions are compared only when the desired rule specifies one —
 * Cloudflare auto-generates a description otherwise.
 */
const sameRules = (
  observed: readonly ObservedRule[],
  desired: readonly BucketEventNotificationRule[],
): boolean => {
  if (observed.length !== desired.length) return false;
  const observedKeys = observed.map(ruleIdentity).sort();
  const desiredKeys = desired.map(ruleIdentity).sort();
  if (!deepEqual(observedKeys, desiredKeys)) return false;
  return desired.every(
    (rule) =>
      rule.description === undefined ||
      observed.some(
        (candidate) =>
          ruleIdentity(candidate) === ruleIdentity(rule) &&
          (candidate.description ?? "") === rule.description,
      ),
  );
};
