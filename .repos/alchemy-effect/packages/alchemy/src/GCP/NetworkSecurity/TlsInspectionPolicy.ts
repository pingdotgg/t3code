import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  normalizeLocation,
  parentOf,
  parseResourceName,
  resourceName,
  toId,
  toResourcePath,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";
import {
  createInternalLabels,
  encodeDescription,
  hasAlchemyLabels,
  hasOwnershipMarker,
  parseDescription,
  sameStringList,
} from "./ownership.ts";

const COLLECTION = "tlsInspectionPolicies";

export type TlsFeatureProfile =
  | "PROFILE_COMPATIBLE"
  | "PROFILE_MODERN"
  | "PROFILE_RESTRICTED"
  | "PROFILE_CUSTOM"
  | (string & {});

export type MinTlsVersion =
  | "TLS_1_0"
  | "TLS_1_1"
  | "TLS_1_2"
  | "TLS_1_3"
  | (string & {});

export type TlsInspectionPolicyProps = {
  /**
   * TlsInspectionPolicy id (the `{tlsInspectionPolicy}` segment of
   * `projects/{project}/locations/{location}/tlsInspectionPolicies/{tlsInspectionPolicy}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must match `^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`.
   * Immutable — changing it replaces the policy.
   */
  tlsInspectionPolicyId?: string;
  /**
   * Location (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the policy. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * CA pool used to issue interception certificates, as
   * `projects/{project}/locations/{location}/caPools/{caPool}` or a bare
   * pool id (combined with `location`).
   */
  caPool: string;
  /**
   * Human-readable description. TlsInspectionPolicy has no labels field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * TLS feature profile. Defaults to `PROFILE_COMPATIBLE` (broadest
   * client/server set). Secure Web Proxy does not yet honor this field.
   */
  tlsFeatureProfile?: TlsFeatureProfile;
  /**
   * Minimum TLS version negotiated with clients and servers. Secure Web
   * Proxy does not yet honor this field.
   */
  minTlsVersion?: MinTlsVersion;
  /**
   * Custom TLS cipher suites. Valid only when `tlsFeatureProfile` is
   * `PROFILE_CUSTOM`. Secure Web Proxy does not yet honor this field.
   */
  customTlsFeatures?: string[];
  /**
   * When true, do not trust the default public CA set — only CAs in
   * `trustConfig` are accepted. Defaults to false. Secure Web Proxy does
   * not yet honor this field.
   * @default false
   */
  excludePublicCaSet?: boolean;
  /**
   * Certificate Manager TrustConfig used when connecting to the TLS
   * server (`projects/{project}/locations/{location}/trustConfigs/{trustConfig}`).
   * Needed for private or self-signed server certificates. Secure Web
   * Proxy does not yet honor this field.
   */
  trustConfig?: string;
};

export type TlsInspectionPolicy = Resource<
  "GCP.NetworkSecurity.TlsInspectionPolicy",
  TlsInspectionPolicyProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/tlsInspectionPolicies/{tlsInspectionPolicy}`. */
    name: string;
    /** TlsInspectionPolicy id (last path segment). */
    tlsInspectionPolicyId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** CA pool used to issue interception certificates. */
    caPool: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** TLS feature profile currently configured. */
    tlsFeatureProfile: string | undefined;
    /** Minimum TLS version currently configured. */
    minTlsVersion: string | undefined;
    /** Custom TLS cipher suites, if `tlsFeatureProfile` is `PROFILE_CUSTOM`. */
    customTlsFeatures: string[];
    /** Whether the default public CA set is excluded. */
    excludePublicCaSet: boolean;
    /** TrustConfig used when connecting to TLS servers, if set. */
    trustConfig: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Security TlsInspectionPolicy — CA pool and TLS settings used
 * to intercept TLS for Secure Web Proxy and Cloud NGFW.
 *
 * TlsInspectionPolicy has no labels field, so Alchemy stamps ownership
 * into the description for `list` / nuke. Changing `tlsInspectionPolicyId`
 * or `location` replaces the policy. `caPool`, description, TLS feature
 * profile, min version, custom features, `excludePublicCaSet`, and
 * `trustConfig` update in place.
 *
 * ### Creating a TlsInspectionPolicy
 * **Example:** Intercept with a CaPool
 * ```typescript
 * const pool = yield* GCP.PrivateCA.CaPool("Intercept", {
 *   location: "us-central1",
 *   tier: "DEVOPS",
 * });
 * const policy = yield* GCP.NetworkSecurity.TlsInspectionPolicy("Inspect", {
 *   caPool: pool.name,
 * });
 * ```
 *
 * **Example:** Named policy with TLS constraints
 * ```typescript
 * const policy = yield* GCP.NetworkSecurity.TlsInspectionPolicy("Inspect", {
 *   tlsInspectionPolicyId: "app-inspect",
 *   location: "us-central1",
 *   caPool: pool.name,
 *   description: "prod intercept",
 *   excludePublicCaSet: true,
 *   minTlsVersion: "TLS_1_2",
 *   tlsFeatureProfile: "PROFILE_MODERN",
 * });
 * ```
 *
 * ### Updating a TlsInspectionPolicy
 * **Example:** Tighten TLS
 * ```typescript
 * const policy = yield* GCP.NetworkSecurity.TlsInspectionPolicy("Inspect", {
 *   tlsInspectionPolicyId: "app-inspect",
 *   location: "us-central1",
 *   caPool: pool.name,
 *   description: "prod intercept v2",
 *   excludePublicCaSet: true,
 *   minTlsVersion: "TLS_1_2",
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const TlsInspectionPolicy = Resource<TlsInspectionPolicy>(
  "GCP.NetworkSecurity.TlsInspectionPolicy",
);

export class TlsInspectionPolicyNotResolved extends Data.TaggedError(
  "GCP.NetworkSecurity.TlsInspectionPolicyNotResolved",
)<{
  name: string;
}> {}

export class TlsInspectionPolicyStillExists extends Data.TaggedError(
  "GCP.NetworkSecurity.TlsInspectionPolicyStillExists",
)<{
  name: string;
}> {}

const caPoolName = (project: string, location: string, caPool: string) => {
  const trimmed = toResourcePath(caPool);
  if (trimmed.includes("/")) return trimmed;
  return `projects/${project}/locations/${location}/caPools/${trimmed}`;
};

const trustConfigName = (
  project: string,
  location: string,
  trustConfig: string | undefined,
) => {
  if (trustConfig === undefined || trustConfig.length === 0) return undefined;
  const trimmed = toResourcePath(trustConfig);
  if (trimmed.includes("/")) return trimmed;
  return `projects/${project}/locations/${location}/trustConfigs/${trimmed}`;
};

const toAttrs = (
  policy: networksecurity.TlsInspectionPolicy,
  project: string,
  region: string,
) => {
  const name = policy.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  const owned = parseDescription(policy.description);
  return {
    name,
    tlsInspectionPolicyId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || region,
    caPool: policy.caPool,
    description: owned.description,
    tlsFeatureProfile: policy.tlsFeatureProfile,
    minTlsVersion: policy.minTlsVersion,
    customTlsFeatures: policy.customTlsFeatures ?? [],
    excludePublicCaSet: policy.excludePublicCaSet === true,
    trustConfig: policy.trustConfig,
    createTime: policy.createTime,
    updateTime: policy.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsTlsInspectionPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((policy) =>
      policy
        ? Effect.succeed(policy)
        : Effect.fail(new TlsInspectionPolicyNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.TlsInspectionPolicyNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((policy) =>
      policy === undefined
        ? Effect.void
        : Effect.fail(new TlsInspectionPolicyStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.TlsInspectionPolicyStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listOwned = (project: string, region: string) =>
  networksecurity.listProjectsLocationsTlsInspectionPolicies
    .pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.tlsInspectionPolicies ?? []),
      ),
      Stream.filter((policy) => hasOwnershipMarker(policy.description)),
      Stream.map((policy) => toAttrs(policy, project, region)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const TlsInspectionPolicyProvider = () =>
  Provider.succeed(TlsInspectionPolicy, {
    stables: [
      "name",
      "tlsInspectionPolicyId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId =
        olds?.tlsInspectionPolicyId ?? output?.tlsInspectionPolicyId;
      const nextId = news.tlsInspectionPolicyId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const tlsInspectionPolicyId = yield* toId(
        id,
        olds?.tlsInspectionPolicyId,
        output?.tlsInspectionPolicyId,
        "tlsinsp",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, tlsInspectionPolicyId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project, env.region);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const tlsInspectionPolicyId = yield* toId(
        id,
        news.tlsInspectionPolicyId,
        output?.tlsInspectionPolicyId,
        "tlsinsp",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        tlsInspectionPolicyId,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const caPool = caPoolName(env.project, location, news.caPool);
      const trustConfig = trustConfigName(
        env.project,
        location,
        news.trustConfig,
      );
      const excludePublicCaSet = news.excludePublicCaSet === true;
      const customTlsFeatures = news.customTlsFeatures ?? [];

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsTlsInspectionPolicies({
            parent: parentOf(env.project, location),
            tlsInspectionPolicyId,
            body: {
              description: desiredDescription,
              caPool,
              trustConfig,
              excludePublicCaSet,
              tlsFeatureProfile: news.tlsFeatureProfile,
              minTlsVersion: news.minTlsVersion,
              customTlsFeatures:
                customTlsFeatures.length > 0 ? customTlsFeatures : undefined,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new TlsInspectionPolicyNotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const caPoolChanged = (current.caPool ?? "") !== caPool;
      const trustChanged = (current.trustConfig ?? "") !== (trustConfig ?? "");
      const excludeChanged =
        (current.excludePublicCaSet === true) !== excludePublicCaSet;
      const profileChanged =
        (current.tlsFeatureProfile ?? "") !== (news.tlsFeatureProfile ?? "");
      const minTlsChanged =
        (current.minTlsVersion ?? "") !== (news.minTlsVersion ?? "");
      const featuresChanged =
        !sameStringList(
          current.customTlsFeatures,
          customTlsFeatures.length > 0
            ? customTlsFeatures
            : current.customTlsFeatures,
        ) && news.customTlsFeatures !== undefined;

      if (
        descriptionChanged ||
        caPoolChanged ||
        trustChanged ||
        excludeChanged ||
        profileChanged ||
        minTlsChanged ||
        featuresChanged
      ) {
        const updateMask = [
          descriptionChanged ? "description" : undefined,
          caPoolChanged ? "caPool" : undefined,
          trustChanged ? "trustConfig" : undefined,
          excludeChanged ? "excludePublicCaSet" : undefined,
          profileChanged ? "tlsFeatureProfile" : undefined,
          minTlsChanged ? "minTlsVersion" : undefined,
          featuresChanged ? "customTlsFeatures" : undefined,
        ].filter((field): field is string => field !== undefined);
        const operation =
          yield* networksecurity.patchProjectsLocationsTlsInspectionPolicies({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              description: desiredDescription,
              caPool,
              trustConfig,
              excludePublicCaSet,
              tlsFeatureProfile: news.tlsFeatureProfile,
              minTlsVersion: news.minTlsVersion,
              customTlsFeatures:
                news.customTlsFeatures !== undefined
                  ? customTlsFeatures
                  : current.customTlsFeatures,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(current.name ?? name);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsTlsInspectionPolicies({
          name: output.name,
          force: true,
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
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
