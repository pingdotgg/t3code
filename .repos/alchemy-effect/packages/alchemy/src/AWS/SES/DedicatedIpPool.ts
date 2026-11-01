import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * The pool's scaling mode. `STANDARD` pools use a fixed set of dedicated IPs
 * you request and warm up yourself; `MANAGED` pools let SES automatically
 * scale the dedicated IP capacity for you.
 */
export type DedicatedIpPoolScalingMode = sesv2.ScalingMode;

export interface DedicatedIpPoolProps {
  /**
   * Name of the dedicated IP pool. May contain lowercase letters, numbers and
   * dashes, up to 64 characters. If omitted, a deterministic lowercase
   * physical name is generated from the app, stage, and logical ID. Changing
   * the name replaces the pool.
   */
  poolName?: string;
  /**
   * The pool's scaling mode. Switching `STANDARD` → `MANAGED` is applied in
   * place via `putDedicatedIpPoolScalingAttributes`; AWS does not support
   * `MANAGED` → `STANDARD`, so that direction replaces the pool.
   * @default "STANDARD"
   */
  scalingMode?: DedicatedIpPoolScalingMode;
  /**
   * Tags to apply to the pool. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface DedicatedIpPool extends Resource<
  "AWS.SES.DedicatedIpPool",
  DedicatedIpPoolProps,
  {
    /** Name of the dedicated IP pool. */
    poolName: string;
    /** The pool's scaling mode. */
    scalingMode: DedicatedIpPoolScalingMode;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES v2 dedicated IP pool — a named group of dedicated IP addresses
 * used to send email, so you can isolate the sending reputation of different
 * kinds of mail (e.g. marketing vs. transactional).
 *
 * :::caution
 * Creating a dedicated IP pool provisions dedicated IP capacity and **starts
 * billing immediately** — `MANAGED` pools bill for managed dedicated IP usage
 * as soon as they exist, and `STANDARD` pools bill per dedicated IP you add.
 * Only create pools you intend to pay for.
 * :::
 *
 * `STANDARD` → `MANAGED` is an in-place scaling change. `MANAGED` → `STANDARD`
 * is not supported by AWS and replaces the pool.
 * ### Creating Pools
 * **Example:** Standard Pool
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const pool = yield* SES.DedicatedIpPool("Marketing", {
 *   scalingMode: "STANDARD",
 * });
 * ```
 *
 * **Example:** Managed Pool
 * ```typescript
 * const pool = yield* SES.DedicatedIpPool("Transactional", {
 *   scalingMode: "MANAGED",
 * });
 * ```
 *
 * **Example:** Explicit Pool Name
 * ```typescript
 * // Without poolName a deterministic lowercase name is derived from
 * // app/stage/id. Pool names allow lowercase letters, numbers, and dashes.
 * const pool = yield* SES.DedicatedIpPool("Marketing", {
 *   poolName: "acme-marketing",
 * });
 * ```
 *
 * ### Changing the Scaling Mode
 * **Example:** Migrate a Standard Pool to Managed
 * ```typescript
 * // STANDARD -> MANAGED is applied in place — the pool keeps its name and
 * // its dedicated IPs.
 * const pool = yield* SES.DedicatedIpPool("Marketing", {
 *   scalingMode: "MANAGED", // was "STANDARD"
 * });
 *
 * // MANAGED -> STANDARD has no AWS API, so it REPLACES the pool: a new pool
 * // is created and the old one deleted, dropping its dedicated IPs.
 * ```
 *
 * ### Isolating Reputation
 * **Example:** Separate Marketing and Transactional Reputation
 * ```typescript
 * // Give each kind of mail its own pool so a marketing reputation hit
 * // cannot take down password resets.
 * const marketing = yield* SES.DedicatedIpPool("Marketing", {
 *   scalingMode: "STANDARD",
 * });
 * const transactional = yield* SES.DedicatedIpPool("Transactional", {
 *   scalingMode: "MANAGED",
 * });
 * ```
 *
 * @resource
 */
export const DedicatedIpPool = Resource<DedicatedIpPool>(
  "AWS.SES.DedicatedIpPool",
);

const DEFAULT_SCALING_MODE = "STANDARD" as const;

const toTagRecord = (
  tags: ReadonlyArray<{ Key: string; Value: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((tag) => [tag.Key, tag.Value]));

// Dedicated IP pools are taggable but their API never returns an ARN — not
// from getDedicatedIpPool, not from listDedicatedIpPools — so the ARN that
// listTagsForResource requires has to be derived.
const dedicatedIpPoolArnOf = (
  region: string,
  accountId: string,
  name: string,
) => `arn:aws:ses:${region}:${accountId}:dedicated-ip-pool/${name}`;

export const DedicatedIpPoolProvider = () =>
  Provider.effect(
    DedicatedIpPool,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<DedicatedIpPoolProps, "poolName">,
      ) {
        return (
          props.poolName ??
          (yield* createPhysicalName({ id, maxLength: 64, lowercase: true }))
        );
      });

      const getPool = Effect.fn(function* (name: string) {
        return yield* sesv2.getDedicatedIpPool({ PoolName: name }).pipe(
          Effect.map((response) => response.DedicatedIpPool),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );
      });

      // getDedicatedIpPool does not return tags, so ownership costs a second
      // API call. Only `read` pays it — `list` deletes by name and does not
      // need to know who owns a pool.
      const getPoolTags = Effect.fn(function* (name: string) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return yield* sesv2
          .listTagsForResource({
            ResourceArn: dedicatedIpPoolArnOf(region, accountId, name),
          })
          .pipe(
            Effect.map((response) => toTagRecord(response.Tags)),
            // The pool went away between the two calls.
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed({} as Record<string, string>),
            ),
          );
      });

      return DedicatedIpPool.Provider.of({
        stables: ["poolName"],

        // Account/region-scoped: enumerate every pool so leaked test resources
        // are cleaned by nuke.
        //
        // listDedicatedIpPools returns names only, so the real ScalingMode
        // needs a read per pool — `list` must produce the same Attributes
        // shape as `read`, and reporting every pool as STANDARD would
        // misdescribe a MANAGED one. Pools that vanish mid-walk drop out.
        list: Effect.fn(function* () {
          const pages = yield* sesv2.listDedicatedIpPools
            .pages({})
            .pipe(Stream.runCollect);
          const poolNames = Array.from(pages).flatMap(
            (page) => page.DedicatedIpPools ?? [],
          );
          const pools = yield* Effect.forEach(
            poolNames,
            (poolName) =>
              getPool(poolName).pipe(
                Effect.map((pool) =>
                  pool ? [{ poolName, scalingMode: pool.ScalingMode }] : [],
                ),
              ),
            { concurrency: 2 },
          );
          return pools.flat();
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.poolName ?? (yield* createName(id, olds ?? {}));
          const found = yield* getPool(name);
          if (!found) return undefined;
          const attrs = { poolName: name, scalingMode: found.ScalingMode };
          // A pool provisions billable dedicated IP capacity, and reconcile
          // brands the ones it creates with internal tags. So existence at our
          // deterministic name is NOT proof of ownership — a pre-existing pool
          // someone else pays for must be adopted deliberately (`--adopt` /
          // `adopt(true)`) rather than silently taken over.
          const tags = yield* getPoolTags(name);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          const oldMode = olds?.scalingMode ?? DEFAULT_SCALING_MODE;
          const newMode = news?.scalingMode ?? DEFAULT_SCALING_MODE;
          // A rename replaces the pool. So does a MANAGED → STANDARD switch,
          // which AWS has no API to perform in place (STANDARD → MANAGED is a
          // supported in-place scaling change, handled in reconcile).
          if (
            oldName !== newName ||
            (oldMode === "MANAGED" && newMode === "STANDARD")
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = output?.poolName ?? (yield* createName(id, news));
          const desiredMode = news.scalingMode ?? DEFAULT_SCALING_MODE;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          let observed = yield* getPool(name);

          if (observed === undefined) {
            // 2. ENSURE — create with the desired scaling mode, branding the
            //    pool with internal tags. AlreadyExists is a race, not a
            //    failure.
            yield* sesv2
              .createDedicatedIpPool({
                PoolName: name,
                ScalingMode: desiredMode,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  Effect.succeed({}),
                ),
              );
            // Not always readable the instant create returns, and on the
            // AlreadyExists race another writer may still be mid-create.
            observed = yield* getPool(name).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (pool) => pool !== undefined,
                times: 8,
              }),
            );
          }

          // 3. SYNC — the only in-place scaling change AWS supports is
          //    STANDARD → MANAGED (MANAGED → STANDARD is a replacement, gated
          //    in diff above).
          if (observed?.ScalingMode !== desiredMode) {
            yield* sesv2.putDedicatedIpPoolScalingAttributes({
              PoolName: name,
              ScalingMode: desiredMode,
            });
          }

          // 3b. SYNC TAGS — brand the pool if it is not already ours. An
          //     adopted pool reaches this point without ever passing through
          //     the create above, so without this it would stay unbranded and
          //     `read` would keep reporting it Unowned on every later deploy.
          //     Diffed against OBSERVED cloud tags, never against olds.
          const observedTags = yield* getPoolTags(name);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 || removed.length > 0) {
            const { accountId, region } = yield* AWSEnvironment.current;
            const poolArn = dedicatedIpPoolArnOf(region, accountId, name);
            if (upsert.length > 0) {
              yield* sesv2.tagResource({ ResourceArn: poolArn, Tags: upsert });
            }
            if (removed.length > 0) {
              yield* sesv2.untagResource({
                ResourceArn: poolArn,
                TagKeys: removed,
              });
            }
          }

          return { poolName: name, scalingMode: desiredMode };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteDedicatedIpPool is idempotent for a missing pool.
          yield* sesv2
            .deleteDedicatedIpPool({ PoolName: output.poolName })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
