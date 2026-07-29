import * as finspace from "@distilled.cloud/aws/finspace";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export type KxEnvironmentStatus = finspace.EnvironmentStatus;
export type TransitGatewayConfiguration = finspace.TransitGatewayConfiguration;
export type CustomDNSServer = finspace.CustomDNSServer;

export interface KxEnvironmentProps {
  /**
   * Name of the kdb environment.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;
  /**
   * A description of the kdb environment.
   */
  description?: string;
  /**
   * The KMS key id used to encrypt data in the environment. Required;
   * changing it replaces the environment.
   */
  kmsKeyId: string;
  /**
   * Transit gateway to attach so on-prem kdb clients can reach the
   * environment. Attached once via `UpdateKxEnvironmentNetwork` after the
   * environment is created; FinSpace does not support changing an attached
   * network, so changing an existing configuration replaces the environment.
   */
  transitGatewayConfiguration?: TransitGatewayConfiguration;
  /**
   * Custom DNS servers to resolve on-prem hostnames from inside the
   * environment. Attached together with `transitGatewayConfiguration`;
   * changing an existing configuration replaces the environment.
   */
  customDNSConfiguration?: CustomDNSServer[];
  /**
   * Tags to associate with the environment.
   */
  tags?: Record<string, string>;
}

export interface KxEnvironment extends Resource<
  "AWS.FinSpace.KxEnvironment",
  KxEnvironmentProps,
  {
    /**
     * Service-assigned unique identifier of the kdb environment.
     */
    environmentId: string;
    /**
     * ARN of the kdb environment.
     */
    environmentArn: string;
    /**
     * The environment's name.
     */
    name: string;
    /**
     * Current lifecycle status of the environment.
     */
    status: KxEnvironmentStatus | undefined;
    /**
     * ID of the KMS key encrypting the environment.
     */
    kmsKeyId: string | undefined;
    /**
     * The environment's description.
     */
    description: string | undefined;
    /**
     * The transit gateway attached to the environment, if any.
     */
    transitGatewayConfiguration: TransitGatewayConfiguration | undefined;
    /**
     * The custom DNS servers configured on the environment, if any.
     */
    customDNSConfiguration: CustomDNSServer[] | undefined;
    /**
     * Current tags reported for the environment.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon FinSpace Managed kdb environment — the account-level container
 * that kdb databases, clusters, users, volumes and scaling groups live in.
 *
 * :::caution
 * kdb environment provisioning is slow (tens of minutes) and the service is
 * gated to onboarded accounts. Live lifecycle tests are gated behind
 * `AWS_TEST_FINSPACE=1`.
 * :::
 * @resource
 * @section Creating kdb Environments
 * @example Basic kdb Environment
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const key = yield* AWS.KMS.Key("KdbKey", {});
 * const env = yield* AWS.FinSpace.KxEnvironment("Kdb", {
 *   kmsKeyId: key.keyArn,
 *   description: "managed kdb environment",
 * });
 * ```
 *
 * @section Connecting to On-Prem Networks
 * @example Attach a Transit Gateway
 * ```typescript
 * const env = yield* AWS.FinSpace.KxEnvironment("Kdb", {
 *   kmsKeyId: key.keyArn,
 *   transitGatewayConfiguration: {
 *     transitGatewayID: "tgw-0123456789abcdef0",
 *     routableCIDRSpace: "10.0.0.0/16",
 *   },
 *   customDNSConfiguration: [
 *     { customDNSServerName: "dns.corp.example", customDNSServerIP: "10.0.0.2" },
 *   ],
 * });
 * ```
 */
export const KxEnvironment = Resource<KxEnvironment>(
  "AWS.FinSpace.KxEnvironment",
);

const createKxEnvironmentName = (
  id: string,
  props: { name?: string | undefined },
) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({ id, maxLength: 255 });

const fetchKxTags = Effect.fn(function* (arn: string) {
  const response = yield* finspace
    .listTagsForResource({ resourceArn: arn })
    .pipe(
      Effect.catchTag(
        ["ResourceNotFoundException", "InvalidRequestException"],
        () => Effect.succeed(undefined),
      ),
    );
  return Object.fromEntries(
    Object.entries(response?.tags ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value] as const],
    ),
  );
});

const isGone = (status: KxEnvironmentStatus | undefined) =>
  status === "DELETED" ||
  status === "DELETING" ||
  status === "DELETE_REQUESTED";

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

interface KxEnvironmentView {
  environmentId?: string;
  environmentArn?: string;
  name?: string;
  status?: KxEnvironmentStatus;
  kmsKeyId?: string;
  description?: string;
  transitGatewayConfiguration?: TransitGatewayConfiguration;
  customDNSConfiguration?: CustomDNSServer[];
}

const toKxAttributes = Effect.fn(function* (
  env: KxEnvironmentView,
  fallbackId: string,
) {
  const environmentArn = env.environmentArn ?? "";
  const attrs: KxEnvironment["Attributes"] = {
    environmentId: env.environmentId ?? fallbackId,
    environmentArn,
    name: env.name ?? "",
    status: env.status,
    kmsKeyId: env.kmsKeyId,
    description: env.description,
    transitGatewayConfiguration: env.transitGatewayConfiguration,
    customDNSConfiguration: env.customDNSConfiguration
      ? [...env.customDNSConfiguration]
      : undefined,
    tags: environmentArn ? yield* fetchKxTags(environmentArn) : {},
  };
  return attrs;
});

const readKxEnvironmentById = Effect.fn(function* (environmentId: string) {
  const response = yield* finspace
    .getKxEnvironment({ environmentId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!response || isGone(response.status)) return undefined;
  return response;
});

const findKxEnvironmentByName = Effect.fn(function* (name: string) {
  const environments = yield* finspace.listKxEnvironments.items({}).pipe(
    EffectStream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
  return environments.find((env) => env.name === name && !isGone(env.status));
});

/**
 * A kdb environment still transitioning toward the awaited status — retried
 * by the bounded schedule in {@link waitForKxEnvironmentStatus}.
 */
class KxEnvironmentNotReady extends Data.TaggedError("KxEnvironmentNotReady")<{
  readonly environmentId: string;
  readonly status: string | undefined;
}> {}

/**
 * A kdb environment whose asynchronous provisioning converged to the
 * terminal `FAILED_CREATION` status.
 */
export class KxEnvironmentProvisioningFailed extends Data.TaggedError(
  "KxEnvironmentProvisioningFailed",
)<{
  readonly environmentId: string;
  readonly status: string | undefined;
}> {}

// Explicitly-typed retry wrapper — an inline `Effect.retry` in provider
// lifecycle code leaks `Retry.Return`'s conditional type into declaration
// emit and widens the provider layer to `unknown` for every consumer of
// `AWS.providers()`.
const retryWhileNotReady = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "KxEnvironmentNotReady",
    // kdb environment provisioning is slow; poll every 20s up to ~40 min.
    schedule: Schedule.max([
      Schedule.spaced("20 seconds"),
      Schedule.recurs(120),
    ]),
  });

// Deleting an environment that is still creating/updating surfaces as a
// Conflict — bounded retry through it. Explicitly typed for the same
// declaration-emit reason as retryWhileNotReady.
const retryThroughConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.spaced("15 seconds"), Schedule.recurs(8)]),
  });

const waitForKxEnvironmentStatus = (
  environmentId: string,
  target: "CREATED" | "DELETED",
) =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const response = yield* finspace
        .getKxEnvironment({ environmentId })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      const status = response?.status;
      if (target === "DELETED") {
        if (response === undefined || isGone(status)) return;
        return yield* Effect.fail(
          new KxEnvironmentNotReady({ environmentId, status }),
        );
      }
      if (status === "CREATED") return;
      if (status === "FAILED_CREATION") {
        return yield* Effect.fail(
          new KxEnvironmentProvisioningFailed({ environmentId, status }),
        );
      }
      return yield* Effect.fail(
        new KxEnvironmentNotReady({ environmentId, status }),
      );
    }),
  );

export const KxEnvironmentProvider = () =>
  Provider.effect(
    KxEnvironment,
    Effect.gen(function* () {
      return {
        stables: ["environmentId", "environmentArn"],
        list: () =>
          Effect.gen(function* () {
            const environments = yield* finspace.listKxEnvironments
              .items({})
              .pipe(
                EffectStream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
              );
            return yield* Effect.forEach(
              environments.filter((env) => !isGone(env.status)),
              (env) => toKxAttributes(env, env.environmentId ?? ""),
              { concurrency: 5 },
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const env = output?.environmentId
            ? yield* readKxEnvironmentById(output.environmentId)
            : yield* findKxEnvironmentByName(
                yield* createKxEnvironmentName(id, olds ?? {}),
              );
          if (!env) return undefined;
          const attrs = yield* toKxAttributes(env, output?.environmentId ?? "");
          return (yield* hasAlchemyTags(id, attrs.tags as Tags))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // The KMS key is fixed at creation.
          if (olds.kmsKeyId !== news.kmsKeyId) {
            return { action: "replace" } as const;
          }
          // FinSpace does not support changing or detaching an attached
          // network (UpdateKxEnvironmentNetwork is attach-once).
          const hadNetwork =
            olds.transitGatewayConfiguration !== undefined ||
            olds.customDNSConfiguration !== undefined;
          if (
            hadNetwork &&
            (!sameJson(
              olds.transitGatewayConfiguration,
              news.transitGatewayConfiguration,
            ) ||
              !sameJson(
                olds.customDNSConfiguration,
                news.customDNSConfiguration,
              ))
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("FinSpace KxEnvironment requires props"),
            );
          }
          const name = yield* createKxEnvironmentName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the cached id; fall back to a name lookup so a
          // create whose state failed to persist is adopted, not duplicated.
          let env: KxEnvironmentView | undefined = output?.environmentId
            ? yield* readKxEnvironmentById(output.environmentId)
            : yield* findKxEnvironmentByName(name);

          // Ensure — create if missing, then wait for CREATED.
          if (env === undefined) {
            const created = yield* finspace.createKxEnvironment({
              name,
              description: news.description,
              kmsKeyId: news.kmsKeyId,
              tags: desiredTags,
            });
            if (!created.environmentId) {
              return yield* Effect.fail(
                new Error(`CreateKxEnvironment for '${name}' returned no id`),
              );
            }
            yield* session.note(
              `Creating kdb environment ${name} (${created.environmentId})...`,
            );
            yield* waitForKxEnvironmentStatus(created.environmentId, "CREATED");
            env = yield* readKxEnvironmentById(created.environmentId);
            if (env === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created kdb environment ${name}`),
              );
            }
          }
          const environmentId = env.environmentId;
          if (environmentId === undefined) {
            return yield* Effect.fail(
              new Error(`kdb environment '${name}' has no environmentId`),
            );
          }

          // Sync network — UpdateKxEnvironmentNetwork is attach-once: apply
          // only when a network is desired and none is observed. (Changing
          // an attached network is a replacement — see diff.)
          const wantsNetwork =
            news.transitGatewayConfiguration !== undefined ||
            news.customDNSConfiguration !== undefined;
          const hasNetwork =
            env.transitGatewayConfiguration !== undefined ||
            (env.customDNSConfiguration !== undefined &&
              env.customDNSConfiguration.length > 0);
          if (wantsNetwork && !hasNetwork) {
            yield* finspace.updateKxEnvironmentNetwork({
              environmentId,
              transitGatewayConfiguration: news.transitGatewayConfiguration,
              customDNSConfiguration: news.customDNSConfiguration,
            });
            yield* session.note(
              `Attaching network to kdb environment ${name}...`,
            );
            yield* waitForKxEnvironmentStatus(environmentId, "CREATED");
            env = (yield* readKxEnvironmentById(environmentId)) ?? env;
          }

          // Sync mutable settings — only call UpdateKxEnvironment on drift.
          const needsUpdate =
            name !== env.name ||
            (news.description !== undefined &&
              news.description !== env.description);
          if (needsUpdate) {
            yield* finspace.updateKxEnvironment({
              environmentId,
              name,
              description: news.description,
            });
            yield* session.note(`Updated kdb environment ${name}`);
          }

          // Sync tags — diff against observed cloud tags.
          const attrs = yield* toKxAttributes(env, environmentId);
          if (attrs.environmentArn) {
            const { removed, upsert } = diffTags(attrs.tags, desiredTags);
            if (removed.length > 0) {
              yield* finspace.untagResource({
                resourceArn: attrs.environmentArn,
                tagKeys: removed,
              });
            }
            if (upsert.length > 0) {
              yield* finspace.tagResource({
                resourceArn: attrs.environmentArn,
                tags: Object.fromEntries(
                  upsert.map(({ Key, Value }) => [Key, Value]),
                ),
              });
            }
          }

          yield* session.note(attrs.environmentArn);

          const final = yield* readKxEnvironmentById(environmentId);
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled kdb environment ${name}`),
            );
          }
          return yield* toKxAttributes(final, environmentId);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryThroughConflict(
            finspace
              .deleteKxEnvironment({ environmentId: output.environmentId })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              ),
          );
          yield* waitForKxEnvironmentStatus(output.environmentId, "DELETED");
        }),
      };
    }),
  );
