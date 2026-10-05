import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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

const DEFAULT_SESSION_AFFINITY = "NONE";
const MAX_NAME_LENGTH = 63;

export type TargetPoolSessionAffinity =
  | "NONE"
  | "CLIENT_IP"
  | "CLIENT_IP_PROTO"
  | (string & {});

export type TargetPoolProps = {
  /**
   * Target pool name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the pool.
   */
  targetPoolName?: string;
  /**
   * Region the pool lives in. Immutable — changing it replaces the pool.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Compute target pools have no labels field, so
   * Alchemy ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`)
   * is stored in a `[alchemy …]` prefix for `list` / nuke. Immutable —
   * changing the user-facing description replaces the pool.
   */
  description?: string;
  /**
   * Session affinity. Immutable — changing it replaces the pool.
   * `NONE` spreads connections. `CLIENT_IP` pins by client IP.
   * `CLIENT_IP_PROTO` pins by client IP and protocol.
   * @default "NONE"
   */
  sessionAffinity?: TargetPoolSessionAffinity;
  /**
   * Backup target pool URL or name in the same region. Used with
   * `failoverRatio` when this pool is the primary for a forwarding rule.
   * Updated in place via `setBackup`.
   */
  backupPool?: string;
  /**
   * Failover threshold in `[0, 1]`. Required when `backupPool` is set.
   * Traffic fails over when the ratio of healthy instances in this pool
   * is at or below this value. Updated in place via `setBackup`.
   */
  failoverRatio?: number;
  /**
   * Legacy HttpHealthCheck URLs or names (at most one). Only the
   * `httpHealthChecks` collection is supported — modern HealthCheck
   * resources cannot be attached. When omitted, existing checks are
   * left as-is; pass `[]` to detach.
   */
  healthChecks?: string[];
  /**
   * Member instance URLs (`projects/{project}/zones/{zone}/instances/{name}`)
   * or `zone/name` shorthand. Instances must be in this pool's region.
   * When omitted, membership is left as-is (managed instance groups may
   * add members). Pass `[]` to detach every instance.
   */
  instances?: string[];
  /**
   * Cloud Armor security policy URL. When omitted, the current policy is
   * left as-is. Pass `""` to detach. Updated in place via
   * `setSecurityPolicy`.
   */
  securityPolicy?: string;
};

export type TargetPool = Resource<
  "GCP.Compute.TargetPool",
  TargetPoolProps,
  {
    /** Target pool name. */
    targetPoolName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Session affinity. */
    sessionAffinity: string | undefined;
    /** Backup pool URL, if set. */
    backupPool: string | undefined;
    /** Failover ratio, if set. */
    failoverRatio: number | undefined;
    /** Legacy HttpHealthCheck URLs. */
    healthChecks: ReadonlyArray<string>;
    /** Member instance URLs. */
    instances: ReadonlyArray<string>;
    /** Attached Cloud Armor policy URL, if any. */
    securityPolicy: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    targetPoolId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine target pool.
 *
 * Target pools are the backend for external network load balancers
 * (target-pool forwarding rules). Members are zonal instances in the
 * same region. Health checking uses legacy HttpHealthCheck resources
 * only. Compute TargetPool has no labels field — Alchemy ownership is
 * stored in the description so nuke can find leaked pools.
 *
 * ### Creating a Target Pool
 * **Example:** Generated name
 * ```typescript
 * const pool = yield* GCP.Compute.TargetPool("backends", {});
 * ```
 *
 * **Example:** Named pool with session affinity
 * ```typescript
 * const pool = yield* GCP.Compute.TargetPool("backends", {
 *   targetPoolName: "app-nlb",
 *   region: "us-central1",
 *   sessionAffinity: "CLIENT_IP",
 *   description: "network load balancer",
 * });
 * ```
 *
 * ### Failover
 * **Example:** Primary pool with a backup
 * ```typescript
 * const backup = yield* GCP.Compute.TargetPool("failover", {});
 * const primary = yield* GCP.Compute.TargetPool("backends", {
 *   backupPool: backup.selfLink,
 *   failoverRatio: 0.5,
 * });
 * ```
 *
 * ### Instances
 * **Example:** Pin specific VMs
 * ```typescript
 * const pool = yield* GCP.Compute.TargetPool("backends", {
 *   instances: [
 *     "projects/{project}/zones/us-central1-a/instances/web-1",
 *     "us-central1-b/web-2",
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const TargetPool = Resource<TargetPool>("GCP.Compute.TargetPool");

export class TargetPoolNotResolved extends Data.TaggedError(
  "GCP.Compute.TargetPoolNotResolved",
)<{
  targetPoolName: string;
  region: string;
}> {}

export class TargetPoolPending extends Data.TaggedError(
  "GCP.Compute.TargetPoolPending",
)<{
  targetPoolName: string;
  status: string;
}> {}

const lastSegment = (value: string | undefined) => {
  if (!value) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const sessionAffinityOf = (value: string | undefined) =>
  value && value.length > 0 ? value : DEFAULT_SESSION_AFFINITY;

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

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    const rfc = generated.replace(/^[^a-z]+/, "t").replace(/-+$/g, "");
    return rfc.slice(0, MAX_NAME_LENGTH);
  });

const toPoolUrl = (project: string, region: string, pool: string) => {
  if (pool.includes("/")) return pool;
  return `projects/${project}/regions/${region}/targetPools/${pool}`;
};

const toHealthCheckUrl = (project: string, healthCheck: string) => {
  if (healthCheck.includes("/")) return healthCheck;
  return `projects/${project}/global/httpHealthChecks/${healthCheck}`;
};

const toInstanceUrl = (project: string, instance: string) => {
  if (instance.startsWith("http") || instance.startsWith("projects/")) {
    return instance;
  }
  const parts = instance.split("/").filter((part) => part.length > 0);
  if (parts.length === 2 && parts[0] !== "zones") {
    return `projects/${project}/zones/${parts[0]}/instances/${parts[1]}`;
  }
  if (parts[0] === "zones") {
    return `projects/${project}/${parts.join("/")}`;
  }
  return instance;
};

const instanceKey = (value: string) => {
  const parts = value.replace(/\/+$/, "").split("/").filter(Boolean);
  const index = parts.lastIndexOf("instances");
  if (index >= 1 && parts[index + 1]) {
    return `${parts[index - 1]}/${parts[index + 1]}`.toLowerCase();
  }
  if (parts.length === 2) {
    return `${parts[0]}/${parts[1]}`.toLowerCase();
  }
  return lastSegment(value).toLowerCase();
};

const toAttrs = (
  pool: compute.TargetPool,
  project: string,
): TargetPool["Attributes"] => {
  const parsed = parseDescription(pool.description);
  return {
    targetPoolName: pool.name ?? "",
    project,
    region: lastSegment(pool.region).toLowerCase(),
    description: parsed.description,
    sessionAffinity: sessionAffinityOf(pool.sessionAffinity),
    backupPool: pool.backupPool,
    failoverRatio: pool.failoverRatio,
    healthChecks: pool.healthChecks ?? [],
    instances: pool.instances ?? [],
    securityPolicy: pool.securityPolicy,
    selfLink: pool.selfLink,
    targetPoolId: pool.id,
    creationTimestamp: pool.creationTimestamp,
    kind: pool.kind,
  };
};

const getByName = (project: string, region: string, targetPool: string) =>
  compute
    .getTargetPools({ project, region, targetPool })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const runOp = <E, R>(
  project: string,
  region: string,
  targetPoolName: string,
  start: Effect.Effect<compute.Operation, E, R>,
) =>
  start.pipe(
    Effect.flatMap((operation) =>
      waitRegionOperation(project, region, operation),
    ),
  );

const requirePool = (project: string, region: string, targetPoolName: string) =>
  getByName(project, region, targetPoolName).pipe(
    Effect.flatMap((pool) =>
      pool
        ? Effect.succeed(pool)
        : Effect.fail(new TargetPoolNotResolved({ targetPoolName, region })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.TargetPoolNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const waitUntilGone = (
  project: string,
  region: string,
  targetPoolName: string,
) =>
  getByName(project, region, targetPoolName).pipe(
    Effect.flatMap((pool) =>
      pool === undefined
        ? Effect.void
        : Effect.fail(
            new TargetPoolPending({
              targetPoolName,
              status: "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.TargetPoolPending",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const sameRef = (left: string | undefined, right: string | undefined) =>
  lastSegment(left).toLowerCase() === lastSegment(right).toLowerCase();

export const TargetPoolProvider = () =>
  Provider.succeed(TargetPool, {
    stables: [
      "targetPoolName",
      "project",
      "region",
      "targetPoolId",
      "selfLink",
      "sessionAffinity",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.targetPoolName ?? output?.targetPoolName;
      const nextName = news.targetPoolName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        nextName !== previousName;

      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const regionChanged = previousRegion !== nextRegion;

      const affinityChanged =
        news.sessionAffinity !== undefined &&
        sessionAffinityOf(news.sessionAffinity) !==
          sessionAffinityOf(olds?.sessionAffinity ?? output?.sessionAffinity);

      const previousDescription =
        olds?.description ?? output?.description ?? "";
      const descriptionChanged =
        news.description !== undefined &&
        (news.description ?? "") !== previousDescription;

      if (nameChanged || regionChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (affinityChanged || descriptionChanged) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousName !== undefined &&
            (news.targetPoolName === undefined ||
              news.targetPoolName === previousName),
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const targetPoolName = yield* toName(
        id,
        olds?.targetPoolName,
        output?.targetPoolName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, targetPoolName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListTargetPools
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.targetPools ?? [])
              .filter((item) => {
                const { labels } = parseDescription(item.description);
                return Object.keys(labels).some((key) =>
                  key.startsWith("alchemy-"),
                );
              })
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const targetPoolName = yield* toName(
        id,
        news.targetPoolName,
        output?.targetPoolName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const sessionAffinity = sessionAffinityOf(news.sessionAffinity);
      const backupPool =
        news.backupPool !== undefined && news.backupPool.length > 0
          ? toPoolUrl(env.project, region, news.backupPool)
          : undefined;
      const healthChecks = news.healthChecks?.map((check) =>
        toHealthCheckUrl(env.project, check),
      );
      const instances = news.instances?.map((instance) =>
        toInstanceUrl(env.project, instance),
      );

      let current = yield* getByName(env.project, region, targetPoolName);

      if (current === undefined) {
        const created = yield* compute
          .insertTargetPools({
            project: env.project,
            region,
            body: {
              name: targetPoolName,
              description: desiredDescription,
              sessionAffinity,
              backupPool,
              failoverRatio: news.failoverRatio,
              healthChecks,
              instances,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }).pipe(
                Effect.flatMap(() =>
                  requirePool(env.project, region, targetPoolName),
                ),
              ),
            ),
            Effect.catchTag("Conflict", () =>
              getByName(env.project, region, targetPoolName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TargetPoolNotResolved({ targetPoolName, region });
      }

      if (news.backupPool !== undefined || news.failoverRatio !== undefined) {
        const desiredBackup =
          news.backupPool !== undefined
            ? news.backupPool.length > 0
              ? toPoolUrl(env.project, region, news.backupPool)
              : ""
            : (current.backupPool ?? "");
        const desiredFailover =
          news.failoverRatio ?? current.failoverRatio ?? 0;
        if (
          !sameRef(desiredBackup, current.backupPool) ||
          desiredFailover !== (current.failoverRatio ?? 0)
        ) {
          yield* runOp(
            env.project,
            region,
            targetPoolName,
            compute.setBackupTargetPools({
              project: env.project,
              region,
              targetPool: targetPoolName,
              failoverRatio: desiredFailover,
              body: { target: desiredBackup },
            }),
          ).pipe(Effect.catchTag("Conflict", () => Effect.void));
          current =
            (yield* getByName(env.project, region, targetPoolName)) ?? current;
        }
      }

      if (healthChecks !== undefined) {
        const observed = current.healthChecks ?? [];
        const observedKeys = new Set(observed.map((url) => lastSegment(url)));
        const desiredKeys = new Set(
          healthChecks.map((url) => lastSegment(url)),
        );
        const toAdd = healthChecks.filter(
          (url) => !observedKeys.has(lastSegment(url)),
        );
        const toRemove = observed.filter(
          (url) => !desiredKeys.has(lastSegment(url)),
        );
        if (toAdd.length > 0) {
          yield* runOp(
            env.project,
            region,
            targetPoolName,
            compute.addHealthCheckTargetPools({
              project: env.project,
              region,
              targetPool: targetPoolName,
              body: {
                healthChecks: toAdd.map((healthCheck) => ({ healthCheck })),
              },
            }),
          );
        }
        if (toRemove.length > 0) {
          yield* runOp(
            env.project,
            region,
            targetPoolName,
            compute.removeHealthCheckTargetPools({
              project: env.project,
              region,
              targetPool: targetPoolName,
              body: {
                healthChecks: toRemove.map((healthCheck) => ({ healthCheck })),
              },
            }),
          );
        }
        current =
          (yield* getByName(env.project, region, targetPoolName)) ?? current;
      }

      if (instances !== undefined) {
        const observed = current.instances ?? [];
        const observedKeys = new Set(observed.map(instanceKey));
        const desiredKeys = new Set(instances.map(instanceKey));
        const toAdd = instances.filter(
          (url) => !observedKeys.has(instanceKey(url)),
        );
        const toRemove = observed.filter(
          (url) => !desiredKeys.has(instanceKey(url)),
        );
        if (toAdd.length > 0) {
          yield* runOp(
            env.project,
            region,
            targetPoolName,
            compute.addInstanceTargetPools({
              project: env.project,
              region,
              targetPool: targetPoolName,
              body: {
                instances: toAdd.map((instance) => ({ instance })),
              },
            }),
          );
        }
        if (toRemove.length > 0) {
          yield* runOp(
            env.project,
            region,
            targetPoolName,
            compute.removeInstanceTargetPools({
              project: env.project,
              region,
              targetPool: targetPoolName,
              body: {
                instances: toRemove.map((instance) => ({ instance })),
              },
            }),
          );
        }
        current =
          (yield* getByName(env.project, region, targetPoolName)) ?? current;
      }

      if (news.securityPolicy !== undefined) {
        const desiredPolicy = news.securityPolicy;
        if (!sameRef(desiredPolicy, current.securityPolicy ?? "")) {
          yield* runOp(
            env.project,
            region,
            targetPoolName,
            compute.setSecurityPolicyTargetPools({
              project: env.project,
              region,
              targetPool: targetPoolName,
              body: { securityPolicy: desiredPolicy },
            }),
          );
          current =
            (yield* getByName(env.project, region, targetPoolName)) ?? current;
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      yield* compute
        .deleteTargetPools({
          project,
          region,
          targetPool: output.targetPoolName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitRegionOperation(project, region, operation, {
              ignore: ["RESOURCE_NOT_FOUND"],
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(project, region, output.targetPoolName);
    }),
  });
