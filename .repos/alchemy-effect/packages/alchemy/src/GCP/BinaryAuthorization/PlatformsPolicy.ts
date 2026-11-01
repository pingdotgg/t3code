import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createOwnership,
  DEFAULT_PLATFORM,
  encodeDescription,
  gkePolicyOf,
  hasOwnershipMarker,
  listPlatformPolicies,
  missingGet,
  ownedBy,
  parseDescription,
  parsePolicyName,
  policyName,
  replaceOnIdentity,
  ResourceNotResolved,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
} from "./internal.ts";

export type GkePolicy = binaryauthorization.GkePolicy;

export type PlatformsPolicyProps = {
  /**
   * Policy id (the `{policy}` segment of
   * `projects/{project}/platforms/{platform}/policies/{policy}`). If omitted,
   * a unique RFC1035 id is generated. Immutable — changing it replaces the
   * policy.
   */
  policyId?: string;
  /**
   * Platform this policy applies to (`gke` or `cloudRun`). Immutable —
   * changing it replaces the policy.
   * @default "gke"
   */
  platform?: string;
  /**
   * Human-readable comment. Platform policies have no labels field, so
   * Alchemy stamps ownership into this field for `list` / nuke and strips
   * the marker from attributes.
   */
  description?: string;
  /**
   * GKE-specific policy. Empty (the default) allows every image. When
   * `checkSets` is non-empty the last entry must be an unscoped catch-all.
   */
  gkePolicy?: GkePolicy;
};

export type PlatformsPolicy = Resource<
  "GCP.BinaryAuthorization.PlatformsPolicy",
  PlatformsPolicyProps,
  {
    /** Full name `projects/{project}/platforms/{platform}/policies/{policy}`. */
    name: string;
    /** Policy id (last path segment). */
    policyId: string;
    /** Platform id (`gke`, `cloudRun`, …). */
    platform: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** GKE-specific policy, if set. */
    gkePolicy: GkePolicy | undefined;
    /** Server-assigned checksum for optimistic concurrency. */
    etag: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Binary Authorization platform policy. Platform policies apply to a
 * specific runtime (`gke` by default) and evaluate images independently of
 * the project-level admission policy.
 *
 * Platform policies have no labels field, so Alchemy stamps ownership into
 * `description` for `list` / nuke. `policyId` and `platform` are identity —
 * changing either replaces the policy. Description and `gkePolicy` update
 * in place via replace.
 *
 * ### Creating a Platform Policy
 * **Example:** Allow all images on GKE
 * ```typescript
 * const policy = yield* GCP.BinaryAuthorization.PlatformsPolicy(
 *   "Default",
 *   {},
 * );
 * ```
 *
 * **Example:** Allowlist Google system images
 * ```typescript
 * const policy = yield* GCP.BinaryAuthorization.PlatformsPolicy(
 *   "Default",
 *   {
 *     policyId: "gke-default",
 *     description: "allowlisted system images",
 *     gkePolicy: {
 *       imageAllowlist: {
 *         allowPattern: ["gcr.io/google-containers/*"],
 *       },
 *     },
 *   },
 * );
 * ```
 *
 * ### Updating a Platform Policy
 * **Example:** Add a catch-all always-deny check
 * ```typescript
 * const policy = yield* GCP.BinaryAuthorization.PlatformsPolicy(
 *   "Default",
 *   {
 *     gkePolicy: {
 *       checkSets: [
 *         {
 *           displayName: "default",
 *           checks: [{ displayName: "deny", alwaysDeny: true }],
 *         },
 *       ],
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category BinaryAuthorization
 */
export const PlatformsPolicy = Resource<PlatformsPolicy>(
  "GCP.BinaryAuthorization.PlatformsPolicy",
);

const getByName = missingGet(binaryauthorization.getProjectsPlatformsPolicies);

const toAttrs = (
  policy: binaryauthorization.PlatformPolicy,
  project: string,
): PlatformsPolicy["Attributes"] => {
  const name = policy.name ?? "";
  const parsed = parsePolicyName(name);
  const { description } = parseDescription(policy.description);
  return {
    name,
    policyId: parsed.policyId,
    platform: parsed.platform,
    project: parsed.project || project,
    description,
    gkePolicy: policy.gkePolicy,
    etag: policy.etag,
    updateTime: policy.updateTime,
  };
};

const toBody = (
  news: PlatformsPolicyProps,
  description: string,
  etag: string | undefined,
): binaryauthorization.PlatformPolicy => ({
  description,
  etag,
  gkePolicy: gkePolicyOf(news.gkePolicy),
});

export const PlatformsPolicyProvider = () =>
  Provider.succeed(PlatformsPolicy, {
    stables: ["name", "policyId", "platform", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.policyId ?? output?.policyId,
        nextId: news.policyId,
        previousParent: olds?.platform ?? output?.platform,
        nextParent: news.platform ?? output?.platform ?? DEFAULT_PLATFORM,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const policyId = yield* toPhysicalId(
        id,
        olds?.policyId,
        output?.policyId,
        "policy",
      );
      const platform = olds?.platform ?? output?.platform ?? DEFAULT_PLATFORM;
      const name = output?.name ?? policyName(env.project, platform, policyId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* ownedBy(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listPlatformPolicies(env.project);
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const policyId = yield* toPhysicalId(
        id,
        news.policyId,
        output?.policyId,
        "policy",
      );
      const platform = news.platform ?? output?.platform ?? DEFAULT_PLATFORM;
      const name = policyName(env.project, platform, policyId);
      const ownership = yield* createOwnership(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredGke = gkePolicyOf(news.gkePolicy);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryTransient(
          binaryauthorization.createProjectsPlatformsPolicies({
            parent: `projects/${env.project}/platforms/${platform}`,
            policyId,
            body: toBody(news, desiredDescription, undefined),
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const descriptionChanged = !sameText(
        current.description,
        desiredDescription,
      );
      const gkeChanged = !sameJson(gkePolicyOf(current.gkePolicy), desiredGke);

      if (descriptionChanged || gkeChanged) {
        current = yield* retryTransient(
          binaryauthorization.replacePlatformPolicyProjectsPlatformsPolicies({
            name: current.name ?? name,
            body: toBody(news, desiredDescription, current.etag),
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* binaryauthorization
        .deleteProjectsPlatformsPolicies({
          name: output.name,
          etag: output.etag,
        })
        .pipe(
          Effect.catchTag("Conflict", () =>
            binaryauthorization.deleteProjectsPlatformsPolicies({
              name: output.name,
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });
