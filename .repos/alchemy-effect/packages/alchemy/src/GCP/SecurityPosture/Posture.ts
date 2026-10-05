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
  DEFAULT_STATE,
  desiredPolicySets,
  fieldMask,
  fingerprint,
  hasAlchemyAnnotationMap,
  lastSegment,
  locationParent,
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

export type PostureState = securityposture.PostureStateEnum | (string & {});
export type PolicySet = securityposture.PolicySet;
export type Policy = securityposture.Policy;
export type Constraint = securityposture.Constraint;

export type PostureProps = {
  /**
   * Posture id (the `{posture}` segment of
   * `organizations/{organization}/locations/global/postures/{posture}`).
   * If omitted, a unique id is generated from the stack, stage, and
   * logical id. Letters, digits, hyphens, and underscores; max 63
   * characters. Immutable — changing it replaces the posture.
   */
  postureId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to `GOOGLE_ORGANIZATION_ID` or the project's Resource
   * Manager ancestor. Immutable — changing it replaces the posture.
   */
  organization?: string;
  /**
   * Location. Security postures live in `global`.
   * @default "global"
   */
  location?: string;
  /**
   * Posture state. `DRAFT` is not deployable; `ACTIVE` can be deployed;
   * `DEPRECATED` cannot be deployed until reactivated.
   * @default "DRAFT"
   */
  state?: PostureState;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User annotations. Postures have no labels field — Alchemy ownership
   * (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is stored here
   * so `list` / `pnpm nuke:gcp` can find owned postures. Annotations are
   * set at create time.
   */
  annotations?: Record<string, string>;
  /**
   * Policy sets the posture includes. When omitted, a disabled Security
   * Health Analytics detector is used so the posture is valid.
   */
  policySets?: PolicySet[];
};

export type Posture = Resource<
  "GCP.SecurityPosture.Posture",
  PostureProps,
  {
    /** Full resource name `organizations/{organization}/locations/global/postures/{posture}`. */
    name: string;
    /** Posture id (last path segment). */
    postureId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Location id (`global`). */
    location: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Posture state (`DRAFT`, `ACTIVE`, or `DEPRECATED`). */
    state: string | undefined;
    /** Opaque eight-character revision id used when deploying. */
    revisionId: string | undefined;
    /** User description. */
    description: string | undefined;
    /** User annotations (Alchemy ownership keys stripped). */
    annotations: Record<string, string>;
    /** Policy sets currently configured. */
    policySets: PolicySet[];
    /** Categories assigned by the Security Posture API. */
    categories: string[] | undefined;
    /** Whether the posture is being updated. */
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
 * An organization-scoped Security Command Center security posture.
 *
 * A posture groups organization-policy constraints and Security Health
 * Analytics detectors into policy sets that can be deployed to a
 * project, folder, or organization. Postures live under
 * `organizations/{organization}/locations/global`. They have no labels
 * field — Alchemy stamps ownership into `annotations`. `postureId` and
 * `organization` are identity. Description, policy sets, and state
 * update in place. State cannot be patched in the same request as other
 * fields.
 *
 * Creating a posture requires the Security Posture API and
 * organization-level Security Command Center Premium or Enterprise.
 *
 * ### Creating a Posture
 * **Example:** Generated id with the default detector policy set
 * ```typescript
 * const posture = yield* GCP.SecurityPosture.Posture("Baseline", {
 *   description: "staging baseline",
 * });
 * ```
 *
 * **Example:** Named ACTIVE posture with a Security Health Analytics module
 * ```typescript
 * const posture = yield* GCP.SecurityPosture.Posture("Baseline", {
 *   organization: "organizations/123456789",
 *   postureId: "staging-baseline",
 *   state: "ACTIVE",
 *   policySets: [
 *     {
 *       policySetId: "sha",
 *       policies: [
 *         {
 *           policyId: "api-key-exists",
 *           constraint: {
 *             securityHealthAnalyticsModule: {
 *               moduleName: "API_KEY_EXISTS",
 *               moduleEnablementState: "DISABLED",
 *             },
 *           },
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category SecurityPosture
 */
export const Posture = Resource<Posture>("GCP.SecurityPosture.Posture");

const resourceName = (
  organization: string,
  location: string,
  postureId: string,
) => `${locationParent(organization, location)}/postures/${postureId}`;

const waitPostureOperation = (operation: securityposture.Operation) =>
  waitForOperation(operation);

const waitPostureOperationGone = (operation: securityposture.Operation) =>
  waitForOperation(operation, { notFoundOk: true });

const toAttrs = (posture: securityposture.Posture, project: string) => {
  const name = posture.name ?? "";
  const parsed = parseName(name, "postures");
  const organization = parsed.organization
    ? organizationParent(parsed.organization)
    : "";
  return {
    name,
    postureId: parsed.id || lastSegment(name),
    organization,
    organizationId: organizationIdOf(organization),
    location: parsed.location,
    project,
    state: posture.state,
    revisionId: posture.revisionId,
    description: posture.description,
    annotations: userAnnotations(posture.annotations),
    policySets: posture.policySets ?? [],
    categories: posture.categories,
    reconciling: posture.reconciling,
    etag: posture.etag,
    createTime: posture.createTime,
    updateTime: posture.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : securityposture
        .getOrganizationsLocationsPostures({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const desiredState = (news: PostureProps) => news.state ?? DEFAULT_STATE;

const desiredBody = (
  news: PostureProps,
  annotations: Record<string, string>,
): securityposture.Posture => ({
  state: desiredState(news),
  description: news.description,
  annotations,
  policySets: desiredPolicySets(news.policySets),
});

export const PostureProvider = () =>
  Provider.succeed(Posture, {
    stables: [
      "name",
      "postureId",
      "organization",
      "organizationId",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.postureId ?? output?.postureId;
      const nextId = news.postureId ?? previousId;
      const previousOrg = olds?.organization ?? output?.organization;
      const nextOrg =
        news.organization !== undefined
          ? organizationParent(news.organization)
          : previousOrg;
      return replaceOnIdentity(
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
          (previousOrg !== undefined &&
            nextOrg !== undefined &&
            organizationParent(previousOrg) !== organizationParent(nextOrg)),
        false,
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const postureId = yield* toPhysicalId(
        id,
        olds?.postureId,
        output?.postureId,
        "posture",
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
          ? resourceName(organization, location, postureId)
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
        return yield* securityposture.listOrganizationsLocationsPostures
          .pages({ parent, pageSize: 1000 })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.postures ?? [])),
            Stream.filter((posture) =>
              hasAlchemyAnnotationMap(posture.annotations),
            ),
            Stream.map((posture) => toAttrs(posture, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const postureId = yield* toPhysicalId(
        id,
        news.postureId,
        output?.postureId,
        "posture",
      );
      const organization = yield* resolveOrganization(
        news.organization ?? output?.organization,
        output?.organization,
      );
      const location = lastSegment(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const parent = locationParent(organization, location);
      const name = resourceName(organization, location, postureId);
      const desiredAnnotations = {
        ...toLabels(news.annotations),
        ...(yield* createInternalLabels(id)),
      };
      const desired = desiredBody(news, desiredAnnotations);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* securityposture
          .createOrganizationsLocationsPostures({
            parent,
            postureId,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitPostureOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
        current = yield* waitUntilExists(
          getByName(name).pipe(
            Effect.map((value) =>
              value &&
              value.reconciling !== true &&
              (value.revisionId ?? "").length > 0
                ? value
                : undefined,
            ),
          ),
          name,
        );
      }

      if (current === undefined) {
        return yield* new SecuritypostureNotResolved({ name });
      }

      const descriptionChanged = !sameText(
        current.description,
        desired.description,
      );
      const policySetsChanged =
        fingerprint(current.policySets) !== fingerprint(desired.policySets);
      const stateChanged = !sameText(
        current.state ?? DEFAULT_STATE,
        desired.state,
      );
      const contentMask = fieldMask([
        descriptionChanged && "description",
        policySetsChanged && "policy_sets",
      ]);

      if (contentMask.length > 0) {
        const operation =
          yield* securityposture.patchOrganizationsLocationsPostures({
            name: current.name ?? name,
            revisionId: current.revisionId,
            updateMask: contentMask,
            body: {
              name: current.name ?? name,
              description: desired.description,
              policySets: desired.policySets,
              etag: current.etag,
            },
          });
        yield* waitPostureOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name).pipe(
            Effect.map((value) =>
              value && value.reconciling !== true ? value : undefined,
            ),
          ),
          current.name ?? name,
        );
      }

      if (stateChanged) {
        const operation =
          yield* securityposture.patchOrganizationsLocationsPostures({
            name: current.name ?? name,
            revisionId: current.revisionId,
            updateMask: "state",
            body: {
              name: current.name ?? name,
              state: desired.state,
              etag: current.etag,
            },
          });
        yield* waitPostureOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name).pipe(
            Effect.map((value) =>
              value && value.reconciling !== true ? value : undefined,
            ),
          ),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* securityposture
        .deleteOrganizationsLocationsPostures({
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
        yield* waitPostureOperationGone(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
