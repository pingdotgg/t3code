import * as deadline from "@distilled.cloud/aws/deadline";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags, type Tags } from "../../Tags.ts";
import { toWireHours, toWireSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import {
  asPlain,
  deadlineArnOf,
  fetchDeadlineTags,
  retryThroughIamPropagation,
  retryWhileConflict,
  retryWhileFarmSettling,
  syncDeadlineTags,
} from "./internal.ts";

export type FleetStatus = deadline.FleetStatus;

/**
 * Worker auto-scaling settings for a fleet, with idle time expressed as a
 * `Duration.Input` (converted to whole seconds on the wire).
 */
export interface FleetAutoScalingConfiguration {
  /**
   * Number of idle workers kept on standby to absorb bursts.
   * @default 0
   */
  standbyWorkerCount?: number;
  /**
   * How long a worker may sit idle before it is scaled in
   * (wire: `workerIdleDurationSeconds`).
   * @default "5 minutes"
   */
  workerIdleDuration?: Duration.Input;
  /**
   * Maximum number of workers added per minute when scaling out.
   */
  scaleOutWorkersPerMinute?: number;
}

/**
 * Customer-managed fleet configuration (you run the worker hosts).
 */
export interface CustomerManagedFleetConfiguration extends Omit<
  deadline.CustomerManagedFleetConfiguration,
  "autoScalingConfiguration"
> {
  /**
   * Auto-scaling behavior for `EVENT_BASED_AUTO_SCALING` mode.
   */
  autoScalingConfiguration?: FleetAutoScalingConfiguration;
}

/**
 * Persistent EBS volume settings for service-managed EC2 workers, with the
 * reuse TTL expressed as a `Duration.Input` (converted to whole hours on the
 * wire).
 */
export interface FleetPersistentVolumeConfiguration extends Omit<
  deadline.PersistentVolumeConfiguration,
  "lastUsedTtlHours"
> {
  /**
   * How long an unused persistent volume is retained for reuse before it is
   * deleted (wire: `lastUsedTtlHours`).
   */
  lastUsedTtl?: Duration.Input;
}

/**
 * Service-managed EC2 fleet configuration (Deadline provisions instances).
 */
export interface ServiceManagedEc2FleetConfiguration extends Omit<
  deadline.ServiceManagedEc2FleetConfiguration,
  "autoScalingConfiguration" | "persistentVolumeConfiguration"
> {
  /**
   * Auto-scaling behavior for the EC2 workers.
   */
  autoScalingConfiguration?: FleetAutoScalingConfiguration;
  /**
   * Persistent EBS volume reused across workers.
   */
  persistentVolumeConfiguration?: FleetPersistentVolumeConfiguration;
}

/**
 * Fleet configuration — either `customerManaged` (you run the workers) or
 * `serviceManagedEc2` (Deadline provisions EC2 instances).
 */
export type FleetConfiguration =
  | {
      customerManaged: CustomerManagedFleetConfiguration;
      serviceManagedEc2?: never;
    }
  | {
      customerManaged?: never;
      serviceManagedEc2: ServiceManagedEc2FleetConfiguration;
    };

/**
 * Startup script run on each worker host, with the timeout expressed as a
 * `Duration.Input` (converted to whole seconds on the wire).
 */
export interface FleetHostConfiguration {
  /**
   * The script body executed when a worker host starts.
   */
  scriptBody: string | Redacted.Redacted<string>;
  /**
   * Maximum time the startup script may run before the worker is marked
   * unhealthy (wire: `scriptTimeoutSeconds`).
   * @default "5 minutes"
   */
  scriptTimeout?: Duration.Input;
}

const toWireAutoScaling = (
  config: FleetAutoScalingConfiguration | undefined,
): deadline.CustomerManagedAutoScalingConfiguration | undefined => {
  if (config === undefined) return undefined;
  const { workerIdleDuration, ...rest } = config;
  return {
    ...rest,
    workerIdleDurationSeconds: toWireSeconds(workerIdleDuration),
  };
};

const toWirePersistentVolume = (
  config: FleetPersistentVolumeConfiguration | undefined,
): deadline.PersistentVolumeConfiguration | undefined => {
  if (config === undefined) return undefined;
  const { lastUsedTtl, ...rest } = config;
  return { ...rest, lastUsedTtlHours: toWireHours(lastUsedTtl) };
};

const toWireConfiguration = (
  config: FleetConfiguration,
): deadline.FleetConfiguration =>
  config.customerManaged !== undefined
    ? {
        customerManaged: {
          ...config.customerManaged,
          autoScalingConfiguration: toWireAutoScaling(
            config.customerManaged.autoScalingConfiguration,
          ),
        },
      }
    : {
        serviceManagedEc2: {
          ...config.serviceManagedEc2,
          autoScalingConfiguration: toWireAutoScaling(
            config.serviceManagedEc2.autoScalingConfiguration,
          ),
          persistentVolumeConfiguration: toWirePersistentVolume(
            config.serviceManagedEc2.persistentVolumeConfiguration,
          ),
        },
      };

const toWireHostConfiguration = (
  config: FleetHostConfiguration | undefined,
): deadline.HostConfiguration | undefined => {
  if (config === undefined) return undefined;
  const { scriptTimeout, ...rest } = config;
  return { ...rest, scriptTimeoutSeconds: toWireSeconds(scriptTimeout) };
};

export interface FleetProps {
  /**
   * The identifier of the farm the fleet belongs to. Changing it replaces
   * the fleet.
   */
  farmId: string;
  /**
   * Display name of the fleet.
   * @default ${app}-${stage}-${id}
   */
  displayName?: string;
  /**
   * A description of the fleet.
   */
  description?: string;
  /**
   * ARN of the IAM role fleet workers assume (trusted by
   * `credentials.deadline.amazonaws.com`).
   */
  roleArn: string;
  /**
   * Minimum number of workers the fleet keeps running.
   * @default 0
   */
  minWorkerCount?: number;
  /**
   * Maximum number of workers the fleet scales to.
   */
  maxWorkerCount: number;
  /**
   * Fleet configuration — either `customerManaged` (you run the workers) or
   * `serviceManagedEc2` (Deadline provisions EC2 instances).
   */
  configuration: FleetConfiguration;
  /**
   * Script run on each worker host when it starts.
   */
  hostConfiguration?: FleetHostConfiguration;
  /**
   * Tags to associate with the fleet.
   */
  tags?: Record<string, string>;
}

export interface Fleet extends Resource<
  "AWS.Deadline.Fleet",
  FleetProps,
  {
    /**
     * The identifier of the farm the fleet belongs to.
     */
    farmId: string;
    /**
     * Service-assigned unique identifier of the fleet (`fleet-...`).
     */
    fleetId: string;
    /**
     * ARN of the fleet.
     */
    fleetArn: string;
    /**
     * The fleet's display name.
     */
    displayName: string;
    /**
     * Current lifecycle status of the fleet.
     */
    status: FleetStatus;
    /**
     * Number of workers currently in the fleet.
     */
    workerCount: number;
    /**
     * The configured minimum worker count.
     */
    minWorkerCount: number;
    /**
     * The configured maximum worker count.
     */
    maxWorkerCount: number;
    /**
     * ARN of the fleet's worker role.
     */
    roleArn: string;
    /**
     * Current tags reported for the fleet.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Deadline Cloud fleet — a group of workers (customer-managed hosts
 * or service-managed EC2 instances) that run render jobs from associated
 * queues.
 *
 * @resource
 * @section Creating Fleets
 * @example Customer-Managed Fleet
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const fleet = yield* AWS.Deadline.Fleet("Workers", {
 *   farmId: farm.farmId,
 *   roleArn: fleetRole.roleArn,
 *   maxWorkerCount: 10,
 *   configuration: {
 *     customerManaged: {
 *       mode: "NO_SCALING",
 *       workerCapabilities: {
 *         vCpuCount: { min: 1 },
 *         memoryMiB: { min: 1024 },
 *         osFamily: "LINUX",
 *         cpuArchitectureType: "x86_64",
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @example Service-Managed EC2 Fleet
 * ```typescript
 * const fleet = yield* AWS.Deadline.Fleet("Workers", {
 *   farmId: farm.farmId,
 *   roleArn: fleetRole.roleArn,
 *   minWorkerCount: 0,
 *   maxWorkerCount: 5,
 *   configuration: {
 *     serviceManagedEc2: {
 *       instanceCapabilities: {
 *         vCpuCount: { min: 2, max: 8 },
 *         memoryMiB: { min: 4096 },
 *         osFamily: "LINUX",
 *         cpuArchitectureType: "x86_64",
 *       },
 *       instanceMarketOptions: { type: "spot" },
 *     },
 *   },
 * });
 * ```
 */
export const Fleet = Resource<Fleet>("AWS.Deadline.Fleet");

const createFleetName = (
  id: string,
  props: { displayName?: string | undefined },
) =>
  props.displayName
    ? Effect.succeed(props.displayName)
    : createPhysicalName({ id, maxLength: 100 });

interface FleetState {
  attrs: Fleet["Attributes"];
  described: deadline.GetFleetResponse;
}

const readFleetById = Effect.fn(function* (
  farmId: string,
  fleetId: string,
  arnOf: (path: string) => string,
) {
  const described = yield* deadline
    .getFleet({ farmId, fleetId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!described) return undefined;
  const fleetArn = arnOf(`farm/${described.farmId}/fleet/${described.fleetId}`);
  const state: FleetState = {
    described,
    attrs: {
      farmId: described.farmId,
      fleetId: described.fleetId,
      fleetArn,
      displayName: described.displayName,
      status: described.status,
      workerCount: described.workerCount,
      minWorkerCount: described.minWorkerCount,
      maxWorkerCount: described.maxWorkerCount,
      roleArn: described.roleArn,
      tags: yield* fetchDeadlineTags(fleetArn),
    },
  };
  return state;
});

const findFleetByDisplayName = Effect.fn(function* (
  farmId: string,
  displayName: string,
  arnOf: (path: string) => string,
) {
  const summaries = yield* deadline.listFleets.items({ farmId }).pipe(
    EffectStream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    // The parent farm may itself be gone.
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed([] as deadline.FleetSummary[]),
    ),
  );
  const match = summaries.find(
    (summary) => summary.displayName === displayName,
  );
  if (!match) return undefined;
  return yield* readFleetById(farmId, match.fleetId, arnOf);
});

/**
 * A fleet still transitioning toward the awaited state — retried by the
 * bounded wait schedules below.
 */
class FleetNotReady extends Data.TaggedError("FleetNotReady")<{
  readonly fleetId: string;
  readonly status: string | undefined;
}> {}

/**
 * A fleet whose asynchronous provisioning converged to a terminal failed
 * status (`CREATE_FAILED` / `UPDATE_FAILED`).
 */
export class FleetProvisioningFailed extends Data.TaggedError(
  "FleetProvisioningFailed",
)<{
  readonly fleetId: string;
  readonly status: string;
  readonly message: string | undefined;
}> {}

const retryWhileNotReady = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "FleetNotReady",
    // Fleet activation is usually well under a minute; stay within the
    // provider-wide bounded provisioning budget.
    schedule: Schedule.max([Schedule.spaced("6 seconds"), Schedule.recurs(9)]),
  });

const waitForFleetActive = (
  farmId: string,
  fleetId: string,
  arnOf: (path: string) => string,
) =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const state = yield* readFleetById(farmId, fleetId, arnOf);
      if (state === undefined) {
        return yield* Effect.fail(
          new FleetNotReady({ fleetId, status: undefined }),
        );
      }
      if (
        state.described.status === "CREATE_FAILED" ||
        state.described.status === "UPDATE_FAILED"
      ) {
        return yield* Effect.fail(
          new FleetProvisioningFailed({
            fleetId,
            status: state.described.status,
            message: state.described.statusMessage,
          }),
        );
      }
      if (
        state.described.status !== "ACTIVE" &&
        state.described.status !== "SUSPENDED"
      ) {
        return yield* Effect.fail(
          new FleetNotReady({ fleetId, status: state.described.status }),
        );
      }
      return state;
    }),
  );

const waitUntilFleetGone = (farmId: string, fleetId: string) =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const described = yield* deadline
        .getFleet({ farmId, fleetId })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (described !== undefined) {
        return yield* Effect.fail(
          new FleetNotReady({ fleetId, status: described.status }),
        );
      }
    }),
  ).pipe(
    // Exhausted retries: deletion is already converging server-side.
    Effect.catchTag("FleetNotReady", () => Effect.void),
  );

export const FleetProvider = () =>
  Provider.effect(
    Fleet,
    Effect.gen(function* () {
      return {
        stables: ["farmId", "fleetId", "fleetArn", "roleArn"],
        // Keyed by a parent farm — sub-resource list() convention.
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, olds, output }) {
          const arnOf = yield* deadlineArnOf;
          const farmId = output?.farmId ?? olds?.farmId;
          if (farmId === undefined) return undefined;
          const state = output?.fleetId
            ? yield* readFleetById(farmId, output.fleetId, arnOf)
            : yield* findFleetByDisplayName(
                farmId,
                yield* createFleetName(id, olds ?? {}),
                arnOf,
              );
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.attrs.tags as Tags))
            ? state.attrs
            : Unowned(state.attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // The parent farm is fixed at creation.
          if (olds.farmId !== news.farmId) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (news === undefined) {
            return yield* Effect.fail(
              new Error("AWS.Deadline.Fleet requires props"),
            );
          }
          const arnOf = yield* deadlineArnOf;
          const farmId = news.farmId;
          const displayName = yield* createFleetName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe.
          let state = output?.fleetId
            ? yield* readFleetById(farmId, output.fleetId, arnOf)
            : yield* findFleetByDisplayName(farmId, displayName, arnOf);

          // Ensure — create if missing, then wait for ACTIVE.
          if (state === undefined) {
            const created = yield* retryWhileFarmSettling(
              retryThroughIamPropagation(
                deadline.createFleet({
                  farmId,
                  displayName,
                  description: news.description,
                  roleArn: news.roleArn,
                  minWorkerCount: news.minWorkerCount,
                  maxWorkerCount: news.maxWorkerCount,
                  configuration: toWireConfiguration(news.configuration),
                  hostConfiguration: toWireHostConfiguration(
                    news.hostConfiguration,
                  ),
                  tags: desiredTags,
                }),
              ),
            );
            yield* session.note(
              `Creating fleet ${displayName} (${created.fleetId})...`,
            );
            state = yield* waitForFleetActive(farmId, created.fleetId, arnOf);
          }

          // Sync mutable settings — only when drifted from OBSERVED state.
          const described = state.described;
          const needsUpdate =
            displayName !== described.displayName ||
            (news.description !== undefined &&
              news.description !== (asPlain(described.description) ?? "")) ||
            news.roleArn !== described.roleArn ||
            (news.minWorkerCount !== undefined &&
              news.minWorkerCount !== described.minWorkerCount) ||
            news.maxWorkerCount !== described.maxWorkerCount ||
            news.configuration !== undefined;
          if (needsUpdate) {
            yield* retryWhileConflict(
              deadline.updateFleet({
                farmId,
                fleetId: state.attrs.fleetId,
                displayName,
                description: news.description,
                roleArn: news.roleArn,
                minWorkerCount: news.minWorkerCount,
                maxWorkerCount: news.maxWorkerCount,
                configuration: toWireConfiguration(news.configuration),
                hostConfiguration: toWireHostConfiguration(
                  news.hostConfiguration,
                ),
              }),
            );
            state = yield* waitForFleetActive(
              farmId,
              state.attrs.fleetId,
              arnOf,
            );
            yield* session.note(`Updated fleet ${displayName}`);
          }

          // Sync tags — diff against observed cloud tags.
          yield* syncDeadlineTags(state.attrs.fleetArn, desiredTags);

          yield* session.note(state.attrs.fleetArn);
          const final = yield* readFleetById(
            farmId,
            state.attrs.fleetId,
            arnOf,
          );
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled fleet ${displayName}`),
            );
          }
          return final.attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryWhileConflict(
            deadline.deleteFleet({
              farmId: output.farmId,
              fleetId: output.fleetId,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          // Fleet deletion drains workers asynchronously; wait until gone so
          // the parent farm's deletion does not hit a dependency conflict.
          yield* waitUntilFleetGone(output.farmId, output.fleetId);
        }),
      };
    }),
  );
