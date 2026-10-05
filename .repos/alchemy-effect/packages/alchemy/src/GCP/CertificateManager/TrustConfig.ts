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
const MAX_NAME_LENGTH = 63;

export type TrustConfigTrustAnchor = {
  /** PEM-encoded root certificate used as a trust anchor. Up to 5kB. */
  pemCertificate?: string;
};

export type TrustConfigIntermediateCA = {
  /**
   * PEM-encoded intermediate CA used while building a validation path.
   * Up to 5kB. Not supported for the workload-certificate / SPIFFE
   * feature.
   */
  pemCertificate?: string;
};

export type TrustConfigTrustStore = {
  /** Trust anchors used when validating client certificates. */
  trustAnchors?: TrustConfigTrustAnchor[];
  /**
   * Intermediate CAs used during path building. Currently unsupported
   * when the TrustConfig is used for SPIFFE / workload certificates.
   */
  intermediateCas?: TrustConfigIntermediateCA[];
};

export type TrustConfigAllowlistedCertificate = {
  /**
   * PEM-encoded certificate that is always considered valid when it
   * parses, proof of private-key possession is established, and SAN
   * constraints are met. Up to 5kB.
   */
  pemCertificate?: string;
};

export type TrustConfigProps = {
  /**
   * TrustConfig id (the `{trustConfig}` segment of
   * `projects/{project}/locations/{location}/trustConfigs/{trustConfig}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters and match `[a-z0-9-]{1,63}`.
   * Immutable — changing it replaces the TrustConfig.
   */
  trustConfigId?: string;
  /**
   * Certificate Manager location (`global`, `us-central1`, …). Immutable —
   * changing it replaces the TrustConfig. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
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
   * Trust stores used with load-balancer mTLS. Only one store is
   * currently allowed. Not supported for SPIFFE validation — use
   * `spiffeTrustStores` instead.
   */
  trustStores?: TrustConfigTrustStore[];
  /**
   * Certificates that are always considered valid (allowlist).
   */
  allowlistedCertificates?: TrustConfigAllowlistedCertificate[];
  /**
   * Mapping from SPIFFE trust domain to a TrustStore. Used for SPIFFE
   * certificate validation.
   */
  spiffeTrustStores?: Record<string, TrustConfigTrustStore>;
};

export type TrustConfig = Resource<
  "GCP.CertificateManager.TrustConfig",
  TrustConfigProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/trustConfigs/{trustConfig}`. */
    name: string;
    /** TrustConfig id (last path segment). */
    trustConfigId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Trust stores configured for load-balancer mTLS. */
    trustStores: TrustConfigTrustStore[];
    /** Allowlisted certificates. */
    allowlistedCertificates: TrustConfigAllowlistedCertificate[];
    /** SPIFFE trust-domain to TrustStore mapping. */
    spiffeTrustStores: Record<string, TrustConfigTrustStore>;
    /** Server-computed checksum, used as an optimistic-concurrency token. */
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
 * A Certificate Manager TrustConfig — the PKI used to validate client
 * certificates in mutual TLS (load balancer or SPIFFE).
 *
 * Changing `trustConfigId` or `location` replaces the resource.
 * Description, labels, trust stores, allowlisted certificates, and SPIFFE
 * trust stores update in place.
 *
 * ### Creating a Trust Config
 * **Example:** Generated name
 * ```typescript
 * const trust = yield* GCP.CertificateManager.TrustConfig("ClientMtls", {
 *   trustStores: [
 *     {
 *       trustAnchors: [{ pemCertificate }],
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Named config with labels
 * ```typescript
 * const trust = yield* GCP.CertificateManager.TrustConfig("ClientMtls", {
 *   trustConfigId: "app-client-mtls",
 *   description: "prod mTLS roots",
 *   labels: { env: "prod" },
 *   trustStores: [
 *     {
 *       trustAnchors: [{ pemCertificate: rootPem }],
 *       intermediateCas: [{ pemCertificate: intermediatePem }],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Allowlisted Certificates
 * **Example:** Allowlist client certificates
 * ```typescript
 * const trust = yield* GCP.CertificateManager.TrustConfig("Allowlist", {
 *   allowlistedCertificates: [
 *     { pemCertificate: clientPemA },
 *     { pemCertificate: clientPemB },
 *   ],
 * });
 * ```
 *
 * ### Regional Trust Config
 * **Example:** Trust config in us-central1
 * ```typescript
 * const trust = yield* GCP.CertificateManager.TrustConfig("RegionalMtls", {
 *   location: "us-central1",
 *   trustStores: [
 *     {
 *       trustAnchors: [{ pemCertificate }],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category CertificateManager
 */
export const TrustConfig = Resource<TrustConfig>(
  "GCP.CertificateManager.TrustConfig",
);

export class TrustConfigNotResolved extends Data.TaggedError(
  "GCP.CertificateManager.TrustConfigNotResolved",
)<{
  name: string;
}> {}

export class TrustConfigStillExists extends Data.TaggedError(
  "GCP.CertificateManager.TrustConfigStillExists",
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
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "trust-config";
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const resourceName = (
  project: string,
  location: string,
  trustConfigId: string,
) => `projects/${project}/locations/${location}/trustConfigs/${trustConfigId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const trustConfigsAt = parts.lastIndexOf("trustConfigs");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    trustConfigId:
      trustConfigsAt >= 0 && parts[trustConfigsAt + 1]
        ? parts[trustConfigsAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (
  id: string,
  trustConfigId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (trustConfigId !== undefined) return trustConfigId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const normalizePem = (pem: string | undefined): string =>
  (pem ?? "").replace(/\s+/g, "");

const pemEntries = (
  entries: { pemCertificate?: string }[] | undefined,
): { pemCertificate?: string }[] =>
  (entries ?? [])
    .map((entry) => ({ pemCertificate: entry.pemCertificate }))
    .filter((entry) => (entry.pemCertificate ?? "").length > 0);

const toStore = (
  store: certificatemanager.TrustStore | TrustConfigTrustStore | undefined,
): TrustConfigTrustStore => ({
  trustAnchors: pemEntries(store?.trustAnchors),
  intermediateCas: pemEntries(store?.intermediateCas),
});

const toStores = (
  stores:
    | ReadonlyArray<certificatemanager.TrustStore | TrustConfigTrustStore>
    | null
    | undefined,
): TrustConfigTrustStore[] => (stores ?? []).map((store) => toStore(store));

const toSpiffeStores = (
  stores:
    | Record<
        string,
        certificatemanager.TrustStore | TrustConfigTrustStore | undefined
      >
    | null
    | undefined,
): Record<string, TrustConfigTrustStore> =>
  Object.fromEntries(
    Object.entries(stores ?? {})
      .filter(
        (
          entry,
        ): entry is [
          string,
          certificatemanager.TrustStore | TrustConfigTrustStore,
        ] => entry[1] !== undefined,
      )
      .map(([domain, store]) => [domain, toStore(store)]),
  );

const pemFingerprint = (entries?: { pemCertificate?: string }[]) =>
  pemEntries(entries)
    .map((entry) => normalizePem(entry.pemCertificate))
    .sort()
    .join("\0");

const storeFingerprint = (store: TrustConfigTrustStore) =>
  `${pemFingerprint(store.trustAnchors)}\n${pemFingerprint(store.intermediateCas)}`;

const storesFingerprint = (stores?: TrustConfigTrustStore[]) =>
  toStores(stores).map(storeFingerprint).sort().join("||");

const spiffeFingerprint = (
  stores?: Record<string, TrustConfigTrustStore | undefined>,
) => {
  const normalized = toSpiffeStores(stores);
  return Object.keys(normalized)
    .sort()
    .map((domain) => `${domain}=${storeFingerprint(normalized[domain]!)}`)
    .join("||");
};

const toAttrs = (config: certificatemanager.TrustConfig, project: string) => {
  const name = config.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    trustConfigId: parsed.trustConfigId,
    project: parsed.project || project,
    location: parsed.location,
    description: config.description,
    labels: userLabels(config.labels),
    trustStores: toStores(config.trustStores),
    allowlistedCertificates: pemEntries(config.allowlistedCertificates),
    spiffeTrustStores: toSpiffeStores(config.spiffeTrustStores),
    etag: config.etag,
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const getByName = (name: string) =>
  certificatemanager
    .getProjectsLocationsTrustConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((config) =>
      config
        ? Effect.succeed(config)
        : Effect.fail(new TrustConfigNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.CertificateManager.TrustConfigNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((config) =>
      config === undefined
        ? Effect.void
        : Effect.fail(new TrustConfigStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.CertificateManager.TrustConfigStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const listOwnedTrustConfigs = (project: string) =>
  certificatemanager.listProjectsLocationsTrustConfigs
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.trustConfigs ?? [])),
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

const toCreateBody = (
  news: TrustConfigProps,
  desiredLabels: Record<string, string>,
): certificatemanager.TrustConfig => {
  const body: certificatemanager.TrustConfig = {
    description: news.description,
    labels: desiredLabels,
  };
  const trustStores = toStores(news.trustStores);
  if (trustStores.length > 0) {
    body.trustStores = trustStores;
  }
  const allowlisted = pemEntries(news.allowlistedCertificates);
  if (allowlisted.length > 0) {
    body.allowlistedCertificates = allowlisted;
  }
  const spiffe = toSpiffeStores(news.spiffeTrustStores);
  if (Object.keys(spiffe).length > 0) {
    body.spiffeTrustStores = spiffe;
  }
  return body;
};

export const TrustConfigProvider = () =>
  Provider.succeed(TrustConfig, {
    stables: ["name", "trustConfigId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.trustConfigId ?? output?.trustConfigId;
      const nextId = news.trustConfigId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation;

      if (!replace) return undefined;
      return { action: "replace" as const };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const trustConfigId = yield* toId(
        id,
        olds?.trustConfigId,
        output?.trustConfigId,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, trustConfigId);
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
        return yield* listOwnedTrustConfigs(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const trustConfigId = yield* toId(
        id,
        news.trustConfigId,
        output?.trustConfigId,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, trustConfigId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* certificatemanager
          .createProjectsLocationsTrustConfigs({
            parent: `projects/${env.project}/locations/${location}`,
            trustConfigId,
            body: toCreateBody(news, desiredLabels),
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
        return yield* new TrustConfigNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const desiredStores = toStores(news.trustStores);
      const storesChanged =
        storesFingerprint(desiredStores) !==
        storesFingerprint(current.trustStores);
      const desiredAllowlisted = pemEntries(news.allowlistedCertificates);
      const allowlistedChanged =
        pemFingerprint(desiredAllowlisted) !==
        pemFingerprint(current.allowlistedCertificates);
      const desiredSpiffe = toSpiffeStores(news.spiffeTrustStores);
      const spiffeChanged =
        spiffeFingerprint(desiredSpiffe) !==
        spiffeFingerprint(current.spiffeTrustStores);

      if (
        labelsChanged ||
        descriptionChanged ||
        storesChanged ||
        allowlistedChanged ||
        spiffeChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          storesChanged ? "trustStores" : undefined,
          allowlistedChanged ? "allowlistedCertificates" : undefined,
          spiffeChanged ? "spiffeTrustStores" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* certificatemanager.patchProjectsLocationsTrustConfigs({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              description: news.description,
              trustStores: desiredStores,
              allowlistedCertificates: desiredAllowlisted,
              spiffeTrustStores: desiredSpiffe,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* certificatemanager
        .deleteProjectsLocationsTrustConfigs({ name: output.name })
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
