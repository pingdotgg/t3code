import * as pages from "@distilled.cloud/cloudflare/pages";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Pages.Deployment" as const;
type TypeId = typeof TypeId;

/**
 * Raised when a Pages deployment reaches a `failure`/`canceled` stage, or
 * does not reach a successful `deploy` stage within the bounded wait.
 */
export class DeploymentFailed extends Data.TaggedError("DeploymentFailed")<{
  readonly projectName: string;
  readonly deploymentId: string;
  readonly stageName: string;
  readonly stageStatus: string;
}> {}

export interface DeploymentProps {
  /**
   * Name of the Pages project to deploy to (e.g. `project.name`).
   * Deployments are immutable and belong to exactly one project —
   * changing the project triggers a replacement.
   */
  projectName: string;
  /**
   * The branch the deployment is attributed to. Deploying to the project's
   * production branch produces a production deployment; any other branch
   * produces a preview deployment. Deployments are immutable — changing
   * the branch triggers a replacement (a new deployment).
   * @default the project's production branch
   */
  branch?: string;
}

export interface DeploymentAttributes {
  /**
   * Cloudflare-assigned UUID of the deployment.
   */
  deploymentId: string;
  /**
   * Short (8-character) id of the deployment. Forms the deployment's
   * preview URL (`<shortId>.<project>.pages.dev`).
   */
  shortId: string;
  /**
   * The Cloudflare account the project belongs to.
   */
  accountId: string;
  /**
   * Name of the Pages project the deployment belongs to.
   */
  projectName: string;
  /**
   * Whether this is a `production` or `preview` deployment, derived from
   * the branch it was created on.
   */
  environment: string;
  /**
   * The live URL serving this specific deployment.
   */
  url: string;
  /**
   * The branch the deployment was created from.
   */
  branch: string;
  /**
   * Name of the deployment's latest pipeline stage (e.g. `deploy`).
   */
  latestStageName: string;
  /**
   * Status of the deployment's latest pipeline stage (e.g. `success`).
   */
  latestStageStatus: string;
  /**
   * When the deployment was created.
   */
  createdOn: string;
}

export type Deployment = Resource<
  TypeId,
  DeploymentProps,
  DeploymentAttributes,
  never,
  Providers
>;

/**
 * A direct-upload deployment on a Cloudflare Pages project.
 *
 * Creating the resource POSTs a new deployment to the project and waits
 * (bounded) for it to reach a successful `deploy` stage. Deployments are
 * immutable — every prop change triggers a replacement (a brand-new
 * deployment that supersedes the previous one).
 *
 * The deployment is created with an **empty asset manifest**: the full
 * direct-upload protocol (asset upload sessions driven by
 * `wrangler pages deploy`) is not part of the public REST surface, so this
 * resource cannot push file contents. It is useful for provisioning an
 * initial/placeholder deployment on a direct-upload project (so the
 * project's `*.pages.dev` subdomain starts serving) and for rolling the
 * active deployment from IaC. For deploying real static sites prefer
 * `Cloudflare.Website` (Workers Assets).
 *
 * Deleting the resource deletes the deployment (with `force`), except when
 * it is the project's active production deployment — Cloudflare refuses to
 * delete the live deployment, so delete tolerates that case and the
 * deployment is cleaned up when the project itself is deleted.
 * @resource
 * @product Pages
 * @category Workers & Compute
 * @section Creating a Deployment
 * @example Production deployment on a direct-upload project
 * ```typescript
 * const project = yield* Cloudflare.Pages.Project("site", {});
 *
 * const deployment = yield* Cloudflare.Pages.Deployment("site-deploy", {
 *   projectName: project.name,
 * });
 * // deployment.url === "https://<shortId>.<project>.pages.dev"
 * // deployment.environment === "production"
 * ```
 *
 * @example Preview deployment from a non-production branch
 * ```typescript
 * const preview = yield* Cloudflare.Pages.Deployment("site-preview", {
 *   projectName: project.name,
 *   branch: "feature-x",
 * });
 * // preview.environment === "preview"
 * ```
 *
 * @see https://developers.cloudflare.com/pages/
 */
export const Deployment = Resource<Deployment>(TypeId);

/**
 * Returns true if the given value is a Deployment resource.
 */
export const isDeployment = (value: unknown): value is Deployment =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const DeploymentProvider = () =>
  Provider.succeed(Deployment, {
    stables: [
      "deploymentId",
      "shortId",
      "accountId",
      "projectName",
      "environment",
      "url",
      "branch",
      "createdOn",
    ],
    diff: Effect.fn(function* ({ olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // Deployments are immutable: a different project or branch means a
      // brand-new deployment.
      const oldProject =
        output?.projectName ??
        (typeof olds?.projectName === "string" ? olds.projectName : undefined);
      if (oldProject !== undefined && oldProject !== news.projectName) {
        return { action: "replace" } as const;
      }
      const oldBranch = olds?.branch;
      if (oldBranch !== news.branch) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      // Deployment ids are server-assigned and carry no deterministic
      // identity, so there is no cold lookup — without persisted state the
      // deployment is reported missing and reconcile creates a fresh one.
      if (!output?.deploymentId) return undefined;
      const observed = yield* getDeployment(
        output.accountId,
        output.projectName,
        output.deploymentId,
      );
      return observed
        ? toAttributes(observed, output.accountId, output.projectName)
        : undefined;
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Deployments are sub-resources keyed by Pages project, with no
      // account-wide deployment enumeration API. Enumerate every project
      // (account-scoped) first, then fan out and list each project's
      // deployments, paginating exhaustively.
      const projects = yield* pages.listProjects.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) => page.result ?? []),
        ),
        // Account without a Pages entitlement can't list projects → nothing.
        Effect.catchTag("Forbidden", () => Effect.succeed([])),
      );
      const rows = yield* Effect.forEach(
        projects,
        (project) =>
          pages.listProjectDeployments
            .pages({ accountId, projectName: project.name })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.result ?? []).map((deployment) =>
                    toAttributes(deployment, accountId, project.name),
                  ),
                ),
              ),
            ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs have been resolved to concrete strings by Plan.
      const projectName = news.projectName as string;

      // 1. Observe — `output.deploymentId` is a cache of the only handle we
      //    have on the deployment; a vanished deployment falls through to
      //    "missing" and we create a fresh one.
      let observed = output?.deploymentId
        ? yield* getDeployment(accountId, projectName, output.deploymentId)
        : undefined;

      // 2. Ensure — create the deployment when missing. Deployments are
      //    immutable, so there is no sync step beyond waiting for the
      //    pipeline to finish; an empty manifest means no assets to upload.
      if (!observed) {
        observed = yield* pages.createProjectDeployment({
          accountId,
          projectName,
          branch: news.branch,
          manifest: "{}",
        });
      }

      // 3. Wait (bounded) for the deployment to reach a terminal stage and
      //    fail with a typed error if it didn't succeed.
      observed = yield* awaitDeployment(accountId, projectName, observed);

      // 4. Return fresh attributes.
      return toAttributes(observed, accountId, projectName);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Idempotent: the deployment may already be gone (DeploymentNotFound)
      // or the whole project deleted (ProjectNotFound) — both are success.
      // The active production deployment cannot be deleted even with
      // `force` (Cloudflare error 8000034) — it is removed when the project
      // itself is deleted, so tolerate and move on.
      yield* pages
        .deleteProjectDeployment({
          accountId: output.accountId,
          projectName: output.projectName,
          deploymentId: output.deploymentId,
          force: true,
        })
        .pipe(
          Effect.catchTag("DeploymentNotFound", () => Effect.void),
          Effect.catchTag("ProjectNotFound", () => Effect.void),
          Effect.catchTag("ActiveProductionDeployment", () =>
            Effect.logWarning(
              `Pages deployment ${output.deploymentId} is the active production deployment of project ${output.projectName}; it will be deleted with the project.`,
            ),
          ),
        );
    }),
  });

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

type ObservedDeployment =
  | pages.GetProjectDeploymentResponse
  | pages.CreateProjectDeploymentResponse;

/**
 * Read a deployment by id, mapping "gone" to `undefined` — either the
 * deployment was deleted (`DeploymentNotFound`, code 8000009) or the whole
 * project no longer exists (`ProjectNotFound`, code 8000007).
 */
const getDeployment = (
  accountId: string,
  projectName: string,
  deploymentId: string,
) =>
  pages.getProjectDeployment({ accountId, projectName, deploymentId }).pipe(
    Effect.catchTag("DeploymentNotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("ProjectNotFound", () => Effect.succeed(undefined)),
  );

const isTerminalStage = (stage: ObservedDeployment["latestStage"]): boolean =>
  (stage.name === "deploy" && stage.status === "success") ||
  stage.status === "failure" ||
  stage.status === "canceled";

/**
 * Poll the deployment until its pipeline reaches a terminal stage —
 * bounded so a stuck deployment fails fast instead of hanging the engine.
 * Anything other than a successful `deploy` stage is a typed failure.
 */
const awaitDeployment = (
  accountId: string,
  projectName: string,
  created: ObservedDeployment,
) =>
  Effect.gen(function* () {
    const observed: ObservedDeployment = isTerminalStage(created.latestStage)
      ? created
      : yield* pages
          .getProjectDeployment({
            accountId,
            projectName,
            deploymentId: created.id,
          })
          .pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (d) => isTerminalStage(d.latestStage),
              times: 25,
            }),
          );
    if (
      observed.latestStage.status !== "success" ||
      observed.latestStage.name !== "deploy"
    ) {
      return yield* Effect.fail(
        new DeploymentFailed({
          projectName,
          deploymentId: observed.id,
          stageName: observed.latestStage.name,
          stageStatus: observed.latestStage.status,
        }),
      );
    }
    return observed;
  });

/**
 * Minimal structural shape `toAttributes` reads — satisfied by both the
 * get/create deployment responses and a `listProjectDeployments` row.
 */
type DeploymentAttributesSource = {
  readonly id: string;
  readonly shortId: string;
  readonly environment: string;
  readonly url: string;
  readonly deploymentTrigger: {
    readonly metadata: { readonly branch: string };
  };
  readonly latestStage: { readonly name: string; readonly status: string };
  readonly createdOn: string;
};

const toAttributes = (
  deployment: DeploymentAttributesSource,
  accountId: string,
  projectName: string,
): DeploymentAttributes => ({
  deploymentId: deployment.id,
  shortId: deployment.shortId,
  accountId,
  projectName,
  environment: deployment.environment,
  url: deployment.url,
  branch: deployment.deploymentTrigger.metadata.branch,
  latestStageName: deployment.latestStage.name,
  latestStageStatus: deployment.latestStage.status,
  createdOn: deployment.createdOn,
});
