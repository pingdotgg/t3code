import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface DeploymentProps {
  /**
   * ID of the application.
   */
  applicationId: string;
  /**
   * ID of the environment to deploy to.
   */
  environmentId: string;
  /**
   * ID of the deployment strategy that governs the rollout.
   */
  deploymentStrategyId: string;
  /**
   * ID of the configuration profile being deployed.
   */
  configurationProfileId: string;
  /**
   * The configuration version to deploy. For a hosted configuration profile
   * this is the hosted version number (as a string); for other sources it is
   * the version identifier defined by that source.
   */
  configurationVersion: string;
  /**
   * Description of the deployment.
   */
  description?: string;
}

export interface Deployment extends Resource<
  "AWS.AppConfig.Deployment",
  DeploymentProps,
  {
    applicationId: string;
    environmentId: string;
    deploymentNumber: number;
    configurationProfileId: string;
    configurationVersion: string;
    state: string;
  },
  never,
  Providers
> {}

/**
 * An AWS AppConfig deployment — releases a configuration version to an
 * environment following a deployment strategy. Deployments are immutable and
 * asynchronous: the provider starts the deployment and waits (bounded) for it
 * to reach a terminal state. Any change to the deployed version, strategy, or
 * target creates a new deployment (a replacement). Use an all-at-once strategy
 * (duration 0, bake 0) for a near-instant rollout.
 *
 * @resource
 * @section Deploying a Configuration
 * @example Deploy a Hosted Version
 * ```typescript
 * const deployment = yield* AppConfig.Deployment("Rollout", {
 *   applicationId: app.applicationId,
 *   environmentId: env.environmentId,
 *   deploymentStrategyId: strategy.deploymentStrategyId,
 *   configurationProfileId: profile.configurationProfileId,
 *   configurationVersion: String(version.versionNumber),
 * });
 * ```
 */
export const Deployment = Resource<Deployment>("AWS.AppConfig.Deployment");

class DeploymentNotSettled extends Data.TaggedError("DeploymentNotSettled")<{
  readonly deploymentNumber: number;
  readonly state: string;
}> {}

const TERMINAL_STATES = new Set(["COMPLETE", "ROLLED_BACK", "REVERTED"]);

export const DeploymentProvider = () =>
  Provider.effect(
    Deployment,
    Effect.gen(function* () {
      const readDeployment = Effect.fn(function* (
        applicationId: string,
        environmentId: string,
        deploymentNumber: number,
      ) {
        return yield* appconfig
          .getDeployment({
            ApplicationId: applicationId,
            EnvironmentId: environmentId,
            DeploymentNumber: deploymentNumber,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      // Deployments roll out asynchronously; wait (bounded) for a terminal
      // state. With an all-at-once strategy this settles in seconds.
      const waitForSettled = Effect.fn(function* (
        applicationId: string,
        environmentId: string,
        deploymentNumber: number,
      ) {
        return yield* readDeployment(
          applicationId,
          environmentId,
          deploymentNumber,
        ).pipe(
          Effect.flatMap((deployment) =>
            deployment !== undefined &&
            !TERMINAL_STATES.has(deployment.State ?? "")
              ? Effect.fail(
                  new DeploymentNotSettled({
                    deploymentNumber,
                    state: deployment.State ?? "",
                  }),
                )
              : Effect.succeed(deployment),
          ),
          Effect.retry({
            while: (e) => e instanceof DeploymentNotSettled,
            schedule: Schedule.max([
              Schedule.fixed("3 seconds"),
              Schedule.recurs(40),
            ]),
          }),
        );
      });

      return {
        stables: ["applicationId", "environmentId", "deploymentNumber"],

        // Deployments are immutable — any change starts a new deployment.
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds !== undefined &&
            (olds.applicationId !== news.applicationId ||
              olds.environmentId !== news.environmentId ||
              olds.deploymentStrategyId !== news.deploymentStrategyId ||
              olds.configurationProfileId !== news.configurationProfileId ||
              olds.configurationVersion !== news.configurationVersion)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ output }) {
          if (output?.deploymentNumber === undefined) return undefined;
          const deployment = yield* readDeployment(
            output.applicationId,
            output.environmentId,
            output.deploymentNumber,
          );
          if (deployment?.DeploymentNumber === undefined) return undefined;
          return {
            applicationId: output.applicationId,
            environmentId: output.environmentId,
            deploymentNumber: deployment.DeploymentNumber,
            configurationProfileId:
              deployment.ConfigurationProfileId ??
              output.configurationProfileId,
            configurationVersion:
              deployment.ConfigurationVersion ?? output.configurationVersion,
            state: deployment.State ?? "",
          };
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          // Observe — an interrupted create may already have started the
          // deployment.
          let observed =
            output?.deploymentNumber !== undefined
              ? yield* readDeployment(
                  news.applicationId,
                  news.environmentId,
                  output.deploymentNumber,
                )
              : undefined;

          // Ensure — start the deployment if it does not exist yet. A
          // concurrent deployment on the same environment rejects with
          // ConflictException; retry (bounded) until it clears.
          if (observed?.DeploymentNumber === undefined) {
            observed = yield* appconfig
              .startDeployment({
                ApplicationId: news.applicationId,
                EnvironmentId: news.environmentId,
                DeploymentStrategyId: news.deploymentStrategyId,
                ConfigurationProfileId: news.configurationProfileId,
                ConfigurationVersion: news.configurationVersion,
                Description: news.description,
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "ConflictException",
                  schedule: Schedule.max([
                    Schedule.fixed("3 seconds"),
                    Schedule.recurs(20),
                  ]),
                }),
              );
          }

          const number = observed.DeploymentNumber!;
          const settled = yield* waitForSettled(
            news.applicationId,
            news.environmentId,
            number,
          );

          yield* session.note(`deployment-${number}`);
          return {
            applicationId: news.applicationId,
            environmentId: news.environmentId,
            deploymentNumber: number,
            configurationProfileId: news.configurationProfileId,
            configurationVersion: news.configurationVersion,
            state: settled?.State ?? observed.State ?? "",
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // A completed deployment is historical and cannot be deleted;
          // stopDeployment only affects an in-progress rollout. Treat a
          // "nothing to stop" rejection as success.
          yield* appconfig
            .stopDeployment({
              ApplicationId: output.applicationId,
              EnvironmentId: output.environmentId,
              DeploymentNumber: output.deploymentNumber,
            })
            .pipe(
              Effect.catchTag(
                ["ResourceNotFoundException", "BadRequestException"],
                () => Effect.void,
              ),
            );
        }),

        // Deployments are keyed under their parent environment.
        list: () => Effect.succeed([]),
      };
    }),
  );
