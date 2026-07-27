import * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireMinutes } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import {
  awaitApplicationCreated,
  awaitApplicationStopped,
} from "./internal.ts";

/**
 * The engine an EMR Serverless application runs. Changing the type replaces
 * the application.
 */
export type ApplicationType = "SPARK" | "HIVE";

/**
 * Auto-stop behavior for an EMR Serverless {@link Application}.
 */
export interface AutoStopConfiguration {
  /**
   * Whether the application stops automatically after being idle.
   * @default true
   */
  enabled?: boolean;
  /**
   * Idle time after which the application stops automatically — e.g.
   * `"5 minutes"` or `Duration.minutes(5)`. Sent to AWS as whole minutes.
   * @default "15 minutes"
   */
  idleTimeout?: Duration.Input;
}

/** Convert the alchemy-facing auto-stop config to the wire shape (minutes). */
const toWireAutoStop = (config: AutoStopConfiguration): emr.AutoStopConfig => ({
  enabled: config.enabled,
  idleTimeoutMinutes: toWireMinutes(config.idleTimeout),
});

export interface ApplicationProps {
  /**
   * Name of the application (1-64 characters: letters, digits, `.` `_` `/`
   * `#` `-`). Changing the name replaces the application.
   * @default a generated physical name
   */
  applicationName?: string;
  /**
   * The engine type. Changing the type replaces the application.
   * @default "SPARK"
   */
  type?: ApplicationType;
  /**
   * The Amazon EMR release associated with the application, e.g.
   * `emr-7.9.0`. Updatable in place (the application must be in a `CREATED`
   * or `STOPPED` state; the provider stops a `STARTED` application before
   * applying the update).
   */
  releaseLabel: string;
  /**
   * The CPU architecture of the application.
   * @default "X86_64"
   */
  architecture?: "X86_64" | "ARM64";
  /**
   * Pre-initialized capacity kept warm per worker type (e.g. `Driver` and
   * `Executor` for Spark; `HiveDriver` and `TezTask` for Hive). Warm workers
   * bill while the application is started.
   */
  initialCapacity?: Record<string, emr.InitialCapacityConfig>;
  /**
   * The maximum aggregate vCPU, memory and disk the application may scale to.
   */
  maximumCapacity?: emr.MaximumAllowedResources;
  /**
   * Whether the application starts automatically on job submission.
   * @default enabled
   */
  autoStartConfiguration?: emr.AutoStartConfig;
  /**
   * Whether (and after how long idle) the application stops
   * automatically.
   * @default enabled after 15 idle minutes
   */
  autoStopConfiguration?: AutoStopConfiguration;
  /**
   * VPC connectivity (subnet + security group IDs) for jobs that must reach
   * resources in a VPC. Omit for the default non-VPC connectivity.
   */
  networkConfiguration?: emr.NetworkConfiguration;
  /**
   * Tags to apply to the application. Merged with the internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Application extends Resource<
  "AWS.EMRServerless.Application",
  ApplicationProps,
  {
    /** The ID of the application. */
    applicationId: string;
    /** The name of the application. */
    applicationName: string;
    /** The ARN of the application. */
    applicationArn: string;
    /** The application type (`SPARK` or `HIVE`). */
    type: string;
    /** The EMR release label the application runs (e.g. `emr-7.5.0`). */
    releaseLabel: string;
    /** The application state (e.g. `CREATED`, `STARTED`, `STOPPED`). */
    state?: string;
  },
  {},
  Providers
> {}

/**
 * An Amazon EMR Serverless application — a serverless Spark or Hive
 * environment that automatically provisions and scales workers per job,
 * with no cluster to manage. An application in the `CREATED` or `STOPPED`
 * state costs nothing; billing only occurs for workers while the application
 * is started (including any pre-initialized `initialCapacity`).
 *
 * @resource
 * @section Creating Applications
 * @example Spark Application
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const app = yield* AWS.EMRServerless.Application("Spark", {
 *   releaseLabel: "emr-7.9.0",
 * });
 * // app.applicationId is passed to StartJobRun
 * ```
 *
 * @example Hive Application with Auto-Stop Tuning
 * ```typescript
 * const app = yield* AWS.EMRServerless.Application("Hive", {
 *   type: "HIVE",
 *   releaseLabel: "emr-7.9.0",
 *   autoStartConfiguration: { enabled: true },
 *   autoStopConfiguration: { enabled: true, idleTimeout: "5 minutes" },
 * });
 * ```
 *
 * @section Capacity
 * @example Pre-Initialized Capacity for Low-Latency Jobs
 * ```typescript
 * const app = yield* AWS.EMRServerless.Application("Warm", {
 *   releaseLabel: "emr-7.9.0",
 *   initialCapacity: {
 *     Driver: {
 *       workerCount: 1,
 *       workerConfiguration: { cpu: "2 vCPU", memory: "4 GB" },
 *     },
 *     Executor: {
 *       workerCount: 2,
 *       workerConfiguration: { cpu: "2 vCPU", memory: "4 GB" },
 *     },
 *   },
 *   maximumCapacity: { cpu: "16 vCPU", memory: "64 GB" },
 * });
 * ```
 *
 * @section Networking
 * @example VPC-Connected Application
 * ```typescript
 * const app = yield* AWS.EMRServerless.Application("InVpc", {
 *   releaseLabel: "emr-7.9.0",
 *   networkConfiguration: {
 *     subnetIds: [subnet.subnetId],
 *     securityGroupIds: [securityGroup.securityGroupId],
 *   },
 * });
 * ```
 */
export const Application = Resource<Application>(
  "AWS.EMRServerless.Application",
);

/** Normalize a possibly-undefined structural prop for drift comparison. */
const canonical = (value: unknown): string =>
  value === undefined ? "" : JSON.stringify(value);

/**
 * Derive a deterministic create token from the resource's instance ID so a
 * retried create after a crashed reconcile never double-provisions.
 */
const createToken = (instanceId: string): string =>
  instanceId.replaceAll(/[^a-zA-Z0-9]/g, "").slice(0, 64) || "alchemy";

export const ApplicationProvider = () =>
  Provider.effect(
    Application,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { applicationName?: string | undefined },
      ) {
        return (
          props.applicationName ??
          (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const toAttributes = (application: emr.Application) => ({
        applicationId: application.applicationId,
        applicationName: application.name ?? application.applicationId,
        applicationArn: application.arn,
        type: application.type,
        releaseLabel: application.releaseLabel,
        state: application.state,
      });

      const observeById = Effect.fn(function* (applicationId: string) {
        return yield* emr.getApplication({ applicationId }).pipe(
          Effect.map((response) => response.application),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      // Applications can only be fetched by id; when the id is unknown (state
      // persistence failed before the first reconcile completed), find the
      // live (non-terminated) application carrying the derived physical name.
      const observeByName = Effect.fn(function* (name: string) {
        const summary = yield* emr.listApplications.items({}).pipe(
          Stream.filter((s) => s.name === name && s.state !== "TERMINATED"),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );
        if (summary === undefined) {
          return undefined;
        }
        return yield* observeById(summary.id);
      });

      const observe = Effect.fn(function* (
        applicationId: string | undefined,
        name: string,
      ) {
        const byId =
          applicationId !== undefined
            ? yield* observeById(applicationId)
            : undefined;
        if (byId !== undefined && byId.state !== "TERMINATED") {
          return byId;
        }
        return yield* observeByName(name);
      });

      const syncTags = Effect.fn(function* (
        application: emr.Application,
        desired: Record<string, string>,
      ) {
        // Diff against OBSERVED cloud tags (adoption may bring foreign tags).
        const observed = Object.fromEntries(
          Object.entries(application.tags ?? {}).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
        const { upsert, removed } = diffTags(observed, desired);
        if (upsert.length > 0) {
          yield* emr.tagResource({
            resourceArn: application.arn,
            tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
          });
        }
        if (removed.length > 0) {
          yield* emr.untagResource({
            resourceArn: application.arn,
            tagKeys: removed,
          });
        }
      });

      return Application.Provider.of({
        stables: ["applicationId", "applicationName", "applicationArn", "type"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* emr.listApplications
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.applications)
              .filter((s) => s.state !== "TERMINATED")
              .map((s) => ({
                applicationId: s.id,
                applicationName: s.name ?? s.id,
                applicationArn: s.arn,
                type: s.type,
                releaseLabel: s.releaseLabel,
                state: s.state,
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.applicationName ?? (yield* createName(id, olds ?? {}));
          const application = yield* observe(output?.applicationId, name);
          if (application === undefined) {
            return undefined;
          }
          const attrs = toAttributes(application);
          return (yield* hasAlchemyTags(id, application.tags))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if ((olds.type ?? "SPARK") !== (news.type ?? "SPARK")) {
            return { action: "replace" } as const;
          }
          // releaseLabel/capacity/autoStart/autoStop/network/tags → update
        }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          session,
          instanceId,
        }) {
          const name = output?.applicationName ?? (yield* createName(id, news));
          const type = news.type ?? "SPARK";
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredAutoStop =
            news.autoStopConfiguration !== undefined
              ? toWireAutoStop(news.autoStopConfiguration)
              : undefined;

          // 1. OBSERVE — cloud state is authoritative; output is an id cache
          let application = yield* observe(output?.applicationId, name);

          // 2. ENSURE — create if missing; ~1 min async until CREATED
          if (application === undefined || application.state === "TERMINATED") {
            const created = yield* emr
              .createApplication({
                clientToken: createToken(instanceId),
                name,
                type,
                releaseLabel: news.releaseLabel,
                architecture: news.architecture,
                initialCapacity: news.initialCapacity,
                maximumCapacity: news.maximumCapacity,
                autoStartConfiguration: news.autoStartConfiguration,
                autoStopConfiguration: desiredAutoStop,
                networkConfiguration: news.networkConfiguration,
                tags: desiredTags,
              })
              .pipe(
                // a concurrent reconciler already created it — observe instead
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            const applicationId =
              created?.applicationId ??
              (yield* observeByName(name))?.applicationId;
            if (applicationId === undefined) {
              return yield* Effect.fail(
                new emr.ResourceNotFoundException({
                  message: `application ${name} not visible after create`,
                }),
              );
            }
            yield* session.note(`creating application ${name} (async)...`);
            application = yield* awaitApplicationCreated(applicationId);
          } else if (application.state === "CREATING") {
            application = yield* awaitApplicationCreated(
              application.applicationId,
            );
          }

          // 3. SYNC — diff each mutable aspect (observed vs desired), apply a
          //    single updateApplication carrying only the drifted fields.
          const drift = {
            releaseLabel:
              news.releaseLabel !== application.releaseLabel
                ? news.releaseLabel
                : undefined,
            architecture:
              news.architecture !== undefined &&
              news.architecture !== application.architecture
                ? news.architecture
                : undefined,
            initialCapacity:
              news.initialCapacity !== undefined &&
              canonical(news.initialCapacity) !==
                canonical(application.initialCapacity)
                ? news.initialCapacity
                : undefined,
            maximumCapacity:
              news.maximumCapacity !== undefined &&
              canonical(news.maximumCapacity) !==
                canonical(application.maximumCapacity)
                ? news.maximumCapacity
                : undefined,
            autoStartConfiguration:
              news.autoStartConfiguration !== undefined &&
              canonical(news.autoStartConfiguration) !==
                canonical(application.autoStartConfiguration)
                ? news.autoStartConfiguration
                : undefined,
            autoStopConfiguration:
              desiredAutoStop !== undefined &&
              canonical(desiredAutoStop) !==
                canonical(application.autoStopConfiguration)
                ? desiredAutoStop
                : undefined,
            networkConfiguration:
              news.networkConfiguration !== undefined &&
              canonical(news.networkConfiguration) !==
                canonical(application.networkConfiguration)
                ? news.networkConfiguration
                : undefined,
          };
          if (Object.values(drift).some((v) => v !== undefined)) {
            // Updates require a CREATED or STOPPED state — stop a started
            // application first (autoStart re-starts it on job submission).
            if (
              application.state === "STARTED" ||
              application.state === "STARTING"
            ) {
              yield* emr.stopApplication({
                applicationId: application.applicationId,
              });
            }
            yield* awaitApplicationStopped(application.applicationId);
            // Fresh token per update: distinct desired states must never be
            // deduplicated against each other.
            const updateToken = yield* Effect.sync(() => crypto.randomUUID());
            const updated = yield* emr.updateApplication({
              applicationId: application.applicationId,
              clientToken: updateToken,
              ...drift,
            });
            application = updated.application;
          }

          // 3b. SYNC TAGS — diff against observed cloud tags
          yield* syncTags(application, desiredTags);

          yield* session.note(application.applicationId);
          return toAttributes(application);
        }),

        delete: Effect.fn(function* ({ output }) {
          const application = yield* emr
            .getApplication({ applicationId: output.applicationId })
            .pipe(
              Effect.map((response) => response.application),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (application === undefined || application.state === "TERMINATED") {
            return;
          }
          // Deletion requires a CREATED or STOPPED state.
          if (
            application.state === "STARTED" ||
            application.state === "STARTING"
          ) {
            yield* emr.stopApplication({
              applicationId: application.applicationId,
            });
          }
          yield* awaitApplicationStopped(application.applicationId).pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
          yield* emr
            .deleteApplication({ applicationId: output.applicationId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
