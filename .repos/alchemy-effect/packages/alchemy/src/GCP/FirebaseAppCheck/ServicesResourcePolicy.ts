import * as firebaseappcheck from "@distilled.cloud/gcp/firebaseappcheck_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createOwnership,
  DEFAULT_SERVICE_ID,
  dummyTargetResource,
  findOwnedResourcePolicy,
  getResourcePolicy,
  hasDummyAlchemyTarget,
  listOwnedResourcePolicies,
  listResourcePolicies,
  normalizeEnforcement,
  parseResourcePolicyName,
  replaceOnIdentity,
  ResourceNotResolved,
  retryTransient,
  sameText,
  serviceParent,
} from "./internal.ts";

export type ServicesResourcePolicyProps = {
  /**
   * App Check service id. Currently only `oauth2.googleapis.com`
   * (Google Identity for iOS) supports resource policies. Immutable —
   * changing it replaces the policy.
   * @default "oauth2.googleapis.com"
   */
  serviceId?: string;
  /**
   * Service-specific resource this policy applies to. For iOS OAuth
   * clients: `//oauth2.googleapis.com/projects/{project}/oauthClients/{clientId}`.
   * The target may be missing at create time. Resource policies have no
   * labels or description field, so when this is omitted Alchemy targets
   * a dummy `alc-{alchemy-id}` OAuth client so `list` / nuke can find
   * the policy. Immutable — changing it replaces the policy.
   */
  targetResource?: string;
  /**
   * App Check enforcement mode. Overrides the service-level setting for
   * this resource.
   * @default "UNENFORCED"
   */
  enforcementMode?:
    | firebaseappcheck.GoogleFirebaseAppcheckV1ResourcePolicyEnforcementModeEnum
    | (string & {});
};

export type ServicesResourcePolicy = Resource<
  "GCP.FirebaseAppCheck.ServicesResourcePolicy",
  ServicesResourcePolicyProps,
  {
    /** Full resource name. */
    name: string;
    /** Server-assigned resource policy id. */
    resourcePolicyId: string;
    /** Parent service resource. */
    parent: string;
    /** Service id (`oauth2.googleapis.com`). */
    serviceId: string;
    /** Project id. */
    project: string;
    /** Target resource this policy applies to. */
    targetResource: string;
    /** Enforcement mode. */
    enforcementMode: string | undefined;
    /** Server-assigned checksum for optimistic concurrency. */
    etag: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An App Check enforcement policy for a single resource of a Google
 * service that App Check supports. Currently only Google Identity for
 * iOS (`oauth2.googleapis.com`) accepts resource policies. The policy
 * overrides the service-level enforcement mode.
 *
 * Resource policies have no labels field. When `targetResource` is
 * omitted, Alchemy points the policy at a dummy OAuth client whose id
 * starts with `alc-` so `list` / nuke can identify it. `serviceId` and
 * `targetResource` are identity — changing either replaces the policy.
 * Enforcement mode updates in place.
 *
 * ### Creating a Resource Policy
 * **Example:** Dummy target for tests
 * ```typescript
 * const policy = yield* GCP.FirebaseAppCheck.ServicesResourcePolicy(
 *   "IosOauth",
 *   { enforcementMode: "UNENFORCED" },
 * );
 * ```
 *
 * **Example:** Real iOS OAuth client
 * ```typescript
 * const policy = yield* GCP.FirebaseAppCheck.ServicesResourcePolicy(
 *   "IosOauth",
 *   {
 *     targetResource:
 *       "//oauth2.googleapis.com/projects/123/oauthClients/abc.apps.googleusercontent.com",
 *     enforcementMode: "ENFORCED",
 *   },
 * );
 * ```
 *
 * ### Updating a Resource Policy
 * **Example:** Switch to monitoring-only
 * ```typescript
 * const policy = yield* GCP.FirebaseAppCheck.ServicesResourcePolicy(
 *   "IosOauth",
 *   {
 *     enforcementMode: "UNENFORCED",
 *   },
 * );
 * ```
 *
 * @resource
 * @category FirebaseAppCheck
 */
export const ServicesResourcePolicy = Resource<ServicesResourcePolicy>(
  "GCP.FirebaseAppCheck.ServicesResourcePolicy",
);

const getByName = getResourcePolicy;

const toAttrs = (
  policy: firebaseappcheck.GoogleFirebaseAppcheckV1ResourcePolicy,
  project: string,
): ServicesResourcePolicy["Attributes"] => {
  const name = policy.name ?? "";
  const parsed = parseResourcePolicyName(name);
  return {
    name,
    resourcePolicyId: parsed.resourcePolicyId,
    parent: parsed.parent,
    serviceId: parsed.serviceId,
    project: parsed.project || project,
    targetResource: policy.targetResource ?? "",
    enforcementMode: policy.enforcementMode,
    etag: policy.etag,
    updateTime: policy.updateTime,
  };
};

export const ServicesResourcePolicyProvider = () =>
  Provider.succeed(ServicesResourcePolicy, {
    stables: [
      "name",
      "resourcePolicyId",
      "parent",
      "serviceId",
      "project",
      "targetResource",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousService =
        olds?.serviceId ?? output?.serviceId ?? DEFAULT_SERVICE_ID;
      const nextService = news.serviceId ?? previousService;
      const previousTarget = olds?.targetResource ?? output?.targetResource;
      return replaceOnIdentity({
        previous: previousService,
        next: nextService,
        extra:
          news.targetResource !== undefined &&
          previousTarget !== undefined &&
          news.targetResource !== previousTarget,
        deleteFirst: true,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const ownership = yield* createOwnership(id);
      let existing = yield* getByName(output?.name ?? "");
      if (existing === undefined) {
        const serviceId =
          olds?.serviceId ?? output?.serviceId ?? DEFAULT_SERVICE_ID;
        existing = findOwnedResourcePolicy(
          yield* listResourcePolicies(env.project, serviceId),
          ownership,
          output?.name,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const owned =
        output !== undefined || hasDummyAlchemyTarget(existing.targetResource);
      return owned ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const policies = yield* listOwnedResourcePolicies(env.project);
        return policies.map((policy) => toAttrs(policy, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceId =
        news.serviceId ?? output?.serviceId ?? DEFAULT_SERVICE_ID;
      const parent = serviceParent(env.project, serviceId);
      const ownership = yield* createOwnership(id);
      const targetResource =
        news.targetResource ??
        output?.targetResource ??
        dummyTargetResource(env.project, ownership);
      const enforcementMode = normalizeEnforcement(news.enforcementMode);

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = findOwnedResourcePolicy(
          yield* listResourcePolicies(env.project, serviceId),
          ownership,
          output?.name,
        );
      }

      if (current === undefined) {
        const created = yield* retryTransient(
          firebaseappcheck.createProjectsServicesResourcePolicies({
            parent,
            body: {
              targetResource,
              enforcementMode:
                enforcementMode as firebaseappcheck.GoogleFirebaseAppcheckV1ResourcePolicyEnforcementModeEnum,
            },
          }),
        ).pipe(
          Effect.catchTag("Conflict", () =>
            listResourcePolicies(env.project, serviceId).pipe(
              Effect.map((policies) =>
                findOwnedResourcePolicy(policies, ownership, output?.name),
              ),
            ),
          ),
        );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({
          name: output?.name ?? `${parent}/resourcePolicies`,
        });
      }

      if (!sameText(current.enforcementMode, enforcementMode)) {
        current = yield* retryTransient(
          firebaseappcheck.patchProjectsServicesResourcePolicies({
            name: current.name ?? "",
            updateMask: "enforcement_mode",
            body: {
              enforcementMode:
                enforcementMode as firebaseappcheck.GoogleFirebaseAppcheckV1ResourcePolicyEnforcementModeEnum,
              etag: current.etag,
            },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        firebaseappcheck.deleteProjectsServicesResourcePolicies({
          name: output.name,
          etag: output.etag,
        }),
      ).pipe(
        Effect.catchTag("Conflict", () =>
          firebaseappcheck.deleteProjectsServicesResourcePolicies({
            name: output.name,
          }),
        ),
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
