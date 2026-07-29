import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  environmentArn,
  readAppConfigTags,
  syncAppConfigTags,
} from "./internal.ts";

/**
 * A CloudWatch alarm AppConfig monitors during a deployment. If the alarm
 * fires while the configuration is rolling out, the deployment rolls back.
 */
export interface EnvironmentMonitor {
  /** ARN of the CloudWatch alarm to monitor. */
  alarmArn: string;
  /** ARN of an IAM role AppConfig assumes to read the alarm's state. */
  alarmRoleArn?: string;
}

export interface EnvironmentProps {
  /**
   * ID of the application this environment belongs to. Changing it replaces
   * the environment.
   */
  applicationId: string;
  /**
   * Name of the environment. Must be 1-64 characters. If omitted, a
   * deterministic physical name is generated. Changing the name replaces the
   * environment.
   */
  environmentName?: string;
  /**
   * Description of the environment.
   */
  description?: string;
  /**
   * CloudWatch alarms AppConfig monitors during deployments to this
   * environment.
   */
  monitors?: EnvironmentMonitor[];
  /**
   * User-defined tags for the environment.
   */
  tags?: Record<string, string>;
}

export interface Environment extends Resource<
  "AWS.AppConfig.Environment",
  EnvironmentProps,
  {
    environmentId: string;
    environmentName: string;
    applicationId: string;
    environmentArn: string;
    state: string;
  },
  never,
  Providers
> {}

/**
 * An AWS AppConfig environment — a deployment group of AppConfig targets
 * (e.g. `Beta`, `Production`) within an application. CloudWatch alarms
 * attached via `monitors` trigger an automatic rollback if they fire during a
 * deployment.
 *
 * @resource
 * @section Creating an Environment
 * @example Basic Environment
 * ```typescript
 * const app = yield* AppConfig.Application("MyApp", {});
 * const env = yield* AppConfig.Environment("Prod", {
 *   applicationId: app.applicationId,
 * });
 * ```
 *
 * @example Environment with Rollback Alarm
 * ```typescript
 * const env = yield* AppConfig.Environment("Prod", {
 *   applicationId: app.applicationId,
 *   monitors: [{ alarmArn: alarm.alarmArn, alarmRoleArn: role.roleArn }],
 * });
 * ```
 */
export const Environment = Resource<Environment>("AWS.AppConfig.Environment");

const toWireMonitors = (
  monitors: EnvironmentMonitor[] | undefined,
): appconfig.Monitor[] | undefined =>
  monitors?.map((m) => ({
    AlarmArn: m.alarmArn,
    AlarmRoleArn: m.alarmRoleArn,
  }));

export const EnvironmentProvider = () =>
  Provider.effect(
    Environment,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<EnvironmentProps>) =>
        props.environmentName
          ? Effect.succeed(props.environmentName)
          : createPhysicalName({ id, maxLength: 64 });

      const readEnvironment = Effect.fn(function* (
        applicationId: string,
        environmentId: string,
      ) {
        return yield* appconfig
          .getEnvironment({
            ApplicationId: applicationId,
            EnvironmentId: environmentId,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const findByName = Effect.fn(function* (
        applicationId: string,
        name: string,
      ) {
        const envs = yield* appconfig.listEnvironments
          .pages({ ApplicationId: applicationId })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Items ?? []),
            ),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed([] as appconfig.Environment[]),
            ),
          );
        return envs.find((e) => e.Name === name);
      });

      return {
        stables: [
          "environmentId",
          "environmentName",
          "applicationId",
          "environmentArn",
        ],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if ((olds?.applicationId ?? undefined) !== news?.applicationId) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const applicationId = output?.applicationId ?? olds?.applicationId;
          if (applicationId === undefined) return undefined;
          const env = output?.environmentId
            ? yield* readEnvironment(applicationId, output.environmentId)
            : yield* findByName(applicationId, yield* toName(id, olds ?? {}));
          if (env?.Id === undefined) return undefined;
          const arn = environmentArn(region, accountId, applicationId, env.Id);
          const attrs = {
            environmentId: env.Id,
            environmentName: env.Name!,
            applicationId,
            environmentArn: arn,
            state: env.State ?? "",
          };
          const tags = yield* readAppConfigTags(arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const applicationId = news.applicationId;
          const name = output?.environmentName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe.
          let observed = output?.environmentId
            ? yield* readEnvironment(applicationId, output.environmentId)
            : undefined;
          if (observed === undefined) {
            observed = yield* findByName(applicationId, name);
          }

          // 2. Ensure.
          if (observed?.Id === undefined) {
            observed = yield* appconfig.createEnvironment({
              ApplicationId: applicationId,
              Name: name,
              Description: news.description,
              Monitors: toWireMonitors(news.monitors),
              Tags: desiredTags,
            });
          } else {
            // 3. Sync — description and monitors are mutable in place.
            observed = yield* appconfig.updateEnvironment({
              ApplicationId: applicationId,
              EnvironmentId: observed.Id,
              Description: news.description,
              Monitors: toWireMonitors(news.monitors),
            });
          }

          const arn = environmentArn(
            region,
            accountId,
            applicationId,
            observed.Id!,
          );

          // 3b. Sync tags.
          yield* syncAppConfigTags(arn, desiredTags);

          yield* session.note(name);
          return {
            environmentId: observed.Id!,
            environmentName: observed.Name ?? name,
            applicationId,
            environmentArn: arn,
            state: observed.State ?? "",
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* appconfig
            .deleteEnvironment({
              ApplicationId: output.applicationId,
              EnvironmentId: output.environmentId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        // Environments are keyed under their parent application, so
        // enumeration walks every application and lists its environments.
        // An application cannot be deleted while environments exist under
        // it, so nuke needs these enumerated as first-class resources.
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const apps = yield* appconfig.listApplications.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.Items ?? []),
              ),
            );
            const results: {
              environmentId: string;
              environmentName: string;
              applicationId: string;
              environmentArn: string;
              state: string;
            }[] = [];
            for (const app of apps) {
              if (app.Id === undefined) continue;
              const envs = yield* appconfig.listEnvironments
                .pages({ ApplicationId: app.Id })
                .pipe(
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap((page) => page.Items ?? []),
                  ),
                  // The application may be deleted between the two calls.
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed([] as appconfig.Environment[]),
                  ),
                );
              for (const env of envs) {
                if (env.Id === undefined || env.Name === undefined) continue;
                results.push({
                  environmentId: env.Id,
                  environmentName: env.Name,
                  applicationId: app.Id,
                  environmentArn: environmentArn(
                    region,
                    accountId,
                    app.Id,
                    env.Id,
                  ),
                  state: env.State ?? "",
                });
              }
            }
            return results;
          }),
      };
    }),
  );
