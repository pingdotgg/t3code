import * as securityposture from "@distilled.cloud/gcp/securityposture_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  defaultTargetResource,
  fieldMask,
  hasAlchemyAnnotationMap,
  lastSegment,
  locationParent,
  normalizeTargetResource,
  organizationIdOf,
  organizationParent,
  parseName,
  replaceOnIdentity,
  resolveOrganization,
  sameText,
  SecuritypostureNotResolved,
  toPhysicalId,
  tryResolveOrganization,
  userAnnotations,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type PostureDeploymentState =
  | securityposture.PostureDeploymentStateEnum
  | (string & {});

export type PostureDeploymentProps = {
  /**
   * Posture deployment id (the `{postureDeployment}` segment of
   * `organizations/{organization}/locations/global/postureDeployments/{postureDeployment}`).
   * If omitted, a unique id is generated from the stack, stage, and
   * logical id. Letters, digits, hyphens, and underscores; max 63
   * characters. Immutable — changing it replaces the deployment.
   */
  postureDeploymentId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to `GOOGLE_ORGANIZATION_ID` or the project's Resource
   * Manager ancestor. Immutable — changing it replaces the deployment.
   */
  organization?: string;
  /**
   * Location. Posture deployments live in `global`.
   * @default "global"
   */
  location?: string;
  /**
   * Organization, folder, or project the posture is applied to
   * (`organizations/{number}`, `folders/{number}`, or
   * `projects/{number}`). Defaults to the stack project. At most one
   * posture can be deployed to each target. Immutable — changing it
   * replaces the deployment.
   */
  targetResource?: string;
  /**
   * Posture used in the deployment, as
   * `organizations/{organization}/locations/global/postures/{posture}`.
   */
  postureId: string;
  /**
   * Revision id of the posture used in the deployment.
   */
  postureRevisionId: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User annotations. Deployments have no labels field — Alchemy
   * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is
   * stored here so `list` / `pnpm nuke:gcp` can find owned deployments.
   * Annotations are set at create time.
   */
  annotations?: Record<string, string>;
};

export type PostureDeployment = Resource<
  "GCP.SecurityPosture.PostureDeployment",
  PostureDeploymentProps,
  {
    /** Full resource name `organizations/{organization}/locations/global/postureDeployments/{postureDeployment}`. */
    name: string;
    /** Posture deployment id (last path segment). */
    postureDeploymentId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Location id (`global`). */
    location: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Target organization, folder, or project. */
    targetResource: string | undefined;
    /** Deployed posture resource name. */
    postureId: string | undefined;
    /** Deployed posture revision id. */
    postureRevisionId: string | undefined;
    /** User description. */
    description: string | undefined;
    /** User annotations (Alchemy ownership keys stripped). */
    annotations: Record<string, string>;
    /** Deployment state (`CREATING`, `ACTIVE`, `CREATE_FAILED`, …). */
    state: string | undefined;
    /** Failure message when the deployment is in a failed state. */
    failureMessage: string | undefined;
    /** Categories assigned by the Security Posture API. */
    categories: string[] | undefined;
    /** Whether the deployment is being updated. */
    reconciling: boolean | undefined;
    /** Server checksum used on update and delete. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Security Command Center posture deployment.
 *
 * Deployments apply a posture revision to one organization, folder, or
 * project. The parent is always the organization, even when the target
 * is a folder or project. At most one posture can be deployed to each
 * target. Deployments have no labels field — Alchemy stamps ownership
 * into `annotations`. `postureDeploymentId`, `organization`, and
 * `targetResource` are identity. `postureId` and `postureRevisionId`
 * update in place.
 *
 * The posture must be `ACTIVE`. Creating a deployment requires the
 * Security Posture API and organization-level Security Command Center
 * Premium or Enterprise.
 *
 * ### Creating a Posture Deployment
 * **Example:** Deploy a posture to the stack project
 * ```typescript
 * const posture = yield* GCP.SecurityPosture.Posture("Baseline", {
 *   state: "ACTIVE",
 * });
 * const deployment = yield* GCP.SecurityPosture.PostureDeployment(
 *   "Staging",
 *   {
 *     postureId: posture.name,
 *     postureRevisionId: posture.revisionId,
 *   },
 * );
 * ```
 *
 * **Example:** Deploy to an explicit project
 * ```typescript
 * const deployment = yield* GCP.SecurityPosture.PostureDeployment(
 *   "Staging",
 *   {
 *     organization: "organizations/123456789",
 *     targetResource: "projects/987654321",
 *     postureId:
 *       "organizations/123456789/locations/global/postures/staging-baseline",
 *     postureRevisionId: "abcdefgh",
 *     description: "staging deployment",
 *   },
 * );
 * ```
 *
 * @resource
 * @category SecurityPosture
 */
export const PostureDeployment = Resource<PostureDeployment>(
  "GCP.SecurityPosture.PostureDeployment",
);

const resourceName = (
  organization: string,
  location: string,
  postureDeploymentId: string,
) =>
  `${locationParent(organization, location)}/postureDeployments/${postureDeploymentId}`;

const waitDeploymentOperation = (operation: securityposture.Operation) =>
  waitForOperation(operation);

const waitDeploymentOperationGone = (operation: securityposture.Operation) =>
  waitForOperation(operation, { notFoundOk: true });

const toAttrs = (
  deployment: securityposture.PostureDeployment,
  project: string,
) => {
  const name = deployment.name ?? "";
  const parsed = parseName(name, "postureDeployments");
  const organization = parsed.organization
    ? organizationParent(parsed.organization)
    : "";
  return {
    name,
    postureDeploymentId: parsed.id || lastSegment(name),
    organization,
    organizationId: organizationIdOf(organization),
    location: parsed.location,
    project,
    targetResource: deployment.targetResource,
    postureId: deployment.postureId,
    postureRevisionId: deployment.postureRevisionId,
    description: deployment.description,
    annotations: userAnnotations(deployment.annotations),
    state: deployment.state,
    failureMessage: deployment.failureMessage,
    categories: deployment.categories,
    reconciling: deployment.reconciling,
    etag: deployment.etag,
    createTime: deployment.createTime,
    updateTime: deployment.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : securityposture
        .getOrganizationsLocationsPostureDeployments({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const isBusy = (deployment: securityposture.PostureDeployment) =>
  deployment.reconciling === true ||
  deployment.state === "CREATING" ||
  deployment.state === "UPDATING" ||
  deployment.state === "DELETING";

const waitUntilSettled = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((current) => {
      if (current === undefined) {
        return Effect.fail(new SecuritypostureNotResolved({ name }));
      }
      if (isBusy(current)) {
        return Effect.fail(
          new SecuritypostureNotResolved({ name: `${name}:${current.state}` }),
        );
      }
      return Effect.succeed(current);
    }),
    Effect.retry({
      while: (error) => error._tag === "GCP.SecurityPosture.NotResolved",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const PostureDeploymentProvider = () =>
  Provider.succeed(PostureDeployment, {
    stables: [
      "name",
      "postureDeploymentId",
      "organization",
      "organizationId",
      "location",
      "project",
      "targetResource",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.postureDeploymentId ?? output?.postureDeploymentId;
      const nextId = news.postureDeploymentId ?? previousId;
      const previousOrg = olds?.organization ?? output?.organization;
      const nextOrg =
        news.organization !== undefined
          ? organizationParent(news.organization)
          : previousOrg;
      const previousTarget = olds?.targetResource ?? output?.targetResource;
      const nextTarget = news.targetResource ?? previousTarget;
      return replaceOnIdentity(
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
          (previousOrg !== undefined &&
            nextOrg !== undefined &&
            organizationParent(previousOrg) !== organizationParent(nextOrg)) ||
          (previousTarget !== undefined &&
            nextTarget !== undefined &&
            previousTarget !== nextTarget),
        true,
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const postureDeploymentId = yield* toPhysicalId(
        id,
        olds?.postureDeploymentId,
        output?.postureDeploymentId,
        "deploy",
      );
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      ).pipe(
        Effect.catchTag("GCP.SecurityPosture.OrganizationNotResolved", () =>
          Effect.succeed(output?.organization ?? ""),
        ),
      );
      const location = lastSegment(
        olds?.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const name =
        output?.name ??
        (organization.length > 0
          ? resourceName(organization, location, postureDeploymentId)
          : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.annotations)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        const parent = locationParent(organization, DEFAULT_LOCATION);
        return yield* securityposture.listOrganizationsLocationsPostureDeployments
          .pages({ parent, pageSize: 1000 })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.postureDeployments ?? []),
            ),
            Stream.filter((deployment) =>
              hasAlchemyAnnotationMap(deployment.annotations),
            ),
            Stream.map((deployment) => toAttrs(deployment, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const postureDeploymentId = yield* toPhysicalId(
        id,
        news.postureDeploymentId,
        output?.postureDeploymentId,
        "deploy",
      );
      const organization = yield* resolveOrganization(
        news.organization ?? output?.organization,
        output?.organization,
      );
      const location = lastSegment(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const parent = locationParent(organization, location);
      const name = resourceName(organization, location, postureDeploymentId);
      const targetResource = yield* news.targetResource !== undefined
        ? normalizeTargetResource(news.targetResource)
        : output?.targetResource
          ? Effect.succeed(output.targetResource)
          : defaultTargetResource();
      const desiredAnnotations = {
        ...toLabels(news.annotations),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* securityposture
          .createOrganizationsLocationsPostureDeployments({
            parent,
            postureDeploymentId,
            body: {
              targetResource,
              postureId: news.postureId,
              postureRevisionId: news.postureRevisionId,
              description: news.description,
              annotations: desiredAnnotations,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitDeploymentOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
        current = yield* waitUntilSettled(current.name ?? name);
      }

      if (current === undefined) {
        return yield* new SecuritypostureNotResolved({ name });
      }

      const postureChanged = !sameText(current.postureId, news.postureId);
      const revisionChanged = !sameText(
        current.postureRevisionId,
        news.postureRevisionId,
      );
      const descriptionChanged = !sameText(
        current.description,
        news.description,
      );
      const mask = fieldMask([
        postureChanged && "posture_id",
        revisionChanged && "posture_revision_id",
        descriptionChanged && "description",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* securityposture.patchOrganizationsLocationsPostureDeployments({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              name: current.name ?? name,
              postureId: news.postureId,
              postureRevisionId: news.postureRevisionId,
              description: news.description,
              etag: current.etag,
            },
          });
        yield* waitDeploymentOperation(operation);
        current = yield* waitUntilSettled(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* securityposture
        .deleteOrganizationsLocationsPostureDeployments({
          name: output.name,
          etag: output.etag,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitDeploymentOperationGone(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
