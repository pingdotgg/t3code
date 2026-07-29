import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface MonitorProps {
  /**
   * Name of the monitor. Must be 1-255 characters of letters, digits,
   * hyphens (-), periods (.) and underscores (_). If omitted, a
   * deterministic physical name is generated. Changing the name replaces
   * the monitor.
   */
  monitorName?: string;
  /**
   * ARNs of the resources to monitor — VPCs, Network Load Balancers,
   * CloudFront distributions, or Amazon WorkSpaces directories. Added and
   * removed in place via UpdateMonitor.
   * @default [] — no resources are monitored until some are added
   */
  resources?: string[];
  /**
   * The maximum number of city-networks (client locations and ASNs,
   * typically ISPs) to monitor for your resources. Caps the total traffic
   * that Internet Monitor monitors (and therefore the cost). You must set
   * either this or `trafficPercentageToMonitor`.
   */
  maxCityNetworksToMonitor?: number;
  /**
   * The percentage of the internet-facing traffic for your application to
   * monitor. You must set either this or `maxCityNetworksToMonitor`.
   */
  trafficPercentageToMonitor?: number;
  /**
   * Publish internet measurements for the monitor to an Amazon S3 bucket
   * (in addition to CloudWatch Logs).
   */
  internetMeasurementsLogDelivery?: im.InternetMeasurementsLogDelivery;
  /**
   * Health-event thresholds — the percentage of overall traffic impact at
   * which the monitor creates availability or performance health events.
   * @default AWS creates health events at a 95% threshold
   */
  healthEventsConfig?: im.HealthEventsConfig;
  /**
   * Desired state of the monitor — `"ACTIVE"` (monitoring) or
   * `"INACTIVE"` (paused). Toggled in place via UpdateMonitor.
   * @default "ACTIVE"
   */
  status?: "ACTIVE" | "INACTIVE";
  /**
   * User-defined tags for the monitor.
   */
  tags?: Record<string, string>;
}

export interface Monitor extends Resource<
  "AWS.InternetMonitor.Monitor",
  MonitorProps,
  {
    /** The name of the monitor. */
    monitorName: string;
    /** The ARN of the monitor. */
    monitorArn: string;
    /** The current status of the monitor (`ACTIVE`, `INACTIVE`, ...). */
    status: string;
    /** The health-event data-processing status of the monitor. */
    processingStatus: string | undefined;
    /** The ARNs of the resources the monitor watches. */
    resources: string[];
    /** The effective cap on monitored city-networks. */
    maxCityNetworksToMonitor: number | undefined;
    /** The effective percentage of traffic monitored. */
    trafficPercentageToMonitor: number | undefined;
    /** The tags applied to the monitor. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon CloudWatch Internet Monitor **monitor** — measures internet
 * availability and performance between your AWS-hosted application and your
 * end users' city-networks (client locations and ASNs, typically ISPs).
 *
 * A monitor is built from the application resources you add to it: VPCs,
 * Network Load Balancers, CloudFront distributions, or WorkSpaces
 * directories. Cost is controlled by capping the number of monitored
 * city-networks (`maxCityNetworksToMonitor`) or the percentage of traffic
 * monitored (`trafficPercentageToMonitor`).
 *
 * @resource
 * @section Creating a Monitor
 * @example Monitor for a VPC
 * ```typescript
 * import * as InternetMonitor from "alchemy/AWS/InternetMonitor";
 *
 * const monitor = yield* InternetMonitor.Monitor("AppMonitor", {
 *   resources: [`arn:aws:ec2:us-east-1:123456789012:vpc/${vpc.vpcId}`],
 *   maxCityNetworksToMonitor: 100,
 * });
 * ```
 *
 * @example Monitor a percentage of traffic
 * ```typescript
 * const monitor = yield* InternetMonitor.Monitor("AppMonitor", {
 *   resources: [cloudfrontDistributionArn],
 *   trafficPercentageToMonitor: 50,
 * });
 * ```
 *
 * @section Health Events
 * @example Custom health-event thresholds
 * ```typescript
 * const monitor = yield* InternetMonitor.Monitor("AppMonitor", {
 *   resources: [vpcArn],
 *   maxCityNetworksToMonitor: 100,
 *   healthEventsConfig: {
 *     AvailabilityScoreThreshold: 90,
 *     PerformanceScoreThreshold: 90,
 *   },
 * });
 * ```
 *
 * @section Log Delivery
 * @example Publish measurements to S3
 * ```typescript
 * const monitor = yield* InternetMonitor.Monitor("AppMonitor", {
 *   resources: [vpcArn],
 *   maxCityNetworksToMonitor: 100,
 *   internetMeasurementsLogDelivery: {
 *     S3Config: {
 *       BucketName: bucket.bucketName,
 *       LogDeliveryStatus: "ENABLED",
 *     },
 *   },
 * });
 * ```
 */
export const Monitor = Resource<Monitor>("AWS.InternetMonitor.Monitor");

/** Normalize the wire tag map (values may be undefined) to a plain record. */
const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export const MonitorProvider = () =>
  Provider.effect(
    Monitor,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (id: string, props: MonitorProps) {
        return props.monitorName ?? (yield* createPhysicalName({ id }));
      });

      const readMonitor = Effect.fn(function* (name: string) {
        return yield* im
          .getMonitor({ MonitorName: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      // Bounded wait for the monitor to leave PENDING (create and updates
      // both transition PENDING -> ACTIVE/INACTIVE, typically in seconds).
      const waitUntilSettled = Effect.fn(function* (name: string) {
        const policy = Schedule.max([
          Schedule.fixed("10 seconds"),
          Schedule.recurs(8),
        ]);
        return yield* readMonitor(name).pipe(
          Effect.flatMap((monitor) => {
            if (monitor === undefined) {
              return Effect.fail(
                new Error(`Internet Monitor monitor '${name}' not found`),
              );
            }
            if (monitor.Status === "PENDING") {
              return Effect.fail(
                new Error(
                  `Internet Monitor monitor '${name}' is still PENDING`,
                ),
              );
            }
            return Effect.succeed(monitor);
          }),
          Effect.retry({ schedule: policy }),
        );
      });

      const toAttrs = (monitor: im.GetMonitorOutput) => ({
        monitorName: monitor.MonitorName,
        monitorArn: monitor.MonitorArn,
        status: monitor.Status,
        processingStatus: monitor.ProcessingStatus,
        resources: [...monitor.Resources],
        maxCityNetworksToMonitor: monitor.MaxCityNetworksToMonitor,
        trafficPercentageToMonitor: monitor.TrafficPercentageToMonitor,
        tags: toTagRecord(monitor.Tags),
      });

      return Monitor.Provider.of({
        stables: ["monitorName", "monitorArn"],

        list: () =>
          im.listMonitors.items({}).pipe(
            Stream.runCollect,
            Effect.flatMap((monitors) =>
              Effect.forEach(
                Array.from(monitors),
                (monitor) =>
                  im.getMonitor({ MonitorName: monitor.MonitorName }).pipe(
                    Effect.map(toAttrs),
                    // Tolerate delete races between list and get.
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((attrs) =>
              attrs.flatMap((a) => (a === undefined ? [] : [a])),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.monitorName ?? (yield* createName(id, olds ?? {}));
          const monitor = yield* readMonitor(name);
          if (monitor === undefined) return undefined;
          const attrs = toAttrs(monitor);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          // The name is the only immutable property; everything else is
          // updatable in place via UpdateMonitor.
          if ((yield* createName(id, olds)) !== (yield* createName(id, news))) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const name = output?.monitorName ?? (yield* createName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...props.tags, ...internalTags };
          const desiredStatus = props.status ?? "ACTIVE";

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readMonitor(name);

          // 2. Ensure — create if missing; a ConflictException means a peer
          //    created the same-named monitor concurrently, so re-observe.
          if (observed === undefined) {
            yield* im
              .createMonitor({
                MonitorName: name,
                Resources: props.resources,
                MaxCityNetworksToMonitor: props.maxCityNetworksToMonitor,
                TrafficPercentageToMonitor: props.trafficPercentageToMonitor,
                InternetMeasurementsLogDelivery:
                  props.internetMeasurementsLogDelivery,
                HealthEventsConfig: props.healthEventsConfig,
                Tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
          }

          // Creation (and prior updates) surface as PENDING; wait (bounded)
          // so UpdateMonitor is not rejected mid-transition.
          observed = yield* waitUntilSettled(name);

          // 3. Sync — compute the update delta from OBSERVED state and
          //    apply a single UpdateMonitor only when something changed.
          const update: im.UpdateMonitorInput = { MonitorName: name };
          let mutated = false;

          if (props.resources !== undefined) {
            const observedResources = observed.Resources;
            const toAdd = props.resources.filter(
              (arn) => !observedResources.includes(arn),
            );
            const toRemove = observedResources.filter(
              (arn) => !props.resources!.includes(arn),
            );
            if (toAdd.length > 0) {
              update.ResourcesToAdd = toAdd;
              mutated = true;
            }
            if (toRemove.length > 0) {
              update.ResourcesToRemove = toRemove;
              mutated = true;
            }
          }
          if (
            props.maxCityNetworksToMonitor !== undefined &&
            props.maxCityNetworksToMonitor !== observed.MaxCityNetworksToMonitor
          ) {
            update.MaxCityNetworksToMonitor = props.maxCityNetworksToMonitor;
            mutated = true;
          }
          if (
            props.trafficPercentageToMonitor !== undefined &&
            props.trafficPercentageToMonitor !==
              observed.TrafficPercentageToMonitor
          ) {
            update.TrafficPercentageToMonitor =
              props.trafficPercentageToMonitor;
            mutated = true;
          }
          if (
            props.internetMeasurementsLogDelivery !== undefined &&
            !sameJson(
              props.internetMeasurementsLogDelivery,
              observed.InternetMeasurementsLogDelivery,
            )
          ) {
            update.InternetMeasurementsLogDelivery =
              props.internetMeasurementsLogDelivery;
            mutated = true;
          }
          if (
            props.healthEventsConfig !== undefined &&
            !sameJson(props.healthEventsConfig, observed.HealthEventsConfig)
          ) {
            update.HealthEventsConfig = props.healthEventsConfig;
            mutated = true;
          }
          if (
            observed.Status !== desiredStatus &&
            (observed.Status === "ACTIVE" || observed.Status === "INACTIVE")
          ) {
            update.Status = desiredStatus;
            mutated = true;
          }
          if (mutated) {
            yield* im.updateMonitor(update);
            observed = yield* waitUntilSettled(name);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const observedTags = toTagRecord(observed.Tags);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* im.tagResource({
              ResourceArn: observed.MonitorArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* im.untagResource({
              ResourceArn: observed.MonitorArn,
              TagKeys: removed,
            });
          }

          yield* session.note(name);
          observed = (yield* readMonitor(name)) ?? observed;
          return toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          const name = output.monitorName;
          // DeleteMonitor rejects monitors that are not INACTIVE
          // ("must be in inactive state before deletion") — deactivate
          // first, then wait (bounded) for the transition to land.
          const observed = yield* readMonitor(name);
          if (observed === undefined) return;
          if (observed.Status !== "INACTIVE") {
            yield* im
              .updateMonitor({ MonitorName: name, Status: "INACTIVE" })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
            yield* readMonitor(name).pipe(
              Effect.flatMap((monitor) =>
                monitor !== undefined && monitor.Status !== "INACTIVE"
                  ? Effect.fail(
                      new Error(
                        `Internet Monitor monitor '${name}' is not yet INACTIVE (status: ${monitor.Status})`,
                      ),
                    )
                  : Effect.succeed(monitor),
              ),
              Effect.retry({
                schedule: Schedule.max([
                  Schedule.fixed("5 seconds"),
                  Schedule.recurs(10),
                ]),
              }),
            );
          }
          yield* im
            .deleteMonitor({ MonitorName: name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          // Internet Monitor auto-creates per-monitor CloudWatch log groups
          // (/aws/internet-monitor/{name}/{byCity,byCountry,byMetro,
          // bySubdivision}) that survive DeleteMonitor — reap them so the
          // monitor leaves no orphans (same doctrine as the Lambda Function
          // /aws/lambda/{name} log-group reap).
          const logGroupPrefix = `/aws/internet-monitor/${name}`;
          const reapLogGroups = logs
            .describeLogGroups({ logGroupNamePrefix: logGroupPrefix })
            .pipe(
              Effect.map((r) => r.logGroups ?? []),
              Effect.flatMap((groups) =>
                Effect.forEach(
                  groups.flatMap((g) =>
                    // Exact-prefix guard: never reap a sibling monitor whose
                    // name merely starts with ours.
                    g.logGroupName !== undefined &&
                    (g.logGroupName === logGroupPrefix ||
                      g.logGroupName.startsWith(`${logGroupPrefix}/`))
                      ? [g.logGroupName]
                      : [],
                  ),
                  (logGroupName) =>
                    logs
                      .deleteLogGroup({ logGroupName })
                      .pipe(
                        Effect.catchTag(
                          "ResourceNotFoundException",
                          () => Effect.void,
                        ),
                      ),
                  { concurrency: 4 },
                ),
              ),
            );
          // Log-group creation/delivery is asynchronous — a group can
          // materialize shortly after the monitor is gone, so sweep again on
          // a short bounded schedule (t=0s / 10s / 20s, each sweep idempotent).
          yield* reapLogGroups.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              times: 2,
            }),
          );
        }),
      });
    }),
  );
