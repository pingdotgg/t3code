import * as datazone from "@distilled.cloud/aws/datazone";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { unredact } from "./internal.ts";

/**
 * A name/value provisioning parameter passed to the environment's blueprint.
 */
export interface EnvironmentUserParameter {
  /** The parameter name. */
  name?: string;
  /** The parameter value. */
  value?: string;
}

export interface EnvironmentProps {
  /**
   * The identifier of the {@link Domain} the environment lives in. Accepts a
   * domain's `domainId` output. Changing it triggers a replacement.
   */
  domainId: string;
  /**
   * The identifier of the {@link Project} that owns the environment. Accepts
   * a project's `projectId` output. Changing it triggers a replacement.
   */
  projectId: string;
  /**
   * Name of the environment. If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID. The name is mutable — it
   * converges via `UpdateEnvironment` without replacement.
   */
  name?: string;
  /**
   * A description of the environment.
   */
  description?: string;
  /**
   * The identifier of the environment profile to create the environment
   * from (V1 domains). Changing it triggers a replacement.
   */
  environmentProfileId?: string;
  /**
   * The identifier of the environment blueprint to create the environment
   * from directly (profile-less flows). Changing it triggers a replacement.
   */
  environmentBlueprintId?: string;
  /**
   * The AWS account to provision the environment in. Defaults to the
   * domain's account. Changing it triggers a replacement.
   */
  environmentAccountId?: string;
  /**
   * The region to provision the environment in. Changing it triggers a
   * replacement.
   */
  environmentAccountRegion?: string;
  /**
   * Blueprint provisioning parameters (e.g. the Glue database name for
   * `DefaultDataLake`).
   */
  userParameters?: EnvironmentUserParameter[];
  /**
   * Glossary term identifiers to attach to the environment.
   */
  glossaryTerms?: string[];
}

export interface Environment extends Resource<
  "AWS.DataZone.Environment",
  EnvironmentProps,
  {
    /** The unique identifier of the environment. */
    environmentId: string;
    /** The identifier of the domain the environment lives in. */
    domainId: string;
    /** The identifier of the owning project. */
    projectId: string;
    /** The name of the environment. */
    name: string;
    /** The status of the environment (`ACTIVE` once deployed). */
    status: string | undefined;
    /** The provider of the environment (e.g. `Amazon DataZone`). */
    provider: string;
    /** The AWS account the environment is provisioned in. */
    awsAccountId: string | undefined;
    /** The region the environment is provisioned in. */
    awsAccountRegion: string | undefined;
    /** The identifier of the environment profile the environment came from. */
    environmentProfileId: string | undefined;
    /** The identifier of the blueprint the environment came from. */
    environmentBlueprintId: string | undefined;
  }
> {}

/**
 * An Amazon DataZone environment — the provisioned collection of AWS
 * resources (Glue databases, IAM roles, Athena workgroups, ...) a project
 * works with, deployed from an environment blueprint via CloudFormation.
 *
 * Environment deployment is asynchronous (minutes — DataZone drives a
 * CloudFormation stack) and is polled to `ACTIVE` with a bounded wait. The
 * environment's blueprint must be configured in the domain first (see
 * {@link EnvironmentBlueprintConfiguration}).
 *
 * @resource
 * @section Creating Environments
 * @example Environment from a Profile (V1 Domains)
 * ```typescript
 * import * as DataZone from "alchemy/AWS/DataZone";
 *
 * const env = yield* DataZone.Environment("datalake-env", {
 *   domainId: domain.domainId,
 *   projectId: project.projectId,
 *   environmentProfileId: profileId,
 * });
 * ```
 *
 * @example Environment with Provisioning Parameters
 * ```typescript
 * const env = yield* DataZone.Environment("datalake-env", {
 *   domainId: domain.domainId,
 *   projectId: project.projectId,
 *   environmentProfileId: profileId,
 *   description: "Analytics data lake environment",
 *   userParameters: [
 *     { name: "glueDbName", value: "analytics_db" },
 *   ],
 * });
 * ```
 */
export const Environment = Resource<Environment>("AWS.DataZone.Environment");

/** The environment deployment settled in a failed state. */
export class EnvironmentDeploymentFailed extends Data.TaggedError(
  "AWS.DataZone.EnvironmentDeploymentFailed",
)<{
  readonly environmentId: string;
  readonly status: string;
  readonly reason: string | undefined;
}> {}

/** Environment status values indicating an in-flight transition to wait out. */
const ENVIRONMENT_TRANSIENT = new Set(["CREATING", "UPDATING", "DELETING"]);

/** Environment status values indicating a failed deployment. */
const ENVIRONMENT_FAILED = new Set([
  "CREATE_FAILED",
  "UPDATE_FAILED",
  "VALIDATION_FAILED",
]);

export const EnvironmentProvider = () =>
  Provider.effect(
    Environment,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<EnvironmentProps, "name">,
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
      });

      // A deleted environment — or one inside a deleted domain — is reported
      // as AccessDeniedException, NOT ResourceNotFoundException: DataZone
      // evaluates domain-scoped authorization before existence. Both mean
      // "absent".
      const getEnvironmentOrUndefined = Effect.fn(function* (
        domainId: string,
        environmentId: string,
      ) {
        return yield* datazone
          .getEnvironment({
            domainIdentifier: domainId,
            identifier: environmentId,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("AccessDeniedException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const findByName = Effect.fn(function* (
        domainId: string,
        projectId: string,
        name: string,
      ) {
        const found = yield* datazone
          .listEnvironments({
            domainIdentifier: domainId,
            projectIdentifier: projectId,
            name,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("AccessDeniedException", () =>
              Effect.succeed(undefined),
            ),
          );
        const summary = (found?.items ?? []).find(
          (s) => unredact(s.name) === name && s.status !== "DELETING",
        );
        return summary?.id;
      });

      // Poll the environment to a settled (non-transient) status. Deployment
      // drives a CloudFormation stack — bounded at ~5 minutes.
      const waitForSettled = Effect.fn(function* (
        domainId: string,
        environmentId: string,
      ) {
        return yield* getEnvironmentOrUndefined(domainId, environmentId).pipe(
          Effect.repeat({
            schedule: Schedule.fixed("5 seconds"),
            until: (env) =>
              env === undefined ||
              env.status === undefined ||
              !ENVIRONMENT_TRANSIENT.has(env.status),
            times: 60,
          }),
        );
      });

      // Poll the environment until it no longer exists — teardown drives a
      // CloudFormation stack delete, bounded at ~5 minutes.
      const waitForGone = Effect.fn(function* (
        domainId: string,
        environmentId: string,
      ) {
        yield* getEnvironmentOrUndefined(domainId, environmentId).pipe(
          Effect.repeat({
            schedule: Schedule.fixed("5 seconds"),
            until: (env) => env === undefined || env.status === "DELETED",
            times: 60,
          }),
        );
      });

      const failIfDeploymentFailed = Effect.fn(function* (
        env: datazone.GetEnvironmentOutput,
        environmentId: string,
      ) {
        if (env.status !== undefined && ENVIRONMENT_FAILED.has(env.status)) {
          return yield* new EnvironmentDeploymentFailed({
            environmentId,
            status: env.status,
            reason: env.lastDeployment?.failureReason?.message,
          });
        }
        return env;
      });

      const toAttributes = (
        env: datazone.GetEnvironmentOutput,
        environmentId: string,
      ) => ({
        environmentId,
        domainId: env.domainId,
        projectId: env.projectId,
        name: unredact(env.name),
        status: env.status,
        provider: env.provider,
        awsAccountId: env.awsAccountId,
        awsAccountRegion: env.awsAccountRegion,
        environmentProfileId: env.environmentProfileId,
        environmentBlueprintId: env.environmentBlueprintId,
      });

      return Environment.Provider.of({
        stables: [
          "environmentId",
          "domainId",
          "projectId",
          "awsAccountId",
          "awsAccountRegion",
        ],

        // Environments are keyed by their parent domain + project — there is
        // no account-level enumeration without those identifiers.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ id, olds, output }) {
          const domainId = output?.domainId ?? olds?.domainId;
          const projectId = output?.projectId ?? olds?.projectId;
          if (domainId === undefined || projectId === undefined) {
            return undefined;
          }
          const environmentId =
            output?.environmentId ??
            (yield* findByName(
              domainId,
              projectId,
              yield* createName(id, olds ?? {}),
            ));
          if (environmentId === undefined) return undefined;
          const env = yield* getEnvironmentOrUndefined(domainId, environmentId);
          if (
            env === undefined ||
            env.status === "DELETING" ||
            env.status === "DELETED"
          ) {
            return undefined;
          }
          // Environments have no tags — ownership is tracked purely by
          // identity.
          return toAttributes(env, environmentId);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds === undefined) return undefined;
          if (
            olds.domainId !== news.domainId ||
            olds.projectId !== news.projectId ||
            olds.environmentProfileId !== news.environmentProfileId ||
            olds.environmentBlueprintId !== news.environmentBlueprintId ||
            olds.environmentAccountId !== news.environmentAccountId ||
            olds.environmentAccountRegion !== news.environmentAccountRegion
          ) {
            return { action: "replace" } as const;
          }
          // name, description, and glossaryTerms converge via
          // updateEnvironment.
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const domainId = news.domainId;
          const projectId = news.projectId;
          const name = yield* createName(id, news);

          // 1. OBSERVE — cloud state is authoritative; output is only an id
          //    cache. Fall back to a name lookup after state loss.
          let environmentId = output?.environmentId;
          let env = environmentId
            ? yield* getEnvironmentOrUndefined(domainId, environmentId)
            : undefined;
          if (env === undefined) {
            environmentId = yield* findByName(domainId, projectId, name);
            if (environmentId !== undefined) {
              env = yield* getEnvironmentOrUndefined(domainId, environmentId);
            }
          }

          if (env === undefined) {
            // 2. ENSURE — create and wait out the CloudFormation deployment.
            const created = yield* datazone.createEnvironment({
              domainIdentifier: domainId,
              projectIdentifier: projectId,
              name,
              description: news.description,
              environmentProfileIdentifier: news.environmentProfileId,
              environmentBlueprintIdentifier: news.environmentBlueprintId,
              environmentAccountIdentifier: news.environmentAccountId,
              environmentAccountRegion: news.environmentAccountRegion,
              userParameters: news.userParameters,
              glossaryTerms: news.glossaryTerms,
            });
            environmentId =
              created.id ?? (yield* findByName(domainId, projectId, name));
            if (environmentId === undefined) {
              return yield* new EnvironmentDeploymentFailed({
                environmentId: "",
                status: "UNKNOWN",
                reason: `createEnvironment for ${name} returned no id`,
              });
            }
            env = yield* waitForSettled(domainId, environmentId);
            if (env === undefined) {
              return yield* new EnvironmentDeploymentFailed({
                environmentId,
                status: "DELETED",
                reason: "environment disappeared during deployment",
              });
            }
            env = yield* failIfDeploymentFailed(env, environmentId);
          } else {
            // 3. SYNC — wait out any in-flight transition, then converge the
            //    mutable aspects by diffing OBSERVED state against desired.
            env = (yield* waitForSettled(domainId, environmentId!)) ?? env;
            const drifted =
              unredact(env.name) !== name ||
              (env.description === undefined
                ? undefined
                : unredact(env.description)) !==
                (news.description ?? undefined);
            if (drifted) {
              yield* datazone.updateEnvironment({
                domainIdentifier: domainId,
                identifier: environmentId!,
                name,
                description: news.description,
                glossaryTerms: news.glossaryTerms,
              });
              env = (yield* waitForSettled(domainId, environmentId!)) ?? env;
              env = yield* failIfDeploymentFailed(env, environmentId!);
            }
          }

          yield* session.note(environmentId!);
          return toAttributes(env, environmentId!);
        }),

        delete: Effect.fn(function* ({ output }) {
          // wait out any in-flight transition first — deleting a CREATING
          // environment is rejected with a conflict.
          yield* waitForSettled(output.domainId, output.environmentId);
          yield* datazone
            .deleteEnvironment({
              domainIdentifier: output.domainId,
              identifier: output.environmentId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              // deleting an environment whose domain is already gone surfaces
              // as AccessDenied — auth is checked before existence.
              Effect.catchTag("AccessDeniedException", () => Effect.void),
            );
          yield* waitForGone(output.domainId, output.environmentId);
        }),
      });
    }),
  );
