import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import type {
  SslPolicyMinTlsVersion,
  SslPolicyPostQuantumKeyExchange,
  SslPolicyProfile,
} from "./SslPolicy.ts";

const DEFAULT_PROFILE: SslPolicyProfile = "COMPATIBLE";
const DEFAULT_MIN_TLS: SslPolicyMinTlsVersion = "TLS_1_0";

export type RegionSslPolicyProps = {
  /**
   * SSL policy name (RFC1035, 1-63 chars). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the resource.
   */
  sslPolicyName?: string;
  /**
   * Region the policy lives in (e.g. `us-central1`). Immutable — changing
   * it replaces the resource. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix so `list` / nuke can find resources (Compute SslPolicy has no
   * labels field).
   */
  description?: string;
  /**
   * Minimum TLS version clients may use (`TLS_1_0`, `TLS_1_1`, `TLS_1_2`,
   * `TLS_1_3`). `TLS_1_3` requires `profile: "RESTRICTED"`.
   * @default "TLS_1_0"
   */
  minTlsVersion?: SslPolicyMinTlsVersion;
  /**
   * Cipher-suite profile (`COMPATIBLE`, `MODERN`, `RESTRICTED`,
   * `FIPS_202205`, `CUSTOM`). `CUSTOM` requires `customFeatures`.
   * `FIPS_202205` requires `minTlsVersion: "TLS_1_2"`.
   * @default "COMPATIBLE"
   */
  profile?: SslPolicyProfile;
  /**
   * Features enabled when `profile` is `CUSTOM`. Must be empty for every
   * other profile.
   */
  customFeatures?: string[];
  /**
   * Whether the load balancer negotiates X25519MLKEM768 (`DEFAULT`,
   * `ENABLED`, `DEFERRED`).
   */
  postQuantumKeyExchange?: SslPolicyPostQuantumKeyExchange;
};

export type RegionSslPolicy = Resource<
  "GCP.Compute.RegionSslPolicy",
  RegionSslPolicyProps,
  {
    /** SSL policy name. */
    sslPolicyName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Minimum TLS version. */
    minTlsVersion: SslPolicyMinTlsVersion;
    /** Cipher-suite profile. */
    profile: SslPolicyProfile;
    /** Custom features (only when `profile` is `CUSTOM`). */
    customFeatures: string[];
    /** Features currently enabled by the selected profile. */
    enabledFeatures: string[];
    /** Post-quantum key exchange mode, if set. */
    postQuantumKeyExchange: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    sslPolicyId: string | undefined;
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine SSL policy for HTTPS and SSL load balancing.
 *
 * SSL policies control the TLS versions and cipher suites offered by
 * regional Application Load Balancers and proxy Network Load Balancers.
 * This resource maps to the `regionSslPolicies` collection (the global
 * `sslPolicies` collection is `GCP.Compute.SslPolicy`). Compute SslPolicy
 * has no labels field — Alchemy ownership is stored in the description
 * so nuke can find leaked policies.
 *
 * ### Creating a Regional SSL Policy
 * **Example:** Generated name (COMPATIBLE, TLS 1.0)
 * ```typescript
 * const policy = yield* GCP.Compute.RegionSslPolicy("Frontend", {
 *   region: "us-central1",
 * });
 * ```
 *
 * **Example:** Modern profile and TLS 1.2
 * ```typescript
 * const policy = yield* GCP.Compute.RegionSslPolicy("Frontend", {
 *   region: "us-central1",
 *   description: "prod frontend",
 *   profile: "MODERN",
 *   minTlsVersion: "TLS_1_2",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionSslPolicy = Resource<RegionSslPolicy>(
  "GCP.Compute.RegionSslPolicy",
);

export class RegionSslPolicyNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionSslPolicyNotResolved",
)<{
  sslPolicyName: string;
  region: string;
}> {}

const lastSegment = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `s${next}`;
  }
  next = next.slice(0, 63).replace(/-+$/, "");
  return next.length > 0 ? next : "sslpolicy";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const asProfile = (value: string | undefined): SslPolicyProfile => {
  switch (value) {
    case "COMPATIBLE":
    case "MODERN":
    case "RESTRICTED":
    case "FIPS_202205":
    case "CUSTOM":
      return value;
    default:
      return DEFAULT_PROFILE;
  }
};

const asMinTlsVersion = (value: string | undefined): SslPolicyMinTlsVersion => {
  switch (value) {
    case "TLS_1_0":
    case "TLS_1_1":
    case "TLS_1_2":
    case "TLS_1_3":
      return value;
    default:
      return DEFAULT_MIN_TLS;
  }
};

const featuresOf = (features: readonly string[] | undefined): string[] => [
  ...(features ?? []),
];

const sameFeatures = (
  observed?: readonly string[],
  desired?: readonly string[],
) =>
  [...(observed ?? [])].sort().join("\0") ===
  [...(desired ?? [])].sort().join("\0");

const toBody = (
  sslPolicyName: string,
  props: RegionSslPolicyProps,
  ownership: Record<string, string>,
  fingerprint?: string,
): compute.SslPolicy => {
  const profile = props.profile ?? DEFAULT_PROFILE;
  return {
    name: sslPolicyName,
    fingerprint,
    description: encodeDescription(ownership, props.description),
    profile,
    minTlsVersion: props.minTlsVersion ?? DEFAULT_MIN_TLS,
    customFeatures:
      profile === "CUSTOM" ? featuresOf(props.customFeatures) : [],
    postQuantumKeyExchange: props.postQuantumKeyExchange,
  };
};

const toAttrs = (
  policy: compute.SslPolicy,
  project: string,
): RegionSslPolicy["Attributes"] => {
  const parsed = parseDescription(policy.description);
  return {
    sslPolicyName: policy.name ?? policy.id ?? "",
    project,
    region: lastSegment(policy.region).toLowerCase(),
    description: parsed.description,
    minTlsVersion: asMinTlsVersion(policy.minTlsVersion),
    profile: asProfile(policy.profile),
    customFeatures: featuresOf(policy.customFeatures),
    enabledFeatures: featuresOf(policy.enabledFeatures),
    postQuantumKeyExchange: policy.postQuantumKeyExchange,
    selfLink: policy.selfLink,
    sslPolicyId: policy.id,
    fingerprint: policy.fingerprint,
    creationTimestamp: policy.creationTimestamp,
    kind: policy.kind,
  };
};

const needsUpdate = (
  current: compute.SslPolicy,
  desired: compute.SslPolicy,
) => {
  if ((current.description ?? "") !== (desired.description ?? "")) return true;
  if (asProfile(current.profile) !== asProfile(desired.profile)) return true;
  if (
    asMinTlsVersion(current.minTlsVersion) !==
    asMinTlsVersion(desired.minTlsVersion)
  ) {
    return true;
  }
  if (!sameFeatures(current.customFeatures, desired.customFeatures)) {
    return true;
  }
  if (
    desired.postQuantumKeyExchange !== undefined &&
    (current.postQuantumKeyExchange ?? "DEFAULT") !==
      desired.postQuantumKeyExchange
  ) {
    return true;
  }
  return false;
};

const getByName = (project: string, region: string, sslPolicy: string) =>
  compute
    .getRegionSslPolicies({ project, region, sslPolicy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (
  project: string,
  region: string,
  sslPolicyName: string,
) =>
  getByName(project, region, sslPolicyName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (policy) => policy !== undefined,
      times: 8,
    }),
  );

export const RegionSslPolicyProvider = () =>
  Provider.succeed(RegionSslPolicy, {
    stables: [
      "sslPolicyName",
      "project",
      "region",
      "sslPolicyId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.sslPolicyName ?? output?.sslPolicyName;
      const nextName = news.sslPolicyName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      if (previousRegion !== nextRegion) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const sslPolicyName = yield* toName(
        id,
        olds?.sslPolicyName,
        output?.sslPolicyName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, sslPolicyName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListSslPolicies
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.sslPolicies ?? [])
              .filter((policy) => (policy.region ?? "").length > 0)
              .filter((policy) => {
                const { labels } = parseDescription(policy.description);
                return Object.keys(labels).some((key) =>
                  key.startsWith("alchemy-"),
                );
              })
              .map((policy) => toAttrs(policy, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const sslPolicyName = yield* toName(
        id,
        news.sslPolicyName,
        output?.sslPolicyName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(sslPolicyName, news, ownership);

      let current = yield* getByName(env.project, region, sslPolicyName);

      if (current === undefined) {
        yield* compute
          .insertRegionSslPolicies({
            project: env.project,
            region,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* awaitResource(env.project, region, sslPolicyName);
      }

      if (current === undefined) {
        return yield* new RegionSslPolicyNotResolved({
          sslPolicyName,
          region,
        });
      }

      if (needsUpdate(current, desired)) {
        yield* compute
          .patchRegionSslPolicies({
            project: env.project,
            region,
            sslPolicy: sslPolicyName,
            body: toBody(sslPolicyName, news, ownership, current.fingerprint),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation),
            ),
          );
        current = yield* getByName(env.project, region, sslPolicyName);
        if (current === undefined) {
          return yield* new RegionSslPolicyNotResolved({
            sslPolicyName,
            region,
          });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      const operation = yield* compute
        .deleteRegionSslPolicies({
          project: env.project,
          region,
          sslPolicy: output.sslPolicyName,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            schedule: Schedule.spaced("2 seconds"),
            times: 8,
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitRegionOperation(env.project, region, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
