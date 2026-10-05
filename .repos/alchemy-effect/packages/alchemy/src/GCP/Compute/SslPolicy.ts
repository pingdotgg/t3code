import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
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

export type SslPolicyMinTlsVersion =
  | "TLS_1_0"
  | "TLS_1_1"
  | "TLS_1_2"
  | "TLS_1_3";

export type SslPolicyProfile =
  | "COMPATIBLE"
  | "MODERN"
  | "RESTRICTED"
  | "FIPS_202205"
  | "CUSTOM";

export type SslPolicyPostQuantumKeyExchange =
  | "DEFAULT"
  | "ENABLED"
  | "DEFERRED";

export type SslPolicyProps = {
  /**
   * SSL policy name (RFC1035, 1-63 chars). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the resource.
   */
  sslPolicyName?: string;
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
   * other profile. Use `listAvailableFeaturesSslPolicies` for the
   * allowed set.
   */
  customFeatures?: string[];
  /**
   * Whether the load balancer negotiates X25519MLKEM768 (`DEFAULT`,
   * `ENABLED`, `DEFERRED`).
   */
  postQuantumKeyExchange?: SslPolicyPostQuantumKeyExchange;
};

export type SslPolicy = Resource<
  "GCP.Compute.SslPolicy",
  SslPolicyProps,
  {
    /** SSL policy name. */
    sslPolicyName: string;
    /** Project id. */
    project: string;
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
 * A global Compute Engine SSL policy for HTTPS and SSL load balancing.
 *
 * SSL policies control the TLS versions and cipher suites offered by
 * Application Load Balancers and proxy Network Load Balancers. This
 * resource maps to the global `sslPolicies` collection
 * (`regionSslPolicies` is a separate resource). Compute SslPolicy has no
 * labels field — Alchemy ownership is stored in the description so nuke
 * can find leaked policies.
 *
 * ### Creating an SSL Policy
 * **Example:** Generated name (COMPATIBLE, TLS 1.0)
 * ```typescript
 * const policy = yield* GCP.Compute.SslPolicy("Frontend", {});
 * ```
 *
 * **Example:** Modern profile and TLS 1.2
 * ```typescript
 * const policy = yield* GCP.Compute.SslPolicy("Frontend", {
 *   description: "prod frontend",
 *   profile: "MODERN",
 *   minTlsVersion: "TLS_1_2",
 * });
 * ```
 *
 * ### Custom Cipher Suites
 * **Example:** CUSTOM profile
 * ```typescript
 * const policy = yield* GCP.Compute.SslPolicy("Frontend", {
 *   profile: "CUSTOM",
 *   minTlsVersion: "TLS_1_2",
 *   customFeatures: [
 *     "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
 *     "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const SslPolicy = Resource<SslPolicy>("GCP.Compute.SslPolicy");

export class SslPolicyNotResolved extends Data.TaggedError(
  "GCP.Compute.SslPolicyNotResolved",
)<{
  sslPolicyName: string;
}> {}

const DEFAULT_PROFILE: SslPolicyProfile = "COMPATIBLE";
const DEFAULT_MIN_TLS: SslPolicyMinTlsVersion = "TLS_1_0";

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
  props: SslPolicyProps,
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
): SslPolicy["Attributes"] => {
  const parsed = parseDescription(policy.description);
  return {
    sslPolicyName: policy.name ?? policy.id ?? "",
    project,
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

const getByName = (project: string, sslPolicy: string) =>
  compute
    .getSslPolicies({ project, sslPolicy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, sslPolicyName: string) =>
  getByName(project, sslPolicyName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (policy) => policy !== undefined,
      times: 8,
    }),
  );

export const SslPolicyProvider = () =>
  Provider.succeed(SslPolicy, {
    stables: [
      "sslPolicyName",
      "project",
      "sslPolicyId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.sslPolicyName ?? output?.sslPolicyName;
      const nextName = news.sslPolicyName;
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
      const existing = yield* getByName(env.project, sslPolicyName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listSslPolicies
          .items({ project: env.project, maxResults: 500 })
          .pipe(
            Stream.filter((policy) => {
              const { labels } = parseDescription(policy.description);
              return Object.keys(labels).some((key) =>
                key.startsWith("alchemy-"),
              );
            }),
            Stream.map((policy) => toAttrs(policy, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const sslPolicyName = yield* toName(
        id,
        news.sslPolicyName,
        output?.sslPolicyName,
      );
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(sslPolicyName, news, ownership);

      let current = yield* getByName(env.project, sslPolicyName);

      if (current === undefined) {
        yield* compute
          .insertSslPolicies({
            project: env.project,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* awaitResource(env.project, sslPolicyName);
      }

      if (current === undefined) {
        return yield* new SslPolicyNotResolved({ sslPolicyName });
      }

      if (needsUpdate(current, desired)) {
        yield* compute
          .patchSslPolicies({
            project: env.project,
            sslPolicy: sslPolicyName,
            body: toBody(sslPolicyName, news, ownership, current.fingerprint),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, sslPolicyName);
        if (current === undefined) {
          return yield* new SslPolicyNotResolved({ sslPolicyName });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteSslPolicies({
          project: env.project,
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
        yield* waitGlobalOperation(env.project, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
