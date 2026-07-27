import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * Zonal deployment behaviour (EC2/on-prem `Server` platform): deploy one
 * Availability Zone at a time, monitoring each zone before moving on.
 * Mirrors the wire `ZonalConfig` with `Duration.Input` monitor durations
 * (CodeDeploy's wire unit for both is whole seconds).
 */
export interface ZonalConfigProps {
  /**
   * How long to monitor the FIRST zone after it finishes before starting
   * the next zone. Wire unit: whole seconds.
   * @default monitorDuration
   */
  firstZoneMonitorDuration?: Duration.Input;
  /**
   * How long to monitor each subsequent zone after it finishes before
   * starting the next one. Wire unit: whole seconds.
   * @default 0
   */
  monitorDuration?: Duration.Input;
  /**
   * Minimum healthy hosts required per Availability Zone while deploying.
   */
  minimumHealthyHostsPerZone?: codedeploy.MinimumHealthyHostsPerZone;
}

/** Convert the zonal-config props to the CodeDeploy wire shape (seconds). */
const toWireZonalConfig = (
  props: ZonalConfigProps | undefined,
): codedeploy.ZonalConfig | undefined =>
  props === undefined
    ? undefined
    : {
        firstZoneMonitorDurationInSeconds: toWireSeconds(
          props.firstZoneMonitorDuration,
        ),
        monitorDurationInSeconds: toWireSeconds(props.monitorDuration),
        minimumHealthyHostsPerZone: props.minimumHealthyHostsPerZone,
      };

export interface DeploymentConfigProps {
  /**
   * Name of the deployment configuration (1-100 chars). If omitted a
   * deterministic physical name is generated. Changing the name replaces
   * the configuration.
   */
  deploymentConfigName?: string;
  /**
   * The compute platform the configuration applies to. Immutable — changing
   * it replaces the configuration.
   * @default "Server"
   */
  computePlatform?: "Server" | "Lambda" | "ECS";
  /**
   * Minimum healthy hosts during the deployment (`HOST_COUNT` or
   * `FLEET_PERCENT`). `Server` platform only.
   */
  minimumHealthyHosts?: codedeploy.MinimumHealthyHosts;
  /**
   * How traffic shifts to the new version (`TimeBasedCanary`,
   * `TimeBasedLinear`, or `AllAtOnce`). `Lambda`/`ECS` platforms. The
   * `canaryInterval`/`linearInterval` fields are whole minutes (the wire
   * unit is semantically part of the AWS field).
   */
  trafficRoutingConfig?: codedeploy.TrafficRoutingConfig;
  /**
   * Deploy one Availability Zone at a time with per-zone monitor
   * durations. `Server` platform only.
   */
  zonalConfig?: ZonalConfigProps;
}

export interface DeploymentConfig extends Resource<
  "AWS.CodeDeploy.DeploymentConfig",
  DeploymentConfigProps,
  {
    /** Physical name of the deployment configuration. */
    deploymentConfigName: string;
    /** Unique CodeDeploy-assigned deployment-config ID. */
    deploymentConfigId: string;
    /** ARN of the deployment configuration. */
    deploymentConfigArn: string;
    /** The compute platform (`Lambda`, `Server`, or `ECS`). */
    computePlatform: string;
  },
  never,
  Providers
> {}

/**
 * A custom AWS CodeDeploy deployment configuration — the rules for how
 * traffic shifts during a deployment (canary/linear traffic routing for
 * `Lambda`/`ECS`, minimum-healthy-hosts and zonal rollout for `Server`).
 * Deployment configurations are immutable: any change replaces the
 * configuration.
 *
 * @resource
 * @section Creating a Deployment Config
 * @example Lambda Canary Config
 * ```typescript
 * const config = yield* CodeDeploy.DeploymentConfig("canary", {
 *   computePlatform: "Lambda",
 *   trafficRoutingConfig: {
 *     type: "TimeBasedCanary",
 *     timeBasedCanary: { canaryPercentage: 10, canaryInterval: 5 },
 *   },
 * });
 * ```
 *
 * @example Server Config with Minimum Healthy Hosts
 * ```typescript
 * const config = yield* CodeDeploy.DeploymentConfig("half-fleet", {
 *   computePlatform: "Server",
 *   minimumHealthyHosts: { type: "FLEET_PERCENT", value: 50 },
 * });
 * ```
 */
export const DeploymentConfig = Resource<DeploymentConfig>(
  "AWS.CodeDeploy.DeploymentConfig",
);

/** Build the ARN for a CodeDeploy deployment configuration. */
const deploymentConfigArn = (
  region: string,
  account: string,
  name: string,
): string => `arn:aws:codedeploy:${region}:${account}:deploymentconfig:${name}`;

export const DeploymentConfigProvider = () =>
  Provider.effect(
    DeploymentConfig,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<DeploymentConfigProps>) =>
        props.deploymentConfigName
          ? Effect.succeed(props.deploymentConfigName)
          : createPhysicalName({ id, maxLength: 100 });

      const getConfig = Effect.fn(function* (name: string) {
        const response = yield* codedeploy
          .getDeploymentConfig({ deploymentConfigName: name })
          .pipe(
            Effect.catchTag("DeploymentConfigDoesNotExistException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.deploymentConfigInfo;
      });

      return {
        stables: [
          "deploymentConfigName",
          "deploymentConfigId",
          "computePlatform",
        ],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // Deployment configurations are immutable — any settings change
          // replaces the configuration.
          const key = (props: Partial<DeploymentConfigProps>) =>
            JSON.stringify([
              props.computePlatform ?? "Server",
              props.minimumHealthyHosts,
              props.trafficRoutingConfig,
              toWireZonalConfig(props.zonalConfig),
            ]);
          if (key(olds ?? {}) !== key(news ?? {})) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.deploymentConfigName ?? (yield* toName(id, olds ?? {}));
          const config = yield* getConfig(name);
          if (config?.deploymentConfigId === undefined) return undefined;
          // Deployment configurations cannot be tagged, so there is no
          // ownership marker to check — a name match is treated as ours.
          return {
            deploymentConfigName: config.deploymentConfigName ?? name,
            deploymentConfigId: config.deploymentConfigId,
            deploymentConfigArn: deploymentConfigArn(region, accountId, name),
            computePlatform: config.computePlatform ?? "Server",
          };
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.deploymentConfigName ?? (yield* toName(id, news));
          const computePlatform = news.computePlatform ?? "Server";

          // 1. Observe — cloud state is authoritative.
          let config = yield* getConfig(name);

          // 2. Ensure — create if missing (configs are immutable, so there
          //    is nothing to sync). Tolerate an already-exists race.
          if (config?.deploymentConfigId === undefined) {
            yield* codedeploy
              .createDeploymentConfig({
                deploymentConfigName: name,
                computePlatform,
                minimumHealthyHosts: news.minimumHealthyHosts,
                trafficRoutingConfig: news.trafficRoutingConfig,
                zonalConfig: toWireZonalConfig(news.zonalConfig),
              })
              .pipe(
                Effect.catchTag("DeploymentConfigAlreadyExistsException", () =>
                  Effect.succeed(undefined),
                ),
              );
            config = yield* getConfig(name);
          }

          // 3. Return fresh attributes.
          yield* session.note(name);
          return {
            deploymentConfigName: config?.deploymentConfigName ?? name,
            deploymentConfigId: config?.deploymentConfigId ?? "",
            deploymentConfigArn: deploymentConfigArn(region, accountId, name),
            computePlatform: config?.computePlatform ?? computePlatform,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // A config still referenced by a deployment group fails with
          // DeploymentConfigInUseException — the engine deletes dependents
          // first, but the reference release is eventually consistent, so
          // retry through it (bounded). Deleting a non-existent config
          // succeeds (no not-found variant in the typed error union).
          yield* codedeploy
            .deleteDeploymentConfig({
              deploymentConfigName: output.deploymentConfigName,
            })
            .pipe(
              Effect.retry({
                while: (e): boolean =>
                  e._tag === "DeploymentConfigInUseException",
                schedule: Schedule.max([
                  Schedule.fixed(3000),
                  Schedule.recurs(10),
                ]),
              }),
            );
        }),

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const names = yield* codedeploy.listDeploymentConfigs
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap(
                    (page) => page.deploymentConfigsList ?? [],
                  ),
                ),
              );
            return (
              names
                // Predefined CodeDeployDefault.* configurations are
                // AWS-managed and cannot be deleted — never ours.
                .filter((name) => !name.startsWith("CodeDeployDefault."))
                .map((name) => ({
                  deploymentConfigName: name,
                  deploymentConfigId: "",
                  deploymentConfigArn: deploymentConfigArn(
                    region,
                    accountId,
                    name,
                  ),
                  computePlatform: "",
                }))
            );
          }),
      };
    }),
  );
