import * as securitylake from "@distilled.cloud/aws/securitylake";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  readSecurityLakeTags,
  retryWhileConflict,
  toTagList,
} from "./internal.ts";

/**
 * The AWS identity (principal + external ID) that a subscriber authenticates
 * with when consuming data from Security Lake.
 */
export interface SubscriberIdentity {
  /** The AWS principal (account ID or service principal) of the subscriber. */
  principal: string;
  /** The external ID the subscriber must present when assuming the role. */
  externalId: string;
}

/**
 * A log source a subscriber consumes — either a natively supported AWS source
 * or a custom source.
 */
export type SubscriberSource = securitylake.LogSourceResource;

/**
 * How the subscriber accesses the data — direct S3 access or Lake Formation
 * (query) access.
 */
export type SubscriberAccessType = "LAKEFORMATION" | "S3";

export interface SubscriberProps {
  /**
   * Name of the subscriber. If omitted, a unique physical name is generated
   * from the app, stage, and logical ID.
   */
  subscriberName?: string;

  /**
   * The AWS identity (principal + external ID) the subscriber uses to access
   * Security Lake data.
   */
  subscriberIdentity: SubscriberIdentity;

  /**
   * Description of the subscriber.
   */
  subscriberDescription?: string;

  /**
   * The log sources the subscriber consumes, e.g.
   * `[{ awsLogSource: { sourceName: "ROUTE53", sourceVersion: "2.0" } }]`.
   */
  sources: SubscriberSource[];

  /**
   * How the subscriber accesses the data. Changing this replaces the
   * subscriber (access type is create-only).
   * @default ["S3"]
   */
  accessTypes?: SubscriberAccessType[];

  /**
   * Tags applied to the subscriber. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

/** @resource */
export interface Subscriber extends Resource<
  "AWS.SecurityLake.Subscriber",
  SubscriberProps,
  {
    /** Unique ID of the subscriber (UUID). */
    subscriberId: string;
    /** ARN of the subscriber. */
    subscriberArn: string;
    /** Name of the subscriber. */
    subscriberName: string;
    /** Current status (`ACTIVE`, `PENDING`, `READY`, `DEACTIVATED`). */
    subscriberStatus: string | undefined;
    /** ARN of the IAM role created for the subscriber to assume. */
    roleArn: string | undefined;
    /** ARN of the S3 bucket the subscriber reads from. */
    s3BucketArn: string | undefined;
    /** The subscriber's notification endpoint, if one is configured. */
    subscriberEndpoint: string | undefined;
    /** ARN of the RAM resource share (Lake Formation access only). */
    resourceShareArn: string | undefined;
    /** Name of the RAM resource share (Lake Formation access only). */
    resourceShareName: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Security Lake subscriber — a consumer (account or service) granted access
 * to data in the Security Lake data lake for specific log sources.
 *
 * @section Creating a Subscriber
 * @example S3 data-access subscriber
 * ```typescript
 * const subscriber = yield* SecurityLake.Subscriber("Analytics", {
 *   subscriberIdentity: {
 *     principal: "123456789012",
 *     externalId: "analytics-external-id",
 *   },
 *   sources: [{ awsLogSource: { sourceName: "ROUTE53", sourceVersion: "2.0" } }],
 * });
 * ```
 *
 * @example Lake Formation (query) access
 * ```typescript
 * const subscriber = yield* SecurityLake.Subscriber("Athena", {
 *   subscriberName: "athena-consumer",
 *   subscriberDescription: "Athena query access to VPC flow logs",
 *   subscriberIdentity: {
 *     principal: "123456789012",
 *     externalId: "athena-external-id",
 *   },
 *   sources: [{ awsLogSource: { sourceName: "VPC_FLOW", sourceVersion: "2.0" } }],
 *   accessTypes: ["LAKEFORMATION"],
 *   tags: { team: "security" },
 * });
 * ```
 */
const SubscriberResource = Resource<Subscriber>("AWS.SecurityLake.Subscriber");

export { SubscriberResource as Subscriber };

/**
 * `CreateSubscriber` returned without a subscriber body and the subscriber
 * could not be re-observed by name.
 */
export class SubscriberCreateFailed extends Data.TaggedError(
  "SubscriberCreateFailed",
)<{ readonly subscriberName: string }> {}

const buildAttrs = (subscriber: securitylake.SubscriberResource) => ({
  subscriberId: subscriber.subscriberId,
  subscriberArn: subscriber.subscriberArn,
  subscriberName: subscriber.subscriberName,
  subscriberStatus: subscriber.subscriberStatus,
  roleArn: subscriber.roleArn,
  s3BucketArn: subscriber.s3BucketArn,
  subscriberEndpoint: subscriber.subscriberEndpoint,
  resourceShareArn: subscriber.resourceShareArn,
  resourceShareName: subscriber.resourceShareName,
});

// Desired sources match observed sources when every desired entry appears in
// the observed list (AWS resolves an omitted sourceVersion, so it is only
// compared when the desired entry pins one) and the counts agree.
const sourcesMatch = (
  desired: readonly securitylake.LogSourceResource[],
  observed: readonly securitylake.LogSourceResource[],
) =>
  desired.length === observed.length &&
  desired.every((want) => {
    const wantAws = want.awsLogSource;
    if (wantAws !== undefined) {
      return observed.some((have) => {
        const haveAws = have.awsLogSource;
        return (
          haveAws !== undefined &&
          haveAws.sourceName === wantAws.sourceName &&
          (wantAws.sourceVersion === undefined ||
            haveAws.sourceVersion === wantAws.sourceVersion)
        );
      });
    }
    return observed.some(
      (have) =>
        have.customLogSource?.sourceName === want.customLogSource?.sourceName &&
        (want.customLogSource?.sourceVersion === undefined ||
          have.customLogSource?.sourceVersion ===
            want.customLogSource.sourceVersion),
    );
  });

export const SubscriberProvider = () =>
  Provider.effect(
    SubscriberResource,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { subscriberName?: string },
      ) {
        return (
          props.subscriberName ??
          (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const getById = (subscriberId: string) =>
        securitylake.getSubscriber({ subscriberId }).pipe(
          Effect.map((response) => response.subscriber),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      // Subscriber names are unique per account/region — find the live
      // subscriber carrying our deterministic name when state was lost.
      const findByName = (subscriberName: string) =>
        securitylake.listSubscribers.items({}).pipe(
          Stream.filter(
            (subscriber) => subscriber.subscriberName === subscriberName,
          ),
          Stream.take(1),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );

      return {
        read: Effect.fn(function* ({ id, olds, output }) {
          // An account that never onboarded Security Lake rejects subscriber
          // APIs with UnauthorizedException — that means "no subscriber".
          const subscriber = yield* (
            output?.subscriberId
              ? getById(output.subscriberId)
              : Effect.flatMap(createName(id, olds ?? {}), findByName)
          ).pipe(
            Effect.catchTag("UnauthorizedException", () =>
              Effect.succeed(undefined),
            ),
          );
          if (subscriber === undefined) return undefined;
          const attrs = buildAttrs(subscriber);
          const tags = yield* readSecurityLakeTags(attrs.subscriberArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        list: () =>
          securitylake.listSubscribers.items({}).pipe(
            Stream.runCollect,
            Effect.map((subscribers) => [...subscribers].map(buildAttrs)),
            // An account that never onboarded Security Lake has no
            // subscribers to enumerate.
            Effect.catchTag(
              [
                "AccessDeniedException",
                "ResourceNotFoundException",
                "UnauthorizedException",
              ],
              () => Effect.succeed([]),
            ),
          ),

        // accessTypes is create-only (UpdateSubscriber cannot change it).
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldAccess = [...(olds.accessTypes ?? ["S3"])].sort();
          const newAccess = [...(news.accessTypes ?? ["S3"])].sort();
          if (
            oldAccess.length !== newAccess.length ||
            oldAccess.some((value, index) => value !== newAccess[index])
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const subscriberName = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — by cached id first, then by deterministic name.
          let subscriber = output?.subscriberId
            ? yield* getById(output.subscriberId)
            : undefined;
          subscriber ??= yield* findByName(subscriberName);

          // 2. ENSURE — create when missing; a ConflictException means a
          // concurrent create won the race, so re-observe by name.
          if (subscriber === undefined) {
            subscriber = yield* securitylake
              .createSubscriber({
                subscriberName,
                subscriberIdentity: news.subscriberIdentity,
                subscriberDescription: news.subscriberDescription,
                sources: news.sources,
                accessTypes: news.accessTypes,
                tags: toTagList(desiredTags),
              })
              .pipe(
                Effect.map((response) => response.subscriber),
                Effect.catchTag("ConflictException", () =>
                  findByName(subscriberName),
                ),
              );
            if (subscriber === undefined) {
              return yield* Effect.fail(
                new SubscriberCreateFailed({ subscriberName }),
              );
            }
          } else {
            // 3. SYNC mutable settings — observed ↔ desired.
            const changed =
              subscriber.subscriberName !== subscriberName ||
              (subscriber.subscriberDescription ?? "") !==
                (news.subscriberDescription ?? "") ||
              subscriber.subscriberIdentity.principal !==
                news.subscriberIdentity.principal ||
              subscriber.subscriberIdentity.externalId !==
                news.subscriberIdentity.externalId ||
              !sourcesMatch(news.sources, subscriber.sources);
            if (changed) {
              subscriber = yield* securitylake
                .updateSubscriber({
                  subscriberId: subscriber.subscriberId,
                  subscriberName,
                  subscriberDescription: news.subscriberDescription,
                  subscriberIdentity: news.subscriberIdentity,
                  sources: news.sources,
                })
                .pipe(
                  retryWhileConflict,
                  Effect.map((response) => response.subscriber ?? subscriber!),
                );
            }

            // 3b. SYNC tags — diff against OBSERVED cloud tags.
            const observedTags = yield* readSecurityLakeTags(
              subscriber.subscriberArn,
            );
            const { upsert, removed } = diffTags(observedTags, desiredTags);
            if (upsert.length > 0) {
              yield* securitylake.tagResource({
                resourceArn: subscriber.subscriberArn,
                tags: upsert.map((t) => ({ key: t.Key, value: t.Value })),
              });
            }
            if (removed.length > 0) {
              yield* securitylake.untagResource({
                resourceArn: subscriber.subscriberArn,
                tagKeys: removed,
              });
            }
          }

          // 4. RETURN fresh attributes.
          const final = (yield* getById(subscriber.subscriberId)) ?? subscriber;
          yield* session.note(final.subscriberArn);
          return buildAttrs(final);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* securitylake
            .deleteSubscriber({ subscriberId: output.subscriberId })
            .pipe(
              retryWhileConflict,
              // Gone already, or the data lake itself was offboarded first
              // (which removes all subscribers and makes subscriber APIs
              // reject with UnauthorizedException).
              Effect.catchTag(
                ["ResourceNotFoundException", "UnauthorizedException"],
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
