import * as certificatemanager from "@distilled.cloud/gcp/certificatemanager_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./operations.ts";

const DEFAULT_LOCATION = "global";
const DEFAULT_LIFETIME = "2592000s";
const DEFAULT_ROTATION = 66;
const DEFAULT_KEY_ALGORITHM: CertificateIssuanceConfigKeyAlgorithm = "RSA_2048";
const MAX_NAME_LENGTH = 63;

export type CertificateIssuanceConfigKeyAlgorithm =
  | "RSA_2048"
  | "ECDSA_P256"
  | (string & {});

export type CertificateAuthorityServiceConfig = {
  /**
   * CA pool that issues workload certificates
   * (`projects/{project}/locations/{location}/caPools/{caPool}`).
   * A bare pool id is expanded with this issuance config's project and
   * location. Immutable — changing it replaces the issuance config.
   */
  caPool: string;
};

export type CertificateAuthorityConfig = {
  /** Certificate Authority Service pool used to mint certificates. */
  certificateAuthorityServiceConfig: CertificateAuthorityServiceConfig;
};

export type CertificateIssuanceConfigProps = {
  /**
   * CertificateIssuanceConfig id (the `{certificateIssuanceConfig}`
   * segment of `projects/{project}/locations/{location}/certificateIssuanceConfigs/{certificateIssuanceConfig}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters, start with a letter, and match
   * `[a-z]([-a-z0-9]*[a-z0-9])?`. Immutable — changing it replaces the
   * issuance config. Ids are unique across all locations.
   */
  certificateIssuanceConfigId?: string;
  /**
   * Certificate Manager location (`global`, `us-central1`, …). Immutable —
   * changing it replaces the issuance config. `US-CENTRAL1` is accepted
   * and normalized to `us-central1`. A regional CA pool may be referenced
   * from a `global` issuance config.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Requested lifetime of issued certificates as a protobuf Duration
   * (`2592000s` for 30 days). Valid range is 21-30 days. Immutable —
   * changing it replaces the issuance config.
   * @default "2592000s"
   */
  lifetime?: string;
  /**
   * Percentage of elapsed lifetime at which renewal begins. Must be
   * 1-99 and leave at least 7 days after issuance and before expiry.
   * Immutable — changing it replaces the issuance config.
   * @default 66
   */
  rotationWindowPercentage?: number;
  /**
   * Key algorithm used when generating the private key. `RSA_2048` or
   * `ECDSA_P256`. Immutable — changing it replaces the issuance config.
   * @default "RSA_2048"
   */
  keyAlgorithm?: CertificateIssuanceConfigKeyAlgorithm;
  /**
   * CA that issues the workload certificate. Immutable — changing the
   * CA pool replaces the issuance config.
   */
  certificateAuthorityConfig: CertificateAuthorityConfig;
};

export type CertificateIssuanceConfig = Resource<
  "GCP.CertificateManager.CertificateIssuanceConfig",
  CertificateIssuanceConfigProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/certificateIssuanceConfigs/{certificateIssuanceConfig}`. */
    name: string;
    /** CertificateIssuanceConfig id (last path segment). */
    certificateIssuanceConfigId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Requested certificate lifetime (protobuf Duration). */
    lifetime: string;
    /** Percentage of elapsed lifetime at which renewal begins. */
    rotationWindowPercentage: number;
    /** Key algorithm (`RSA_2048` or `ECDSA_P256`). */
    keyAlgorithm: string;
    /** CA pool resource name used to issue certificates. */
    caPool: string;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Certificate Manager issuance config — how Google-managed certificates
 * are minted from Certificate Authority Service (lifetime, rotation,
 * key algorithm, and CA pool).
 *
 * Changing `certificateIssuanceConfigId`, `location`, `lifetime`,
 * `rotationWindowPercentage`, `keyAlgorithm`, or the CA pool replaces
 * the resource. Description and labels update in place.
 *
 * ### Creating an Issuance Config
 * **Example:** Generated name
 * ```typescript
 * const pool = yield* GCP.PrivateCA.CaPool("AppCa", {
 *   location: "us-central1",
 * });
 * const issuance = yield* GCP.CertificateManager.CertificateIssuanceConfig(
 *   "WorkloadTls",
 *   {
 *     certificateAuthorityConfig: {
 *       certificateAuthorityServiceConfig: { caPool: pool.name },
 *     },
 *   },
 * );
 * ```
 *
 * **Example:** Named config with labels
 * ```typescript
 * const issuance = yield* GCP.CertificateManager.CertificateIssuanceConfig(
 *   "WorkloadTls",
 *   {
 *     certificateIssuanceConfigId: "app-workload-tls",
 *     description: "prod workload certs",
 *     labels: { env: "prod" },
 *     lifetime: "2592000s",
 *     rotationWindowPercentage: 66,
 *     keyAlgorithm: "ECDSA_P256",
 *     certificateAuthorityConfig: {
 *       certificateAuthorityServiceConfig: { caPool: pool.name },
 *     },
 *   },
 * );
 * ```
 *
 * ### Regional Issuance Config
 * **Example:** us-central1 issuance config
 * ```typescript
 * const issuance = yield* GCP.CertificateManager.CertificateIssuanceConfig(
 *   "RegionalTls",
 *   {
 *     location: "us-central1",
 *     certificateAuthorityConfig: {
 *       certificateAuthorityServiceConfig: { caPool: pool.name },
 *     },
 *   },
 * );
 * ```
 *
 * ### Google-Managed Private Certificates
 * **Example:** Issue a managed certificate from an issuance config
 * ```typescript
 * const cert = yield* GCP.CertificateManager.Certificate("FrontendTls", {
 *   type: "MANAGED",
 *   managed: {
 *     domains: ["www.example.com"],
 *     issuanceConfig: issuance.name,
 *   },
 * });
 * ```
 *
 * @resource
 * @category CertificateManager
 */
export const CertificateIssuanceConfig = Resource<CertificateIssuanceConfig>(
  "GCP.CertificateManager.CertificateIssuanceConfig",
);

export class CertificateIssuanceConfigNotResolved extends Data.TaggedError(
  "GCP.CertificateManager.CertificateIssuanceConfigNotResolved",
)<{
  name: string;
}> {}

export class CertificateIssuanceConfigStillExists extends Data.TaggedError(
  "GCP.CertificateManager.CertificateIssuanceConfigStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `c${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "issuance-config";
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const resourceName = (
  project: string,
  location: string,
  certificateIssuanceConfigId: string,
) =>
  `projects/${project}/locations/${location}/certificateIssuanceConfigs/${certificateIssuanceConfigId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const configsAt = parts.lastIndexOf("certificateIssuanceConfigs");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    certificateIssuanceConfigId:
      configsAt >= 0 && parts[configsAt + 1]
        ? parts[configsAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (
  id: string,
  certificateIssuanceConfigId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (certificateIssuanceConfigId !== undefined) {
      return certificateIssuanceConfigId;
    }
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const parseDurationSeconds = (
  value: string | undefined,
): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const trimmed = value.trim();
  const seconds = /^(-?\d+(?:\.\d+)?)s$/i.exec(trimmed);
  if (seconds) return Number(seconds[1]);
  const days = /^(-?\d+(?:\.\d+)?)d$/i.exec(trimmed);
  if (days) return Number(days[1]) * 86400;
  return undefined;
};

const normalizeLifetime = (value: string | undefined): string => {
  const raw =
    value === undefined || value.trim() === "" ? DEFAULT_LIFETIME : value;
  const seconds = parseDurationSeconds(raw);
  return seconds !== undefined && Number.isFinite(seconds)
    ? `${Math.trunc(seconds)}s`
    : raw;
};

const lifetimeEquals = (left: string | undefined, right: string | undefined) =>
  normalizeLifetime(left) === normalizeLifetime(right);

const normalizeKeyAlgorithm = (value: string | undefined): string => {
  const compact = (value ?? "").trim().toUpperCase().replace(/-/g, "_");
  if (
    compact === "" ||
    compact === "KEY_ALGORITHM_UNSPECIFIED" ||
    compact === "UNSPECIFIED"
  ) {
    return DEFAULT_KEY_ALGORITHM;
  }
  if (
    compact === "ECDSA_P256" ||
    compact === "ECDSA" ||
    compact === "EC_P256" ||
    compact === "ECDSA_P_256"
  ) {
    return "ECDSA_P256";
  }
  if (compact === "RSA_2048" || compact === "RSA") {
    return "RSA_2048";
  }
  return compact;
};

const normalizeRotation = (value: number | undefined): number =>
  value ?? DEFAULT_ROTATION;

const normalizeCaPool = (
  value: string | undefined,
  project: string,
  location: string,
): string => {
  if (value === undefined) return "";
  const trimmed = value.replace(/\/+$/, "").trim();
  if (trimmed.length === 0) return "";
  if (trimmed.includes("/")) return trimmed;
  return `projects/${project}/locations/${location}/caPools/${trimmed}`;
};

const caPoolOf = (
  config:
    | CertificateAuthorityConfig
    | certificatemanager.CertificateAuthorityConfig
    | undefined,
) => config?.certificateAuthorityServiceConfig?.caPool;

const toAttrs = (
  config: certificatemanager.CertificateIssuanceConfig,
  project: string,
) => {
  const name = config.name ?? "";
  const parsed = parseName(name);
  const location = parsed.location;
  const resolvedProject = parsed.project || project;
  return {
    name,
    certificateIssuanceConfigId: parsed.certificateIssuanceConfigId,
    project: resolvedProject,
    location,
    description: config.description,
    labels: userLabels(config.labels),
    lifetime: normalizeLifetime(config.lifetime),
    rotationWindowPercentage: normalizeRotation(
      config.rotationWindowPercentage,
    ),
    keyAlgorithm: normalizeKeyAlgorithm(config.keyAlgorithm),
    caPool: normalizeCaPool(
      caPoolOf(config.certificateAuthorityConfig),
      resolvedProject,
      location,
    ),
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const getByName = (name: string) =>
  certificatemanager
    .getProjectsLocationsCertificateIssuanceConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((config) =>
      config
        ? Effect.succeed(config)
        : Effect.fail(new CertificateIssuanceConfigNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.CertificateManager.CertificateIssuanceConfigNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((config) =>
      config === undefined
        ? Effect.void
        : Effect.fail(new CertificateIssuanceConfigStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.CertificateManager.CertificateIssuanceConfigStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const listOwnedIssuanceConfigs = (project: string) =>
  certificatemanager.listProjectsLocationsCertificateIssuanceConfigs
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.certificateIssuanceConfigs ?? []),
      ),
      Stream.filter((config) =>
        Object.keys(config.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((config) => toAttrs(config, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const desiredCaPool = (
  news: CertificateIssuanceConfigProps,
  project: string,
  location: string,
) =>
  normalizeCaPool(caPoolOf(news.certificateAuthorityConfig), project, location);

const toCreateBody = (
  news: CertificateIssuanceConfigProps,
  desiredLabels: Record<string, string>,
  caPool: string,
): certificatemanager.CertificateIssuanceConfig => ({
  description: news.description,
  labels: desiredLabels,
  lifetime: normalizeLifetime(news.lifetime),
  rotationWindowPercentage: normalizeRotation(news.rotationWindowPercentage),
  keyAlgorithm: normalizeKeyAlgorithm(news.keyAlgorithm),
  certificateAuthorityConfig: {
    certificateAuthorityServiceConfig: { caPool },
  },
});

export const CertificateIssuanceConfigProvider = () =>
  Provider.succeed(CertificateIssuanceConfig, {
    stables: [
      "name",
      "certificateIssuanceConfigId",
      "project",
      "location",
      "lifetime",
      "rotationWindowPercentage",
      "keyAlgorithm",
      "caPool",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId =
        olds?.certificateIssuanceConfigId ??
        output?.certificateIssuanceConfigId;
      const nextId = news.certificateIssuanceConfigId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousLifetime = olds?.lifetime ?? output?.lifetime;
      const previousRotation = normalizeRotation(
        olds?.rotationWindowPercentage ?? output?.rotationWindowPercentage,
      );
      const nextRotation = normalizeRotation(news.rotationWindowPercentage);
      const previousAlgorithm = normalizeKeyAlgorithm(
        olds?.keyAlgorithm ?? output?.keyAlgorithm,
      );
      const nextAlgorithm = normalizeKeyAlgorithm(news.keyAlgorithm);
      const previousCaPool = normalizeCaPool(
        olds?.certificateAuthorityConfig
          ? caPoolOf(olds.certificateAuthorityConfig)
          : output?.caPool,
        output?.project ?? "",
        previousLocation,
      );
      const nextCaPool = normalizeCaPool(
        caPoolOf(news.certificateAuthorityConfig) ?? output?.caPool,
        output?.project ?? "",
        nextLocation,
      );

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousLifetime !== undefined &&
          !lifetimeEquals(
            news.lifetime ?? previousLifetime,
            previousLifetime,
          )) ||
        previousRotation !== nextRotation ||
        previousAlgorithm !== nextAlgorithm ||
        (previousCaPool !== "" &&
          nextCaPool !== "" &&
          previousCaPool !== nextCaPool);

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const certificateIssuanceConfigId = yield* toId(
        id,
        olds?.certificateIssuanceConfigId,
        output?.certificateIssuanceConfigId,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        resourceName(env.project, location, certificateIssuanceConfigId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwnedIssuanceConfigs(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const certificateIssuanceConfigId = yield* toId(
        id,
        news.certificateIssuanceConfigId,
        output?.certificateIssuanceConfigId,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(
        env.project,
        location,
        certificateIssuanceConfigId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const caPool = desiredCaPool(news, env.project, location);

      let current = yield* getByName(name);

      if (current === undefined) {
        yield* Effect.gen(function* () {
          const created = yield* certificatemanager
            .createProjectsLocationsCertificateIssuanceConfigs({
              parent: `projects/${env.project}/locations/${location}`,
              certificateIssuanceConfigId,
              body: toCreateBody(news, desiredLabels, caPool),
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
        }).pipe(
          Effect.retry({
            // "config validation failed" (INVALID_ARGUMENT) while the CA
            // pool grant for the Certificate Manager agent propagates.
            while: (error) =>
              error._tag === "GCP.OperationFailed" && error.code === 3,
            times: 8,
            schedule: Schedule.spaced("3 seconds"),
          }),
        );
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new CertificateIssuanceConfigNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");

      if (labelsChanged || descriptionChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* certificatemanager.patchProjectsLocationsCertificateIssuanceConfigs(
            {
              name,
              updateMask: updateMask.join(","),
              body: {
                name,
                labels: desiredLabels,
                description: news.description,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* certificatemanager
        .deleteProjectsLocationsCertificateIssuanceConfigs({
          name: output.name,
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
